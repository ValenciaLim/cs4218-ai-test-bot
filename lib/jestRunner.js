const { spawnSync } = require("child_process");

/**
 * Run Jest in projectRoot and return { success, json, stdout, stderr, error }.
 * Uses --json (stdout) when supported.
 */
function runJest(projectRoot, extraArgs = []) {
  const args = ["jest", "--json", "--no-coverage", "--passWithNoTests", ...extraArgs];
  const result = spawnSync("npx", args, {
    cwd: projectRoot,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0" }
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  let json = null;
  const parseJson = text => {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  };
  json = parseJson(stdout) || parseJson(stdout + stderr);

  const success = result.status === 0;
  return {
    success,
    status: result.status,
    json,
    stdout,
    stderr,
    error: result.error
  };
}

/**
 * Collect human-readable failure summaries from Jest JSON output.
 */
function summarizeJestFailures(jestJson) {
  if (!jestJson || !Array.isArray(jestJson.testResults)) {
    return { failures: [], summary: "No Jest JSON or empty testResults." };
  }
  const failures = [];
  for (const tr of jestJson.testResults) {
    if (tr.status === "passed") continue;
    const file = tr.name || tr.testFilePath || "";
    for (const ar of tr.assertionResults || []) {
      if (ar.status === "passed") continue;
      const msgs = (ar.failureMessages || []).join("\n");
      failures.push({
        file,
        title: ar.fullName || ar.title || "",
        ancestorTitles: ar.ancestorTitles || [],
        messages: msgs
      });
    }
    if ((tr.assertionResults || []).length === 0 && tr.message) {
      failures.push({ file, title: "(file-level)", messages: tr.message });
    }
  }
  const maxMsg = 12000;
  const summary = failures
    .map((f, i) => {
      let msg = f.messages || "";
      const clipped = msg.length > maxMsg ? `${msg.slice(0, maxMsg)}\n… (truncated)` : msg;
      return `--- Failure ${i + 1} of ${failures.length} ---\nTest: ${f.title}\nFile: ${f.file}\n\n${clipped}`;
    })
    .join("\n\n---\n\n");
  return { failures, summary: summary || "No failing assertions found in JSON." };
}

module.exports = { runJest, summarizeJestFailures };
