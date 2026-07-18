import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessIdentity } from "../../src/core/contracts.js";
import {
  identityMatches,
  planTermination,
  ProcessRegistry,
  readActiveProcessRoots,
  type ProcessSnapshot,
  type KillableChild,
  waitForChildTermination,
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

test("reconciles active roots from controller and blind-grader registries", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-process-registries-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const primaryPath = path.join(root, "processes.jsonl");
  const graderPath = path.join(root, "blind-grader-processes.jsonl");
  const primary = new ProcessRegistry(primaryPath);
  const grader = new ProcessRegistry(graderPath);
  const controllerChild = processSnapshot(301, 1, "2026-07-17T00:00:00.000Z");
  const graderChild = processSnapshot(302, 1, "2026-07-17T00:00:01.000Z");
  await primary.recordStarted("controller", controllerChild);
  await grader.recordStarted("grader", graderChild);
  const roots = await readActiveProcessRoots([primaryPath, graderPath]);
  assert.deepEqual(
    roots.map((entry) => [entry.identity.pid, path.basename(entry.registryPath)]).sort(),
    [[301, "processes.jsonl"], [302, "blind-grader-processes.jsonl"]],
  );
});

test("abort falls back to exact direct-child escalation and has a hard deadline", async () => {
  class FakeChild extends EventEmitter {
    readonly pid = 321;
    readonly exitCode = null;
    readonly signalCode = null;
    readonly signals: Array<NodeJS.Signals | number | undefined> = [];

    kill(signal?: NodeJS.Signals | number): boolean {
      this.signals.push(signal);
      return true;
    }
  }

  const child = new FakeChild();
  const controller = new AbortController();
  const outcomePromise = waitForChildTermination(
    child as unknown as KillableChild,
    controller.signal,
    () => Promise.reject(new Error("CIM unavailable")),
    { graceMs: 5, deadlineMs: 25 },
  );
  controller.abort();
  const outcome = await outcomePromise;
  assert.equal(outcome.closed, false);
  assert.match(outcome.error?.message ?? "", /did not terminate/);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("wait recognizes a child that closed before listeners were attached", async () => {
  class ClosedChild extends EventEmitter {
    readonly pid = 322;
    readonly exitCode = 0;
    readonly signalCode = null;
    kill(): boolean {
      throw new Error("closed child must not be killed");
    }
  }
  const outcome = await waitForChildTermination(
    new ClosedChild() as unknown as KillableChild,
    new AbortController().signal,
    () => Promise.reject(new Error("tree termination must not run")),
  );
  assert.equal(outcome.closed, true);
  assert.equal(outcome.exitCode, 0);
});
