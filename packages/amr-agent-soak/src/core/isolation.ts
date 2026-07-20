import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  IsolatedWorkspace,
  PackageCacheProvenance,
  SoakArm,
  SoakScenario,
} from "./contracts.js";
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

const PASSTHROUGH_ENV_NAMES = new Set([
  "COMSPEC",
  "COPILOT_GITHUB_TOKEN",
  "COPILOT_GH_HOST",
  "COPILOT_TRAMPOLINE_IDENTIFIER",
  "COPILOT_TRAMPOLINE_PORT",
  "COPILOT_TRAMPOLINE_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "GH_TOKEN",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PSMODULEPATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "WINDIR",
]);
const PARENT_SESSION_ENV_NAMES = new Set([
  "MSFT_AGENCY",
  "AI_AGENT",
  "AGENT_MERGE_REPLY_BYLINE_FILE",
  "RUBBER_DUCK_AGENT",
  "COPILOT_AGENT_SESSION_ID",
  "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
]);
export const PROFILE_CACHE_EXCLUSIONS = [
  ".tool-cache",
  ".cargo/registry",
  ".cargo/git",
  ".npm",
  ".nuget/packages",
  ".gradle/caches",
  ".gradle/wrapper/dists",
  "go/pkg/mod",
  ".cache/go-build",
  ".m2/repository",
  "appdata/local/copilot/pkg",
] as const;

function isProfileCachePath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/").toLowerCase();
  return PROFILE_CACHE_EXCLUSIONS.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

function isVolatileProfilePath(relativePath: string): boolean {
  const name = path.basename(relativePath).toLowerCase();
  return (
    name === "lock" ||
    [".lock", ".lockb", ".pid", ".sock", ".socket", ".tmp", ".temp"].some((suffix) =>
      name.endsWith(suffix),
    )
  );
}

function isParentSessionEnvironment(name: string): boolean {
  return name.startsWith("AGENCY_") || PARENT_SESSION_ENV_NAMES.has(name);
}

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

async function listRelativeEntries(
  root: string,
  skipProfileCaches = false,
): Promise<ReadonlyArray<string>> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      result.push(relative);
      if (skipProfileCaches && isProfileCachePath(relative)) {
        continue;
      }
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

const packageCacheHashes = new Map<string, Promise<string>>();

export async function hashPackageCacheMetadata(root: string): Promise<string> {
  let pending = packageCacheHashes.get(root);
  if (!pending) {
    let created: Promise<string>;
    created = (async () => {
      const digest = createHash("sha256");
      async function visit(current: string): Promise<void> {
        const entries = await readdir(current, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const absolute = path.join(current, entry.name);
          const relative = path.relative(root, absolute).split(path.sep).join("/");
          const entryStat = await stat(absolute);
          digest.update(
            `${relative}\0${entry.isDirectory() ? "d" : "f"}\0${entryStat.size}\0`,
          );
          if (entry.isDirectory()) {
            await visit(absolute);
          }
        }
      }
      await visit(root);
      return digest.digest("hex");
    })().catch((error: unknown) => {
      if (packageCacheHashes.get(root) === created) {
        packageCacheHashes.delete(root);
      }
      throw error;
    });
    pending = created;
    packageCacheHashes.set(root, created);
  }
  return pending;
}

