import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  ExecutionArtifact,
  ExecutionRequest,
  ExecutorCapabilities,
  HeadlessExecutor,
  IsolatedWorkspace,
} from "../core/contracts.js";
import { writeAtomicJson } from "../core/atomic.js";
import { detectContamination, hashIsolatedProfile } from "../core/isolation.js";
import { hashBytes, hashTree } from "../core/hash.js";
import {
  SystemProcessManager,
  type ProcessManager,
  waitForChildTermination,
} from "../core/process.js";

interface CapturedProcess {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function isBundledExtractionRace(output: string): boolean {
  return /Failed to extract bundled package|EPERM: operation not permitted, rename/i.test(output);
}

export function preflightRetryDelayMs(attempt: number): number {
  return 500 * 2 ** attempt;
}

interface RetryAttempt<T> {
  readonly value: T;
  readonly failed: boolean;
  readonly stderr: string;
}

const EXTRACTION_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;

export function isPackageExtractionRace(stderr: string): boolean {
  return (
    /failed to extract bundled package/i.test(stderr) &&
    /\bEPERM\b/i.test(stderr) &&
    /\brename\b/i.test(stderr) &&
    /\.extracting-/i.test(stderr)
  );
}

export async function runExtractionRetry<T>(
  attempt: (attemptNumber: number) => Promise<RetryAttempt<T>>,
  options: {
    cleanup: () => Promise<void>;
    sleep?: (delayMs: number) => Promise<void>;
    shouldStop?: () => boolean;
  },
): Promise<T> {
  const sleep =
    options.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let last: RetryAttempt<T> | undefined;
  for (let attemptNumber = 1; attemptNumber <= 4; attemptNumber += 1) {
    last = await attempt(attemptNumber);
    if (
      !last.failed ||
      !isPackageExtractionRace(last.stderr) ||
      attemptNumber === 4 ||
      options.shouldStop?.()
    ) {
      return last.value;
    }
    await options.cleanup();
    await sleep(EXTRACTION_RETRY_DELAYS_MS[attemptNumber - 1]);
    if (options.shouldStop?.()) {
      return last.value;
    }
  }
  return last!.value;
}

export function extractFinalResponseText(events: ReadonlyArray<unknown>): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== "object") {
      continue;
    }
    const record = event as Record<string, unknown>;
    if (record.type === "assistant.message") {
      if (record.data && typeof record.data === "object") {
        const content = (record.data as Record<string, unknown>).content;
        if (typeof content === "string") {
          return content;
        }
      }
      if (typeof record.content === "string") {
        return record.content;
      }
      if (typeof record.message === "string") {
        return record.message;
      }
    }
  }
  return "";
}

export async function cleanExtractionDirectories(workspace: IsolatedWorkspace): Promise<void> {
  const localAppData = workspace.environment.LOCALAPPDATA;
  if (!localAppData) {
    return;
  }
  const root = path.resolve(localAppData);
  async function visit(current: string, depth: number): Promise<void> {
    if (depth > 6) {
      return;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.resolve(current, entry.name);
      if (!candidate.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Refusing extraction cleanup outside isolated LOCALAPPDATA: ${candidate}`);
      }
      if (
        path.relative(root, candidate).split(path.sep).join("/").toLowerCase() ===
        "copilot/pkg"
      ) {
        continue;
      }
      if (entry.name.startsWith(".extracting-")) {
        await rm(candidate, { recursive: true, force: true });
      } else {
        await visit(candidate, depth + 1);
      }
    }
  }
  await visit(root, 0);
}

async function capture(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    processManager: ProcessManager;
  },
): Promise<CapturedProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    let timedOut = false;
    const identityPromise = child.pid
      ? options.processManager.identify(child.pid).catch(() => undefined)
      : Promise.resolve(undefined);
    const timeout = setTimeout(() => {
      timedOut = true;
      void identityPromise.then(async (identity) => {
        if (identity) {
          await options.processManager.terminateTree(identity);
        } else if (child.pid) {
          child.kill("SIGKILL");
        }
      }).catch(reject);
    }, options.timeoutMs);
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Process timed out after ${options.timeoutMs}ms: ${command}`));
      } else {
        resolve({ pid: child.pid ?? -1, exitCode, signal, stdout, stderr });
      }
    });
  });
}

