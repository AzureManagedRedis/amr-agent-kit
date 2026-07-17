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
