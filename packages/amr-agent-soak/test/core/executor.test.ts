import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionArtifact, ExecutorCapabilities } from "../../src/core/contracts.js";
import {
  assertCalibrationArtifact,
  assertCalibratedModels,
  assertExecutorCapabilities,
  extractFinalResponseText,
  isBundledExtractionRace,
  preflightRetryDelayMs,
  responseTextFromEvents,
  runExtractionRetry,
} from "../../src/executor/copilot-cli.js";

const capabilities: ExecutorCapabilities = {
  executablePath: "copilot",
  executableHash: "hash",
  version: "1.0.0",
  helpHash: "help",
  supportsPrompt: true,
  supportsJsonOutput: true,
  supportsNoAskUser: true,
  supportsToolApproval: true,
  supportsInstructionDisable: true,
  supportsMcpDisable: true,
  supportsNoRemote: true,
  supportsNoRemoteExport: true,
  supportsNoAutoUpdate: true,
  supportsStreamControl: true,
  calibratedModels: ["auto"],
  packageCacheHash: "package-cache-hash",
  packageCacheSource: "package-cache-source",
};

test("preflight requires every flag used by execution", () => {
  assert.doesNotThrow(() => assertExecutorCapabilities(capabilities));
  for (const property of [
    "supportsNoRemote",
    "supportsNoRemoteExport",
    "supportsNoAutoUpdate",
    "supportsStreamControl",
  ] as const) {
    assert.throws(
      () => assertExecutorCapabilities({ ...capabilities, [property]: false }),
      new RegExp(property.replace(/^supports/, ""), "i"),
    );
  }
});

test("configured calibration models must appear in executor capabilities", () => {
  assert.doesNotThrow(() =>
    assertCalibratedModels(
      { ...capabilities, calibratedModels: ["GPT-5.6-SOL", "claude-opus-4.8"] },
      ["gpt-5.6-sol", "CLAUDE-OPUS-4.8"],
    ),
  );
  assert.throws(
    () => assertCalibratedModels(capabilities, ["missing-model"]),
    /did not calibrate configured models: missing-model/,
  );
});

test("extracts response text from real nested CLI events and legacy top-level fixtures", () => {
  assert.equal(
    responseTextFromEvents([
      { type: "user.message", data: { content: "ignored prompt" } },
      { type: "assistant.message", data: { content: "nested" } },
      { type: "assistant.message", content: "top-level" },
    ]),
    "nested\ntop-level",
  );
});

test("preflight recognizes Windows bundled-package extraction races and backs off", () => {
  assert.equal(
    isBundledExtractionRace("Failed to extract bundled package: EPERM: operation not permitted, rename"),
    true,
  );
  assert.equal(isBundledExtractionRace("ordinary command failure"), false);
  assert.deepEqual([0, 1, 2].map(preflightRetryDelayMs), [500, 1000, 2000]);
});

