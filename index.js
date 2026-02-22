require("dotenv").config();
const path = require("path");
const fs = require("fs-extra");
const { generateUnitTest, generateUserStory, writeUnitTests } = require("./LLMClient");
const { postStory } = require("./trofos");
const { runTestsAndCollectBugs } = require("./analyser");
const { generateReport } = require("./reportGenerator");
const { extractFunctions } = require("./utils/fileUtils");

const selectedFiles = require("./selectedFiles.json");
const epics = selectedFiles.epics || {};

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Path to the project repo (relative from current folder) - can be overridden with env PROJECT_REPO
const PROJECT_REPO = process.env.PROJECT_REPO || path.resolve("../cs4218-2520-ecom-project-cs4218-2520-team21");

async function main() {
  // Startup validations
  if (!process.env.OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY. Set it in your environment before running.");
    process.exit(1);
  }

  const trofosSessionExists = await fs.pathExists(path.join(__dirname, "trofos-session.json"));
  if (!trofosSessionExists) {
    console.warn("Warning: trofos-session.json not found — story posting will be skipped unless you run login.js");
  }

  if (!(await fs.pathExists(PROJECT_REPO))) {
    console.error(`PROJECT_REPO not found at ${PROJECT_REPO}`);
    process.exit(1);
  }

  // Warn if node_modules missing in target repo
  const nodeModulesPath = path.join(PROJECT_REPO, "node_modules");
  if (!(await fs.pathExists(nodeModulesPath))) {
    console.warn(`Warning: node_modules not found in PROJECT_REPO (${nodeModulesPath}). Tests may fail unless dependencies are installed.`);
  }

  let functionsAnalyzed = 0;
  let testsGenerated = 0;
  const generatedTestFiles = [];

  // 1️⃣ Generate User Stories & Post to Trofos and generate tests
  const allFiles = [...selectedFiles.frontend, ...Object.keys(selectedFiles.backend)];
  for (const filePath of allFiles) {
    const fullPath = path.join(PROJECT_REPO, filePath);

    try {
      if (!(await fs.pathExists(fullPath))) {
        console.warn(`File not found, skipping: ${fullPath}`);
        continue;
      }

      const code = await fs.readFile(fullPath, "utf-8");

      // Generate story
      let story;
      try {
        story = await generateUserStory(code, fullPath);
      } catch (e) {
        console.warn(`Failed to generate story for ${filePath}: ${e.message}`);
      }

      // Post story only if session exists
      // apply epic override from mapping if present
      if (story) {
        const mappedEpic = epics[filePath] || epics[path.relative(PROJECT_REPO, fullPath)] || "";
        if (mappedEpic) story.epic = mappedEpic;
        // Write an HTML preview of the generated story for user inspection
        try {
          const previewDir = path.join(__dirname, "story-previews");
          await fs.ensureDir(previewDir);
          const safeName = filePath.replace(/[\/\\]/g, "_").replace(/\s+/g, "_");
          const filename = `${safeName}-${Date.now()}.html`;
          const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(story.title)}</title></head><body><h1>${escapeHtml(story.title)}</h1><p><strong>Source File:</strong> ${escapeHtml(filePath)}</p><p><strong>Epic:</strong> ${escapeHtml(story.epic || "")}</p><p><strong>Sprint:</strong> ${escapeHtml(story.sprint || "")}</p><p><strong>Priority:</strong> ${escapeHtml(story.priority || "")}</p><p><strong>Points:</strong> ${escapeHtml(story.points || "")}</p><p><strong>Assignee:</strong> ${escapeHtml(story.assignee || "")}</p><hr/><pre>${escapeHtml(story.description || "")}</pre></body></html>`;
          await fs.writeFile(path.join(previewDir, filename), html, "utf8");
        } catch (e) {
          console.warn(`Failed to write story preview: ${e.message}`);
        }
      }

      if (story && trofosSessionExists) {
        try {
          await postStory(story);
        } catch (e) {
          console.warn(`Failed to post story for ${filePath}: ${e.message}`);
        }
      }

      // Generate unit tests
      const backendEntry = selectedFiles.backend[filePath];
      let functionsToTest = [];

      if (Array.isArray(backendEntry) && backendEntry.length > 0) {
        functionsToTest = backendEntry;
      } else if (Object.prototype.hasOwnProperty.call(selectedFiles.backend, filePath)) {
        // backend file listed but no functions specified: extract from source
        functionsToTest = extractFunctions(code, []);
      }

      if (functionsToTest.length > 0) {
        // generate per-function tests
        for (const fn of functionsToTest) {
          try {
            const testContent = await generateUnitTest(fullPath, code, { functions: [fn] });
            const createdFiles = await writeUnitTests(PROJECT_REPO, fullPath, testContent, [fn]);
            functionsAnalyzed += 1;
            testsGenerated += createdFiles.length;
            generatedTestFiles.push(...createdFiles);
          } catch (e) {
            console.warn(`Failed to generate/write test for ${filePath} -> ${fn}: ${e.message}`);
          }
        }
      } else {
        // frontend or backend with no detectable functions: generate a file-level test
        try {
          const testContent = await generateUnitTest(fullPath, code);
          const createdFiles = await writeUnitTests(PROJECT_REPO, fullPath, testContent);
          testsGenerated += createdFiles.length;
          generatedTestFiles.push(...createdFiles);
        } catch (e) {
          console.warn(`Failed to generate/write test for ${filePath}: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn(`Unexpected error processing ${filePath}: ${e.message}`);
      continue;
    }
  }

  // 3️⃣ Run tests in the project repo and collect bugs
  let bugs = [];
  try {
    if (generatedTestFiles.length > 0) {
      // Run only the generated tests to keep the report focused
      bugs = await runTestsAndCollectBugs(PROJECT_REPO, generatedTestFiles);
    } else {
      console.warn("No generated test files found — skipping test run.");
    }
  } catch (e) {
    console.error(`Running tests failed: ${e.message}`);
  }

  // 4️⃣ Generate grading report
  const unitTestStats = {
    approach: "Principled approach: isolated unit tests using AAA / Given-When-Then pattern covering happy paths and edge cases.",
    functionsAnalyzed,
    testsGenerated,
    generatedTestFiles,
    bugsFixed: 0 // assume none auto-fixed for now
  };

  await generateReport({ unitTestStats, bugs, outputPath: path.join(__dirname, "unit-test-report.html") });
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
