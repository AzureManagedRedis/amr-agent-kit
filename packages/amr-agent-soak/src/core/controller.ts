import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ExecutionArtifact,
  ExecutorCapabilities,
  LedgerEvent,
  RunStatus,
  RunSummary,
  SoakArm,
  SoakModules,
  SoakScenario,
  ProcessIdentity,
} from "./contracts.js";
import type { NormalizedSoakConfig } from "./config.js";
import { normalizeConfig, type SoakConfig } from "./config.js";
import { readJsonIfExists, writeAtomicJson } from "./atomic.js";
import { hashJson, hashTree } from "./hash.js";
import { createIsolatedWorkspace } from "./isolation.js";
import { EventLedger, readLastLedgerSequence } from "./ledger.js";
import { ProcessRegistry, SystemProcessManager } from "./process.js";

interface ArmState {
  status: "pending" | "running" | "completed" | "failed" | "timed-out" | "cancelled" | "cached";
  attempts: number;
  artifactPath?: string;
}

interface PairState {
  scenarioId: string;
  repetition: number;
  armOrder: ReadonlyArray<SoakArm>;
  admittedAt?: string;
  completedAt?: string;
  gradedAt?: string;
  arms: Record<SoakArm, ArmState>;
}

interface ControllerState {
  schemaVersion: 1;
  runId: string;
  status: RunStatus;
  startedAt: string;
  admissionEndsAt: string;
  finishedAt?: string;
  configHash: string;
  scenarioHash: string;
  skillHash: string;
  executorHash: string;
  lastLedgerSequence: number;
  pairs: Record<string, PairState>;
  failure?: string;
}

interface Heartbeat {
  schemaVersion: 1;
  runId: string;
  controller: ProcessIdentity;
  timestamp: string;
  status: RunStatus;
  activePairIds: ReadonlyArray<string>;
  activeProcesses: ReadonlyArray<ProcessIdentity>;
  completedPairs: number;
  totalPairs: number;
  admissionEndsAt: string;
}

const ARMS: ReadonlyArray<SoakArm> = ["without-skill", "with-skill"];

function pairId(scenario: SoakScenario, repetition: number): string {
  const suffix = createHash("sha256")
    .update(`${scenario.id}\0${repetition}`)
    .digest("hex")
    .slice(0, 12);
  return `${scenario.id.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64)}-r${repetition}-${suffix}`;
}

export function randomizedArmOrder(runId: string, id: string): ReadonlyArray<SoakArm> {
  const firstByte = createHash("sha256").update(`${runId}\0${id}`).digest()[0];
  return firstByte % 2 === 0 ? ARMS : [...ARMS].reverse();
}

function terminal(status: ArmState["status"]): boolean {
  return ["completed", "failed", "timed-out", "cancelled", "cached"].includes(status);
}

