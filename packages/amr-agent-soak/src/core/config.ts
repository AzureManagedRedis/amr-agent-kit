import path from "node:path";

export interface SoakConfig {
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly outputRoot?: string;
  readonly skillSnapshotPath: string;
  readonly concurrency?: number;
  readonly repetitions?: number;
  readonly durationHours?: number;
  readonly timeoutMinutes?: number;
  readonly heartbeatSeconds?: number;
  readonly probeConcurrency?: number;
  readonly model?: string;
}

export interface NormalizedSoakConfig {
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly outputRoot: string;
  readonly runDir: string;
  readonly skillSnapshotPath: string;
  readonly concurrency: number;
  readonly repetitions: number;
  readonly durationMs: number;
  readonly timeoutMs: number;
  readonly heartbeatMs: number;
  readonly probeConcurrency: number;
  readonly model?: string;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function normalizeConfig(config: SoakConfig): NormalizedSoakConfig {
  if (!RUN_ID_PATTERN.test(config.runId)) {
    throw new Error(`Invalid runId: ${config.runId}`);
  }

  const concurrency = config.concurrency ?? 14;
  if (!Number.isInteger(concurrency) || concurrency < 12 || concurrency > 16) {
    throw new Error(`concurrency must be an integer from 12 through 16; got ${concurrency}`);
  }

  const repetitions = config.repetitions ?? 1;
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error(`repetitions must be a positive integer; got ${repetitions}`);
  }

  const durationHours = config.durationHours ?? 48;
  const timeoutMinutes = config.timeoutMinutes ?? 30;
  const heartbeatSeconds = config.heartbeatSeconds ?? 5;
  for (const [name, value] of [
    ["durationHours", durationHours],
    ["timeoutMinutes", timeoutMinutes],
    ["heartbeatSeconds", heartbeatSeconds],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be positive; got ${value}`);
    }
  }
  const probeConcurrency = config.probeConcurrency ?? 2;
  if (!Number.isInteger(probeConcurrency) || probeConcurrency < 1 || probeConcurrency > 4) {
    throw new Error(`probeConcurrency must be an integer from 1 through 4; got ${probeConcurrency}`);
  }

  const repositoryRoot = path.resolve(config.repositoryRoot);
  const outputRoot = path.resolve(config.outputRoot ?? path.join(repositoryRoot, "eval-runs"));
  return {
    runId: config.runId,
    repositoryRoot,
    outputRoot,
    runDir: path.join(outputRoot, config.runId),
    skillSnapshotPath: path.resolve(config.skillSnapshotPath),
    concurrency,
    repetitions,
    durationMs: durationHours * 60 * 60 * 1_000,
    timeoutMs: timeoutMinutes * 60 * 1_000,
    heartbeatMs: heartbeatSeconds * 1_000,
    probeConcurrency,
    model: config.model,
  };
}
