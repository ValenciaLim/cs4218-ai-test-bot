const fs = require("fs-extra");
const path = require("path");

async function generateReport({ unitTestStats, bugs, outputPath }) {
  const html = `
<html>
<head>
  <title>Unit Test Report</title>
  <style>
    body { font-family: Arial; }
    h2 { color: #333; }
    .chart { width: 100%; height: 300px; margin-bottom: 20px; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
    th, td { border: 1px solid #999; padding: 8px; }
  </style>
</head>
<body>
  <h2>Unit Test Approach</h2>
  <p>${unitTestStats.approach}</p>

  <h2>Statistics</h2>
  <ul>
    <li>Functions analyzed: ${unitTestStats.functionsAnalyzed}</li>
    <li>Tests generated: ${unitTestStats.testsGenerated}</li>
    <li>Bugs found: ${bugs.length}</li>
    <li>Bugs fixed: ${unitTestStats.bugsFixed}</li>
  </ul>

  <h2>Generated Test Files</h2>
  <ul>
    ${
      (unitTestStats.generatedTestFiles || [])
        .map(f => `<li>${f}</li>`)
        .join("")
    }
  </ul>

  <h2>Bug List</h2>
  <table>
    <tr><th>File</th><th>Test</th><th>Error</th></tr>
    ${bugs.map(b => `<tr><td>${b.file}</td><td>${b.test}</td><td>${b.message}</td></tr>`).join("")}
  </table>

  <h2>Graphs (Placeholder)</h2>
  <p>Graphs for grading should be included here.</p>
</body>
</html>
  `;
  await fs.outputFile(outputPath, html);
  console.log(`Report generated at ${outputPath}`);
}

module.exports = { generateReport };
