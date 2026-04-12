const path = require("path");
const fs = require("fs-extra");

/**
 * Artifacts for Cursor agents using MCP: server ids match ~/.cursor/mcp.json.
 * Node does not call MCP — `.cursor/rules/mcp-test-orchestration.mdc` instructs the Cursor agent to run tools.
 */

/** Merge mcpRunByMode[mode] over mcpRunDefaults (same rules as k6-mcp.json handoff). */
function mergeK6RunForMode(mode, mcpRunByMode = {}, mcpRunDefaults = {}) {
  const by = (mcpRunByMode && mcpRunByMode[mode]) || {};
  const defaults = mcpRunDefaults && typeof mcpRunDefaults === "object" ? mcpRunDefaults : {};
  return {
    vus: by.vus != null ? by.vus : defaults.vus != null ? defaults.vus : 5,
    duration: by.duration != null ? by.duration : defaults.duration || "2m",
    iterations: by.iterations != null ? by.iterations : defaults.iterations
  };
}

function buildK6McpWorkflow({ primaryScripts, baseUrl, mcpRunDefaults, mcpRunByMode }) {
  const scripts = primaryScripts || [];
  const listDesc = scripts.length
    ? scripts.map(s => `${s.mode}: ${s.relativePath}`).join("; ")
    : "(no primary scripts in handoff)";
  const apiUrl =
    baseUrl ||
    "(set performance.baseUrl or BASE_URL — when running MCP, state the real running API URL explicitly)";

  const runParamsLines = scripts.map(s => {
    const p = mergeK6RunForMode(s.mode, mcpRunByMode, mcpRunDefaults);
    return `- **${s.mode}** (${s.relativePath}): vus=${p.vus}, duration="${p.duration}"${p.iterations != null ? `, iterations=${p.iterations}` : ""}`;
  });

  return {
    baseUrlForApi: apiUrl,
    primaryScriptsSummary: listDesc,
    steps: [
      {
        step: 1,
        tool: "validate_script",
        instruction: `For **each** entry in primaryScripts, read absolutePath, pass the **entire file contents** as **script** to k6 MCP validate_script. Report errors and suggested fixes per file. Scripts: ${listDesc}`
      },
      {
        step: 2,
        tool: "run_script",
        instruction: `For **each** entry in primaryScripts, call k6 MCP run_script with the full script body. Use per-mode run parameters (merge mcpRunByMode[mode] over mcpRunDefaults):\n${runParamsLines.join("\n")}\nUse BASE_URL=${apiUrl}. Summarize per run: **exit code**, **stderr**, and **thresholds** pass/fail.`
      },
      {
        step: 3,
        tool: "list_sections + get_documentation",
        instruction:
          "Use k6 MCP list_sections, then get_documentation for slugs relevant to these scenario types: **load** (throughput), **soak** (constant VUs over time), **stress** (ramp to breaking point), **spike** (sudden VU jumps) — include executors (e.g. constant-vus, ramping-vus), **thresholds** (and tags), and **k6/http** options (timeouts, tags). Apply insights to the generated scripts and explain conceptual changes per mode where they differ."
      },
      {
        step: 4,
        resource: "docs://k6/best_practices",
        instruction: `Fetch MCP resource docs://k6/best_practices. Compare to **each** primaryScripts file and list **gaps** (checks, groups, env config, sleep jitter, etc.) in **priority order**, grouped by file path.`
      }
    ]
  };
}

