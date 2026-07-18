import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutorCapabilities } from "../../src/core/contracts.js";
import {
  assertExecutorCapabilities,
  isBundledExtractionRace,
  preflightRetryDelayMs,
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

test("preflight recognizes Windows bundled-package extraction races and backs off", () => {
  assert.equal(
    isBundledExtractionRace("Failed to extract bundled package: EPERM: operation not permitted, rename"),
    true,
  );
  assert.equal(isBundledExtractionRace("ordinary command failure"), false);
  assert.deepEqual([0, 1, 2].map(preflightRetryDelayMs), [500, 1000, 2000]);
});
