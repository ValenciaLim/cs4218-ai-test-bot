# CS4218 AI Test Bot

Config-driven Node tool that uses the **OpenAI API** (not MCP) to generate **Jest unit tests**, **Playwright integration artifacts** (`specs/*.md`, `tests/*.spec.js` in the default layout), and **k6 scripts** in a target app repository (`projectRepo`). It writes **MCP handoff JSON** so a **Cursor** session—with **Playwright** and **k6** MCP servers configured—can **validate, run, explore the UI, and heal** tests using `.cursor/rules/mcp-test-orchestration.mdc`.

**Important:** `node index.js` does **not** call Playwright or k6 MCP to *author* those files; MCP is for the **IDE agent** after handoff. Adding an MCP client inside Node (e.g. stdio to `mcp-k6`) would be a separate feature if you want generation to go through MCP instead of OpenAI directly.

## Prerequisites

- Node.js (LTS)
- `OPENAI_API_KEY` in the environment (or in a `.env` file at the repo root; `dotenv` is loaded by `index.js`)

## Setup

```bash
npm install
cp agent.config.example.json agent.config.json
```

Edit **`agent.config.json`**: set **`paths.projectRepo`** to your app repo (path is relative to the config file unless absolute), **`paths.userStories`** (or rely on **`paths.selectedFiles`** epics), and integration/performance URLs as needed.

## Usage

```bash
node index.js [--config=./agent.config.json] [--agent=unit|integration|performance|all]
```

Default agent comes from **`agent`** in the JSON; default config path is **`./agent.config.json`** or **`AGENT_CONFIG`** if set.

```bash
node index.js --help
```

## Step-by-step guides

Do **one-time prep** once, then open the agent you need. Each subsection has **terminal** commands (adjust paths) and **Cursor prompts** you can paste so the agent uses Playwright / k6 MCP with the handoff files (see **`.cursor/rules/mcp-test-orchestration.mdc`**).

### One-time prep (every machine)

**Terminal — bot repo**

```bash
cd /path/to/cs4218-ai-test-bot
npm install
cp agent.config.example.json agent.config.json
```

Edit **`agent.config.json`**: **`paths.projectRepo`**, **`paths.userStories`** (or epics inside **`selectedFiles`**), **`paths.selectedFiles`**, **`integration.baseUrl`**, **`performance.baseUrl`**, and **`mcp.playwright` / `mcp.k6`** so server ids match **`~/.cursor/mcp.json`**.

**Terminal — OpenAI API key**

```bash
# Option A: .env in the bot repo (loaded by index.js)
echo 'OPENAI_API_KEY=sk-...' >> .env

# Option B: current shell only
export OPENAI_API_KEY='sk-...'
```

**Terminal — run any agent (from bot repo)**

```bash
cd /path/to/cs4218-ai-test-bot
node index.js --config=./agent.config.json --agent=unit
# integration | performance | all
# omit --agent to use the "agent" field in agent.config.json
```

**Cursor — MCP**

Configure **Playwright** and **k6** in **`~/.cursor/mcp.json`**, then reload Cursor.

---

### Unit agent

<<<<<<< Updated upstream
1. Confirm **`paths.projectRepo`** points at the repo that already has **`node_modules`** and your source files under test.
2. In **`selectedFiles.json`**, list **`backend`** file paths and function names (and **`frontend`** if you use them for context). Add **`epics`** keyed by file path if you are not using a separate **`userStories`** file.
3. In your user stories (file or epics), use **`testFor`** values that include **`unit`** if you want only unit-relevant stories; otherwise the unit agent still runs with the stories it receives when you pass **`--agent=unit`**.
4. Optionally tune **`unit.autoFix`**, **`unit.maxFixRounds`**, and **`unit.demoInjectFailingAssertion`** in **`agent.config.json`**.
5. Run **`node index.js --agent=unit`** (or **`--agent=all`**).
6. Open **`projectRepo`** and inspect new or updated **`*.test.js`** files next to the targeted modules (or as configured by the generator). Run **`npm test`** or **`npx jest`** in **`projectRepo`** to execute them.
=======
**Config:** **`paths.projectRepo`** has **`node_modules`**; **`selectedFiles.json`** lists **`backend`** (and optional **`frontend`** / **`epics`**).

**Terminal — generate**

```bash
cd /path/to/cs4218-ai-test-bot
node index.js --config=./agent.config.json --agent=unit
```

**Terminal — run Jest in the app**

```bash
cd /path/to/your-app-repo
npm test
# or: npx jest
```

**Cursor — prompts (optional)**

```text
Summarize which *.test.js files changed under my app repo after the unit agent run. I will paste `npm test` output next.
```