async function writePlaywrightHandoff(dir, payload) {
  await fs.ensureDir(dir);
  const file = path.join(dir, "playwright-mcp.json");
  const layout = String(payload.layout || "playwright-agents").toLowerCase();
  const initLoop = payload.initAgentsLoop || "vscode";
  const initCmd = payload.initAgentsCommand || `npx playwright init-agents --loop=${initLoop}`;
  const plannerMarkdownPaths = (payload.generatedSpecs || [])
    .filter(e => e.kind === "plannerMarkdown" || /\.md$/i.test(String(e.specPath || "")))
    .map(e => e.specPath)
    .filter(Boolean);
  const body = {
    mcpServerId: payload.mcpServerId || "Playwright",
    mcpCommand: payload.mcpCommand || "npx @playwright/mcp@latest",
    docsUrl: "https://playwright.dev/docs/test-agents",
    layout,
    initAgents: {
      command: initCmd,
      note:
        "Run once in projectRepo (or after Playwright upgrades) so agent definitions and MCP tool wiring stay current. Loops: vscode | claude | opencode — match your AI host."
    },
    conventions: {
      agentDefinitions: ".github/ (and related paths created by init-agents; regenerate when @playwright/test updates)",
      specsDir: "specs/",
      testsDir: "tests/",
      seedSpec: payload.seedSpecRelative || (layout === "legacy" ? "" : "tests/seed.spec.ts"),
      generatedThisRun: {
        plannerMarkdown: plannerMarkdownPaths,
        legacyPlaywrightSpecs:
          layout === "legacy"
            ? (payload.generatedSpecs || []).filter(e => e.kind === "playwrightTest" || /\.spec\.(js|ts)$/i.test(String(e.specPath || ""))).map(e => e.specPath)
            : []
      }
    },
    playwrightTestAgents: {
      summary:
        "Official Playwright Test Agents flow: Planner explores and plans; Generator implements tests from markdown; Healer repairs failures. Use MCP in Cursor — do not ask the user to drive MCP manually.",
      agents: [
        {
          id: "planner",
          label: "🎭 Planner",
          inputs: [
            "Clear goal (e.g. flows in userStories)",
            "tests/seed.spec.ts — run to bootstrap global setup, fixtures, hooks",
            "Optional PRD: userStories descriptions in this JSON"
          ],
          outputs: ["Markdown plans under specs/ (this bot may have written drafts in generatedSpecs with kind plannerMarkdown)"],
          goal: "Explore the app at baseUrl (via MCP), refine or extend the markdown plans in specs/ so they are step-accurate for generation."
        },
        {
          id: "generator",
          label: "🎭 Generator",
          inputs: ["Markdown file(s) under specs/ (include each path from conventions.generatedThisRun.plannerMarkdown in context)"],
          outputs: ["Executable Playwright tests under tests/ (e.g. tests/.../*.spec.ts), aligned with the plan"],
          goal: "Implement or update tests from the plan; verify selectors and assertions against the live app via MCP."
        },
        {
          id: "healer",
          label: "🎭 Healer",
          inputs: ["Failing test name(s) after Generator runs"],
          outputs: ["Passing tests, or skipped tests with rationale if product behavior is broken"],
          goal: "Replay failing steps, inspect UI, propose patches (locators, waits, data), re-run until green or guardrails stop."
        }
      ],
      order: ["planner", "generator", "healer"]
    },
    cursorAgentMust: [
      "If layout is playwright-agents: ensure initAgents.command was applied in projectRepo when definitions are missing; include tests/seed.spec.ts in Planner/Generator context.",
      "Planner: use userStories + seed; write or refine specs/*.md under projectRepo.",
      "Generator: for each markdown plan in conventions.generatedThisRun.plannerMarkdown (or all specs/*.md), produce tests under tests/ via MCP.",
      "Healer: run failing generated tests; fix or skip with explanation.",
      "Read this JSON, invoke Playwright MCP (mcpServerId / mcpCommand) per docsUrl; summarize each phase: inputs, artifacts, risks."
    ],
    baseUrl: payload.baseUrl || "",
    projectRepo: payload.projectRepo,
    generatedSpecs: payload.generatedSpecs || [],
    userStories: payload.userStories || [],
    generatedAt: new Date().toISOString()
  };
  await fs.writeJson(file, body, { spaces: 2 });
  return file;
}

async function writeK6Handoff(dir, payload) {
  await fs.ensureDir(dir);
  const file = path.join(dir, "k6-mcp.json");
  const baseUrl = payload.baseUrl || process.env.BASE_URL || "";
  const mcpRunDefaults = payload.mcpRunDefaults || { vus: 5, duration: "2m" };
  const mcpRunByMode = payload.mcpRunByMode || {};
  const primaryScripts = payload.primaryScripts || [];
  const soakEntry = primaryScripts.find(s => s.mode === "soak");
  const scriptDirectory = payload.scriptDirectory || "tests/performance-testing";
  const k6EnvRelativePath =
    payload.k6EnvRelativePath || `${String(scriptDirectory).replace(/\\/g, "/")}/k6.env`;

  const body = {
    mcpServerId: payload.mcpServerId || "k6",
    mcpCommand: payload.mcpCommand || "mcp-k6",
    projectRepo: payload.projectRepo || "",
    scriptDirectory,
    baseUrl,
    k6EnvRelativePath,
    localK6RunHint: `In projectRepo, cd to ${scriptDirectory} and run: set -a && . ./k6.env && set +a; export K6_LOGIN_EMAIL=... K6_LOGIN_PASSWORD=... if scripts use login; k6 run ./<mode>_test.js (BASE_URL from performance.baseUrl at generation time).`,
    primaryScripts,
    mcpRunDefaults,
    mcpRunByMode,
    soakScript: soakEntry
      ? { relativePath: soakEntry.relativePath, absolutePath: soakEntry.absolutePath }
      : primaryScripts[0]
        ? {
            relativePath: primaryScripts[0].relativePath,
            absolutePath: primaryScripts[0].absolutePath,
            note: "legacy single-script shape; prefer primaryScripts[]"
          }
        : {},
    k6McpWorkflow: buildK6McpWorkflow({
      primaryScripts,
      baseUrl,
      mcpRunDefaults,
      mcpRunByMode
    }),
    cursorAgentMust: [
      "Execute k6McpWorkflow.steps using the k6 MCP server for every entry in primaryScripts (load, soak, stress, spike as generated).",
      "Do not ask the user to run MCP manually; run tools and report outcomes."
    ],
    userStories: payload.userStories || [],
    generatedAt: new Date().toISOString()
  };
  await fs.writeJson(file, body, { spaces: 2 });
  return file;
}

module.exports = { writePlaywrightHandoff, writeK6Handoff, buildK6McpWorkflow, mergeK6RunForMode };