async function resolveExecutable(
  command: string,
  workspace: IsolatedWorkspace,
  timeoutMs: number,
  processManager: ProcessManager,
): Promise<string> {
  const resolver = process.platform === "win32" ? "where.exe" : "which";
  const result = await capture(resolver, [command], {
    cwd: workspace.projectDir,
    env: workspace.environment,
    timeoutMs,
    processManager,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to resolve ${command}: ${result.stderr || result.stdout}`);
  }
  const executablePath = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!executablePath) {
    throw new Error(`Resolver returned no path for ${command}`);
  }
  return path.resolve(executablePath);
}

async function captureSuccessful(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    processManager: ProcessManager;
    workspace: IsolatedWorkspace;
    label: string;
  },
): Promise<CapturedProcess> {
  const captureRoot = path.join(options.workspace.root, "preflight-captures");
  await mkdir(captureRoot, { recursive: true });
  return runExtractionRetry(
    async (attemptNumber) => {
      const result = await capture(command, args, options);
      const prefix = path.join(
        captureRoot,
        `${options.label}.attempt-${attemptNumber}`,
      );
      await Promise.all([
        writeFile(`${prefix}.stdout.log`, result.stdout),
        writeFile(`${prefix}.stderr.log`, result.stderr),
      ]);
      return {
        value: result,
        failed: result.exitCode !== 0,
        stderr: result.stderr,
      };
    },
    { cleanup: () => cleanExtractionDirectories(options.workspace) },
  );
}

export function assertExecutorCapabilities(capabilities: ExecutorCapabilities): void {
  const missing = Object.entries({
    prompt: capabilities.supportsPrompt,
    jsonOutput: capabilities.supportsJsonOutput,
    noAskUser: capabilities.supportsNoAskUser,
    toolApproval: capabilities.supportsToolApproval,
    instructionDisable: capabilities.supportsInstructionDisable,
    mcpDisable: capabilities.supportsMcpDisable,
    noRemote: capabilities.supportsNoRemote,
    noRemoteExport: capabilities.supportsNoRemoteExport,
    noAutoUpdate: capabilities.supportsNoAutoUpdate,
    streamControl: capabilities.supportsStreamControl,
  })
    .filter(([, supported]) => !supported)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Copilot CLI cannot prove required headless controls: ${missing.join(", ")}`);
  }
}

