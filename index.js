require("dotenv").config();
const path = require("path");
const fs = require("fs-extra");
const { loadUserStories, storiesFromEpicsManifest } = require("./lib/userStories");
const { loadAgentConfig, defaultConfigPath } = require("./lib/agentConfig");
const { runUnitTestAgent } = require("./agents/unitTestAgent");
const { runIntegrationTestAgent } = require("./agents/integrationTestAgent");
const { runPerformanceTestAgent } = require("./agents/performanceTestAgent");

function parseArgs(argv) {
  const args = {
    help: false,
    configPath: null,
    agent: null
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("--config=")) args.configPath = a.split("=").slice(1).join("=").trim();
    else if (a.startsWith("--agent=")) args.agent = a.split("=")[1].trim().toLowerCase();
  }
  return args;
}

function printHelp() {
  console.log(`
AI test bot — config-driven (JSON). Integration/UI and performance use your Cursor MCP servers.

Usage:
  node index.js [--config=./agent.config.json] [--agent=unit|integration|performance|all]

Paths, stories, MCP execution mode, and URLs live in agent.config.json (see agent.config.example.json).
Override ~/.cursor/mcp.json server names under "mcp" if yours differ.

Environment:
  OPENAI_API_KEY (required), OPENAI_MODEL, AGENT_CONFIG (default config path), BASE_URL
`);
}

async function loadSelectedManifest(selectedFilesPath) {
  const full = path.isAbsolute(selectedFilesPath) ? selectedFilesPath : path.resolve(selectedFilesPath);
  if (!(await fs.pathExists(full))) {
    throw new Error(`selected files manifest not found: ${full}`);
  }
  return fs.readJson(full);
}

async function main() {
  const cli = parseArgs(process.argv);
  if (cli.help) {
    printHelp();
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY.");
    process.exit(1);
  }

  const cfgPath = cli.configPath || defaultConfigPath(process.argv, __dirname);
  const cfg = await loadAgentConfig(cfgPath);
  const agent = (cli.agent || cfg.agent || "all").toLowerCase();

  const projectRepo = path.resolve(cfg.projectRepo);
  if (!(await fs.pathExists(projectRepo))) {
    console.error(`projectRepo not found: ${projectRepo}`);
    process.exit(1);
  }

  const nodeModulesPath = path.join(projectRepo, "node_modules");
  if (!(await fs.pathExists(nodeModulesPath))) {
    console.warn(`Warning: node_modules missing under ${projectRepo}.`);
  }

  const selectedFiles = await loadSelectedManifest(cfg.selectedFilesPath);

  let stories;
  if (cfg.userStoriesPath) {
    if (!(await fs.pathExists(cfg.userStoriesPath))) {
      console.error(`User stories file not found: ${cfg.userStoriesPath}`);
      process.exit(1);
    }
    stories = await loadUserStories(cfg.userStoriesPath);
  } else {
    stories = storiesFromEpicsManifest(selectedFiles);
    if (!stories.length) {
      console.error(
        "No user stories: set paths.userStories in agent.config.json (or add epics to the selected-files manifest)."
      );
      process.exit(1);
    }
    console.log("[info] Using epics from the selected-files manifest as user stories.");
  }

  if (!["unit", "integration", "performance", "all"].includes(agent)) {
    console.error(`Unknown agent: ${agent}`);
    process.exit(1);
  }

  const common = { projectRepo, selectedFiles, stories };
  const output = { mcpHandoffDir: cfg.output.mcpHandoffDir };

  if (agent === "unit" || agent === "all") {
    console.log("\n=== Unit testing agent ===\n");
    await runUnitTestAgent({
      ...common,
      autoFix: cfg.unit.autoFix,
      maxFixRounds: cfg.unit.maxFixRounds,
      demoInjectFailingAssertion: cfg.unit.demoInjectFailingAssertion
    });
  }

  if (agent === "integration" || agent === "all") {
    console.log("\n=== Integration / UI agent ===\n");
    await runIntegrationTestAgent({
      ...common,
      integration: cfg.integration,
      output
    });
  }

  if (agent === "performance" || agent === "all") {
    console.log("\n=== Performance agent ===\n");
    await runPerformanceTestAgent({
      projectRepo,
      stories,
      performance: cfg.performance,
      output
    });
  }
}

module.exports = { main, parseArgs };

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
