import { createHash } from "node:crypto";
import {
  lstat as fsLstat,
  readdir as fsReaddir,
  readFile as fsReadFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

export function hashBytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashJson(value: unknown): string {
  return hashBytes(JSON.stringify(value, objectKeySorter));
}

function objectKeySorter(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  }
  return value;
}

export interface HashTreeOptions {
  readonly excludeRelativePath?: (relativePath: string) => boolean;
  readonly operations?: {
    readonly lstat?: (filePath: string) => Promise<Stats>;
    readonly readdir?: (directoryPath: string) => Promise<ReadonlyArray<string>>;
    readonly readFile?: (filePath: string) => Promise<Buffer>;
    readonly sleep?: (delayMs: number) => Promise<void>;
  };
}

const HASH_RETRY_DELAYS_MS = [50, 100, 200] as const;

function isRetryableHashError(error: unknown): boolean {
  return ["EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
}

async function withHashRetry<T>(
  operation: () => Promise<T>,
  sleep: (delayMs: number) => Promise<void>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableHashError(error) || attempt === 3) {
        throw error;
      }
      await sleep(HASH_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

export async function hashTree(root: string, options: HashTreeOptions = {}): Promise<string> {
  const digest = createHash("sha256");
  const entries: Array<{ relativePath: string; bytes: Buffer }> = [];
  const lstat = options.operations?.lstat ?? fsLstat;
  const readdir = options.operations?.readdir ?? fsReaddir;
  const readFile = options.operations?.readFile ?? fsReadFile;
  const sleep =
    options.operations?.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  async function visit(current: string): Promise<void> {
    const stat = await withHashRetry(() => lstat(current), sleep);
    if (stat.isSymbolicLink()) {
      throw new Error(`Snapshot contains unsupported symbolic link: ${current}`);
    }
    if (stat.isDirectory()) {
      const processed = new Set<string>();
      for (let listingAttempt = 0; listingAttempt < 4; listingAttempt += 1) {
        const children = [...(await withHashRetry(() => readdir(current), sleep))];
        children.sort((left, right) => left.localeCompare(right));
        let disappeared = false;
        for (const child of children) {
          if (processed.has(child)) {
            continue;
          }
          const childPath = path.join(current, child);
          const relativePath = path.relative(root, childPath).split(path.sep).join("/");
          if (options.excludeRelativePath?.(relativePath)) {
            processed.add(child);
            continue;
          }
          const checkpoint = entries.length;
          try {
            await visit(childPath);
            processed.add(child);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
            entries.length = checkpoint;
            disappeared = true;
          }
        }
        if (!disappeared) {
          break;
        }
        if (listingAttempt === 3) {
          throw Object.assign(
            new Error(`Snapshot did not stabilize after disappearing entries: ${current}`),
            { code: "ENOENT" },
          );
        }
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Snapshot contains unsupported entry: ${current}`);
    }
    entries.push({
      relativePath: path.relative(root, current).split(path.sep).join("/"),
      bytes: await withHashRetry(() => readFile(current), sleep),
    });
  }

  await visit(root);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  for (const entry of entries) {
    digest.update(entry.relativePath);
    digest.update("\0");
    digest.update(entry.bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}
