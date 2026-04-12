# CS4218 AI Test Bot

Config-driven Node tool that uses the OpenAI API to generate **Jest unit tests**, **Playwright integration / planner artifacts**, and **k6 performance scripts** in a target app repository (`projectRepo`). It writes **MCP handoff JSON** next to your config so a **Cursor** session (with Playwright and k6 MCP servers) can run tests and iterate using `.cursor/rules/mcp-test-orchestration.mdc`.

Plain `node` does **not** speak MCP over stdio; generation and handoff live here, MCP execution is intended for Cursor.

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

- **`integration.layout`**: **`playwright-agents`** (default) writes planner markdown under **`projectRepo/specs/`**, ensures **`projectRepo/tests/seed.spec.ts`**, and prepares Playwright MCP handoff. **`legacy`** writes **`projectRepo/__tests__/integration/*.spec.js`** and runs static review + LLM review on generated specs.
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
