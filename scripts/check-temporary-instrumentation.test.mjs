import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findTemporaryInstrumentation } from "./check-temporary-instrumentation.mjs";

function temporaryMarker(taskId) {
  return `${String.fromCharCode(91)}${["DEBUG", "TMP"].join("-")}:${taskId}]`;
}

test("finds temporary instrumentation in source files", async (task) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "temporary-instrumentation-"));
  task.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "probe.ts"), `console.log("${temporaryMarker("task-42")}");`);

  const matches = await findTemporaryInstrumentation(directory);

  assert.deepEqual(matches, [
    {
      filePath: path.join(directory, "probe.ts"),
      line: 1,
      marker: temporaryMarker("task-42"),
    },
  ]);
});

test("finds malformed temporary instrumentation markers", async (task) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "temporary-instrumentation-"));
  task.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "probe.rs"), `tracing::debug!("${temporaryMarker("")}");`);

  const matches = await findTemporaryInstrumentation(directory);

  assert.deepEqual(matches, [
    {
      filePath: path.join(directory, "probe.rs"),
      line: 1,
      marker: temporaryMarker(""),
    },
  ]);
});

test("ignores generated dependency directories and non-source files", async (task) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "temporary-instrumentation-"));
  task.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "node_modules"));
  await writeFile(path.join(directory, "node_modules", "probe.js"), temporaryMarker("dependency"));
  await writeFile(path.join(directory, "notes.md"), temporaryMarker("notes"));

  const matches = await findTemporaryInstrumentation(directory);

  assert.deepEqual(matches, []);
});
