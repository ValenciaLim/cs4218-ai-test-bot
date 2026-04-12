const path = require("path");
const fs = require("fs-extra");

const DEFAULT_CONFIG = "agent.config.json";

function resolveFromConfigDir(configDir, p) {
  if (!p) return "";
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.resolve(configDir, p);
}

/**
 * Load bot config. Paths in JSON are relative to the config file's directory.
 */
async function loadAgentConfig(configPath) {
  const abs = path.isAbsolute(configPath) ? configPath : path.resolve(configPath);
  if (!(await fs.pathExists(abs))) {
    throw new Error(`Config not found: ${abs}. Copy agent.config.example.json to agent.config.json.`);
  }
  const raw = await fs.readJson(abs);
  const dir = path.dirname(abs);

  const paths = raw.paths || {};
  const projectRepo = resolveFromConfigDir(dir, paths.projectRepo || raw.projectRepo || "");
  if (!projectRepo) {
    throw new Error('agent.config.json: set paths.projectRepo to your target repository.');
  }
  const userStoriesPath = resolveFromConfigDir(dir, paths.userStories || raw.userStories || "");
  const selectedFilesPath = resolveFromConfigDir(
    dir,
    paths.selectedFiles || raw.selectedFiles || path.join(dir, "selectedFiles.json")
  );

  const mcp = raw.mcp || {};
  const playwrightMcp = mcp.playwright || {};
  const k6Mcp = mcp.k6 || {};

  const integration = {
    ...(raw.integration || {}),
    executor: ((raw.integration || {}).executor || "mcp").toLowerCase(),
    baseUrl: (raw.integration && raw.integration.baseUrl) || process.env.BASE_URL || "",
    playwrightServerId: playwrightMcp.serverId || "Playwright",
    playwrightCommand: playwrightMcp.command || "npx @playwright/mcp@latest",
    layout: String((raw.integration && raw.integration.layout) || "playwright-agents").toLowerCase(),
    initAgentsLoop: (raw.integration && raw.integration.initAgentsLoop) || "vscode",
    runInitAgents: !!(raw.integration && raw.integration.runInitAgents),
    overwriteSeed: !!(raw.integration && raw.integration.overwriteSeed),
    runPlaywrightInstall: (raw.integration || {}).runPlaywrightInstall !== false
  };

  const performance = {
    ...(raw.performance || {}),
    executor: ((raw.performance || {}).executor || "mcp").toLowerCase(),
    baseUrl: (raw.performance && raw.performance.baseUrl) || process.env.BASE_URL || "",
    modes: (Array.isArray(raw.performance && raw.performance.modes) && raw.performance.modes.length
      ? raw.performance.modes
      : ["load"]),
    k6ServerId: k6Mcp.serverId || "k6",
    k6Command: k6Mcp.command || "mcp-k6",
    scriptDirectory: (raw.performance && raw.performance.scriptDirectory) || "tests/performance-testing",
    mcpRunByMode: (raw.performance && raw.performance.mcpRunByMode) || {},
    mcpRunDefaults: {
      vus: 5,
      duration: "2m",
      ...((raw.performance && raw.performance.mcpRunDefaults) || {})
    },
    /** Minimum ~wall-clock seconds for generated k6 scripts (stages sum); dashboard-friendly */
    k6MinScenarioDurationSeconds: Math.max(
      30,
      parseInt(
        String(
          (raw.performance && raw.performance.k6MinScenarioDurationSeconds != null
            ? raw.performance.k6MinScenarioDurationSeconds
            : 120) || "120"
        ),
        10
      ) || 120
    ),
    /** Written into projectRepo k6.env for load scripts (override in agent.config.json). */
    k6LoginEmail: String((raw.performance && raw.performance.k6LoginEmail) ?? "admin@admin.com"),
    k6LoginPassword: String((raw.performance && raw.performance.k6LoginPassword) ?? "admin")
  };

  const unit = {
    ...(raw.unit || {}),
    autoFix: !!(raw.unit && raw.unit.autoFix),
    maxFixRounds: Math.max(1, parseInt((raw.unit && raw.unit.maxFixRounds) || "1", 10) || 1),
    demoInjectFailingAssertion: !!(raw.unit && raw.unit.demoInjectFailingAssertion)
  };

  const output = {
    mcpHandoffDir: resolveFromConfigDir(dir, (raw.output && raw.output.mcpHandoffDir) || "./mcp-handoff")
  };

  return {
    configPath: abs,
    configDir: dir,
    agent: (raw.agent || "all").toLowerCase(),
    projectRepo,
    userStoriesPath,
    selectedFilesPath,
    mcp: { playwright: playwrightMcp, k6: k6Mcp },
    integration,
    performance,
    unit,
    output,
    raw
  };
}

function defaultConfigPath(argv, cwd) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--config=")) return a.split("=").slice(1).join("=").trim();
  }
  if (process.env.AGENT_CONFIG) return process.env.AGENT_CONFIG;
  return path.join(cwd, DEFAULT_CONFIG);
}

module.exports = { loadAgentConfig, defaultConfigPath, DEFAULT_CONFIG };
