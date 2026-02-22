const { exec } = require("child_process");
const path = require("path");
const fs = require("fs-extra");

async function runTestsAndCollectBugs(repoPath, testFiles = []) {
  return new Promise((resolve, reject) => {
    const resultsPath = path.join(repoPath, "test-results.json");

    // If specific test files were provided, run jest only for those files using npx
    // This keeps the report focused on generated tests instead of the whole repo.
    let cmd;
    if (Array.isArray(testFiles) && testFiles.length > 0) {
      const relFiles = testFiles.map(f => path.relative(repoPath, f));
      const filesArg = relFiles.map(f => `"${f}"`).join(" ");
      cmd = `npx jest ${filesArg} --json --outputFile=${resultsPath}`;
    } else {
      cmd = `npm run test -- --json --outputFile=${resultsPath}`;
    }

    exec(cmd, { cwd: repoPath }, async (err, stdout, stderr) => {
      if (err) {
        // If Jest fails, still try to read results file if it exists
        try {
          if (!(await fs.pathExists(resultsPath))) {
            return reject(new Error(`Test command failed: ${stderr || err.message}`));
          }
        } catch (e) {
          return reject(new Error(`Test command failed: ${stderr || err.message}`));
        }
      }

      try {
        if (!(await fs.pathExists(resultsPath))) {
          return resolve([]);
        }

        const raw = await fs.readFile(resultsPath, "utf-8");
        const results = JSON.parse(raw);
        const bugs = [];

        if (Array.isArray(results.testResults)) {
          for (const suite of results.testResults) {
            const assertions = suite.assertionResults || [];
            for (const test of assertions) {
              if (test.status === "failed") {
                bugs.push({ test: test.fullName, file: suite.name, message: (test.failureMessages || []).join("\n") });
              }
            }
          }
        }

        resolve(bugs);
      } catch (e) {
        reject(e);
      }
    });
  });
}

module.exports = { runTestsAndCollectBugs };