function pairCompleted(pair: PairState): boolean {
  return ARMS.every((arm) => terminal(pair.arms[arm].status));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function notify(modules: SoakModules, event: LedgerEvent): Promise<void> {
  await modules.reporter?.onEvent(event);
}

export async function runSoak(rawConfig: SoakConfig, modules: SoakModules): Promise<RunSummary> {
  const config = normalizeConfig(rawConfig);
  await mkdir(config.runDir, { recursive: true });
  const processManager = modules.processManager ?? new SystemProcessManager();
  const controllerIdentity = await processManager.identify(process.pid);
  const statePath = path.join(config.runDir, "state.json");
  const heartbeatPath = path.join(config.runDir, "heartbeat.json");
  const stopPath = path.join(config.runDir, "stop-request.json");
  const staleStopAtInvocationStart =
    await readJsonIfExists<Readonly<Record<string, unknown>>>(stopPath);
  const scenarios = [...(await modules.scenarios.listScenarios())];
  if (scenarios.length === 0) {
    throw new Error("Scenario provider returned no scenarios");
  }
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) {
    throw new Error("Scenario ids must be unique");
  }
  const probeKeys = (modules.probes ?? []).map((probe) => `${probe.phase}\0${probe.id}`);
  if (new Set(probeKeys).size !== probeKeys.length) {
    throw new Error("Probe ids must be unique within each phase");
  }

  const scenarioHash = hashJson(scenarios);
  const configSnapshot = {
    ...config,
    repositoryRoot: path.resolve(config.repositoryRoot),
    skillSnapshotPath: path.resolve(config.skillSnapshotPath),
  };
  const modulesSnapshot = {
    integration: modules.snapshot ?? {},
    probes: (modules.probes ?? [])
      .map((probe) => ({ id: probe.id, phase: probe.phase }))
      .sort((left, right) => `${left.phase}:${left.id}`.localeCompare(`${right.phase}:${right.id}`)),
  };
  const configHash = hashJson({ config: configSnapshot, modules: modulesSnapshot });
  const skillHash = await hashTree(config.skillSnapshotPath);
  const preflightScenario: SoakScenario = { id: "preflight", prompt: "preflight", scaffold: {} };
  const preflightRoot = path.join(config.runDir, "preflight");
  await rm(preflightRoot, { recursive: true, force: true });
  const [withoutSkillPreflight, withSkillPreflight] = await Promise.all(
    ARMS.map((arm) =>
      createIsolatedWorkspace({
        root: path.join(preflightRoot, arm),
        arm,
        scenario: preflightScenario,
        skillSnapshotPath: config.skillSnapshotPath,
        repositoryRoot: config.repositoryRoot,
        soakRunId: config.runId,
      }),
    ),
  );
  if (withoutSkillPreflight.projectHash !== withSkillPreflight.projectHash) {
    throw new Error("Preflight could not prove identical neutral project scaffolding");
  }
  const capabilities = await modules.executor.probe({
    withoutSkill: withoutSkillPreflight,
    withSkill: withSkillPreflight,
  });
  const executorHash = hashJson(capabilities);

  let state = await readJsonIfExists<ControllerState>(statePath);
  const isResumed = Boolean(state);
  if (state) {
    const mismatches = [
      ["config", state.configHash, configHash],
      ["scenarios", state.scenarioHash, scenarioHash],
      ["skill", state.skillHash, skillHash],
      ["executor", state.executorHash, executorHash],
    ].filter(([, actual, expected]) => actual !== expected);
    if (mismatches.length > 0) {
      throw new Error(
        `Resume snapshot mismatch: ${mismatches.map(([name]) => name).join(", ")}`,
      );
    }
    for (const pair of Object.values(state.pairs)) {
      for (const arm of ARMS) {
        if (pair.arms[arm].status === "running") {
          pair.arms[arm] = { ...pair.arms[arm], status: "pending" };
        }
      }
    }
    state.status = "running";
    state.failure = undefined;
    state.finishedAt = undefined;
  } else {
    const startedAt = new Date().toISOString();
    const pairs: Record<string, PairState> = {};
    for (const scenario of scenarios) {
      for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
        const id = pairId(scenario, repetition);
        pairs[id] = {
          scenarioId: scenario.id,
          repetition,
          armOrder: randomizedArmOrder(config.runId, id),
          arms: {
            "without-skill": { status: "pending", attempts: 0 },
            "with-skill": { status: "pending", attempts: 0 },
          },
        };
      }
    }
    state = {
      schemaVersion: 1,
      runId: config.runId,
      status: "initializing",
      startedAt,
      admissionEndsAt: new Date(Date.parse(startedAt) + config.durationMs).toISOString(),
      configHash,
      scenarioHash,
      skillHash,
      executorHash,
      lastLedgerSequence: 0,
      pairs,
    };
    await Promise.all([
      writeAtomicJson(path.join(config.runDir, "config.snapshot.json"), configSnapshot),
      writeAtomicJson(path.join(config.runDir, "scenarios.snapshot.json"), scenarios),
      writeAtomicJson(path.join(config.runDir, "executor.snapshot.json"), capabilities),
      writeAtomicJson(path.join(config.runDir, "modules.snapshot.json"), modulesSnapshot),
      writeAtomicJson(path.join(config.runDir, "skill.snapshot.json"), {
        path: config.skillSnapshotPath,
        hash: skillHash,
      }),
    ]);
  }

  const currentStop = await readJsonIfExists<Readonly<Record<string, unknown>>>(stopPath);
  if (
    staleStopAtInvocationStart &&
    currentStop &&
    hashJson(staleStopAtInvocationStart) === hashJson(currentStop)
  ) {
    await writeAtomicJson(
      path.join(
        config.runDir,
        "stop-requests",
        `stale-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      ),
      currentStop,
    );
    await rm(stopPath, { force: true });
  }

  const ledgerPath = path.join(config.runDir, "events.jsonl");
  state.lastLedgerSequence = Math.max(
    state.lastLedgerSequence,
    await readLastLedgerSequence(ledgerPath),
  );
  const ledger = new EventLedger(
    ledgerPath,
    config.runId,
    state.lastLedgerSequence,
  );
  let persistQueue = Promise.resolve();
  const persistState = (): Promise<void> => {
    persistQueue = persistQueue.then(() => writeAtomicJson(statePath, state));
    return persistQueue;
  };
  const append = async (
    type: string,
    context: {
      pairId?: string;
      executionId?: string;
      data?: Readonly<Record<string, unknown>>;
    } = {},
  ): Promise<void> => {
    const event = await ledger.append(type, context);
    state.lastLedgerSequence = event.sequence;
    await persistState();
    await notify(modules, event);
  };

  state.status = "running";
  await persistState();
  await append("run.started", {
    data: {
      resumed: isResumed,
      concurrency: config.concurrency,
      scenarioHash,
      skillHash,
      executorHash,
    },
  });

  const processRegistry = new ProcessRegistry(path.join(config.runDir, "processes.jsonl"));
  const activeProcesses = new Map<string, ProcessIdentity>();
  const processKey = (identity: ProcessIdentity): string =>
    `${identity.pid}\0${identity.startedAt}\0${identity.name.toLowerCase()}`;
  const trackProcessStarted =
    (owner: string) =>
    async (identity: ProcessIdentity): Promise<void> => {
      await processRegistry.recordStarted(owner, identity);
      activeProcesses.set(processKey(identity), identity);
    };
  const trackProcessExited =
    (owner: string) =>
    async (identity: ProcessIdentity): Promise<void> => {
      await processRegistry.recordExited(owner, identity);
      activeProcesses.delete(processKey(identity));
    };
  const activePairIds = new Set<string>();
  const cancellation = new AbortController();
  const pairFinished = (pair: PairState): boolean =>
    pairCompleted(pair) && (!modules.grader?.gradePair || Boolean(pair.gradedAt));
  let stopWatcherBusy = false;
  const heartbeat = async (): Promise<void> => {
    const value: Heartbeat = {
      schemaVersion: 1,
      runId: config.runId,
      controller: controllerIdentity,
      timestamp: new Date().toISOString(),
      status: state.status,
      activePairIds: [...activePairIds].sort(),
      activeProcesses: [...activeProcesses.values()].sort(
        (left, right) => left.pid - right.pid,
      ),
      completedPairs: Object.values(state.pairs).filter(pairFinished).length,
      totalPairs: Object.keys(state.pairs).length,
      admissionEndsAt: state.admissionEndsAt,
    };
    await writeAtomicJson(heartbeatPath, value);
    if (!stopWatcherBusy) {
      stopWatcherBusy = true;
      try {
        if (await exists(stopPath)) {
          state.status = "stopping";
          cancellation.abort(new Error("Stop requested"));
        }
      } finally {
        stopWatcherBusy = false;
      }
    }
  };
  await heartbeat();
  const heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error: unknown) => {
      state.status = "failed";
      state.failure = `Heartbeat failed: ${String(error)}`;
      cancellation.abort(error);
    });
  }, config.heartbeatMs);

  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const pendingPairIds = Object.entries(state.pairs)
    .filter(([, pair]) => !pairFinished(pair))
    .sort(([, left], [, right]) => Number(Boolean(right.admittedAt)) - Number(Boolean(left.admittedAt)))
    .map(([id]) => id);
  let nextPairIndex = 0;

  const runProbes = async (phase: "source" | "live"): Promise<void> => {
    const probes = (modules.probes ?? []).filter((probe) => probe.phase === phase);
    let nextProbeIndex = 0;
    const worker = async (): Promise<void> => {
      while (!cancellation.signal.aborted) {
        const index = nextProbeIndex;
        nextProbeIndex += 1;
        const probe = probes[index];
        if (!probe) {
          return;
        }
        await append("probe.started", { data: { probeId: probe.id, phase } });
        const artifact = await probe.run({
          soakRunId: config.runId,
          runDir: config.runDir,
          signal: cancellation.signal,
          onProcessStarted: trackProcessStarted(`probe:${phase}:${probe.id}`),
          onProcessExited: trackProcessExited(`probe:${phase}:${probe.id}`),
        });
        await append("probe.finished", {
          data: {
            probeId: probe.id,
            phase,
            status: artifact.status,
            artifactPath: artifact.artifactPath,
          },
        });
        if (artifact.status !== "completed") {
          throw new Error(`Required ${phase} probe failed: ${probe.id} (${artifact.status})`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(config.probeConcurrency, probes.length) }, () => worker()),
    );
  };

  const executeArm = async (
    id: string,
    pair: PairState,
    scenario: SoakScenario,
    arm: SoakArm,
  ): Promise<void> => {
    if (terminal(pair.arms[arm].status)) {
      return;
    }
    const executionId = `${id}-${arm}`;
    const attempt = pair.arms[arm].attempts + 1;
    const executionRoot = path.join(config.runDir, "pairs", id, arm, `attempt-${attempt}`);
    const workspace = await createIsolatedWorkspace({
      root: path.join(executionRoot, "workspace"),
      arm,
      scenario,
      skillSnapshotPath: config.skillSnapshotPath,
      repositoryRoot: config.repositoryRoot,
      soakRunId: config.runId,
    });
    const scenarioKeyHash = hashJson(scenario);
    const cacheKey = {
      soakRunId: config.runId,
      scenarioHash: scenarioKeyHash,
      arm,
      executorHash,
      skillHash,
    };
    const cached = await modules.cache?.get(cacheKey);
    if (cached) {
      const artifact = { ...cached, executionId, status: "cached" as const };
      const artifactPath = path.join(executionRoot, "artifact.json");
      await writeAtomicJson(artifactPath, artifact);
      pair.arms[arm] = { status: "cached", attempts: attempt, artifactPath };
      await append("execution.cached", { pairId: id, executionId });
      await persistState();
      return;
    }

    pair.arms[arm] = { status: "running", attempts: attempt };
    await persistState();
    await append("execution.started", { pairId: id, executionId, data: { arm } });
    let artifact = await modules.executor.execute(
      {
        executionId,
        scenario,
        arm,
        workspace,
        timeoutMs: config.timeoutMs,
        model: config.model,
        signal: cancellation.signal,
        onProcessStarted: trackProcessStarted(`execution:${executionId}`),
        onProcessExited: trackProcessExited(`execution:${executionId}`),
      },
      capabilities,
    );
    if (modules.grader?.grade) {
      artifact = { ...artifact, grade: await modules.grader.grade(artifact, scenario) };
    }
    const artifactPath = path.join(executionRoot, "artifact.json");
    await writeAtomicJson(artifactPath, artifact);
    pair.arms[arm] = { status: artifact.status, attempts: attempt, artifactPath };
    if (artifact.status === "completed") {
      await modules.cache?.put(cacheKey, artifact);
    }
    await append("execution.finished", {
      pairId: id,
      executionId,
      data: {
        arm,
        status: artifact.status,
        contamination: artifact.trace.contamination,
      },
    });
    await persistState();
  };

  const gradeCompletedPair = async (
    id: string,
    pair: PairState,
    scenario: SoakScenario,
  ): Promise<void> => {
    if (!modules.grader?.gradePair || pair.gradedAt) {
      return;
    }
    if (!pairCompleted(pair)) {
      throw new Error(`Cannot pair-grade incomplete pair ${id}`);
    }
    const artifacts = {} as Record<SoakArm, ExecutionArtifact>;
    for (const arm of ARMS) {
      const artifactPath = pair.arms[arm].artifactPath;
      if (!artifactPath) {
        throw new Error(`Pair ${id}/${arm} is missing its artifact path`);
      }
      const artifact = await readJsonIfExists<ExecutionArtifact>(artifactPath);
      if (!artifact) {
        throw new Error(`Pair ${id}/${arm} artifact disappeared: ${artifactPath}`);
      }
      artifacts[arm] = artifact;
    }
    const grades = await modules.grader.gradePair(artifacts, scenario, id);
    for (const arm of ARMS) {
      if (!grades[arm]) {
        throw new Error(`Pair grader omitted ${id}/${arm}`);
      }
      await writeAtomicJson(pair.arms[arm].artifactPath!, {
        ...artifacts[arm],
        grade: grades[arm],
      });
    }
    pair.gradedAt = new Date().toISOString();
    await append("pair.graded", { pairId: id });
    await persistState();
  };

  const worker = async (): Promise<void> => {
    while (!cancellation.signal.aborted) {
      if (await exists(stopPath)) {
        state.status = "stopping";
        cancellation.abort(new Error("Stop requested"));
        return;
      }
      const index = nextPairIndex;
      nextPairIndex += 1;
      const id = pendingPairIds[index];
      if (!id) {
        return;
      }
      const pair = state.pairs[id];
      const wasAdmitted = Boolean(pair.admittedAt);
      if (!wasAdmitted && Date.now() >= Date.parse(state.admissionEndsAt)) {
        state.status = "draining";
        return;
      }
      const scenario = scenarioById.get(pair.scenarioId);
      if (!scenario) {
        throw new Error(`Scenario disappeared during run: ${pair.scenarioId}`);
      }
      activePairIds.add(id);
      pair.admittedAt ??= new Date().toISOString();
      await append(wasAdmitted ? "pair.resumed" : "pair.admitted", {
        pairId: id,
        data: { armOrder: pair.armOrder },
      });
      await persistState();
      try {
        for (const arm of pair.armOrder) {
          await executeArm(id, pair, scenario, arm);
          if (cancellation.signal.aborted) {
            break;
          }
        }
        if (pairCompleted(pair)) {
          await gradeCompletedPair(id, pair, scenario);
          pair.completedAt = new Date().toISOString();
          await append("pair.finished", { pairId: id });
          await persistState();
        }
      } finally {
        activePairIds.delete(id);
      }
    }
  };

  let failure: unknown;
  try {
    await runProbes("source");
    await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
    if (!cancellation.signal.aborted) {
      await runProbes("live");
    }
  } catch (error) {
    failure = error;
    state.status = "failed";
    state.failure = error instanceof Error ? error.stack ?? error.message : String(error);
    cancellation.abort(error);
  } finally {
    clearInterval(heartbeatTimer);
    await persistQueue;
  }

  const finishedAt = new Date().toISOString();
  if (!failure) {
    state.status = cancellation.signal.aborted
      ? "stopping"
      : Object.values(state.pairs).every(pairFinished)
        ? "completed"
        : "draining";
  }
  state.finishedAt = finishedAt;
  await persistState();
  await append(failure ? "run.failed" : "run.finished", {
    data: { status: state.status, failure: state.failure },
  });
  await heartbeat();
  await ledger.flush();

  const arms = Object.values(state.pairs).flatMap((pair) => ARMS.map((arm) => pair.arms[arm]));
  const summary: RunSummary = {
    runId: config.runId,
    status: state.status,
    admittedPairs: Object.values(state.pairs).filter((pair) => pair.admittedAt).length,
    completedPairs: Object.values(state.pairs).filter(pairFinished).length,
    completedExecutions: arms.filter((arm) => terminal(arm.status)).length,
    failedExecutions: arms.filter((arm) =>
      ["failed", "timed-out", "cancelled"].includes(arm.status),
    ).length,
    startedAt: state.startedAt,
    finishedAt,
  };
  await writeAtomicJson(path.join(config.runDir, "summary.json"), summary);
  await modules.reporter?.finalize(summary);
  if (failure) {
    throw failure;
  }
  return summary;
}

export async function readRunStatus(runDir: string): Promise<Readonly<Record<string, unknown>>> {
  const [state, heartbeat, summary] = await Promise.all([
    readJsonIfExists<Record<string, unknown>>(path.join(runDir, "state.json")),
    readJsonIfExists<Record<string, unknown>>(path.join(runDir, "heartbeat.json")),
    readJsonIfExists<Record<string, unknown>>(path.join(runDir, "summary.json")),
  ]);
  return { runDir: path.resolve(runDir), state, heartbeat, summary };
}

export async function requestStop(runDir: string, reason = "operator request"): Promise<void> {
  await writeAtomicJson(path.join(runDir, "stop-request.json"), {
    requestedAt: new Date().toISOString(),
    requestedByPid: process.pid,
    reason,
  });
}
