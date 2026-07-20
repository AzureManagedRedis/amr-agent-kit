import assert from "node:assert/strict";
import test from "node:test";
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createIsolatedWorkspace,
  hashPackageCacheMetadata,
  seedCopilotPackageCache,
} from "../../src/core/isolation.js";
import { cleanExtractionDirectories } from "../../src/executor/copilot-cli.js";
import type { IsolatedWorkspace } from "../../src/core/contracts.js";

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

test("seeds only the trusted Copilot package cache", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-package-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const parentLocalAppData = path.join(root, "parent-local");
  const source = path.join(parentLocalAppData, "copilot", "pkg");
  await mkdir(path.join(source, "win32-x64", "1.2.3"), { recursive: true });
  await writeFile(path.join(source, "win32-x64", "1.2.3", "copilot.exe"), "trusted");
  await writeFile(path.join(parentLocalAppData, "copilot", "config.json"), "parent-config");
  await writeFile(path.join(parentLocalAppData, "copilot", "session.db"), "parent-session");
  const profile = path.join(root, "profile");

  const provenance = await seedCopilotPackageCache(profile, parentLocalAppData);
  const isolatedCopilot = path.join(profile, "AppData", "Local", "copilot");
  assert.deepEqual(await readdir(isolatedCopilot), ["pkg"]);
  assert.equal(provenance.sourcePath, path.resolve(source));
  assert.equal(provenance.destinationPath, path.join(isolatedCopilot, "pkg"));
  assert.ok(provenance.metadataHash.length > 0);
  if ((await lstat(provenance.destinationPath)).isSymbolicLink()) {
    assert.equal(await realpath(provenance.destinationPath), await realpath(source));
    assert.equal(provenance.mode, "junction");
  } else {
    assert.equal(provenance.mode, "copy");
  }
  await assert.rejects(readFile(path.join(isolatedCopilot, "config.json")), /ENOENT/);
  await assert.rejects(readFile(path.join(isolatedCopilot, "session.db")), /ENOENT/);
});

test("falls back to a contained package-only copy when junction creation fails", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-package-copy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const parentLocalAppData = path.join(root, "parent-local");
  const source = path.join(parentLocalAppData, "copilot", "pkg");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "package.txt"), "trusted");
  const profile = path.join(root, "profile");
  const provenance = await seedCopilotPackageCache(profile, parentLocalAppData, {
    createLink: () =>
      Promise.reject(Object.assign(new Error("junction unavailable"), { code: "EPERM" })),
    copy: (from, to) =>
      cp(from, to, { recursive: true, errorOnExist: true, force: false }),
  });
  assert.equal(provenance.mode, "copy");
  assert.equal(await readFile(path.join(provenance.destinationPath, "package.txt"), "utf8"), "trusted");
  assert.equal((await lstat(provenance.destinationPath)).isSymbolicLink(), false);
  await assert.rejects(
    seedCopilotPackageCache(path.join(root, "missing-profile"), path.join(root, "missing-local")),
    /ENOENT/,
  );
});

test("extraction cleanup never traverses the seeded package cache", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-package-cleanup-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const parentLocalAppData = path.join(root, "parent-local");
  const source = path.join(parentLocalAppData, "copilot", "pkg");
  const parentExtraction = path.join(source, ".extracting-parent");
  await mkdir(parentExtraction, { recursive: true });
  const parentSentinel = path.join(parentExtraction, "sentinel.txt");
  await writeFile(parentSentinel, "must-survive");
  const profileDir = path.join(root, "profile");
  const packageCache = await seedCopilotPackageCache(profileDir, parentLocalAppData);
  const localAppData = path.join(profileDir, "AppData", "Local");
  const localExtraction = path.join(localAppData, "copilot", "other", ".extracting-local");
  await mkdir(localExtraction, { recursive: true });
  await writeFile(path.join(localExtraction, "sentinel.txt"), "remove-me");
  const workspace = {
    root,
    projectDir: path.join(root, "project"),
    profileDir,
    tempDir: path.join(root, "temp"),
    logDir: path.join(root, "logs"),
    arm: "without-skill",
    projectHash: "project",
    profileHash: "profile",
    environment: { LOCALAPPDATA: localAppData },
    forbiddenMarkers: [],
    parentSessionMarkers: [],
    packageCache,
  } satisfies IsolatedWorkspace;

  await cleanExtractionDirectories(workspace);
  assert.equal(await readFile(parentSentinel, "utf8"), "must-survive");
  await assert.rejects(readFile(path.join(localExtraction, "sentinel.txt")), /ENOENT/);
});

test("failed package provenance hashes are evicted and retryable", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amr-soak-package-hash-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "pkg");
  await assert.rejects(hashPackageCacheMetadata(packageRoot), /ENOENT/);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "package.txt"), "trusted");
  assert.match(await hashPackageCacheMetadata(packageRoot), /^[a-f0-9]{64}$/);
});
