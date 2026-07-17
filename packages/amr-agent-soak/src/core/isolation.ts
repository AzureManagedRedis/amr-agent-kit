import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IsolatedWorkspace, SoakArm, SoakScenario } from "./contracts.js";
import { hashTree } from "./hash.js";

const FORBIDDEN_PARTS = new Set([
  "agents.md",
  "skill.md",
  "plugin.json",
  "gemini-extension.json",
  ".claude-plugin",
  ".cursor-plugin",
  ".codex-plugin",
  "skills",
]);

const SCRUBBED_ENV_PREFIXES = ["COPILOT_", "CLAUDE_", "CODEX_", "GEMINI_"];
const PRESERVED_AUTH_ENV_NAMES = new Set(["COPILOT_GITHUB_TOKEN"]);
const SCRUBBED_ENV_NAMES = new Set([
  "AGENTS_FILE",
  "GITHUB_COPILOT_EXTENSIONS_PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

function validateRelativeScaffoldPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Scenario scaffold path must be relative: ${relativePath}`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Scenario scaffold path escapes the workspace: ${relativePath}`);
  }
  for (const part of normalized.split(path.sep)) {
    if (FORBIDDEN_PARTS.has(part.toLowerCase())) {
      throw new Error(`Scenario scaffold contains forbidden agent configuration path: ${relativePath}`);
    }
  }
  return normalized;
}

async function listRelativeEntries(root: string): Promise<ReadonlyArray<string>> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      result.push(relative);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (!entry.isFile()) {
        throw new Error(`Isolation workspace contains unsupported entry: ${absolute}`);
      }
    }
  }
  await visit(root);
  return result.sort((left, right) => left.localeCompare(right));
}

async function assertNeutralProject(projectDir: string): Promise<void> {
  const violations = (await listRelativeEntries(projectDir)).filter((entry) =>
    entry.split(path.sep).some((part) => FORBIDDEN_PARTS.has(part.toLowerCase())),
  );
  if (violations.length > 0) {
    throw new Error(`Neutral scaffold contains forbidden agent files: ${violations.join(", ")}`);
  }
}

function isolatedEnvironment(profileDir: string, tempDir: string, soakRunId: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    if (
      !PRESERVED_AUTH_ENV_NAMES.has(upper) &&
      (SCRUBBED_ENV_NAMES.has(upper) ||
      SCRUBBED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
      )
    ) {
      continue;
    }
    environment[name] = value;
  }

  const appData = path.join(profileDir, "AppData", "Roaming");
  const profileRoot = path.parse(profileDir).root;
  return {
    ...environment,
    HOME: profileDir,
    USERPROFILE: profileDir,
    HOMEDRIVE: profileRoot.replace(/[\\/]$/, ""),
    HOMEPATH: profileDir.slice(profileRoot.length - 1),
    APPDATA: appData,
    XDG_CONFIG_HOME: path.join(profileDir, ".config"),
    XDG_DATA_HOME: path.join(profileDir, ".local", "share"),
    TMP: tempDir,
    TEMP: tempDir,
    COPILOT_HOME: path.join(profileDir, ".copilot"),
    SOAK_RUN_ID: soakRunId,
    AMR_SOAK_RUN_ID: soakRunId,
    OTEL_RESOURCE_ATTRIBUTES: `soak.run_id=${soakRunId}`,
    CI: "1",
    NO_COLOR: "1",
  };
}

export interface IsolationOptions {
  readonly root: string;
  readonly arm: SoakArm;
  readonly scenario: SoakScenario;
  readonly skillSnapshotPath: string;
  readonly repositoryRoot: string;
  readonly soakRunId: string;
}

export async function createIsolatedWorkspace(options: IsolationOptions): Promise<IsolatedWorkspace> {
  const projectDir = path.join(options.root, "project");
  const profileDir = path.join(options.root, "profile");
  const tempDir = path.join(options.root, "temp");
  const logDir = path.join(options.root, "logs");
  await Promise.all([
    mkdir(projectDir, { recursive: true }),
    mkdir(profileDir, { recursive: true }),
    mkdir(tempDir, { recursive: true }),
    mkdir(logDir, { recursive: true }),
  ]);

  for (const [relativePath, content] of Object.entries(options.scenario.scaffold ?? {})) {
    const normalized = validateRelativeScaffoldPath(relativePath);
    const destination = path.join(projectDir, normalized);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { encoding: "utf8", flag: "wx" });
  }
  await assertNeutralProject(projectDir);

  if (options.arm === "with-skill") {
    const skillName = path.basename(options.skillSnapshotPath);
    const destination = path.join(profileDir, ".copilot", "skills", skillName);
    await cp(options.skillSnapshotPath, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
  }

  if (options.arm === "without-skill") {
    const profileEntries = await listRelativeEntries(profileDir);
    const violations = profileEntries.filter((entry) =>
      entry.split(path.sep).some((part) => FORBIDDEN_PARTS.has(part.toLowerCase())),
    );
    if (violations.length > 0) {
      throw new Error(`Without-skill profile is contaminated: ${violations.join(", ")}`);
    }
  }

  const forbiddenMarkers = [
    path.resolve(options.repositoryRoot),
    path.resolve(options.skillSnapshotPath),
    path.join(process.env.USERPROFILE ?? "", ".copilot", "skills"),
    path.join(process.env.USERPROFILE ?? "", ".agents", "skills"),
    path.join(process.env.HOME ?? "", ".copilot", "skills"),
    path.join(process.env.HOME ?? "", ".agents", "skills"),
  ]
    .filter((value, index, values) => value.length > 3 && values.indexOf(value) === index)
    .map((value) => value.toLowerCase());

  return {
    root: options.root,
    projectDir,
    profileDir,
    tempDir,
    logDir,
    arm: options.arm,
    pinnedSkillName:
      options.arm === "with-skill" ? path.basename(options.skillSnapshotPath) : undefined,
    projectHash: await hashTree(projectDir),
    profileHash: await hashTree(profileDir),
    environment: isolatedEnvironment(profileDir, tempDir, options.soakRunId),
    forbiddenMarkers,
  };
}

export async function detectContamination(
  workspace: IsolatedWorkspace,
  outputFiles: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const findings = new Set<string>();
  const projectEntries = await listRelativeEntries(workspace.projectDir);
  for (const entry of projectEntries) {
    if (entry.split(path.sep).some((part) => FORBIDDEN_PARTS.has(part.toLowerCase()))) {
      findings.add(`forbidden project entry: ${entry}`);
    }
  }

  if (workspace.arm === "without-skill") {
    for (const entry of await listRelativeEntries(workspace.profileDir)) {
      if (entry.split(path.sep).some((part) => FORBIDDEN_PARTS.has(part.toLowerCase()))) {
        findings.add(`forbidden profile entry: ${entry}`);
      }
    }
  }

  for (const filePath of outputFiles) {
    const content = (await readFile(filePath, "utf8")).toLowerCase();
    for (const marker of workspace.forbiddenMarkers) {
      if (content.includes(marker)) {
        findings.add(`output references excluded path: ${marker}`);
      }
    }
  }
  return [...findings].sort();
}