```text
Fix only the test file at <path>: here is the Jest failure output: <paste>
```
>>>>>>> Stashed changes

---

### Integration agent (default: `playwright-agents`)

<<<<<<< Updated upstream
1. Set **`integration.baseUrl`** in **`agent.config.json`** to the URL of a running app (for example **`http://localhost:3001`**).
2. Ensure **`projectRepo`** has **`@playwright/test`** in **`package.json`** if you want **`integration.runPlaywrightInstall`** to install browsers.
3. Run **`node index.js --agent=integration`**.
4. In **`projectRepo`**, you should see **`specs/*.md`** planner output and **`tests/seed.spec.ts`** (created or updated per **`integration.overwriteSeed`**).
5. In this bot repo, open **`mcp-handoff/playwright-mcp.json`** after the run. In **Cursor**, use the Playwright MCP and the rule in **`.cursor/rules/mcp-test-orchestration.mdc`**: Planner → Generator → Healer using that handoff (**`integration.executor`** **`mcp`** means Node did not run full suites for you).
6. If you set **`integration.executor`** to **`cli`** or **`both`**, Node will also run **`npx playwright test`** for the seed (and in **`legacy`** layout, per generated spec) from **`projectRepo`**; fix failures or use Healer in Cursor.

**Legacy layout (`integration.layout`: `legacy`):** output goes under **`projectRepo/__tests__/integration/`** as **`*.spec.js`**. Static review and an LLM review run on each generated file before handoff.
=======
**Config:** **`integration.baseUrl`** = running app (e.g. **`http://localhost:3001`**). **`integration.layout`**: **`playwright-agents`** or **`legacy`**.

**Terminal — generate + handoff**

```bash
cd /path/to/cs4218-ai-test-bot
node index.js --config=./agent.config.json --agent=integration
```

**Terminal — app repo (first-time Playwright)**

```bash
cd /path/to/your-app-repo
npm install
npx playwright install
```

**Terminal — Test Agent definitions (once per app / after @playwright/test upgrades)**

```bash
cd /path/to/your-app-repo
npx playwright init-agents --loop=vscode
```

**Terminal — optional local Playwright** (if **`integration.executor`** is **`cli`** or **`both`**, Node may already have run some tests)

```bash
cd /path/to/your-app-repo
npx playwright test tests/seed.spec.ts
npx playwright test tests/Your_Story_Name.spec.js
```

**Cursor — prompts** (after **`mcp-handoff/playwright-mcp.json`** exists; use a chat where this repo’s rules apply)

```text
Read mcp-handoff/playwright-mcp.json, then execute the Playwright MCP handoff per .cursor/rules/mcp-test-orchestration.mdc: Planner (explore baseUrl with seed context), Generator (align tests under tests/ with specs/*.md), Healer (fix failing Playwright tests). Summarize each phase.
```

```text
Run Playwright MCP using baseUrl from mcp-handoff/playwright-mcp.json. Open tests/seed.spec.ts and the generated tests/*.spec.js; fix locators and assertions until npx playwright test would pass, and list files you changed.
```

```text
Read specs/*.md paths from generatedSpecs in playwright-mcp.json, refine the markdown with MCP snapshots from the live app, then update the matching tests/*.spec.js files.
```

**Legacy (`integration.layout`: `legacy`)** — same **`node index.js --agent=integration`**; outputs **`projectRepo/__tests__/integration/<StoryName>.spec.js`**. Use the same style of prompts but reference **`__tests__/integration`** instead of **`specs/`** + **`tests/*.spec.js`**.
>>>>>>> Stashed changes

---

### Performance agent

**Config:** **`performance.baseUrl`**, optional **`k6LoginEmail`** / **`k6LoginPassword`**, **`scriptDirectory`**, **`modes`**.

**Terminal — generate scripts + k6.env + handoff**

```bash
cd /path/to/cs4218-ai-test-bot
node index.js --config=./agent.config.json --agent=performance
```

**Terminal — run k6 locally** (API must match **`BASE_URL`** in **`k6.env`**)

```bash
cd /path/to/your-app-repo/tests/performance-testing
set -a && . ./k6.env && set +a
k6 run ./load_test.js
# soak_test.js, stress_test.js, spike_test.js as generated
# optional: K6_WEB_DASHBOARD=true k6 run ./load_test.js
```

If **`performance.executor`** is **`cli`** or **`both`**, **`node index.js --agent=performance`** also runs **`k6 run`** for each script when **`k6`** is on **`PATH`**.

**Cursor — prompts** (after **`mcp-handoff/k6-mcp.json`** exists)

```text
Read mcp-handoff/k6-mcp.json, then run k6McpWorkflow.steps in order using the k6 MCP: validate every primaryScripts entry, then run each with merged mcpRunByMode[mode] over mcpRunDefaults, using baseUrl as BASE_URL. Summarize validation errors, run exit codes, threshold pass/fail, and the best-practices gap list.
```

