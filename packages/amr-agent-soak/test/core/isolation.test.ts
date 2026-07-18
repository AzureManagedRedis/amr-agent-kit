import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIsolatedWorkspace } from "../../src/core/isolation.js";

test("creates identical neutral projects and physically separates the skill", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-isolation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const skill = path.join(root, "snapshot", "redis-code");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# pinned\n");
  const scenario = {
    id: "neutral",
    prompt: "test",
    scaffold: { "src/index.js": "console.log('neutral');\n" },
  };

  const withoutSkill = await createIsolatedWorkspace({
    root: path.join(root, "without"),
    arm: "without-skill",
    scenario,
    skillSnapshotPath: skill,
    repositoryRoot: root,
    soakRunId: "test-run",
  });
  const withSkill = await createIsolatedWorkspace({
    root: path.join(root, "with"),
    arm: "with-skill",
    scenario,
    skillSnapshotPath: skill,
    repositoryRoot: root,
    soakRunId: "test-run",
  });

  assert.equal(withoutSkill.projectHash, withSkill.projectHash);
  assert.notEqual(withoutSkill.profileHash, withSkill.profileHash);
  assert.equal(
    withoutSkill.environment.LOCALAPPDATA,
    path.join(withoutSkill.profileDir, "AppData", "Local"),
  );
  for (const name of [
    "AGENCY_SESSION_SUBPROCESS",
    "AGENCY_SESSION_ID",
    "AGENCY_LOG_SESSION_DIR",
    "AGENCY_OPERATION_ID",
    "AGENCY_REPO_DIR",
    "AGENCY_ENGINE",
    "MSFT_AGENCY",
    "COPILOT_AGENT_SESSION_ID",
    "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
    "AI_AGENT",
    "AGENT_MERGE_REPLY_BYLINE_FILE",
    "RUBBER_DUCK_AGENT",
  ]) {
    assert.equal(withoutSkill.environment[name], undefined, `${name} leaked into isolation`);
  }
  for (const name of [
    "COPILOT_TRAMPOLINE_IDENTIFIER",
    "COPILOT_TRAMPOLINE_PORT",
    "COPILOT_TRAMPOLINE_TOKEN",
  ]) {
    if (process.env[name]) {
      assert.equal(withoutSkill.environment[name], process.env[name]);
    }
  }
  assert.equal(
    await readFile(path.join(withSkill.profileDir, ".copilot", "skills", "redis-code", "SKILL.md"), "utf8"),
    "# pinned\n",
  );
  await assert.rejects(
    createIsolatedWorkspace({
      root: path.join(root, "contaminated"),
      arm: "without-skill",
      scenario: { ...scenario, scaffold: { "AGENTS.md": "do not load" } },
      skillSnapshotPath: skill,
      repositoryRoot: root,
      soakRunId: "test-run",
    }),
    /forbidden agent configuration/,
  );
});
