import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessIdentity } from "../../src/core/contracts.js";
import {
  identityMatches,
  planTermination,
  ProcessRegistry,
  type ProcessSnapshot,
} from "../../src/core/process.js";

function processSnapshot(
  pid: number,
  parentPid: number,
  startedAt: string,
  name = "node.exe",
): ProcessSnapshot {
  return {
    pid,
    parentPid,
    startedAt,
    name,
    executablePath: `C:\\tools\\${name}`,
  };
}

test("plans an exact-PID process tree deepest-first and excludes unrelated processes", () => {
  const root = processSnapshot(100, 10, "2026-07-17T00:00:00.000Z");
  const child = processSnapshot(101, 100, "2026-07-17T00:00:01.000Z", "git.exe");
  const grandchild = processSnapshot(102, 101, "2026-07-17T00:00:02.000Z", "testhost.exe");
  const sibling = processSnapshot(200, 10, "2026-07-17T00:00:03.000Z");
  assert.deepEqual(
    planTermination(root, [root, child, grandchild, sibling]).map((entry) => entry.pid),
    [102, 101, 100],
  );
  assert.deepEqual(
    planTermination(root, [child, grandchild, sibling]).map((entry) => entry.pid),
    [102, 101],
  );
});

test("refuses a reused root PID with a different process identity", () => {
  const expected: ProcessIdentity = processSnapshot(
    100,
    10,
    "2026-07-17T00:00:00.000Z",
  );
  const reused = processSnapshot(100, 10, "2026-07-17T01:00:00.000Z");
  const child = processSnapshot(101, 100, "2026-07-17T01:00:01.000Z");
  assert.equal(identityMatches(expected, reused), false);
  assert.deepEqual(planTermination(expected, [reused, child]), []);
});

test("durably tracks process start and exit identities", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-processes-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const registry = new ProcessRegistry(path.join(root, "processes.jsonl"));
  const identity = processSnapshot(123, 1, "2026-07-17T00:00:00.000Z");
  await registry.recordStarted("test", identity);
  assert.deepEqual(await registry.readActive(), [identity]);
  await registry.recordExited("test", identity);
  await appendFile(path.join(root, "processes.jsonl"), '{"timestamp":');
  assert.deepEqual(await registry.readActive(), []);
  const resumedIdentity = processSnapshot(124, 1, "2026-07-17T00:01:00.000Z");
  await registry.recordStarted("resumed", resumedIdentity);
  assert.deepEqual(await registry.readActive(), [resumedIdentity]);
});
