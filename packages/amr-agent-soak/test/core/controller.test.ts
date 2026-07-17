import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExecutionArtifact,
  ExecutionRequest,
  ExecutorCapabilities,
  HeadlessExecutor,
  IsolatedWorkspace,
} from "../../src/core/contracts.js";
import { runSoak } from "../../src/core/controller.js";

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
};

class FakeExecutor implements HeadlessExecutor {
  probe(_workspaces: {
    readonly withoutSkill: IsolatedWorkspace;
    readonly withSkill: IsolatedWorkspace;
  }): Promise<ExecutorCapabilities> {
    return Promise.resolve(capabilities);
  }

  execute(request: ExecutionRequest): Promise<ExecutionArtifact> {
    const timestamp = new Date().toISOString();
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
  };

  const first = await runSoak(config, modules);
  const statePath = path.join(config.outputRoot, config.runId, "state.json");
  const staleState = JSON.parse(await readFile(statePath, "utf8")) as {
    lastLedgerSequence: number;
  };
  staleState.lastLedgerSequence = 0;
  await writeFile(statePath, `${JSON.stringify(staleState)}\n`);
  const second = await runSoak(config, modules);
  assert.equal(first.completedExecutions, 2);
  assert.equal(second.completedExecutions, 2);

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
});
