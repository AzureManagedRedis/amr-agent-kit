import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExecutionArtifact,
  ExecutionRequest,
  ExecutorCapabilities,
  HeadlessExecutor,
  IsolatedWorkspace,
  ProcessIdentity,
} from "../../src/core/contracts.js";
import { runSoak } from "../../src/core/controller.js";
import type { ProcessManager, TerminationResult } from "../../src/core/process.js";

const capabilities: ExecutorCapabilities = {
  executablePath: process.execPath,
  executableHash: "executor-hash",
  version: process.version,
  helpHash: "help-hash",
  supportsPrompt: true,
  supportsJsonOutput: true,
  supportsNoAskUser: true,
  supportsToolApproval: true,
  supportsInstructionDisable: true,
  supportsMcpDisable: true,
  supportsNoRemote: true,
  supportsNoRemoteExport: true,
  supportsNoAutoUpdate: true,
  supportsStreamControl: true,
  calibratedModels: ["fake"],
  packageCacheHash: "package-cache-hash",
  packageCacheSource: "package-cache-source",
};

class FakeExecutor implements HeadlessExecutor {
  executions = 0;

  probe(_workspaces: {
    readonly withoutSkill: IsolatedWorkspace;
    readonly withSkill: IsolatedWorkspace;
    readonly calibrations: ReadonlyArray<{ readonly workspace: IsolatedWorkspace; readonly model?: string }>;
  }): Promise<ExecutorCapabilities> {
    return Promise.resolve(capabilities);
  }

  execute(request: ExecutionRequest): Promise<ExecutionArtifact> {
    this.executions += 1;
    const timestamp = new Date().toISOString();
    const processIdentity = {
      pid: process.pid,
      startedAt: timestamp,
      name: path.basename(process.execPath),
      executablePath: process.execPath,
    };
    return Promise.resolve({
      soakRunId: request.workspace.environment.SOAK_RUN_ID!,
      executionId: request.executionId,
      scenarioId: request.scenario.id,
      arm: request.arm,
      status: "completed",
      startedAt: timestamp,
      finishedAt: timestamp,
      responseText: "ok",
      events: [],
      trace: {
        executablePath: process.execPath,
        executableHash: capabilities.executableHash,
        args: [],
        cwd: request.workspace.projectDir,
        pid: process.pid,
        attemptNumber: 1,
        processIdentity,
        descendants: [],
        startedAt: timestamp,
        finishedAt: timestamp,
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        stdoutFile: "",
        stderrFile: "",
        projectHashBefore: request.workspace.projectHash,
        projectHashAfter: request.workspace.projectHash,
        profileHashBefore: request.workspace.profileHash,
        profileHashAfter: request.workspace.profileHash,
        contamination: [],
      },
    });
  }
}

class FakeProcessManager implements ProcessManager {
  readonly identity: ProcessIdentity = {
    pid: process.pid,
    startedAt: "2026-07-17T00:00:00.000Z",
    name: path.basename(process.execPath),
    executablePath: process.execPath,
  };

  identify(): Promise<ProcessIdentity> {
    return Promise.resolve(this.identity);
  }

  isRunning(): Promise<boolean> {
    return Promise.resolve(true);
  }

  terminateTree(): Promise<TerminationResult> {
    return Promise.resolve({ discovered: [], killed: [], skipped: [] });
  }
}

test("completed runs resume idempotently with monotonic ledger sequences", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-controller-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const skill = path.join(root, "skill");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: test-skill\n---\n");
  const config = {
    runId: "resume-test",
    repositoryRoot: root,
    outputRoot: path.join(root, "eval-runs"),
    skillSnapshotPath: skill,
    concurrency: 12,
    repetitions: 1,
    durationHours: 1,
    timeoutMinutes: 1,
  };
  const modules = {
    scenarios: {
      listScenarios: () =>
        Promise.resolve([
          { id: "scenario", prompt: "test", scaffold: { "index.txt": "neutral" } },
        ]),
    },
    executor: new FakeExecutor(),
    processManager: new FakeProcessManager(),
  };

  const first = await runSoak(config, modules);
  const statePath = path.join(config.outputRoot, config.runId, "state.json");
  const staleState = JSON.parse(await readFile(statePath, "utf8")) as {
    lastLedgerSequence: number;
    admissionEndsAt: string;
    pairs: Record<
      string,
      {
        completedAt?: string;
        admittedAt?: string;
        arms: Record<"without-skill" | "with-skill", { status: string; attempts: number }>;
      }
    >;
  };
  staleState.lastLedgerSequence = 0;
  staleState.admissionEndsAt = new Date(Date.now() - 60_000).toISOString();
  const resumedPair = Object.values(staleState.pairs)[0];
  assert.ok(resumedPair.admittedAt);
  delete resumedPair.completedAt;
  resumedPair.arms["with-skill"].status = "pending";
  await writeFile(statePath, `${JSON.stringify(staleState)}\n`);
  const runDir = path.join(config.outputRoot, config.runId);
  await writeFile(
    path.join(runDir, "stop-request.json"),
    `${JSON.stringify({ requestedAt: new Date(Date.now() - 60_000).toISOString() })}\n`,
  );
  const second = await runSoak(config, modules);
  assert.equal(first.completedExecutions, 2);
  assert.equal(second.completedExecutions, 2);
  assert.equal(modules.executor.executions, 3);
  await assert.rejects(readFile(path.join(runDir, "stop-request.json")), /ENOENT/);
  assert.equal((await readdir(path.join(runDir, "stop-requests"))).length, 1);

  const events = (
    await readFile(path.join(config.outputRoot, config.runId, "events.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { sequence: number; type: string; data?: { resumed?: boolean } });
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: events.length }, (_, index) => index + 1),
  );
  assert.deepEqual(
    events.filter((event) => event.type === "run.started").map((event) => event.data?.resumed),
    [false, true],
  );
  assert.ok(events.some((event) => event.type === "pair.resumed"));
});
