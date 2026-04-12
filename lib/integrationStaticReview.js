/**
 * Pre-execution heuristics: duplicate / weak tests, shallow coverage hints.
 * Does not validate user story JSON schema.
 */

function extractTestTitles(code) {
  const titles = [];
  const re = /\b(?:it|test)\s*\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) titles.push(m[1]);
  return titles;
}

function extractDescribeTitles(code) {
  const titles = [];
  const re = /\bdescribe\s*\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) titles.push(m[1]);
  return titles;
}

function shallowAssertionHints(code) {
  const hints = [];
  const expectCount = (code.match(/\bexpect\s*\(/g) || []).length;
  const itCount = (code.match(/\b(?:it|test)\s*\(/g) || []).length;
  if (itCount > 0 && expectCount / itCount < 1.2) {
    hints.push("Low expect() count per test — consider deeper assertions on DOM, network, or state.");
  }
  if (/\bexpect\s*\([^)]*\)\.toBe\s*\(\s*true\s*\)/.test(code)) {
    hints.push("Found expect(...).toBe(true) — prefer specific matchers (toContain, toHaveText, etc.).");
  }
  if (/\bexpect\s*\([^)]*\)\.toBeTruthy\s*\(\s*\)/.test(code) && expectCount <= 2) {
    hints.push("toBeTruthy alone is often shallow — combine with role/text queries.");
  }
  if (!/\bwaitFor\b|\bexpect\.poll\b|\btoPass\b/.test(code) && /\basync\s+function/.test(code)) {
    hints.push("Async flows without waitFor/polling may be flaky — align waits with user story outcomes.");
  }
  return hints;
}

function duplicateTitles(titles) {
  const seen = new Map();
  const dups = [];
  for (const t of titles) {
    const k = t.trim().toLowerCase();
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const [k, n] of seen) {
    if (n > 1) dups.push({ title: k, count: n });
  }
  return dups;
}

function reviewIntegrationTestCode(content) {
  const issues = [];
  const warnings = [];

  if (/\b(test|it|describe)\.only\b/.test(content)) {
    warnings.push("Contains .only — remove before CI.");
  }
  if (/\bpage\.goto\s*\([^)]*\)\s*;/.test(content) && !/\bexpect\b/.test(content.split("\n").slice(0, 15).join("\n"))) {
    warnings.push("Early navigation with few assertions — ensure post-condition checks match the user story.");
  }

  const itTitles = extractTestTitles(content);
  const dups = duplicateTitles(itTitles);
  if (dups.length) {
    issues.push(`Duplicate or very similar test titles: ${dups.map(d => `"${d.title}" x${d.count}`).join(", ")}`);
  }

  const describes = extractDescribeTitles(content);
  if (describes.length > 1) {
    const dd = duplicateTitles(describes);
    if (dd.length) issues.push(`Duplicate describe blocks: ${dd.map(d => d.title).join(", ")}`);
  }

  for (const h of shallowAssertionHints(content)) warnings.push(h);

  if (itTitles.length === 0) {
    issues.push("No it()/test() blocks detected — file may not be executable Playwright/Jest tests.");
  }

  return { issues, warnings, stats: { itCount: itTitles.length, describeCount: describes.length } };
}

module.exports = { reviewIntegrationTestCode, extractTestTitles };