export async function seedCopilotPackageCache(
  profileDir: string,
  originalLocalAppData = process.env.LOCALAPPDATA,
  operations: {
    createLink?: (source: string, destination: string) => Promise<void>;
    copy?: (source: string, destination: string) => Promise<void>;
  } = {},
): Promise<PackageCacheProvenance> {
  if (!originalLocalAppData) {
    throw new Error("LOCALAPPDATA is required to seed the Copilot package cache");
  }
  const parentLocalAppData = path.resolve(originalLocalAppData);
  const sourcePath = path.resolve(parentLocalAppData, "copilot", "pkg");
  if (!sourcePath.startsWith(`${parentLocalAppData}${path.sep}`)) {
    throw new Error(`Invalid Copilot package cache source: ${sourcePath}`);
  }
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Copilot package cache is not a directory: ${sourcePath}`);
  }

  const isolatedLocalAppData = path.resolve(profileDir, "AppData", "Local");
  const destinationPath = path.resolve(isolatedLocalAppData, "copilot", "pkg");
  if (!destinationPath.startsWith(`${isolatedLocalAppData}${path.sep}`)) {
    throw new Error(`Invalid isolated package cache destination: ${destinationPath}`);
  }
  await mkdir(path.dirname(destinationPath), { recursive: true });
  const createLink =
    operations.createLink ??
    ((source: string, destination: string) =>
      symlink(source, destination, process.platform === "win32" ? "junction" : "dir"));
  const copy =
    operations.copy ??
    ((source: string, destination: string) =>
      cp(source, destination, { recursive: true, errorOnExist: true, force: false }));
  let mode: PackageCacheProvenance["mode"] = "junction";
  try {
    await createLink(sourcePath, destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw error;
    }
    mode = "copy";
    await copy(sourcePath, destinationPath);
  }
  return {
    sourcePath,
    destinationPath,
    mode,
    metadataHash: await hashPackageCacheMetadata(sourcePath),
  };
}

export async function hashIsolatedProfile(profileDir: string): Promise<string> {
  return hashTree(profileDir, {
    excludeRelativePath: (relativePath) =>
      isProfileCachePath(relativePath) || isVolatileProfilePath(relativePath),
  });
}

async function assertNeutralProject(projectDir: string): Promise<void> {
  const violations = (await listRelativeEntries(projectDir)).filter((entry) =>
    entry.split(path.sep).some((part) => FORBIDDEN_PARTS.has(part.toLowerCase())),
  );
  if (violations.length > 0) {
    throw new Error(`Neutral scaffold contains forbidden agent files: ${violations.join(", ")}`);
  }
}

function isForbiddenProfileEntry(entry: string): boolean {
  const normalized = entry.split(path.sep).join("/").toLowerCase();
  if (isProfileCachePath(normalized)) {
    return false;
  }
  return normalized
    .split("/")
    .some((part) => FORBIDDEN_PARTS.has(part));
}

function isolatedEnvironment(profileDir: string, tempDir: string, soakRunId: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    if (
      PASSTHROUGH_ENV_NAMES.has(upper) ||
      upper.startsWith("COPILOT_GH_ACCOUNT_") ||
      upper === "LANG" ||
      upper === "LC_ALL"
    ) {
      environment[name] = value;
    }
  }

  const appData = path.join(profileDir, "AppData", "Roaming");
  const localAppData = path.join(profileDir, "AppData", "Local");
  const toolCache = path.join(profileDir, ".tool-cache");
  const profileRoot = path.parse(profileDir).root;
  return {
    ...environment,
    HOME: profileDir,
    USERPROFILE: profileDir,
    HOMEDRIVE: profileRoot.replace(/[\\/]$/, ""),
    HOMEPATH: profileDir.slice(profileRoot.length - 1),
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: path.join(profileDir, ".config"),
    XDG_DATA_HOME: path.join(profileDir, ".local", "share"),
    XDG_CACHE_HOME: path.join(toolCache, "xdg"),
    CARGO_HOME: path.join(toolCache, "cargo"),
    NPM_CONFIG_CACHE: path.join(toolCache, "npm"),
    NUGET_PACKAGES: path.join(toolCache, "nuget"),
    GOMODCACHE: path.join(toolCache, "go", "pkg", "mod"),
    GOCACHE: path.join(toolCache, "go", "build"),
    GRADLE_USER_HOME: path.join(toolCache, "gradle"),
    DOTNET_CLI_HOME: path.join(toolCache, "dotnet"),
    PIP_CACHE_DIR: path.join(toolCache, "pip"),
    UV_CACHE_DIR: path.join(toolCache, "uv"),
    MAVEN_OPTS: `-Dmaven.repo.local="${path.join(toolCache, "maven")}"`,
    TMP: tempDir,
    TEMP: tempDir,
    COPILOT_HOME: path.join(profileDir, ".copilot"),
    COPILOT_AUTO_UPDATE: "false",
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
    mkdir(path.join(profileDir, ".tool-cache"), { recursive: true }),
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
    const profileEntries = await listRelativeEntries(profileDir, true);
    const violations = profileEntries.filter(isForbiddenProfileEntry);
    if (violations.length > 0) {
      throw new Error(`Without-skill profile is contaminated: ${violations.join(", ")}`);
    }
  }
  const profileHash = await hashIsolatedProfile(profileDir);
  const packageCache = await seedCopilotPackageCache(profileDir);

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
  const parentSessionMarkers = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        isParentSessionEnvironment(name.toUpperCase()) && (value?.length ?? 0) > 5,
    )
    .map(([, value]) => value!.toLowerCase())
    .filter(
      (value) =>
        value.length >= 12 &&
        !options.root.toLowerCase().includes(value) &&
        !options.repositoryRoot.toLowerCase().includes(value) &&
        !options.skillSnapshotPath.toLowerCase().includes(value),
    )
    .filter((value, index, values) => values.indexOf(value) === index);

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
    profileHash,
    environment: isolatedEnvironment(profileDir, tempDir, options.soakRunId),
    forbiddenMarkers,
    parentSessionMarkers,
    packageCache,
    profileHashExclusions: [
      ...PROFILE_CACHE_EXCLUSIONS,
      "volatile files: *.lock, *.lockb, *.pid, *.sock, *.socket, *.tmp, *.temp",
    ],
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
    for (const entry of await listRelativeEntries(workspace.profileDir, true)) {
      if (isForbiddenProfileEntry(entry)) {
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
