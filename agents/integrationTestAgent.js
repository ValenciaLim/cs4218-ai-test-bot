const path = require("path");
const fs = require("fs-extra");
const { spawnSync } = require("child_process");
const {
  generateIntegrationUITest,
  generatePlannerSpecMarkdown,
  reviewIntegrationTestsLLM
} = require("../LLMClient");
const { reviewIntegrationTestCode } = require("../lib/integrationStaticReview");
const { writePlaywrightHandoff } = require("../lib/mcpHandoff");
const { storyAppliesToAgent } = require("../lib/userStories");

function safeStoryBaseName(story) {
  return (story.title || "story").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 48);
}

const DEFAULT_SEED_TS = `import { test, expect } from '@playwright/test';

/**
 * Seed test for Playwright Test Agents: validates bootstrap (global setup, deps, fixtures, hooks).
 * Set use.baseURL in playwright.config.* to your running app URL.
 */
test('seed', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/.*/);
});
`;

async function ensureSeedSpec(projectRepo, { overwriteSeed }) {
  const testsDir = path.join(projectRepo, "tests");
  const seedPath = path.join(testsDir, "seed.spec.ts");
  await fs.ensureDir(testsDir);
  const exists = await fs.pathExists(seedPath);
  if (!exists || overwriteSeed) {
    await fs.writeFile(seedPath, DEFAULT_SEED_TS, "utf-8");
  }
  return seedPath;
}

async function projectHasPlaywrightTest(projectRepo) {
  const pkgPath = path.join(projectRepo, "package.json");
  if (!(await fs.pathExists(pkgPath))) return false;
  try {
    const pkg = await fs.readJson(pkgPath);
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return !!deps["@playwright/test"];
  } catch {
    return false;
  }
}

/**
 * Ensures browsers are present for `npx playwright test` in projectRepo (idempotent).
 * Set integration.runPlaywrightInstall: false to skip (e.g. CI with cached browsers).
 */
async function runPlaywrightInstallBrowsersIfNeeded(projectRepo, integration) {
  if (integration.runPlaywrightInstall === false) {
    console.log("[integration] Skipping npx playwright install (runPlaywrightInstall: false).");
    return { skipped: true };
  }
  if (!(await projectHasPlaywrightTest(projectRepo))) {
    console.log(
      "[integration] Skipping npx playwright install — add @playwright/test to projectRepo devDependencies to enable."
    );
    return { skipped: true };
  }
  console.log("[integration] Running npx playwright install in projectRepo (may download browsers once)…");
  const r = spawnSync("npx", ["playwright", "install"], {
    cwd: projectRepo,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env }
  });
  console.log(`[integration] npx playwright install exit ${r.status}\n${(r.stdout || "").slice(-5000)}`);
  if (r.stderr) console.error((r.stderr || "").slice(-3000));
  return { status: r.status };
}

function runPlaywrightInitAgentsIfRequested(projectRepo, { runInitAgents, initAgentsLoop }) {
  if (!runInitAgents) return { skipped: true };
  const loop = String(initAgentsLoop || "vscode").trim() || "vscode";
  const r = spawnSync("npx", ["playwright", "init-agents", `--loop=${loop}`], {
    cwd: projectRepo,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, CI: process.env.CI || "1" }
  });
  console.log(
    `[integration] npx playwright init-agents --loop=${loop} exit ${r.status}\n${(r.stdout || "").slice(-3000)}`
  );
  if (r.stderr) console.error((r.stderr || "").slice(-2000));
  return { status: r.status, loop };
}

