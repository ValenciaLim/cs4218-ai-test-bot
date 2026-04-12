# MCP: Node vs Cursor

## What `node index.js` does

- **Generates** Playwright specs under `projectRepo/__tests__/integration/`.
- **Generates** one k6 script per configured **mode** under **`projectRepo/<performance.scriptDirectory>/`** as **`{mode}_test.js`** (e.g. `load_test.js`, `soak_test.js`, `stress_test.js`, `spike_test.js`). Modes come from **`performance.modes`** (subset of: `load`, `soak`, `stress`, `spike`). It also writes **`k6.env`** in that folder with **`export BASE_URL=...`** from **`performance.baseUrl`** (or env / default) so you can **`source`** it before manual **`k6 run`** in the project repo.
- Writes **`mcp-handoff/playwright-mcp.json`** and **`mcp-handoff/k6-mcp.json`** with **`primaryScripts[]`**, **`mcpRunByMode`**, **`playwrightTestAgents`**, and **`k6McpWorkflow.steps`** for k6 MCP (`validate_script`, `run_script`, `list_sections`, `get_documentation`, resource `docs://k6/best_practices`).

It does **not** call MCP over stdio/HTTP — that is not available from plain Node in this design.

## What the Cursor agent must do

Project rule **`.cursor/rules/mcp-test-orchestration.mdc`** (`alwaysApply: true`) tells the **Cursor agent** to:

1. **Integration / UI** — After handoff exists or updates, use the **Playwright** MCP server and the **Playwright Test Agents** workflow ([docs](https://playwright.dev/docs/test-agents)): **🎭 Planner → 🎭 Generator → 🎭 Healer**, using `baseUrl`, `userStories`, and `generatedSpecs` from `playwright-mcp.json`. The agent runs MCP tools; it does not ask the user to do so manually.

2. **Performance** — After handoff exists or updates, use the **k6** MCP server and execute **`k6McpWorkflow.steps`** for **every** entry in **`primaryScripts`** (validate → run with merged `mcpRunByMode` / `mcpRunDefaults` → docs → best-practices gap analysis).

## User story `testFor`

| Token / alias | Agent |
|-----------------|--------|
| `unit`, `unittest`, `jest` | Unit (Jest) |
| `integration`, `ui`, `e2e`, `playwright`, `system` | Integration / UI |
| `performance`, `load`, `k6`, `soak`, `spike`, `stress`, `perf` | Performance (k6) |

Omit `testFor`, or use `all` / `*`, for every agent.

## `~/.cursor/mcp.json` server ids

| Server id   | Command                      |
|------------|------------------------------|
| `Playwright` | `npx @playwright/mcp@latest` |
| `k6`       | `mcp-k6`                     |

If tool names differ on your k6 MCP build, the Cursor agent should read the tool schema once and map equivalents, then continue.

## Config snippets

**`performance.scriptDirectory`** (default `tests/performance-testing`) — folder under `projectRepo` for `{mode}_test.js` files.

**`performance.modes`** — fallback when no user story `testFor` names a concrete k6 mode (`load`, `soak`, `stress`, `spike`). If any perf-scoped story includes those tokens, **only that union** of modes is generated (e.g. `testFor: "stress"` → `stress_test.js` only).

**`performance.mcpRunDefaults`** — default `{ "vus": 5, "duration": "2m" }` for MCP run instructions.

**`performance.mcpRunByMode`** — optional overrides per mode, e.g. `{ "spike": { "vus": 100, "duration": "1m" }, "load": { "vus": 20, "duration": "3m" } }`.

**`performance.k6MinScenarioDurationSeconds`** (default **120**) — passed into k6 script generation so stage durations sum to a **minimum wall time** (operators using `K6_WEB_DASHBOARD=true` can open the UI before the run ends). Increase (e.g. **180**–**300**) for longer dashboards.

**`performance.executor`** — **`mcp`** (default) only writes scripts, **`k6.env`**, and handoff; run k6 via Cursor MCP or manually (see **`k6EnvRelativePath`** / **`localK6RunHint`** in **`k6-mcp.json`**). **`cli`** or **`both`** runs **`k6 run`** locally after each script when **`k6`** is on `PATH`, using the merged **vus / duration** from **`mcpRunByMode`** / **`mcpRunDefaults`**.

**`integration.baseUrl`** — app URL for Planner / Generator / Healer.

## Run

```bash
node index.js --agent=integration
node index.js --agent=performance
```

Then continue in **the same Cursor chat** (or a follow-up) so the agent applies **`mcp-test-orchestration`** and invokes MCP tools using the handoff files.
