import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { detectContamination } from "../core/isolation.js";
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
  },
): Promise<CapturedProcess> {
  let last: CapturedProcess | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    last = await capture(command, args, options);
    if (last.exitCode === 0) {
      return last;
    }
  }
  return last!;
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

  constructor(
    command = "copilot",
    options: { processManager?: ProcessManager; preflightTimeoutMs?: number } = {},
  ) {
    this.#command = command;
    this.#processManager = options.processManager ?? new SystemProcessManager();
    this.#preflightTimeoutMs = options.preflightTimeoutMs ?? 30_000;
  }

  async probe(workspaces: {
    readonly withoutSkill: IsolatedWorkspace;
    readonly withSkill: IsolatedWorkspace;
  }): Promise<ExecutorCapabilities> {
    const workspace = workspaces.withoutSkill;
    const executablePath = await resolveExecutable(
      this.#command,
      workspace,
      this.#preflightTimeoutMs,
      this.#processManager,
    );
    // CLI startup initializes profile state. Probe sequentially so concurrent initialization
    // cannot fall back to the operator profile while an isolated profile is being created.
    const executableBytes = await readFile(executablePath);
    const help = await captureSuccessful(executablePath, ["--help"], {
      cwd: workspace.projectDir,
      env: workspace.environment,
      timeoutMs: this.#preflightTimeoutMs,
      processManager: this.#processManager,
    });
    const version = await captureSuccessful(executablePath, ["--version"], {
      cwd: workspace.projectDir,
      env: workspace.environment,
      timeoutMs: this.#preflightTimeoutMs,
      processManager: this.#processManager,
    });
    const withoutSkills = await captureSuccessful(
      executablePath,
      ["--no-custom-instructions", "skill", "list", "--json"],
      {
        cwd: workspaces.withoutSkill.projectDir,
        env: workspaces.withoutSkill.environment,
        timeoutMs: this.#preflightTimeoutMs,
        processManager: this.#processManager,
      },
    );
    const withSkills = await captureSuccessful(
      executablePath,
      ["--no-custom-instructions", "skill", "list", "--json"],
      {
        cwd: workspaces.withSkill.projectDir,
        env: workspaces.withSkill.environment,
        timeoutMs: this.#preflightTimeoutMs,
        processManager: this.#processManager,
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
    const capabilities: ExecutorCapabilities = {
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
    };
    assertExecutorCapabilities(capabilities);
    return capabilities;
  }

  async execute(
    request: ExecutionRequest,
    capabilities: ExecutorCapabilities,
  ): Promise<ExecutionArtifact> {
    assertExecutorCapabilities(capabilities);
    const startedAt = new Date().toISOString();
    const stdoutFile = path.join(request.workspace.root, "stdout.jsonl");
    const stderrFile = path.join(request.workspace.root, "stderr.log");
    const traceFile = path.join(request.workspace.root, "process-trace.json");
    await mkdir(request.workspace.root, { recursive: true });
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
      request.workspace.logDir,
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
      hashTree(request.workspace.projectDir),
      hashTree(request.workspace.profileDir),
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
    const responseText = events
      .map((event) => {
        if (!event || typeof event !== "object") {
          return "";
        }
        const record = event as Record<string, unknown>;
        return typeof record.content === "string"
          ? record.content
          : typeof record.message === "string"
            ? record.message
            : "";
      })
      .filter(Boolean)
      .join("\n");

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
