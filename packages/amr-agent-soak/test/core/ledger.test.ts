import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventLedger, readLastLedgerSequence } from "../../src/core/ledger.js";

test("serializes concurrent appends as ordered durable JSONL", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-ledger-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "events.jsonl");
  const ledger = new EventLedger(filePath, "run-1");
  await Promise.all(Array.from({ length: 25 }, (_, index) => ledger.append("test", { data: { index } })));
  await ledger.flush();

  const events = (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { sequence: number; runId: string });
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: 25 }, (_, index) => index + 1),
  );
  assert.ok(events.every((event) => event.runId === "run-1"));
  await appendFile(filePath, '{"sequence":');
  assert.equal(await readLastLedgerSequence(filePath), 25);
  const resumed = new EventLedger(filePath, "run-1", 25);
  await resumed.append("resumed");
  assert.equal(await readLastLedgerSequence(filePath), 26);
});

test("ledger recovery fails only when no valid event remains", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-ledger-torn-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "events.jsonl");
  await writeFile(filePath, '{"sequence":');
  await assert.rejects(readLastLedgerSequence(filePath), /no valid monotonic event/);
  await writeFile(filePath, "");
  assert.equal(await readLastLedgerSequence(filePath), 0);
});