async function runIntegrationTestAgent({
  projectRepo,
  stories,
  selectedFiles,
  integration = {},
  output = {}
}) {
  const executor = String(integration.executor || "mcp").toLowerCase();
  const layout = String(integration.layout || "playwright-agents").toLowerCase();
  const outputs = [];
  const generatedSpecs = [];

  let list = stories.filter(
    s =>
      storyAppliesToAgent(s, "integration") && !/^performance$/i.test(String(s.type || "").trim())
  );
  if (!list.length) {
    list = stories.filter(s => !/^performance$/i.test(String(s.type || "").trim()));
    if (list.length) {
      console.log(
        "[integration] No stories matched testFor integration/ui/e2e/playwright; using all non-performance stories."
      );
    }
  }

  runPlaywrightInitAgentsIfRequested(projectRepo, {
    runInitAgents: integration.runInitAgents,
    initAgentsLoop: integration.initAgentsLoop
  });

  await runPlaywrightInstallBrowsersIfNeeded(projectRepo, integration);

  if (layout === "legacy") {
    const outDir = path.join(projectRepo, "__tests__", "integration");
    await fs.ensureDir(outDir);

    for (const story of list) {
      const userStory = {
        title: story.title,
        type: story.type,
        priority: story.priority,
        description: story.description,
        testFor: story.testFor || ""
      };

      let code = "";
      let samplePath = "";
      const files =
        story.files && story.files.length
          ? story.files
          : [...(selectedFiles.frontend || []).slice(0, 1)];
      if (files.length) {
        samplePath = files[0];
        const full = path.join(projectRepo, samplePath);
        if (await fs.pathExists(full)) {
          code = await fs.readFile(full, "utf-8");
          code = code.slice(0, 24000);
        }
      }

      try {
        const testContent = await generateIntegrationUITest(samplePath || "app", code, { userStory });
        const safeName = safeStoryBaseName(story);
        const testFile = path.join(outDir, `${safeName}.spec.js`);
        await fs.writeFile(testFile, testContent);

        const staticFindings = reviewIntegrationTestCode(testContent);
        console.log(`[integration] Static pre-check for ${story.title}:`, JSON.stringify(staticFindings, null, 2));

        const llmReview = await reviewIntegrationTestsLLM(userStory, testContent, staticFindings);
        console.log(`[integration] LLM pre-execution review:\n${llmReview}\n`);

        const relSpec = path.relative(projectRepo, testFile).replace(/\\/g, "/");
        generatedSpecs.push({
          storyTitle: story.title,
          specPath: relSpec,
          kind: "playwrightTest",
          absolutePath: testFile
        });

        if (executor === "cli" || executor === "both") {
          const r = spawnSync("npx", ["playwright", "test", relSpec], {
            cwd: projectRepo,
            encoding: "utf-8",
            maxBuffer: 20 * 1024 * 1024,
            env: { ...process.env, CI: "1" }
          });
          console.log(`[integration] CLI Playwright exit ${r.status}\n${(r.stdout || "").slice(-4000)}`);
          if (r.stderr) console.error(r.stderr.slice(-2000));
          outputs.push({ story: story.title, testFile, playwrightStatus: r.status, staticFindings });
        } else {
          outputs.push({ story: story.title, testFile, staticFindings, executor: "mcp" });
        }
      } catch (e) {
        console.warn(`[integration] Failed '${story.title}': ${e.message}`);
        outputs.push({ story: story.title, error: e.message });
      }
    }
  } else {
    const specsDir = path.join(projectRepo, "specs");
    await fs.ensureDir(specsDir);
    const seedAbs = await ensureSeedSpec(projectRepo, {
      overwriteSeed: integration.overwriteSeed
    });
    const relSeed = path.relative(projectRepo, seedAbs).replace(/\\/g, "/");
    console.log(
      `[integration] Playwright Test Agents layout: planner markdown → ${specsDir.replace(/\\/g, "/")}; seed → ${relSeed}`
    );

    for (const story of list) {
      const userStory = {
        title: story.title,
        type: story.type,
        priority: story.priority,
        description: story.description,
        testFor: story.testFor || ""
      };

      let codeSnippet = "";
      let samplePath = "";
      const files =
        story.files && story.files.length
          ? story.files
          : [...(selectedFiles.frontend || []).slice(0, 1)];
      if (files.length) {
        samplePath = files[0];
        const full = path.join(projectRepo, samplePath);
        if (await fs.pathExists(full)) {
          codeSnippet = (await fs.readFile(full, "utf-8")).slice(0, 24000);
        }
      }

      try {
        const md = await generatePlannerSpecMarkdown({
          samplePath: samplePath || "app",
          codeSnippet,
          userStory,
          baseUrl: integration.baseUrl || ""
        });
        const safeName = safeStoryBaseName(story);
        const planFile = path.join(specsDir, `${safeName}.md`);
        await fs.writeFile(planFile, md, "utf-8");

        const relPlan = path.relative(projectRepo, planFile).replace(/\\/g, "/");
        generatedSpecs.push({
          storyTitle: story.title,
          specPath: relPlan,
          kind: "plannerMarkdown",
          absolutePath: planFile
        });

        if (executor === "cli" || executor === "both") {
          const r = spawnSync("npx", ["playwright", "test", relSeed], {
            cwd: projectRepo,
            encoding: "utf-8",
            maxBuffer: 20 * 1024 * 1024,
            env: { ...process.env, CI: "1" }
          });
          console.log(
            `[integration] CLI seed only (agents layout) exit ${r.status}\n${(r.stdout || "").slice(-3000)}`
          );
          if (r.stderr) console.error(r.stderr.slice(-2000));
          outputs.push({
            story: story.title,
            plannerMarkdown: planFile,
            seedTest: seedAbs,
            playwrightStatus: r.status,
            note: "Executable flows: use Playwright MCP Generator on specs/*.md (see handoff)."
          });
        } else {
          outputs.push({
            story: story.title,
            plannerMarkdown: planFile,
            seedTest: seedAbs,
            executor: "mcp",
            note: "Use MCP Generator on plannerMarkdown; Healer on failing generated tests."
          });
        }
      } catch (e) {
        console.warn(`[integration] Failed '${story.title}': ${e.message}`);
        outputs.push({ story: story.title, error: e.message });
      }
    }
  }

  if (executor === "mcp" || executor === "both") {
    const handoffDir = output.mcpHandoffDir || path.join(__dirname, "..", "mcp-handoff");
    const loop = integration.initAgentsLoop || "vscode";
    const handoffFile = await writePlaywrightHandoff(handoffDir, {
      mcpServerId: integration.playwrightServerId,
      mcpCommand: integration.playwrightCommand,
      baseUrl: integration.baseUrl,
      projectRepo,
      layout,
      initAgentsCommand: `npx playwright init-agents --loop=${loop}`,
      initAgentsLoop: loop,
      seedSpecRelative: layout !== "legacy" ? "tests/seed.spec.ts" : "",
      generatedSpecs,
      userStories: list.map(s => ({
        title: s.title,
        type: s.type,
        priority: s.priority,
        description: s.description,
        testFor: s.testFor || "",
        files: s.files || []
      }))
    });
    console.log(
      `[integration] Playwright MCP handoff written: ${handoffFile}\n` +
        `  → Follow .cursor/rules/mcp-test-orchestration.mdc: init-agents if needed, seed + specs → MCP Generator → tests/, then Healer (${integration.baseUrl || "set integration.baseUrl"}).`
    );
  }

  return outputs;
}

module.exports = { runIntegrationTestAgent };
