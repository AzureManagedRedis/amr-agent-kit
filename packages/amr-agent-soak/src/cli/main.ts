#!/usr/bin/env node
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ScenarioProvider,
  SoakCache,
  SoakGrader,
  SoakModules,
  SoakReporter,
} from "../core/contracts.js";
import type { SoakConfig } from "../core/config.js";
import { createIsolatedWorkspace } from "../core/isolation.js";
import { readRunStatus, requestStop, runSoak } from "../core/controller.js";
import { CopilotCliExecutor } from "../executor/copilot-cli.js";
import {
  DotnetTestProbe,
  type DotnetTestProbeConfig,
} from "../executor/dotnet-test-probe.js";

interface ControllerFile extends SoakConfig {
  readonly scenarioModule: string;
  readonly cacheModule?: string;
  readonly graderModule?: string;
  readonly reporterModule?: string;
  readonly copilotCommand?: string;
  readonly dotnetProbes?: ReadonlyArray<DotnetTestProbeConfig>;
}

function option(args: ReadonlyArray<string>, name: string, required = true): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && !value) {
    throw new Error(`Missing required option ${name}`);
  }
  return value;
}

async function importExport<T>(modulePath: string, exportName: string): Promise<T> {
  const module = (await import(pathToFileURL(path.resolve(modulePath)).href)) as Record<string, unknown>;
  const value = module[exportName];
  if (!value) {
    throw new Error(`${modulePath} does not export ${exportName}`);
  }
  return value as T;
}

async function controller(configPath: string): Promise<void> {
  const config = JSON.parse(await readFile(path.resolve(configPath), "utf8")) as ControllerFile;
  const modules: SoakModules = {
    scenarios: await importExport<ScenarioProvider>(config.scenarioModule, "scenarioProvider"),
    executor: new CopilotCliExecutor(config.copilotCommand),
    cache: config.cacheModule
      ? await importExport<SoakCache>(config.cacheModule, "cacheModule")
      : undefined,
    grader: config.graderModule
      ? await importExport<SoakGrader>(config.graderModule, "graderModule")
      : undefined,
    reporter: config.reporterModule
      ? await importExport<SoakReporter>(config.reporterModule, "reporterModule")
      : undefined,
    probes: config.dotnetProbes?.map((probe) => new DotnetTestProbe(probe)),
  };
  const summary = await runSoak(config, modules);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function preflight(configPath: string): Promise<void> {
  const config = JSON.parse(await readFile(path.resolve(configPath), "utf8")) as ControllerFile;
  const runRoot = path.join(
    path.resolve(config.outputRoot ?? path.join(config.repositoryRoot, "eval-runs")),
    config.runId,
    "preflight-cli",
  );
  await rm(runRoot, { recursive: true, force: true });
  const workspace = await createIsolatedWorkspace({
    root: path.join(runRoot, "without-skill"),
    arm: "without-skill",
    scenario: { id: "preflight", prompt: "preflight" },
    skillSnapshotPath: path.resolve(config.skillSnapshotPath),
    repositoryRoot: path.resolve(config.repositoryRoot),
    soakRunId: config.runId,
  });
  const withSkill = await createIsolatedWorkspace({
    root: path.join(runRoot, "with-skill"),
    arm: "with-skill",
    scenario: { id: "preflight", prompt: "preflight" },
    skillSnapshotPath: path.resolve(config.skillSnapshotPath),
    repositoryRoot: path.resolve(config.repositoryRoot),
    soakRunId: config.runId,
  });
  const capabilities = await new CopilotCliExecutor(config.copilotCommand).probe({
    withoutSkill: workspace,
    withSkill,
  });
  process.stdout.write(`${JSON.stringify(capabilities, null, 2)}\n`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function janitor(runDir: string, controllerPid: number): Promise<void> {
  while (isAlive(controllerPid)) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const status = await readRunStatus(runDir);
  const heartbeat = status.heartbeat as { controllerPid?: number; activePids?: number[] } | undefined;
  if (heartbeat?.controllerPid !== controllerPid) {
    return;
  }
  for (const pid of heartbeat.activePids ?? []) {
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The process may exit between the liveness check and the signal.
      }
    }
  }
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  switch (command) {
    case "controller":
      await controller(option(args, "--config")!);
      break;
    case "preflight":
      await preflight(option(args, "--config")!);
      break;
    case "status":
      process.stdout.write(
        `${JSON.stringify(await readRunStatus(option(args, "--run-dir")!), null, 2)}\n`,
      );
      break;
    case "stop":
      await requestStop(option(args, "--run-dir")!, option(args, "--reason", false));
      break;
    case "janitor":
      await janitor(
        option(args, "--run-dir")!,
        Number.parseInt(option(args, "--controller-pid")!, 10),
      );
      break;
    default:
      throw new Error(
        "Usage: main.js <controller|preflight|status|stop|janitor> [options]",
      );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