export function assertCalibratedModels(
  capabilities: ExecutorCapabilities,
  requestedModels: ReadonlyArray<string>,
): void {
  const calibratedModels = Array.isArray(capabilities.calibratedModels)
    ? capabilities.calibratedModels
    : [];
  const calibrated = new Set(calibratedModels.map((model) => model.toLowerCase()));
  const missing = requestedModels.filter((model) => !calibrated.has(model.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(`Copilot CLI did not calibrate configured models: ${missing.join(", ")}`);
  }
}

export function assertCalibrationArtifact(
  artifact: ExecutionArtifact,
  parentSessionMarkers: ReadonlyArray<string> = [],
  expectedModel?: string,
): string | undefined {
  if (artifact.status !== "completed" || artifact.trace.exitCode !== 0) {
    throw new Error(
      `Calibration execution failed (${artifact.status}, exit ${artifact.trace.exitCode}); stderr: ${artifact.trace.stderrFile}`,
    );
  }
  if (
    artifact.events.length === 0 ||
    artifact.events.some(
      (event) =>
        event &&
        typeof event === "object" &&
        (event as Record<string, unknown>).type === "unparsed",
    )
  ) {
    throw new Error("Calibration execution did not produce a valid JSON event stream");
  }
  const serialized = JSON.stringify(artifact.events).toLowerCase();
  const forbidden = [
    "todo_status",
    "inbox_entries",
    "agency_session",
    "session attachment",
    "unable to open database file",
    ...parentSessionMarkers.map((marker) => marker.toLowerCase()),
  ].filter((marker) => serialized.includes(marker));
  if (forbidden.length > 0) {
    throw new Error(
      `Calibration execution inherited parent session content: ${forbidden.join(", ")}`,
    );
  }
  if (artifact.responseText.trim() !== "CALIBRATION_OK") {
    throw new Error(
      `Calibration execution returned an unexpected response: ${artifact.responseText.trim() || "<empty>"}`,
    );
  }
  const servedModels = new Set(
    artifact.events.flatMap((event) => {
      if (!event || typeof event !== "object") return [];
      const record = event as Record<string, unknown>;
      if (!["assistant.turn_start", "assistant.message", "assistant.turn_end"].includes(String(record.type))) {
        return [];
      }
      const data = record.data;
      if (!data || typeof data !== "object") return [];
      const model = (data as Record<string, unknown>).model;
      return typeof model === "string" && model.length > 0 ? [model] : [];
    }),
  );
  if (expectedModel) {
    if (servedModels.size === 0) {
      throw new Error(`Calibration execution did not report a served model for ${expectedModel}`);
    }
    const mismatch = [...servedModels].filter(
      (model) => model.toLowerCase() !== expectedModel.toLowerCase(),
    );
    if (mismatch.length > 0) {
      throw new Error(
        `Calibration requested ${expectedModel} but the CLI served ${mismatch.join(", ")}`,
      );
    }
  }
  return servedModels.size === 1 ? [...servedModels][0] : expectedModel;
}

export function responseTextFromEvents(events: ReadonlyArray<unknown>): string {
  const text = (record: Record<string, unknown>, delta = false): string => {
    const data =
      record.data && typeof record.data === "object"
        ? (record.data as Record<string, unknown>)
        : undefined;
    if (delta && typeof data?.deltaContent === "string") {
      return data.deltaContent;
    }
    return typeof data?.content === "string"
      ? data.content
      : typeof data?.message === "string"
        ? data.message
        : typeof record.content === "string"
          ? record.content
          : typeof record.message === "string"
            ? record.message
            : "";
  };
  const records = events.filter(
    (event): event is Record<string, unknown> => !!event && typeof event === "object",
  );
  const messages = records
    .filter((record) => record.type === "assistant.message")
    .map((record) => text(record))
    .filter(Boolean);
  if (messages.length > 0) {
    return messages.join("\n");
  }
  const deltas = records
    .filter((record) => record.type === "assistant.message_delta")
    .map((record) => text(record, true))
    .filter(Boolean);
  if (deltas.length > 0) {
    return deltas.join("");
  }
  return records
    .filter((record) => record.type === undefined)
    .map((record) => text(record))
    .filter(Boolean)
    .join("\n");
}

function skillRecords(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
  ) {
    throw new Error("Copilot CLI skill discovery returned an unexpected shape");
  }
  return value as ReadonlyArray<Record<string, unknown>>;
}

export class CopilotCliExecutor implements HeadlessExecutor {
  readonly #command: string;
  readonly #processManager: ProcessManager;
  readonly #preflightTimeoutMs: number;
  readonly #hashProject: (directory: string) => Promise<string>;
  readonly #hashProfile: (directory: string) => Promise<string>;

  constructor(
    command = "copilot",
    options: {
      processManager?: ProcessManager;
      preflightTimeoutMs?: number;
      hashProject?: (directory: string) => Promise<string>;
      hashProfile?: (directory: string) => Promise<string>;
    } = {},
  ) {
    this.#command = command;
    this.#processManager = options.processManager ?? new SystemProcessManager();
    this.#preflightTimeoutMs = options.preflightTimeoutMs ?? 120_000;
    this.#hashProject = options.hashProject ?? hashTree;
    this.#hashProfile = options.hashProfile ?? hashIsolatedProfile;
  }

