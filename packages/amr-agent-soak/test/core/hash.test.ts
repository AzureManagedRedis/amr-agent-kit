import assert from "node:assert/strict";
import test from "node:test";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashTree } from "../../src/core/hash.js";

function fileError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test("hashTree retries transient Windows EBUSY reads with bounded backoff", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-hash-busy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "source.txt"), "stable");
  let attempts = 0;
  const delays: number[] = [];
  const hash = await hashTree(root, {
    operations: {
      readFile: async (filePath) => {
        attempts += 1;
        if (attempts < 3) {
          throw fileError("EBUSY");
        }
        return readFile(filePath);
      },
      sleep: (delay) => {
        delays.push(delay);
        return Promise.resolve();
      },
    },
  });
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [50, 100]);
});

test("hashTree re-lists a directory when a discovered file disappears", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-hash-gone-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let listings = 0;
  const hash = await hashTree(root, {
    operations: {
      readdir: async (directoryPath) => {
        if (path.resolve(directoryPath) === path.resolve(root)) {
          listings += 1;
          return listings === 1 ? ["gone.txt"] : [];
        }
        return readdir(directoryPath);
      },
      lstat: async (filePath) => {
        if (filePath.endsWith("gone.txt")) {
          throw fileError("ENOENT");
        }
        return lstat(filePath);
      },
    },
  });
  assert.equal(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(listings, 2);
});

test("hashTree keeps deterministic order when a file reappears", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-hash-reappear-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    await writeFile(path.join(root, name), name);
  }
  const expected = await hashTree(root);
  let missingOnce = true;
  const raced = await hashTree(root, {
    operations: {
      lstat: async (filePath) => {
        if (filePath.endsWith("b.txt") && missingOnce) {
          missingOnce = false;
          throw fileError("ENOENT");
        }
        return lstat(filePath);
      },
    },
  });
  assert.equal(raced, expected);
});

test("hashTree rolls back partial nested entries before re-listing", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-hash-nested-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "A");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "f1.txt"), "f1");
  await writeFile(path.join(root, "x.txt"), "x");
  const expected = await hashTree(root);
  let nestedListings = 0;
  const raced = await hashTree(root, {
    operations: {
      readdir: async (directoryPath) => {
        if (path.resolve(directoryPath) === path.resolve(nested)) {
          nestedListings += 1;
          if (nestedListings === 1) {
            return ["f1.txt", "f2.txt"];
          }
          if (nestedListings === 2) {
            throw fileError("ENOENT");
          }
          return ["f1.txt"];
        }
        return readdir(directoryPath);
      },
      lstat: async (filePath) => {
        if (filePath.endsWith("f2.txt")) {
          throw fileError("ENOENT");
        }
        return lstat(filePath);
      },
    },
  });
  assert.equal(raced, expected);
  assert.equal(nestedListings, 3);
});

test("hashTree fails closed after bounded transient retries", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-hash-fail-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "locked.txt"), "locked");
  let attempts = 0;
  await assert.rejects(
    hashTree(root, {
      operations: {
        readFile: () => {
          attempts += 1;
          return Promise.reject(fileError("EPERM"));
        },
        sleep: () => Promise.resolve(),
      },
    }),
    (error: NodeJS.ErrnoException) => error.code === "EPERM",
  );
  assert.equal(attempts, 4);
});
