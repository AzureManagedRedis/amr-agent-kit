import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { ProcessIdentity } from "./contracts.js";

export interface ProcessSnapshot extends ProcessIdentity {
  readonly parentPid: number;
}

export interface TerminationResult {
  readonly discovered: ReadonlyArray<ProcessSnapshot>;
  readonly killed: ReadonlyArray<ProcessIdentity>;
  readonly skipped: ReadonlyArray<ProcessIdentity>;
}

export interface ProcessManager {
  identify(pid: number): Promise<ProcessIdentity>;
  isRunning(identity: ProcessIdentity): Promise<boolean>;
  terminateTree(
    root: ProcessIdentity,
    onDiscovered?: (identities: ReadonlyArray<ProcessSnapshot>) => Promise<void>,
  ): Promise<TerminationResult>;
}

export interface KillableChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface ChildTerminationOutcome {
  readonly closed: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
  readonly terminationResult?: TerminationResult;
}

export function waitForChildTermination(
  child: KillableChild,
  signal: AbortSignal,
  terminateTree: () => Promise<TerminationResult>,
  options: { graceMs?: number; deadlineMs?: number } = {},
): Promise<ChildTerminationOutcome> {
  const graceMs = options.graceMs ?? 5_000;
  const deadlineMs = options.deadlineMs ?? 20_000;
  return new Promise((resolve) => {
    let aborted = false;
    let closed = false;
    let treeSettled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let error: Error | undefined;
    let terminationResult: TerminationResult | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let resolved = false;

    const finish = (): void => {
      if (resolved || !closed || (aborted && !treeSettled)) {
        return;
      }
      resolved = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
      }
      signal.removeEventListener("abort", onAbort);
      resolve({ closed, exitCode, signal: exitSignal, error, terminationResult });
    };

    const onAbort = (): void => {
      if (aborted || resolved) {
        return;
      }
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch (killError) {
        error = killError as Error;
      }
      graceTimer = setTimeout(() => {
        if (!closed) {
          try {
            child.kill("SIGKILL");
          } catch (killError) {
            error ??= killError as Error;
          }
        }
      }, graceMs);
      deadlineTimer = setTimeout(() => {
        if (resolved) {
          return;
        }
        resolved = true;
        if (graceTimer) {
          clearTimeout(graceTimer);
        }
        signal.removeEventListener("abort", onAbort);
        const deadlineError = new Error(
          `Process ${child.pid ?? "unknown"} did not terminate within ${deadlineMs}ms`,
        );
        if (error) {
          deadlineError.cause = error;
        }
        resolve({
          closed,
          exitCode,
          signal: exitSignal,
          error: deadlineError,
          terminationResult,
        });
      }, deadlineMs);
      void terminateTree()
        .then((result) => {
          terminationResult = result;
        })
        .catch((terminationError: Error) => {
          error = terminationError;
        })
        .finally(() => {
          treeSettled = true;
          finish();
        });
    };

    child.once("error", (childError) => {
      error = childError;
      closed = true;
      treeSettled = true;
      finish();
    });
    child.once("close", (code, closeSignal) => {
      closed = true;
      exitCode = code;
      exitSignal = closeSignal;
      finish();
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      closed = true;
      exitCode = child.exitCode;
      exitSignal = child.signalCode;
      treeSettled = true;
      finish();
      return;
    }
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}\0${identity.startedAt}\0${identity.name.toLowerCase()}`;
}

export function identityMatches(
  expected: ProcessIdentity,
  actual: ProcessIdentity | undefined,
): boolean {
  if (!actual) {
    return false;
  }
  return (
    expected.pid === actual.pid &&
    expected.startedAt === actual.startedAt &&
    expected.name.toLowerCase() === actual.name.toLowerCase() &&
    (!expected.executablePath ||
      !actual.executablePath ||
      path.resolve(expected.executablePath).toLowerCase() ===
        path.resolve(actual.executablePath).toLowerCase()) &&
    (!expected.commandLineHash ||
      !actual.commandLineHash ||
      expected.commandLineHash === actual.commandLineHash)
  );
}

export function planTermination(
  root: ProcessIdentity,
  snapshots: ReadonlyArray<ProcessSnapshot>,
): ReadonlyArray<ProcessSnapshot> {
  const byPid = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
  const currentRoot = byPid.get(root.pid);
  if (currentRoot && !identityMatches(root, currentRoot)) {
    return [];
  }

  const depth = (snapshot: ProcessSnapshot): number | undefined => {
    let current: ProcessSnapshot | undefined = snapshot;
    const visited = new Set<number>();
    let result = 0;
    while (current && !visited.has(current.pid)) {
      if (current.pid === root.pid) {
        return result;
      }
      if (current.parentPid === root.pid) {
        return result + 1;
      }
      visited.add(current.pid);
      current = byPid.get(current.parentPid);
      result += 1;
    }
    return snapshot.parentPid === root.pid ? 1 : undefined;
  };

  return snapshots
    .map((snapshot) => ({ snapshot, depth: depth(snapshot) }))
    .filter(
      (entry): entry is { snapshot: ProcessSnapshot; depth: number } =>
        entry.depth !== undefined,
    )
    .sort((left, right) => right.depth - left.depth || right.snapshot.pid - left.snapshot.pid)
    .map((entry) => entry.snapshot);
}

async function runPowerShell(
  script: string,
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = 15_000,
): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      {
        env: environment,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`PowerShell process query failed (${code}): ${stderr || stdout}`));
      }
    });
  });
}

function commandHash(commandLine: unknown): string | undefined {
  return typeof commandLine === "string" && commandLine.length > 0
    ? createHash("sha256").update(commandLine).digest("hex")
    : undefined;
}

function parseSnapshots(output: string): ReadonlyArray<ProcessSnapshot> {
  const parsed = JSON.parse(output || "[]") as unknown;
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records.map((value) => {
    if (!value || typeof value !== "object") {
      throw new Error("Process snapshot returned an invalid record");
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.pid !== "number" ||
      typeof record.parentPid !== "number" ||
      typeof record.startedAt !== "string" ||
      typeof record.name !== "string"
    ) {
      throw new Error("Process snapshot is missing identity fields");
    }
    return {
      pid: record.pid,
      parentPid: record.parentPid,
      startedAt: record.startedAt,
      name: record.name,
      executablePath:
        typeof record.executablePath === "string" ? record.executablePath : undefined,
      commandLineHash: commandHash(record.commandLine),
    };
  });
}

export class SystemProcessManager implements ProcessManager {
  async #snapshotWindows(): Promise<ReadonlyArray<ProcessSnapshot>> {
    const output = await runPowerShell(`
$items = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    startedAt = $_.CreationDate.ToUniversalTime().ToString('o')
    name = [string]$_.Name
    executablePath = [string]$_.ExecutablePath
    commandLine = [string]$_.CommandLine
  }
})
$items | ConvertTo-Json -Compress
`);
    return parseSnapshots(output);
  }

  async identify(pid: number): Promise<ProcessIdentity> {
    if (process.platform !== "win32") {
      return {
        pid,
        startedAt: new Date().toISOString(),
        name: path.basename(process.execPath),
      };
    }
    const identity = (await this.#snapshotWindows()).find((entry) => entry.pid === pid);
    if (!identity) {
      throw new Error(`Process exited before identity capture: ${pid}`);
    }
    return identity;
  }

  async isRunning(identity: ProcessIdentity): Promise<boolean> {
    if (process.platform !== "win32") {
      try {
        process.kill(identity.pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    const current = (await this.#snapshotWindows()).find((entry) => entry.pid === identity.pid);
    return identityMatches(identity, current);
  }

  async terminateTree(
    root: ProcessIdentity,
    onDiscovered?: (identities: ReadonlyArray<ProcessSnapshot>) => Promise<void>,
  ): Promise<TerminationResult> {
    if (process.platform !== "win32") {
      if (!(await this.isRunning(root))) {
        return { discovered: [], killed: [], skipped: [root] };
      }
      process.kill(root.pid, "SIGKILL");
      return { discovered: [], killed: [root], skipped: [] };
    }

    const planned = planTermination(root, await this.#snapshotWindows());
    if (planned.length === 0) {
      return { discovered: [], killed: [], skipped: [root] };
    }
    const descendants = planned.filter((entry) => entry.pid !== root.pid);
    await onDiscovered?.(descendants);
    const expected = Buffer.from(JSON.stringify(planned), "utf8").toString("base64");
    const output = await runPowerShell(
      `
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AMR_SOAK_IDENTITIES)) | ConvertFrom-Json
$result = @()
foreach ($item in @($expected)) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.pid)" -ErrorAction SilentlyContinue
  $matched = $false
  if ($null -ne $current) {
    $startedAt = $current.CreationDate.ToUniversalTime().ToString('o')
    $matched = ($startedAt -eq [string]$item.startedAt) -and ([string]$current.Name -ieq [string]$item.name)
    if ($matched -and $item.executablePath) {
      $matched = ([string]$current.ExecutablePath -ieq [string]$item.executablePath)
    }
    if ($matched -and $item.commandLineHash) {
      $sha = [Security.Cryptography.SHA256]::Create()
      try {
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$current.CommandLine)
        $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
        $matched = ($hash -eq [string]$item.commandLineHash)
      } finally {
        $sha.Dispose()
      }
    }
  }
  if ($matched) {
    Stop-Process -Id ([int]$item.pid) -Force -ErrorAction Stop
  }
  $result += [pscustomobject]@{ pid = [int]$item.pid; killed = $matched }
}
$result | ConvertTo-Json -Compress
`,
      { ...process.env, AMR_SOAK_IDENTITIES: expected },
    );
    const records = JSON.parse(output || "[]") as
      | { pid: number; killed: boolean }
      | Array<{ pid: number; killed: boolean }>;
    const results = Array.isArray(records) ? records : [records];
    const killedPids = new Set(results.filter((entry) => entry.killed).map((entry) => entry.pid));
    return {
      discovered: descendants,
      killed: planned.filter((entry) => killedPids.has(entry.pid)),
      skipped: planned.filter((entry) => !killedPids.has(entry.pid)),
    };
  }
}

interface ProcessRegistryEvent {
  readonly timestamp: string;
  readonly action: "started" | "exited";
  readonly owner: string;
  readonly identity: ProcessIdentity;
}

export class ProcessRegistry {
  readonly #filePath: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  recordStarted(owner: string, identity: ProcessIdentity): Promise<void> {
    return this.#append({ timestamp: new Date().toISOString(), action: "started", owner, identity });
  }

  recordExited(owner: string, identity: ProcessIdentity): Promise<void> {
    return this.#append({ timestamp: new Date().toISOString(), action: "exited", owner, identity });
  }

  #append(event: ProcessRegistryEvent): Promise<void> {
    this.#queue = this.#queue.then(async () => {
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const handle = await open(this.#filePath, "a+", 0o600);
      try {
        const { size } = await handle.stat();
        let prefix = "";
        if (size > 0) {
          const lastByte = Buffer.alloc(1);
          await handle.read(lastByte, 0, 1, size - 1);
          if (lastByte[0] !== 0x0a && lastByte[0] !== 0x0d) {
            prefix = "\n";
          }
        }
        await handle.writeFile(`${prefix}${JSON.stringify(event)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    return this.#queue;
  }

  async readActive(): Promise<ReadonlyArray<ProcessIdentity>> {
    let content: string;
    try {
      content = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const active = new Map<string, ProcessIdentity>();
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      let event: ProcessRegistryEvent;
      try {
        event = JSON.parse(line) as ProcessRegistryEvent;
      } catch {
        continue;
      }
      const key = identityKey(event.identity);
      if (event.action === "started") {
        active.set(key, event.identity);
      } else {
        active.delete(key);
      }
    }
    return [...active.values()];
  }
}

export interface RegisteredProcessRoot {
  readonly identity: ProcessIdentity;
  readonly registryPath: string;
}

export async function readActiveProcessRoots(
  registryPaths: ReadonlyArray<string>,
): Promise<ReadonlyArray<RegisteredProcessRoot>> {
  const roots: RegisteredProcessRoot[] = [];
  const seen = new Set<string>();
  for (const registryPath of registryPaths) {
    const registry = new ProcessRegistry(registryPath);
    for (const identity of await registry.readActive()) {
      const key = identityKey(identity);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      roots.push({ identity, registryPath });
    }
  }
  return roots;
}