test("calibration rejects parent session attachments and database failures", () => {
  const timestamp = new Date().toISOString();
  const artifact: ExecutionArtifact = {
    soakRunId: "test",
    executionId: "calibration",
    scenarioId: "calibration",
    arm: "without-skill",
    status: "completed",
    startedAt: timestamp,
    finishedAt: timestamp,
    responseText: "CALIBRATION_OK",
    events: [{ type: "user.message", content: "<system_reminder><todo_status>" }],
    trace: {
      executablePath: "copilot",
      executableHash: "hash",
      args: [],
      cwd: ".",
      pid: 1,
      attemptNumber: 1,
      processIdentity: { pid: 1, startedAt: timestamp, name: "copilot" },
      descendants: [],
      startedAt: timestamp,
      finishedAt: timestamp,
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      stdoutFile: "stdout",
      stderrFile: "stderr",
      projectHashBefore: "before",
      projectHashAfter: "after",
      profileHashBefore: "before",
      profileHashAfter: "after",
      contamination: [],
    },
  };
  assert.throws(() => assertCalibrationArtifact(artifact), /parent session content/);
  assert.throws(
    () =>
      assertCalibrationArtifact({
        ...artifact,
        events: [{ type: "unparsed", text: "unable to open database file" }],
      }),
    /valid JSON event stream/,
  );
  for (const marker of [
    "unable to open database file",
    "inbox_entries",
    "agency_session",
    "session attachment",
  ]) {
    assert.throws(
      () =>
        assertCalibrationArtifact({
          ...artifact,
          events: [{ type: "user.message", content: marker }],
        }),
      /parent session content/,
      marker,
    );
  }
  assert.throws(
    () =>
      assertCalibrationArtifact(
        { ...artifact, events: [{ type: "user.message", content: "parent-session-123" }] },
        ["parent-session-123"],
      ),
    /parent session content/,
  );
  assert.doesNotThrow(() =>
    assertCalibrationArtifact({
      ...artifact,
      events: [
        {
          type: "user.message",
          content:
            "<system_reminder><sql_tables>Available tables: todos, todo_deps</sql_tables></system_reminder>",
        },
      ],
    }),
  );
  const served = {
    ...artifact,
    responseText: "CALIBRATION_OK",
    events: [
      { type: "assistant.turn_start", data: { model: "gpt-5.6-sol" } },
      { type: "assistant.message", data: { model: "gpt-5.6-sol", content: "CALIBRATION_OK" } },
    ],
  };
  assert.equal(assertCalibrationArtifact(served, [], "GPT-5.6-SOL"), "gpt-5.6-sol");
  assert.throws(
    () => assertCalibrationArtifact(served, [], "claude-opus-4.8"),
    /requested claude-opus-4.8 but the CLI served gpt-5.6-sol/,
  );
  assert.throws(
    () => assertCalibrationArtifact({ ...artifact, events: [{ type: "assistant.idle", data: {} }] }, [], "gpt-5.6-sol"),
    /did not report a served model/,
  );
});

const extractionRace =
  "Failed to extract bundled package: Error: EPERM: operation not permitted, rename '.extracting-1.0.69-2' -> '1.0.69-2'";

test("execute retry returns only the successful extraction-race attempt", async () => {
  const attempts: number[] = [];
  const cleanups: number[] = [];
  const delays: number[] = [];
  let cleaned = false;
  const result = await runExtractionRetry(
    (attemptNumber) => {
      attempts.push(attemptNumber);
      return Promise.resolve(
        attemptNumber === 1 || !cleaned
          ? { value: "failed-attempt", failed: true, stderr: extractionRace }
          : { value: "successful-attempt", failed: false, stderr: "" },
      );
    },
    {
      cleanup: () => {
        cleanups.push(1);
        cleaned = true;
        return Promise.resolve();
      },
      sleep: (delay) => {
        delays.push(delay);
        return Promise.resolve();
      },
    },
  );
  assert.equal(result, "successful-attempt");
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(cleanups.length, 1);
  assert.deepEqual(delays, [500]);
});

test("execute retry does not retry ordinary failures", async () => {
  let attempts = 0;
  const result = await runExtractionRetry(
    () => {
      attempts += 1;
      return Promise.resolve({
        value: "ordinary-failure",
        failed: true,
        stderr: "model unavailable",
      });
    },
    { cleanup: () => Promise.resolve(), sleep: () => Promise.resolve() },
  );
  assert.equal(result, "ordinary-failure");
  assert.equal(attempts, 1);
});

test("execute extraction retry is bounded to four attempts", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await runExtractionRetry(
    () => {
      attempts += 1;
      return Promise.resolve({ value: attempts, failed: true, stderr: extractionRace });
    },
    {
      cleanup: () => Promise.resolve(),
      sleep: (delay) => {
        delays.push(delay);
        return Promise.resolve();
      },
    },
  );
  assert.equal(result, 4);
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [500, 1_000, 2_000]);
});

test("extracts only the final assistant JSONL response", () => {
  assert.equal(
    extractFinalResponseText([
      { type: "assistant.message_delta", data: { deltaContent: "RE" } },
      { type: "assistant.message_delta", data: { deltaContent: "TRY_OK" } },
      { type: "assistant.message", data: { content: "RETRY_OK" } },
      { type: "assistant.turn_end", data: {} },
      { type: "session.ended", message: "session closed" },
    ]),
    "RETRY_OK",
  );
});
