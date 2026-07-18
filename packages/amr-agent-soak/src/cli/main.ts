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
  ProcessIdentity,
} from "../core/contracts.js";
import type { SoakConfig } from "../core/config.js";
import { createIsolatedWorkspace } from "../core/isolation.js";
import { readRunStatus, requestStop, runSoak } from "../core/controller.js";
import { CopilotCliExecutor } from "../executor/copilot-cli.js";
import {
  DotnetTestProbe,
  type DotnetTestProbeConfig,
} from "../executor/dotnet-test-probe.js";
import { ProcessRegistry, SystemProcessManager } from "../core/process.js";

interface ControllerFile extends SoakConfig {
  readonly scenarioModule?: string;
  readonly cacheModule?: string;
  readonly graderModule?: string;
  readonly reporterModule?: string;
  readonly integrationModule?: string;
  readonly integration?: Readonly<Record<string, unknown>>;
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
  const resolvedConfigPath = path.resolve(configPath);
  const config = JSON.parse(await readFile(resolvedConfigPath, "utf8")) as ControllerFile;
  const processManager = new SystemProcessManager();
  const resolveModule = (modulePath: string): string =>
    path.isAbsolute(modulePath)
      ? modulePath
      : path.resolve(config.repositoryRoot ?? path.dirname(resolvedConfigPath), modulePath);
  const integrated = config.integrationModule
    ? await importExport<
        (context: {
          readonly config: ControllerFile;
          readonly configPath: string;
          readonly processManager: SystemProcessManager;
        }) => Promise<Partial<SoakModules>>
      >(resolveModule(config.integrationModule), "createSoakModules").then((factory) =>
        factory({ config, configPath: resolvedConfigPath, processManager }),
      )
    : {};
  if (!integrated.scenarios && !config.scenarioModule) {
    throw new Error("Config must include integrationModule or scenarioModule");
  }
  const modules: SoakModules = {
    scenarios:
      integrated.scenarios ??
      (await importExport<ScenarioProvider>(resolveModule(config.scenarioModule!), "scenarioProvider")),
    executor: integrated.executor ?? new CopilotCliExecutor(config.copilotCommand, { processManager }),
    cache:
      integrated.cache ??
      (config.cacheModule
        ? await importExport<SoakCache>(resolveModule(config.cacheModule), "cacheModule")
        : undefined),
    grader:
      integrated.grader ??
      (config.graderModule
        ? await importExport<SoakGrader>(resolveModule(config.graderModule), "graderModule")
        : undefined),
    reporter:
      integrated.reporter ??
      (config.reporterModule
        ? await importExport<SoakReporter>(resolveModule(config.reporterModule), "reporterModule")
        : undefined),
    probes: [
      ...(integrated.probes ?? []),
      ...(config.dotnetProbes?.map((probe) => new DotnetTestProbe(probe, processManager)) ?? []),
    ],
    processManager,
    snapshot: integrated.snapshot,
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

interface PidRecord {
  readonly controller: ProcessIdentity;
  readonly janitor: ProcessIdentity;
  readonly resourceJanitor?: ProcessIdentity;
}

async function readPidRecord(runDir: string): Promise<PidRecord> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return JSON.parse(await readFile(path.join(runDir, "pids.json"), "utf8")) as PidRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`PID record did not appear: ${runDir}`);
}

async function terminateRun(runDir: string, includeSupervisors: boolean): Promise<void> {
  const manager = new SystemProcessManager();
  const registry = new ProcessRegistry(path.join(runDir, "processes.jsonl"));
  const roots = [...(await registry.readActive())];
  if (includeSupervisors) {
    const pids = await readPidRecord(runDir);
    roots.push(pids.controller, pids.janitor);
    if (pids.resourceJanitor) roots.push(pids.resourceJanitor);
  }
  const handled = new Set<string>();
  for (const root of roots) {
    const key = `${root.pid}\0${root.startedAt}`;
    if (handled.has(key)) {
      continue;
    }
    handled.add(key);
    const result = await manager.terminateTree(root, async (identities) => {
      for (const identity of identities) {
        await registry.recordStarted(`termination:${root.pid}`, identity);
      }
    });
    for (const identity of result.killed) {
      await registry.recordExited(`termination:${root.pid}`, identity);
    }
  }
}

async function janitor(runDir: string): Promise<void> {
  const manager = new SystemProcessManager();
  const pids = await readPidRecord(runDir);
  while (await manager.isRunning(pids.controller)) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await terminateRun(runDir, false);
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
      await janitor(option(args, "--run-dir")!);
      break;
    case "terminate":
      await terminateRun(option(args, "--run-dir")!, true);
      break;
    default:
      throw new Error(
        "Usage: main.js <controller|preflight|status|stop|janitor|terminate> [options]",
      );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