```text
Use k6 MCP validate_script on each primaryScripts file from mcp-handoff/k6-mcp.json and report syntax/setup issues before I run k6 locally.
```

<<<<<<< Updated upstream
=======
---

### Run everything (`all`)

**Terminal**

```bash
cd /path/to/cs4218-ai-test-bot
node index.js --config=./agent.config.json --agent=all
```

**Cursor — single prompt for both handoffs**

```text
Read mcp-handoff/playwright-mcp.json and mcp-handoff/k6-mcp.json. Execute the Playwright MCP handoff per .cursor/rules/mcp-test-orchestration.mdc, then execute k6McpWorkflow.steps with the k6 MCP. Summarize integration and performance outcomes separately.
```

---

>>>>>>> Stashed changes
## Environment variables

| Variable | Role |
|----------|------|
| `OPENAI_API_KEY` | Required for API calls |
| `OPENAI_MODEL` | Optional (default `gpt-4`) |
| `OPENAI_CONCURRENCY` | Optional max concurrent requests (default `3`) |
| `AGENT_CONFIG` | Optional default path to `agent.config.json` |
| `BASE_URL` | Optional fallback when config omits integration/performance base URLs |

## What each agent does

All writable paths under **`paths.projectRepo`** are **outside** this repo unless you point `projectRepo` here (not recommended).

### Unit (`--agent=unit`)

- Uses **`selectedFiles.json`** (see **`paths.selectedFiles`**) and user stories to target backend files / functions.
- Generates or updates **Jest** tests under `projectRepo`. Optional **`unit.autoFix`** loop runs Jest and asks the model for fixes.

### Integration (`--agent=integration`)

- **`integration.layout`**: **`playwright-agents`** (default) writes planner markdown under **`projectRepo/specs/`**, then **Generator (LLM)** writes **`projectRepo/tests/<StoryName>.spec.js`** from each plan, ensures **`projectRepo/tests/seed.spec.ts`**, and prepares Playwright MCP handoff. **`legacy`** writes **`projectRepo/__tests__/integration/*.spec.js`** and runs static review + LLM review on generated specs.
- **`integration.executor`**: **`mcp`** (default) skips local Playwright CLI except optional seed install; **`cli`** / **`both`** can run `npx playwright test` from `projectRepo` when configured.

### Performance (`--agent=performance`)

- Writes **`{mode}_test.js`** under **`projectRepo/<performance.scriptDirectory>/`** (modes from user story **`testFor`** or **`performance.modes`**).
- Writes **`k6.env`** there with **`BASE_URL`**, **`K6_LOGIN_EMAIL`**, and **`K6_LOGIN_PASSWORD`** (defaults configurable via **`performance.k6LoginEmail`** / **`k6LoginPassword`**).
- **`performance.executor`**: **`mcp`** only generates files + handoff; run k6 yourself after `set -a && . ./k6.env && set +a` in that directory, or use Cursor k6 MCP from **`mcp-handoff/k6-mcp.json`**. **`cli`** / **`both`** runs **`k6 run`** locally when `k6` is on `PATH`.

## User stories and `testFor`

Stories may include **`testFor`** tokens to scope agents (e.g. `integration`, `performance`, `load`). See **`docs/IMPLEMENTATION_MCP.md`** for the alias table. Omit **`testFor`** or use broad tokens so **`--agent=all`** includes every agent.

## MCP handoff and Cursor

After a run, **`mcp-handoff/`** (or **`output.mcpHandoffDir`**) contains **`playwright-mcp.json`** and **`k6-mcp.json`**. Keep **`.cursor/rules/`** committed so clones get the same orchestration rule.

Details: **`docs/IMPLEMENTATION_MCP.md`**.

## Safety

- **`paths.projectRepo`** must be the repository that should receive generated tests, specs, and k6 files. Wrong path means writes go to the wrong tree.
- **`k6.env`** can contain dev credentials; treat it like secrets in shared repos (override in config, add to the app repo’s `.gitignore` if needed).

## Troubleshooting

- **Config not found**: copy **`agent.config.example.json`** to **`agent.config.json`** next to **`index.js`** (or pass **`--config=`**).
- **`projectRepo not found`**: fix **`paths.projectRepo`** to an existing directory (resolve paths relative to the config file’s directory).
- **OpenAI errors**: verify **`OPENAI_API_KEY`**, **`OPENAI_MODEL`**, and network access.

## Implementation notes

- **`utils/fileUtils.js`** uses **Acorn** to extract functions for unit-test context.
- OpenAI calls use a small concurrency limit and retries for transient failures.
