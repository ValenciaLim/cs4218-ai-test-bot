const path = require("path");
const fs = require("fs-extra");
const { extractFunctions, readFile, writeFile } = require("../utils/fileUtils");
const {
  generateUnitTest,
  writeUnitTests,
  analyzeJestFailures,
  suggestFixes,
  generateAdditionalTestInputs
} = require("../LLMClient");
const { runJest, summarizeJestFailures } = require("../lib/jestRunner");
const {
  storiesForFile,
  mergeStoriesForPrompt,
  collectUnitTargetFiles,
  storyAppliesToAgent
} = require("../lib/userStories");

const DEMO_FAIL_MARKER = "_autofix_demo_intentional_failure";

async function maybeInjectAutofixDemoFailure(testAbsPath, enabled) {
  if (!enabled || !testAbsPath) return;
  if (!/tipPct\.test\.js$/i.test(testAbsPath)) return;
  let t = await readFile(testAbsPath);
  if (t.includes(DEMO_FAIL_MARKER)) return;
  t =
    t.trimEnd() +
    `\n\ndescribe("${DEMO_FAIL_MARKER}", () => {\n  it("demo: wrong expected tip (20 vs 18) for autofix", () => {\n    expect(tipPct(99.99)).toBe(20);\n  });\n});\n`;
  await writeFile(testAbsPath, t);
  console.log(
    `[unit] Demo: appended failing assertion expect(tipPct(99.99)).toBe(20) — real value is 18. Remove unit.demoInjectFailingAssertion for normal runs.`
  );
}

async function runUnitTestAgent({
  projectRepo,
  selectedFiles,
  stories,
  autoFix = false,
  maxFixRounds = 1,
  demoInjectFailingAssertion = false
}) {
  const epics = selectedFiles.epics || {};
  const allFiles = collectUnitTargetFiles(selectedFiles, stories);
  const results = [];

  for (const filePath of allFiles) {
    const fullPath = path.join(projectRepo, filePath);
    if (!(await fs.pathExists(fullPath))) {
      console.warn(`[unit] Skip missing file: ${fullPath}`);
      continue;
    }
    const code = await fs.readFile(fullPath, "utf-8");
    let applicable = storiesForFile(stories, filePath.replace(/\\/g, "/"));
    applicable = applicable.filter(s => storyAppliesToAgent(s, "unit"));
    const perfFree = applicable.filter(s => !/^performance$/i.test(String(s.type || "").trim()));
    if (perfFree.length) applicable = perfFree;
    const userStory = mergeStoriesForPrompt(applicable);
    if (!userStory.description && epics[filePath]) {
      userStory.description = epics[filePath];
      userStory.title = userStory.title || epics[filePath];
    }

    const backendEntry = (selectedFiles.backend || {})[filePath];
    let functionsToTest = [];
    if (Array.isArray(backendEntry) && backendEntry.length > 0) {
      functionsToTest = backendEntry;
    } else if (Object.prototype.hasOwnProperty.call(selectedFiles.backend || {}, filePath)) {
      functionsToTest = extractFunctions(code, []);
    }

    try {
      const createdFiles = [];
      if (functionsToTest.length > 0) {
        for (const fn of functionsToTest) {
          const testContent = await generateUnitTest(fullPath, code, { functions: [fn], userStory });
          const c = await writeUnitTests(projectRepo, fullPath, testContent, [fn]);
          createdFiles.push(...c);
        }
      } else {
        const testContent = await generateUnitTest(fullPath, code, { userStory });
        const c = await writeUnitTests(projectRepo, fullPath, testContent);
        createdFiles.push(...c);
      }

      const primaryTest = createdFiles[0];
      if (primaryTest) {
        await maybeInjectAutofixDemoFailure(primaryTest, demoInjectFailingAssertion);
      }

      const relTests = createdFiles.map(f => path.relative(projectRepo, f).replace(/\\/g, "/"));
      const jestArgs = relTests.length ? relTests : [];
      let jestResult = runJest(projectRepo, jestArgs);
      const entry = {
        file: filePath,
        createdFiles,
        jestSuccess: jestResult.success,
        fixRounds: 0
      };
      if (functionsToTest.length) entry.functions = functionsToTest;

      if (jestResult.success) {
        console.log(`[unit] Jest passed for ${filePath} (${relTests.join(", ")})`);
      } else {
        console.warn(
          `[unit] Jest failed for ${filePath} (exit ${jestResult.status}). ${jestResult.json ? "Failure details summarized below." : "No JSON report parsed — check Jest config (e.g. jest.frontend.config.js) or run Jest manually in projectRepo."}`
        );
      }

      let round = 0;
      while (!jestResult.success && jestResult.json && round < maxFixRounds) {
        const { summary } = summarizeJestFailures(jestResult.json);
        const analysis = await analyzeJestFailures(jestResult.json);
        console.log(`[unit] Jest analysis for ${filePath}:\n${analysis}\n`);

        let testCode = "";
        if (primaryTest && (await fs.pathExists(primaryTest))) {
          testCode = await readFile(primaryTest);
        }
        const fix = await suggestFixes({
          sourceCode: code,
          testCode,
          filePath,
          testFilePath: path.relative(projectRepo, primaryTest || ""),
          failureSummary: summary,
          analysis
        });
        console.log(`[unit] Fix suggestions (raw excerpt):\n${fix.raw.slice(0, 2000)}${fix.raw.length > 2000 ? "…" : ""}\n`);

        if (!autoFix && round === 0) {
          console.log(
            "[unit] autoFix is off — only suggestions were printed. Set unit.autoFix to true in agent.config.json to apply test-file patches only (production code is never modified)."
          );
        }

        if (autoFix && fix.testCode && primaryTest) {
          await writeFile(primaryTest, fix.testCode);
          console.log(`[unit] Auto-applied test patch: ${primaryTest}`);
        }

        jestResult = runJest(projectRepo, jestArgs);
        round++;
        entry.fixRounds = round;
        entry.jestSuccess = jestResult.success;
        if (jestResult.success) {
          console.log(`[unit] Jest passed after fix round ${round} for ${filePath}`);
        }
      }

      if (!jestResult.success) {
        console.warn(
          `[unit] Jest still failing for ${filePath} (status ${jestResult.status}). Increase unit.maxFixRounds, enable unit.autoFix, or fix imports/config manually.`
        );
      }

      const extra = await generateAdditionalTestInputs(filePath, code, userStory);
      console.log(`[unit] Additional case ideas for ${filePath}:\n${extra}\n`);
      entry.additionalCases = extra;
      entry.phase = "done";
      results.push(entry);
    } catch (e) {
      console.warn(`[unit] Error on ${filePath}: ${e.message}`);
      results.push({ file: filePath, error: e.message });
    }
  }

  return results;
}

module.exports = { runUnitTestAgent };
