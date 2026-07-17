import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../../src/core/config.js";

test("normalizes safe soak defaults", () => {
  const result = normalizeConfig({
    runId: "soak-2026-07-17",
    repositoryRoot: ".",
    skillSnapshotPath: "skills/redis-code",
  });
  assert.equal(result.concurrency, 14);
  assert.equal(result.durationMs, 48 * 60 * 60 * 1_000);
  assert.equal(result.timeoutMs, 30 * 60 * 1_000);
  assert.match(result.runDir, /eval-runs/);
});

test("rejects concurrency outside the bounded range", () => {
  for (const concurrency of [11, 17]) {
    assert.throws(
      () =>
        normalizeConfig({
          runId: "invalid",
          repositoryRoot: ".",
          skillSnapshotPath: "skills/redis-code",
          concurrency,
        }),
      /12 through 16/,
    );
  }
});
