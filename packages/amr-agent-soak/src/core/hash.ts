import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
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

export async function hashTree(root: string): Promise<string> {
  const digest = createHash("sha256");
  const entries: Array<{ relativePath: string; bytes: Buffer }> = [];

  async function visit(current: string): Promise<void> {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Snapshot contains unsupported symbolic link: ${current}`);
    }
    if (stat.isDirectory()) {
      const children = await readdir(current);
      children.sort((left, right) => left.localeCompare(right));
      for (const child of children) {
        await visit(path.join(current, child));
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Snapshot contains unsupported entry: ${current}`);
    }
    entries.push({
      relativePath: path.relative(root, current).split(path.sep).join("/"),
      bytes: await readFile(current),
    });
  }

  await visit(root);
  for (const entry of entries) {
    digest.update(entry.relativePath);
    digest.update("\0");
    digest.update(entry.bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}
