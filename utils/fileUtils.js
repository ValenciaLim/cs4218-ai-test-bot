const fs = require("fs-extra");
const path = require("path");
const acorn = require("acorn");

// Ensure the test file exists
async function ensureTestFile(filePath) {
  if (!(await fs.pathExists(filePath))) {
    await fs.outputFile(filePath, "");
  }
}

// Write content to a file
async function writeFile(filePath, content) {
  await fs.outputFile(filePath, content);
}

// Read file content
async function readFile(filePath) {
  return fs.readFile(filePath, "utf-8");
}

// Get function names from code using AST parsing (supports declarations, exports, arrow functions)
function extractFunctions(code, selectedFunctions = []) {
  if (selectedFunctions && selectedFunctions.length > 0) return selectedFunctions;

  const names = new Set();
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
  } catch (e) {
    return [];
  }

  walkAST(ast, node => {
    switch (node.type) {
      case "FunctionDeclaration":
        if (node.id && node.id.name) names.add(node.id.name);
        break;
      case "VariableDeclaration":
        for (const decl of node.declarations) {
          if (decl.id && decl.id.name && decl.init) {
            const initType = decl.init.type;
            if (initType === "ArrowFunctionExpression" || initType === "FunctionExpression") {
              names.add(decl.id.name);
            }
          }
        }
        break;
      case "ExportNamedDeclaration":
        if (node.declaration) {
          const d = node.declaration;
          if (d.type === "FunctionDeclaration" && d.id && d.id.name) names.add(d.id.name);
          if (d.type === "VariableDeclaration") {
            for (const decl of d.declarations) {
              if (decl.id && decl.id.name) names.add(decl.id.name);
            }
          }
        }
        if (node.specifiers) {
          for (const spec of node.specifiers) {
            if (spec.exported && spec.exported.name) names.add(spec.exported.name);
          }
        }
        break;
    }
  });

  return Array.from(names);
}

function walkAST(node, cb) {
  cb(node);
  for (const key in node) {
    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c.type === "string") walkAST(c, cb);
      }
    } else if (child && typeof child.type === "string") {
      walkAST(child, cb);
    }
  }
}

module.exports = { ensureTestFile, writeFile, readFile, extractFunctions };
