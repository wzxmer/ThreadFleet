import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".ps1",
  ".py",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

const temporaryInstrumentationName = ["DEBUG", "TMP"].join("-");
const temporaryInstrumentationPattern = new RegExp(
  `\\[${temporaryInstrumentationName}:[^\\]\\r\\n]*\\]`,
  "g",
);

function lineNumberAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function isSourceFile(filePath) {
  return sourceExtensions.has(path.extname(filePath).toLowerCase());
}

export async function findTemporaryInstrumentation(rootDirectory) {
  const matches = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(entryPath);
        }
        continue;
      }

      if (!entry.isFile() || !isSourceFile(entryPath)) {
        continue;
      }

      const source = await readFile(entryPath, "utf8");
      for (const match of source.matchAll(temporaryInstrumentationPattern)) {
        matches.push({
          filePath: entryPath,
          line: lineNumberAt(source, match.index),
          marker: match[0],
        });
      }
    }
  }

  await visit(rootDirectory);
  return matches;
}

async function main() {
  const rootDirectory = path.resolve(process.argv[2] ?? process.cwd());
  const matches = await findTemporaryInstrumentation(rootDirectory);
  if (matches.length === 0) {
    console.log("Temporary instrumentation guard passed.");
    return;
  }

  console.error("Temporary instrumentation remains:");
  for (const match of matches) {
    console.error(`${path.relative(rootDirectory, match.filePath)}:${match.line} ${match.marker}`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