  async probe(workspaces: {
    readonly withoutSkill: IsolatedWorkspace;
    readonly withSkill: IsolatedWorkspace;
    readonly calibrations: ReadonlyArray<{
      readonly workspace: IsolatedWorkspace;
      readonly model?: string;
    }>;
  }): Promise<ExecutorCapabilities> {
    const workspace = workspaces.withoutSkill;
    const packageCaches = [
      workspaces.withoutSkill.packageCache,
      workspaces.withSkill.packageCache,
      ...workspaces.calibrations.map((calibration) => calibration.workspace.packageCache),
    ];
    if (
      packageCaches.some(
        (cache) =>
          cache.sourcePath !== packageCaches[0].sourcePath ||
          cache.metadataHash !== packageCaches[0].metadataHash,
      )
    ) {
      throw new Error("Isolated workspaces do not share one trusted Copilot package cache");
    }
    const executablePath = await resolveExecutable(
      this.#command,
      workspace,
      this.#preflightTimeoutMs,
      this.#processManager,
    );
    // CLI startup initializes profile state. Probe sequentially so concurrent initialization
    // cannot fall back to the operator profile while an isolated profile is being created.
    const executableBytes = await readFile(executablePath);
    const help = await captureSuccessful(executablePath, ["--no-auto-update", "--help"], {
      cwd: workspace.projectDir,
      env: workspace.environment,
      timeoutMs: this.#preflightTimeoutMs,
      processManager: this.#processManager,
      workspace,
      label: "help",
    });
    const version = await captureSuccessful(executablePath, ["--no-auto-update", "--version"], {
      cwd: workspace.projectDir,
      env: workspace.environment,
      timeoutMs: this.#preflightTimeoutMs,
      processManager: this.#processManager,
      workspace,
      label: "version",
    });
    const withoutSkills = await captureSuccessful(
      executablePath,
      ["--no-auto-update", "--no-custom-instructions", "skill", "list", "--json"],
      {
        cwd: workspaces.withoutSkill.projectDir,
        env: workspaces.withoutSkill.environment,
        timeoutMs: this.#preflightTimeoutMs,
        processManager: this.#processManager,
        workspace: workspaces.withoutSkill,
        label: "without-skill-list",
      },
    );
    const withSkills = await captureSuccessful(
      executablePath,
      ["--no-auto-update", "--no-custom-instructions", "skill", "list", "--json"],
      {
        cwd: workspaces.withSkill.projectDir,
        env: workspaces.withSkill.environment,
        timeoutMs: this.#preflightTimeoutMs,
        processManager: this.#processManager,
        workspace: workspaces.withSkill,
        label: "with-skill-list",
      },
    );
    if (
      help.exitCode !== 0 ||
      version.exitCode !== 0 ||
      withoutSkills.exitCode !== 0 ||
      withSkills.exitCode !== 0
    ) {
      throw new Error(
        `Copilot CLI probe failed: ${help.stderr || version.stderr || withoutSkills.stderr || withSkills.stderr}`,
      );
    }
    let withoutSkillList: unknown;
    let withSkillList: unknown;
    try {
      withoutSkillList = JSON.parse(withoutSkills.stdout);
      withSkillList = JSON.parse(withSkills.stdout);
    } catch (error) {
      throw new Error(`Copilot CLI skill discovery did not return valid JSON: ${String(error)}`);
    }
    const pinnedSkillName = workspaces.withSkill.pinnedSkillName?.toLowerCase();
    if (!pinnedSkillName) {
      throw new Error("With-skill preflight has no pinned skill name");
    }
    const isAmrSkill = (record: Record<string, unknown>): boolean => {
      const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
      return (
        name === pinnedSkillName ||
        name === "redis-code" ||
        name === "azure-redis-infra" ||
        name.includes("amr-agent")
      );
    };
    const amrWithout = skillRecords(withoutSkillList).filter(isAmrSkill);
    if (amrWithout.length > 0) {
      throw new Error(
        `Without-skill preflight discovered AMR skill contamination: ${JSON.stringify(amrWithout)}`,
      );
    }
    const copiedSkillRoot = path.join(workspaces.withSkill.profileDir, ".copilot", "skills");
    const externalWith = skillRecords(withSkillList).filter((record) => record.source !== "builtin");
    const copiedRootPrefix = `${path.resolve(copiedSkillRoot).toLowerCase()}${path.sep}`;
    const pinnedRecords = externalWith.filter(
      (record) =>
        typeof record.path === "string" &&
        `${path.resolve(record.path).toLowerCase()}${path.sep}`.startsWith(copiedRootPrefix),
    );
    const externalAmrRecords = externalWith.filter(
      (record) => isAmrSkill(record) && !pinnedRecords.includes(record),
    );
    if (pinnedRecords.length !== 1 || externalAmrRecords.length > 0) {
      throw new Error("With-skill preflight could not prove discovery of the pinned skill snapshot");
    }
    const isolationFindings = await detectContamination(workspaces.withoutSkill, []);
    if (isolationFindings.length > 0) {
      throw new Error(
        `Without-skill preflight created contaminated state: ${isolationFindings.join(", ")}`,
      );
    }
    const text = help.stdout;
    let capabilities: ExecutorCapabilities = {
      executablePath,
      executableHash: hashBytes(executableBytes),
      version: version.stdout.trim(),
      helpHash: hashBytes(text),
      supportsPrompt: /(?:-p,\s*)?--prompt\b/.test(text),
      supportsJsonOutput: /--output-format\b[\s\S]*json/.test(text),
      supportsNoAskUser: /--no-ask-user\b/.test(text),
      supportsToolApproval: /--allow-all-tools\b/.test(text),
      supportsInstructionDisable: /--no-custom-instructions\b/.test(text),
      supportsMcpDisable: /--disable-builtin-mcps\b/.test(text),
      supportsNoRemote: /--no-remote\b/.test(text),
      supportsNoRemoteExport: /--no-remote-export\b/.test(text),
      supportsNoAutoUpdate: /--no-auto-update\b/.test(text),
      supportsStreamControl: /--stream\s+<mode>[\s\S]*(?:on|off)/.test(text),
      calibratedModels: [],
      packageCacheHash: packageCaches[0].metadataHash,
      packageCacheSource: packageCaches[0].sourcePath,
    };
    assertExecutorCapabilities(capabilities);
    const calibratedModels: string[] = [];
    for (const [index, calibration] of workspaces.calibrations.entries()) {
      const warmup = await captureSuccessful(
        executablePath,
        ["--no-auto-update", "--version"],
        {
          cwd: calibration.workspace.projectDir,
          env: calibration.workspace.environment,
          timeoutMs: this.#preflightTimeoutMs,
          processManager: this.#processManager,
          workspace: calibration.workspace,
          label: "calibration-warmup",
        },
      );
      if (warmup.exitCode !== 0) {
        throw new Error(
          `Calibration profile warmup failed: ${warmup.stderr || warmup.stdout}`,
        );
      }
      const warmedWorkspace: IsolatedWorkspace = {
        ...calibration.workspace,
        profileHash: await this.#hashProfile(calibration.workspace.profileDir),
      };
      const artifact = await this.execute(
        {
          executionId: `preflight-calibration-${index + 1}`,
          scenario: {
            id: `preflight-calibration-${index + 1}`,
            prompt: "Reply with exactly CALIBRATION_OK. Do not call tools.",
          },
          arm: "without-skill",
          workspace: warmedWorkspace,
          timeoutMs: this.#preflightTimeoutMs,
          model: calibration.model,
          signal: new AbortController().signal,
        },
        capabilities,
      );
      const servedModel = assertCalibrationArtifact(
        artifact,
        warmedWorkspace.parentSessionMarkers,
        calibration.model,
      );
      calibratedModels.push(servedModel ?? calibration.model ?? "auto");
    }
    capabilities = { ...capabilities, calibratedModels };
    return capabilities;
  }

