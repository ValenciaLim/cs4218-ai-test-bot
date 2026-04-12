require("dotenv").config();
const fs = require("fs-extra");
const path = require("path");
const { writeFile, ensureTestFile, extractFunctions, readFile } = require("./utils/fileUtils");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Simple retry helper with exponential backoff
async function retry(fn, attempts = 3, baseDelay = 500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const delay = baseDelay * Math.pow(2, i) + Math.floor(Math.random() * 100);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Concurrency-limited queue for OpenAI requests
const MAX_CONCURRENCY = parseInt(process.env.OPENAI_CONCURRENCY || "3", 10) || 3;
let _active = 0;
const _queue = [];

function _processQueue() {
  if (_active >= MAX_CONCURRENCY) return;
  const item = _queue.shift();
  if (!item) return;
  _active++;
  (async () => {
    try {
      const res = await item.task();
      item.resolve(res);
    } catch (e) {
      item.reject(e);
    } finally {
      _active--;
      _processQueue();
    }
  })();
}

function enqueueOpenAI(task) {
  return new Promise((resolve, reject) => {
    _queue.push({ task, resolve, reject });
    _processQueue();
  });
}

async function sendChatCompletion(params) {
  return enqueueOpenAI(() => openai.chat.completions.create(params));
}

// Generate AI-powered user story from code
async function generateUserStory(code, filePath) {
  const prompt = `Please respond with a JSON object containing keys: title, description, sprint (optional), epic (optional), priority (optional), points (optional), assignee (optional).\nAnalyze the following JavaScript/React code and generate appropriate values.\n\nCode:\n${code}`;

  const call = async () => {
    const completion = await sendChatCompletion({
      model: process.env.OPENAI_MODEL || "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    });
    const text = (completion.choices?.[0]?.message?.content || "").trim();
    // Try parse JSON, fallback to naive split
    try {
      const parsed = JSON.parse(text);
      return {
        title: parsed.title || "Auto-generated Story",
        description: parsed.description || parsed.desc || "",
        sprint: parsed.sprint || "",
        epic: parsed.epic || "",
        priority: parsed.priority || "",
        points: parsed.points || "",
        assignee: parsed.assignee || ""
      };
    } catch (e) {
      const [titleLine, ...descLines] = text.split("\n");
      return { title: titleLine || "Auto-generated Story", description: descLines.join("\n") };
    }
  };

  return retry(call, 3, 500);
}

// Generate Jest unit tests for a file
async function generateUnitTest(filePath, code, extraInfo = {}) {
  const functions = extraInfo.functions || extractFunctions(code, extraInfo.functions || []);
  // If file looks like a React component (contains JSX), produce a deterministic
  // React Testing Library test locally instead of relying on the LLM. This
  // yields consistent, useful tests for simple components that render static
  // content.
  const looksLikeJSX = /<[^>]+>/.test(code) && /return\s*\(/.test(code);
  if (looksLikeJSX && functions.length === 0) {
    // Extract some visible text snippets from JSX to assert on
    const snippets = new Set();
    const textRegex = />\s*([^<>\n]{3,200}?)\s*</g;
    let m;
    while ((m = textRegex.exec(code)) && snippets.size < 3) {
      const text = m[1].trim();
      if (text && !/^\{/.test(text)) snippets.add(text);
    }

    const texts = Array.from(snippets);
    const compImportPath = filePath.replace(/\\\\/g, '/');

    const testLines = [];
    testLines.push("import React from 'react';");
    testLines.push("import { render, screen } from '@testing-library/react';");
    testLines.push("import '@testing-library/jest-dom/extend-expect';");
    testLines.push(`import Component from '${compImportPath.replace(/^.*?\/(.*)$/,'./$1')}';`);
    testLines.push("");
    testLines.push("describe('Component render', () => {");
    testLines.push("  it('renders without crashing and displays expected static text', () => {");
    testLines.push("    render(<Component />);");
    for (const t of texts) {
      testLines.push(`    expect(screen.getByText(/${escapeRegExp(t)}/i)).toBeInTheDocument();`);
    }
    if (texts.length === 0) {
      testLines.push("    // No obvious static text found; verify it renders by querying the root element");
      testLines.push("    expect(document.body).toBeDefined();");
    }
    testLines.push("  });");
    testLines.push("});");

    return testLines.join('\n');
  }

  const us = extraInfo.userStory || {};
  const storyBlock =
    us && (us.title || us.description || us.testFor)
      ? `
User story (guide scenarios and edge cases; use Given-When-Then in test names where helpful):
Title: ${us.title || ""}
Type: ${us.type || ""}
Priority: ${us.priority || ""}
Test for: ${us.testFor || "(not specified — treat as general unit scope)"}
Description: ${us.description || ""}
`
      : "";

  const prompt = `
Generate real Jest unit test templates for the following code file: ${filePath}.
Use AAA (Arrange-Act-Assert) and Given-When-Then style in describe/it names.
Test functions in isolation, cover happy path and meaningful edge cases (null, empty, boundaries) implied by the user story.
Include missing functions as skeleton tests only if necessary.
Output a single complete test file body (imports + tests), no markdown fences.

${storyBlock}
Code:
${code}
Functions to test: ${functions.join(", ")}
`;

  const call = async () => {
    const completion = await sendChatCompletion({
      model: process.env.OPENAI_MODEL || "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    });
    return (completion.choices?.[0]?.message?.content || "").trim();
  };

  const raw = await retry(call, 3, 500);
  return extractFirstCodeBlock(raw);
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Write tests to the correct repo location
async function writeUnitTests(sourceRepoPath, filePath, testContent, backendFunctions = []) {
  const relativePath = path.relative(sourceRepoPath, filePath);
  const testFilePath = backendFunctions.length
    ? backendFunctions.map(fn => path.join(sourceRepoPath, path.dirname(relativePath), `${fn}.test.js`))
    : [path.join(sourceRepoPath, relativePath.replace(/\.js$/, ".test.js"))];
  const created = [];
  for (const tf of testFilePath) {
    await ensureTestFile(tf);
    await writeFile(tf, testContent);
    created.push(tf);
  }

  return created;
}

// Generate Playwright-based integration/UI tests for a file
async function generateIntegrationUITest(filePath, code, extraInfo = {}) {
  const userStory = extraInfo.userStory || {};
  const prompt = `
You are an expert QA engineer. Generate Playwright Test specs using @playwright/test for file: ${filePath}.
Downstream work may follow Playwright Test Agents (🎭 Planner → Generator → Healer); keep specs clear and selector-friendly for MCP-driven healing.
Import: const { test, expect } = require('@playwright/test');
Use the user story context below to guide scenarios and assertions.
Avoid excessive mocking; prefer real navigation and UI state. Add deep assertions (visible text, roles, URLs, network where appropriate), not only toBeTruthy.
Use AAA / Given-When-Then style in test titles.

User Story:
Title: ${userStory.title || ''}
Type: ${userStory.type || ''}
Priority: ${userStory.priority || ''}
Test for: ${userStory.testFor || ''}
Description: ${userStory.description || ''}

Code:
${code}
`;

  const call = async () => {
    const completion = await sendChatCompletion({
      model: process.env.OPENAI_MODEL || "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    });
    return (completion.choices?.[0]?.message?.content || "").trim();
  };

  const rawInt = await retry(call, 3, 500);
  return extractFirstCodeBlock(rawInt);
}

/** Remove a single outer ```fence``` wrapper if the model wrapped the whole reply */
function stripOuterMarkdownFence(text) {
  let s = String(text || "").trim();
  const m = /^```(?:\w+)?\s*([\s\S]*?)```\s*$/m.exec(s);
  return m ? m[1].trim() : s;
}

/**
 * Playwright Test Agents — Planner output: human-readable markdown plan for specs/*.md
 * (Generator consumes this; Healer fixes resulting tests).
 */
async function generatePlannerSpecMarkdown({
  samplePath,
  codeSnippet,
  userStory,
  baseUrl
}) {
  const us = userStory || {};
  const prompt = `You are the Playwright **Planner** test agent. Write one **markdown test plan** file that is precise enough for a **Generator** agent to implement as @playwright/test specs, but stays human-readable.

Include:
- Title and scope (one line)
- Preconditions / test data
- Main flow: numbered steps with **expected UI outcome** per step
- Edge cases or negative paths (bullets)
- Success criteria (behavioral assertions the UI must satisfy; prefer roles, accessible names, visible text — not brittle CSS)

Context:
- The repo follows Playwright Test Agents layout: \`tests/seed.spec.ts\` bootstraps the environment (global setup, fixtures, hooks). Assume the Generator may run the seed first; describe steps accordingly if useful.
- App base URL for planning: ${baseUrl || "(set in playwright.config baseURL and/or handoff baseUrl)"}
- Optional UI file for context: ${samplePath || "n/a"}

User story:
- Title: ${us.title || ""}
- Type: ${us.type || ""}
- Priority: ${us.priority || ""}
- Test for: ${us.testFor || ""}
- Description: ${us.description || ""}

${codeSnippet ? `--- UI code excerpt (reference only) ---\n${String(codeSnippet).slice(0, 12000)}\n` : ""}

Output **markdown only**. Do not wrap the entire document in one markdown code fence.`;

  const call = async () => {
    const completion = await sendChatCompletion({
      model: process.env.OPENAI_MODEL || "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.35
    });
    return (completion.choices?.[0]?.message?.content || "").trim();
  };
  const raw = await retry(call, 3, 500);
  return stripOuterMarkdownFence(raw);
}

function extractFirstCodeBlock(text) {
  const s = String(text || "").trim();
  const paired = /^```(?:\w+)?\s*([\s\S]*?)```\s*$/m.exec(s);
  if (paired && paired[1]) return paired[1].trim();
  const greedy = /```(?:\w+)?\s*([\s\S]*?)```/g;
  let m;
  let best = "";
  while ((m = greedy.exec(s))) {
    const body = (m[1] || "").trim();
    if (body.length > best.length) best = body;
  }
  if (best) return best;
  if (/^```(?:\w+)?\r?\n?/.test(s)) {
    return s.replace(/^```(?:\w+)?\r?\n?/, "").replace(/\r?\n?```\s*$/m, "").trim();
  }
  return s;
}

/** Summarize Jest JSON failures for the model */
async function analyzeJestFailures(jestJson, extraNotes = "") {
  const { summarizeJestFailures } = require("./lib/jestRunner");
  const { failures, summary } = summarizeJestFailures(jestJson);
  const n = failures.length;
  const rules =
    n === 0
      ? "There are no failing assertions in the excerpt below."
      : `There are exactly ${n} failing assertion group(s) below (numbered Failure 1 … Failure ${n}).

You must:
- Write exactly ${n} bullet points, in order: bullet 1 = Failure 1, bullet 2 = Failure 2, etc.
- For each bullet, start with the test name from that group, then quote verbatim any lines that contain Expected, Received, matcher hints, or the first line of the stack that names the assertion — copy from THAT group only.
- Do not describe a scenario (null, undefined, NaN, mocks, wrong import path, etc.) unless that word or value appears in THAT group's failure text. Do not merge or confuse failures across groups.
- After quoting, one short clause: whether the evidence points to a wrong expectation in the test vs surprising application output.`;

  const prompt = `You are a senior engineer. ${rules}

${extraNotes || ""}

Jest failure output (verbatim excerpts from JSON):
${summary || "(none)"}
`;
  const call = async () => {
    const completion = await sendChatCompletion({
      model: process.env.OPENAI_MODEL || "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    });
    return (completion.choices?.[0]?.message?.content || "").trim();
  };
  return retry(call, 3, 500);
}

/**
 * Suggest test-only patches. Production source is never modified by the tool; implementationCode is always null.
 */
async function suggestFixes({ sourceCode, testCode, filePath, testFilePath, failureSummary, analysis }) {
  const prompt = `You are fixing failing Jest tests by editing the TEST FILE ONLY.

Source file (read-only context; do NOT output modified source): ${filePath}
Test file: ${testFilePath}

Prior analysis:
${analysis || ""}

Failures / stack excerpts:
${failureSummary || ""}

--- Source code (reference only) ---
${sourceCode}

--- Test code ---
${testCode}

Hard rules:
- Align fixes with the failure output above. If several tests failed, your TEST_CODE must fix every failing case (match each Expected/Received or error to the right it() block).
- Output a corrected full test file body only. Never output patches to production / application source.
- If the failure is due to a bug in the application under test, say so under EXPLANATION and still only adjust tests (e.g. skip, todo, or correct assertions if the test was wrong). Do not rewrite application code.
- Under ### TEST_CODE output raw JavaScript only. Do NOT wrap the code in markdown fences (no \`\`\` or \`\`\`javascript).

Return sections EXACTLY in this order:
### EXPLANATION
(short)

### TEST_CODE
(full replacement test file if tests need changes, else write SKIP)
`;
  const call = async () => {
    const completion = await sendChatCompletion({
      model: process.env.OPENAI_MODEL || "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    });
    return (completion.choices?.[0]?.message?.content || "").trim();
  };
  const raw = await retry(call, 3, 500);
  let testMatch = raw.match(/###\s*TEST_CODE\s*([\s\S]*?)(?=\n###\s+[A-Za-z_]|\s*$)/i);
  let testCodeOut = testMatch ? testMatch[1].trim() : "";
  testCodeOut = testCodeOut.replace(/\n###\s*IMPLEMENTATION_CODE[\s\S]*$/i, "").trim();
  testCodeOut = extractFirstCodeBlock(testCodeOut);
  if (/^SKIP$/i.test(testCodeOut)) testCodeOut = "";
  return { raw, testCode: testCodeOut || null, implementationCode: null };
}

async function generateAdditionalTestInputs(filePath, code, userStory, focus = "boundary, invalid, and fuzz-style cases") {
  const prompt = `Given this code and user story, propose additional Jest test cases (titles + brief Given-When-Then + input examples). Focus: ${focus}.
Return markdown bullet list only. No full test file.

File: ${filePath}
User story — Title: ${userStory.title || ""}; Type: ${userStory.type || ""}; Priority: ${userStory.priority || ""}; Test for: ${userStory.testFor || ""}; Description: ${userStory.description || ""}

Code:
${code.slice(0, 12000)}
`;
  const call = async () => {
    const completion = await sendChatCompletion({
      model: process.env.OPENAI_MODEL || "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.35
    });
    return (completion.choices?.[0]?.message?.content || "").trim();
  };
  return retry(call, 3, 500);
}

async function reviewIntegrationTestsLLM(userStory, testCode, staticFindings) {
  const prompt = `Review this Playwright/integration test for quality before execution.

User story:
Title: ${userStory.title || ""}
Type: ${userStory.type || ""}
Priority: ${userStory.priority || ""}
Test for: ${userStory.testFor || ""}
Description: ${userStory.description || ""}

Static tool findings (may be incomplete):
${JSON.stringify(staticFindings, null, 2)}

Test code:
${testCode.slice(0, 20000)}

Reply with:
1) DUPLICATE_OR_WEAK: bullets
2) SHALLOW_EDGE_COVERAGE: bullets  
3) SUGGESTIONS: bullets (deep assertions tied to the user story)
`;
  const call = async () => {
    const completion = await sendChatCompletion({
      model: process.env.OPENAI_MODEL || "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.25
    });
    return (completion.choices?.[0]?.message?.content || "").trim();
  };
  return retry(call, 3, 500);
}

/** Generate k6 script (soak/load/stress/spike) from user stories */
async function generateK6Script(userStories, options = {}) {
  const mode = options.mode || "load";
  const rawMin = options.minScenarioDurationSeconds;
  const minWallSeconds = Math.max(
    30,
    typeof rawMin === "number" && Number.isFinite(rawMin)
      ? rawMin
      : parseInt(String(rawMin ?? "120"), 10) || 120
  );
  const steadyFloor = Math.max(45, Math.floor(minWallSeconds * 0.55));
  const defaultBaseUrl =
    String(options.defaultBaseUrl || options.baseUrl || "").trim() || "http://localhost:3000";
  const defaultBaseUrlLiteral = JSON.stringify(defaultBaseUrl);
  const storiesText = userStories
    .map(
      (s, i) =>
        `${i + 1}. [${s.type}] ${s.title} (priority ${s.priority}; testFor: ${s.testFor || "all"})\n   ${s.description}`
    )
    .join("\n\n");
  const prompt = `Write a k6 test script (JavaScript for k6) for scenario type: "${mode}".
Use options: soak | load | stress | spike — reflect the mode in stages/VUs/duration (long-running constant load is **soak**, not a separate mode).
Base flows and thresholds on these user stories (invent plausible HTTP paths only if the story implies API usage; always resolve a real base URL as below):

${storiesText}

**Duration (mandatory):** Operators often use \`K6_WEB_DASHBOARD=true\` and need time to open http://127.0.0.1:5665 and read charts. The run must **not** finish in a few seconds.
- **Minimum wall-clock time** ~**${minWallSeconds}s** total: use \`export const options = { stages: [...] }\` (or \`scenarios\`) so the **sum of stage \`duration\` strings** is **at least ~${minWallSeconds}s** (e.g. ramp-up 20s–45s, then a **steady phase of at least ${steadyFloor}s** at fixed target VUs, then optional ramp-down).
- Avoid ultra-short stages like a single \`10s\` total test. Include \`sleep()\` between requests (e.g. 0.3–1.5s) so the steady phase is observable, not millions of iterations in 5 seconds.
- k6 dashboard graphs need enough span; err on the side of **longer** steady load, not shorter.

**BASE_URL (mandatory):** If the runner omits \`BASE_URL\`, \`__ENV.BASE_URL\` is undefined and concatenation becomes the literal string \`undefined/auth/login\` (invalid). Immediately after imports, define this constant (copy this pattern; keep the regex as shown):
const BASE_URL = (typeof __ENV.BASE_URL === 'string' && __ENV.BASE_URL.trim() && /^https?:\\/\\//i.test(__ENV.BASE_URL.trim()))
  ? __ENV.BASE_URL.trim().replace(/\\/$/, '')
  : ${defaultBaseUrlLiteral};
Use only \`BASE_URL\` to build every request URL (e.g. \`\${BASE_URL}/auth/login\`). Never use raw \`__ENV.BASE_URL\` in a URL.

**setup() & auth (mandatory):** Many failures are "server down" or "login returns 401 because credentials were hardcoded or missing".
- **Never** use bare identifiers \`K6_LOGIN_EMAIL\` or \`K6_LOGIN_PASSWORD\` in JavaScript — they are **not** variables and cause \`ReferenceError\`. Only read via \`__ENV.K6_LOGIN_EMAIL\` and \`__ENV.K6_LOGIN_PASSWORD\`, or locals like \`const loginEmail = String(__ENV.K6_LOGIN_EMAIL || '').trim();\`.
- Add \`import { test } from 'k6/execution';\` alongside other imports.
- At **module scope** immediately after \`BASE_URL\`, define \`const loginEmail = String(__ENV.K6_LOGIN_EMAIL || '').trim();\` and \`const loginPassword = String(__ENV.K6_LOGIN_PASSWORD || '').trim();\` whenever the default function POSTs to an auth/login path. Use **only** \`loginEmail\` / \`loginPassword\` in \`setup()\` and in \`default()\` for JSON bodies — never \`K6_LOGIN_EMAIL\` without \`__ENV.\`.
- Immediately after those consts, add \`export function setup() { ... }\` that:
  1) **Reachability:** \`const ping = http.get(BASE_URL + '/');\` — if \`ping.error\`, call \`test.abort('Cannot reach BASE_URL=' + BASE_URL + ' — ' + String(ping.error) + '. Start the API, match the port to performance.baseUrl, then: set -a && . ./k6.env && set +a');\` (404/401 on GET / is OK; only abort on transport \`ping.error\`).
  2) **Login/sign-in:** If the default function POSTs to any auth path, in \`setup()\` if \`!loginEmail || !loginPassword\`, \`test.abort('Set K6_LOGIN_EMAIL and K6_LOGIN_PASSWORD (source k6.env from the performance agent or export manually).');\`
- \`setup()\` runs once before VUs; keep it fast (one GET + optional env check).

Requirements:
- import http from 'k6/http'; import { check, sleep } from 'k6'; import { Rate } from 'k6/metrics'; import { test } from 'k6/execution';
- Custom \`Rate\` (and other custom metric) names must be valid k6 identifiers: ASCII letters, digits, underscores only — **no spaces** (e.g. \`failed_requests\`, not \`failed requests\`). Threshold keys must match exactly.
- export const options = { stages: [ ... ] } (or scenarios) meeting the duration rules above.
- Default thresholds: http_req_failed rate < 0.1 unless story says stricter.
- Output ONLY the script, no markdown fences.
`;
  const call = async () => {
    const completion = await sendChatCompletion({
      model: process.env.OPENAI_MODEL || "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.25
    });
    let out = (completion.choices?.[0]?.message?.content || "").trim();
    out = extractFirstCodeBlock(out);
    return out;
  };
  return retry(call, 3, 500);
}

module.exports = {
  generateUnitTest,
  writeUnitTests,
  generateIntegrationUITest,
  generatePlannerSpecMarkdown,
  analyzeJestFailures,
  suggestFixes,
  generateAdditionalTestInputs,
  reviewIntegrationTestsLLM,
  generateK6Script
};
