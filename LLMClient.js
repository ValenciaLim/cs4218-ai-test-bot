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

  const prompt = `
Generate real Jest unit test templates for the following code file: ${filePath}.
Use AAA / Given-When-Then pattern.
Test functions in isolation, cover happy path and edge cases.
Include missing functions as skeleton tests if necessary.

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

  return retry(call, 3, 500);
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

module.exports = { generateUnitTest, generateUserStory, writeUnitTests };