  async execute(
    request: ExecutionRequest,
    capabilities: ExecutorCapabilities,
  ): Promise<ExecutionArtifact> {
    assertExecutorCapabilities(capabilities);
    try {
      return await runExtractionRetry(
        async (attemptNumber) => {
          const attemptRequest: ExecutionRequest = {
            ...request,
            workspace: {
              ...request.workspace,
              projectHash: await this.#hashProject(request.workspace.projectDir),
              profileHash: await this.#hashProfile(request.workspace.profileDir),
            },
          };
          const artifact = await this.#executeAttempt(
            attemptRequest,
            capabilities,
            attemptNumber,
          );
          const stderr = await readFile(artifact.trace.stderrFile, "utf8");
          return {
            value: artifact,
            failed:
              artifact.status === "failed" &&
              artifact.trace.exitCode !== 0 &&
              !artifact.trace.timedOut &&
              !artifact.trace.cancelled,
            stderr,
          };
        },
        {
          cleanup: () => cleanExtractionDirectories(request.workspace),
          shouldStop: () => request.signal.aborted,
        },
      );
    } catch (error) {
      return this.#createFailureArtifact(request, capabilities, error);
    }
  }

  async #createFailureArtifact(
    request: ExecutionRequest,
    capabilities: ExecutorCapabilities,
    error: unknown,
  ): Promise<ExecutionArtifact> {
    const timestamp = new Date().toISOString();
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    const stderrFile = path.join(request.workspace.root, "stderr.failure.log");
    const stdoutFile = path.join(request.workspace.root, "stdout.failure.jsonl");
    const traceFile = path.join(request.workspace.root, "process-trace.failure.json");
    await mkdir(request.workspace.root, { recursive: true });
    await Promise.all([writeFile(stderrFile, message), writeFile(stdoutFile, "")]);
    const status: ExecutionArtifact["status"] = request.signal.aborted ? "cancelled" : "failed";
    const trace = {
      executablePath: capabilities.executablePath,
      executableHash: capabilities.executableHash,
      args: [],
      cwd: request.workspace.projectDir,
      pid: 0,
      attemptNumber: 0,
      processIdentity: { pid: 0, startedAt: timestamp, name: "not-started" },
      descendants: [],
      startedAt: timestamp,
      finishedAt: timestamp,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: request.signal.aborted,
      executionError: message,
      stdoutFile,
      stderrFile,
      projectHashBefore: request.workspace.projectHash,
      projectHashAfter: request.workspace.projectHash,
      profileHashBefore: request.workspace.profileHash,
      profileHashAfter: request.workspace.profileHash,
      profileHashExclusions: request.workspace.profileHashExclusions,
      contamination: [],
    };
    await writeAtomicJson(traceFile, trace);
    return {
      soakRunId: request.workspace.environment.SOAK_RUN_ID ?? "unknown",
      executionId: request.executionId,
      scenarioId: request.scenario.id,
      arm: request.arm,
      status,
      startedAt: timestamp,
      finishedAt: timestamp,
      responseText: "",
      events: [],
      trace,
    };
  }

  async #executeAttempt(
    request: ExecutionRequest,
    capabilities: ExecutorCapabilities,
    attemptNumber: number,
  ): Promise<ExecutionArtifact> {
    const startedAt = new Date().toISOString();
    const attemptSuffix = `attempt-${attemptNumber}`;
    const stdoutFile = path.join(request.workspace.root, `stdout.${attemptSuffix}.jsonl`);
    const stderrFile = path.join(request.workspace.root, `stderr.${attemptSuffix}.log`);
    const traceFile = path.join(request.workspace.root, `process-trace.${attemptSuffix}.json`);
    const attemptLogDir = path.join(request.workspace.logDir, attemptSuffix);
    await Promise.all([
      mkdir(request.workspace.root, { recursive: true }),
      mkdir(attemptLogDir, { recursive: true }),
    ]);
    await Promise.all([writeFile(stdoutFile, ""), writeFile(stderrFile, "")]);

    const args = [
      "-C",
      request.workspace.projectDir,
      "--prompt",
      request.scenario.prompt,
      "--output-format",
      "json",
      "--allow-all-tools",
      "--no-ask-user",
      "--no-custom-instructions",
      "--disable-builtin-mcps",
      "--no-auto-update",
      "--no-remote",
      "--no-remote-export",
      "--stream",
      "off",
      "--log-dir",
      attemptLogDir,
    ];
    if (request.model) {
      args.push("--model", request.model);
    }

    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const forwardAbort = (): void => {
      cancelled = true;
      controller.abort(request.signal.reason);
    };
    if (request.signal.aborted) {
      forwardAbort();
    } else {
      request.signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Execution timed out after ${request.timeoutMs}ms`));
    }, request.timeoutMs);

    const stdout = createWriteStream(stdoutFile, { flags: "a" });
    const stderr = createWriteStream(stderrFile, { flags: "a" });
    const child = spawn(capabilities.executablePath, args, {
      cwd: request.workspace.projectDir,
      env: request.workspace.environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (!pid) {
      clearTimeout(timeout);
      throw new Error("Copilot CLI did not expose a process id");
    }
    const processIdentity = await this.#processManager.identify(pid);
    await request.onProcessStarted?.(processIdentity);
    const terminateTree = async (): Promise<import("../core/process.js").TerminationResult> =>
      this.#processManager
        .terminateTree(processIdentity, async (descendants) => {
          for (const descendant of descendants) {
            await request.onProcessStarted?.(descendant);
          }
        })
        .then(async (result) => {
          const killed = new Set(result.killed.map((identity) => identity.pid));
          for (const descendant of result.discovered.filter((identity) => killed.has(identity.pid))) {
            await request.onProcessExited?.(descendant);
          }
          return result;
        });
    const pipeErrors: Error[] = [];
    const stdoutPipeline = pipeline(child.stdout, stdout).catch((error: Error) => {
      pipeErrors.push(error);
    });
    const stderrPipeline = pipeline(child.stderr, stderr).catch((error: Error) => {
      pipeErrors.push(error);
    });

    const outcome = await waitForChildTermination(child, controller.signal, terminateTree);
    const exitCode = outcome.exitCode;
    const exitSignal = outcome.signal;
    let spawnError = outcome.error;
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", forwardAbort);
    if (outcome.closed) {
      await request.onProcessExited?.(processIdentity);
    } else {
      child.stdout.destroy(outcome.error);
      child.stderr.destroy(outcome.error);
      stdout.destroy(outcome.error);
      stderr.destroy(outcome.error);
    }
    await Promise.all([stdoutPipeline, stderrPipeline]);
    if (pipeErrors.length > 0 && !spawnError) {
      spawnError = pipeErrors[0];
    }

    const finishedAt = new Date().toISOString();
    const [projectHashAfter, profileHashAfter, stdoutText] = await Promise.all([
      this.#hashProject(request.workspace.projectDir),
      this.#hashProfile(request.workspace.profileDir),
      readFile(stdoutFile, "utf8"),
    ]);
    const contamination = await detectContamination(request.workspace, [stdoutFile, stderrFile]);
    const events = stdoutText
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return { type: "unparsed", text: line };
        }
      });
    const responseText = extractFinalResponseText(events);

    const status: ExecutionArtifact["status"] = timedOut
      ? "timed-out"
      : cancelled
        ? "cancelled"
        : exitCode === 0 && contamination.length === 0 && !spawnError
          ? "completed"
          : "failed";
    const trace = {
      executablePath: capabilities.executablePath,
      executableHash: capabilities.executableHash,
      args,
      cwd: request.workspace.projectDir,
      pid,
      attemptNumber,
      processIdentity,
      descendants: outcome.terminationResult?.discovered ?? [],
      startedAt,
      finishedAt,
      exitCode,
      signal: exitSignal,
      timedOut,
      cancelled,
      terminationError: outcome.error?.message,
      stdoutFile,
      stderrFile,
      projectHashBefore: request.workspace.projectHash,
      projectHashAfter,
      profileHashBefore: request.workspace.profileHash,
      profileHashAfter,
      profileHashExclusions: request.workspace.profileHashExclusions,
      contamination,
    };
    await writeAtomicJson(traceFile, trace);
    return {
      soakRunId: request.workspace.environment.SOAK_RUN_ID ?? "unknown",
      executionId: request.executionId,
      scenarioId: request.scenario.id,
      arm: request.arm,
      status,
      startedAt,
      finishedAt,
      responseText,
      events,
      trace,
    };
  }
}
