import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { writeAtomicJson } from "../core/atomic.js";
import type { ProbeArtifact, ProbeContext, SoakProbe } from "../core/contracts.js";
import {
  SystemProcessManager,
  type ProcessManager,
  type TerminationResult,
} from "../core/process.js";

export interface DotnetTestProbeConfig {
  readonly id: string;
  readonly phase: "source" | "live";
  readonly workingDirectory: string;
  readonly projectPath: string;
  readonly selectors: ReadonlyArray<string>;
  readonly timeoutMinutes?: number;
  readonly maxConcurrency?: number;
  readonly noRestore?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
}

interface SelectorResult {
  readonly selector: string;
  readonly status: ProbeArtifact["status"];
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly stdoutFile: string;
  readonly stderrFile: string;
}

function safeName(value: string): string {
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 68)}-${suffix}`;
}

export class DotnetTestProbe implements SoakProbe {
  readonly id: string;
  readonly phase: "source" | "live";
  readonly #config: DotnetTestProbeConfig;
  readonly #processManager: ProcessManager;

  constructor(config: DotnetTestProbeConfig, processManager: ProcessManager = new SystemProcessManager()) {
    if (!config.id || config.selectors.length === 0) {
      throw new Error("Dotnet probe requires an id and at least one selector");
    }
    const maxConcurrency = config.maxConcurrency ?? 1;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4) {
      throw new Error(`Dotnet probe maxConcurrency must be from 1 through 4; got ${maxConcurrency}`);
    }
    this.id = config.id;
    this.phase = config.phase;
    this.#config = config;
    this.#processManager = processManager;
  }

  async run(context: ProbeContext): Promise<ProbeArtifact> {
    const startedAt = new Date().toISOString();
    const attemptId = `${Date.now()}-${process.pid}`;
    const root = path.join(
      context.runDir,
      "probes",
      safeName(this.id),
      this.phase,
      `attempt-${attemptId}`,
    );
    await mkdir(root, { recursive: true });
    const results: SelectorResult[] = [];
    let nextIndex = 0;
    const maxConcurrency = this.#config.maxConcurrency ?? 1;

    const runSelector = async (selector: string, index: number): Promise<SelectorResult> => {
      const selectorRoot = path.join(root, `${index + 1}-${safeName(selector)}`);
      await mkdir(selectorRoot, { recursive: true });
      const stdoutFile = path.join(selectorRoot, "stdout.log");
      const stderrFile = path.join(selectorRoot, "stderr.log");
      const stdout = createWriteStream(stdoutFile, { flags: "wx" });
      const stderr = createWriteStream(stderrFile, { flags: "wx" });
      const args = [
        "test",
        path.resolve(this.#config.projectPath),
        "--filter",
        selector,
        "--nologo",
      ];
      if (this.#config.noRestore) {
        args.push("--no-restore");
      }
      const localController = new AbortController();
      let timedOut = false;
      const forwardAbort = (): void => localController.abort(context.signal.reason);
      if (context.signal.aborted) {
        forwardAbort();
      } else {
        context.signal.addEventListener("abort", forwardAbort, { once: true });
      }
      const timeout = setTimeout(() => {
        timedOut = true;
        localController.abort(new Error("Dotnet probe timed out"));
      }, (this.#config.timeoutMinutes ?? 30) * 60 * 1_000);
      const selectorStartedAt = new Date().toISOString();
      const child = spawn("dotnet", args, {
        cwd: path.resolve(this.#config.workingDirectory),
        env: {
          ...process.env,
          ...this.#config.environment,
          SOAK_RUN_ID: context.soakRunId,
          AMR_SOAK_RUN_ID: context.soakRunId,
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child.pid) {
        throw new Error(`dotnet test did not expose a PID for selector ${selector}`);
      }
      const processIdentity = await this.#processManager.identify(child.pid);
      await context.onProcessStarted?.(processIdentity);
      let terminationPromise: Promise<TerminationResult> | undefined;
      const terminateTree = (): void => {
        terminationPromise ??= this.#processManager
          .terminateTree(processIdentity, async (descendants) => {
            for (const descendant of descendants) {
              await context.onProcessStarted?.(descendant);
            }
          })
          .then(async (result) => {
            for (const descendant of result.discovered) {
              await context.onProcessExited?.(descendant);
            }
            return result;
          });
      };
      if (localController.signal.aborted) {
        terminateTree();
      } else {
        localController.signal.addEventListener("abort", terminateTree, { once: true });
      }
      const pipeErrors: Error[] = [];
      const pipes = [
        pipeline(child.stdout, stdout).catch((error: Error) => pipeErrors.push(error)),
        pipeline(child.stderr, stderr).catch((error: Error) => pipeErrors.push(error)),
      ];
      let exitCode: number | null = null;
      let spawnError: Error | undefined;
      await new Promise<void>((resolve) => {
        child.on("error", (error) => {
          spawnError = error;
        });
        child.on("close", (code) => {
          exitCode = code;
          resolve();
        });
      }).finally(() => {
        clearTimeout(timeout);
        context.signal.removeEventListener("abort", forwardAbort);
      });
      await terminationPromise?.catch((error: Error) => {
        spawnError = error;
      });
      await context.onProcessExited?.(processIdentity);
      await Promise.all(pipes);
      if (pipeErrors.length > 0 && !spawnError) {
        spawnError = pipeErrors[0];
      }
      return {
        selector,
        status: timedOut
          ? "timed-out"
          : context.signal.aborted
            ? "cancelled"
            : exitCode === 0 && !spawnError
              ? "completed"
              : "failed",
        exitCode,
        startedAt: selectorStartedAt,
        finishedAt: new Date().toISOString(),
        stdoutFile,
        stderrFile,
      };
    };

    const worker = async (): Promise<void> => {
      while (!context.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        const selector = this.#config.selectors[index];
        if (!selector) {
          return;
        }
        results.push(await runSelector(selector, index));
      }
    };
    await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
    results.sort((left, right) => left.selector.localeCompare(right.selector));
    const finishedAt = new Date().toISOString();
    const status: ProbeArtifact["status"] = context.signal.aborted
      ? "cancelled"
      : results.some((result) => result.status === "timed-out")
        ? "timed-out"
        : results.some((result) => result.status === "failed")
          ? "failed"
          : "completed";
    const artifactPath = path.join(root, "artifact.json");
    await writeAtomicJson(artifactPath, {
      soakRunId: context.soakRunId,
      probeId: this.id,
      phase: this.phase,
      status,
      startedAt,
      finishedAt,
      config: {
        ...this.#config,
        workingDirectory: path.resolve(this.#config.workingDirectory),
        projectPath: path.resolve(this.#config.projectPath),
      },
      results,
    });
    return {
      soakRunId: context.soakRunId,
      probeId: this.id,
      phase: this.phase,
      status,
      startedAt,
      finishedAt,
      artifactPath,
    };
  }
}
