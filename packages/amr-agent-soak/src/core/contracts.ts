export type SoakArm = "without-skill" | "with-skill";

export interface SoakScenario {
  readonly id: string;
  readonly prompt: string;
  readonly scaffold?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ScenarioProvider {
  listScenarios(): Promise<ReadonlyArray<SoakScenario>>;
}

export interface CacheKey {
  readonly soakRunId: string;
  readonly scenarioHash: string;
  readonly arm: SoakArm;
  readonly executorHash: string;
  readonly skillHash: string;
}

export interface SoakCache {
  get(key: CacheKey): Promise<ExecutionArtifact | undefined>;
  put(key: CacheKey, artifact: ExecutionArtifact): Promise<void>;
}

export interface GradeResult {
  readonly score?: number;
  readonly passed?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface SoakGrader {
  grade?(artifact: ExecutionArtifact, scenario: SoakScenario): Promise<GradeResult>;
  gradePair?(
    artifacts: Readonly<Record<SoakArm, ExecutionArtifact>>,
    scenario: SoakScenario,
    pairId: string,
  ): Promise<Readonly<Record<SoakArm, GradeResult>>>;
}

export interface SoakReporter {
  onEvent(event: LedgerEvent): Promise<void>;
  finalize(summary: RunSummary): Promise<void>;
}

export interface ExecutorCapabilities {
  readonly executablePath: string;
  readonly executableHash: string;
  readonly version: string;
  readonly helpHash: string;
  readonly supportsPrompt: boolean;
  readonly supportsJsonOutput: boolean;
  readonly supportsNoAskUser: boolean;
  readonly supportsToolApproval: boolean;
  readonly supportsInstructionDisable: boolean;
  readonly supportsMcpDisable: boolean;
  readonly supportsNoRemote: boolean;
  readonly supportsNoRemoteExport: boolean;
  readonly supportsNoAutoUpdate: boolean;
  readonly supportsStreamControl: boolean;
  readonly calibratedModels: ReadonlyArray<string>;
}

export interface ProcessIdentity {
  readonly pid: number;
  readonly parentPid?: number;
  readonly startedAt: string;
  readonly name: string;
  readonly executablePath?: string;
  readonly commandLineHash?: string;
}

export interface IsolatedWorkspace {
  readonly root: string;
  readonly projectDir: string;
  readonly profileDir: string;
  readonly tempDir: string;
  readonly logDir: string;
  readonly arm: SoakArm;
  readonly pinnedSkillName?: string;
  readonly projectHash: string;
  readonly profileHash: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly forbiddenMarkers: ReadonlyArray<string>;
  readonly parentSessionMarkers: ReadonlyArray<string>;
}

export interface ExecutionRequest {
  readonly executionId: string;
  readonly scenario: SoakScenario;
  readonly arm: SoakArm;
  readonly workspace: IsolatedWorkspace;
  readonly timeoutMs: number;
  readonly model?: string;
  readonly signal: AbortSignal;
  readonly onProcessStarted?: (identity: ProcessIdentity) => Promise<void>;
  readonly onProcessExited?: (identity: ProcessIdentity) => Promise<void>;
}

export interface ProcessTrace {
  readonly executablePath: string;
  readonly executableHash: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly pid: number;
  readonly attemptNumber: number;
  readonly processIdentity: ProcessIdentity;
  readonly descendants: ReadonlyArray<ProcessIdentity>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly terminationError?: string;
  readonly stdoutFile: string;
  readonly stderrFile: string;
  readonly projectHashBefore: string;
  readonly projectHashAfter: string;
  readonly profileHashBefore: string;
  readonly profileHashAfter: string;
  readonly contamination: ReadonlyArray<string>;
}

export interface ExecutionArtifact {
  readonly soakRunId: string;
  readonly executionId: string;
  readonly scenarioId: string;
  readonly arm: SoakArm;
  readonly status: "completed" | "failed" | "timed-out" | "cancelled" | "cached";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly responseText: string;
  readonly events: ReadonlyArray<unknown>;
  readonly trace: ProcessTrace;
  readonly grade?: GradeResult;
}

export interface HeadlessExecutor {
  probe(workspaces: {
    readonly withoutSkill: IsolatedWorkspace;
    readonly withSkill: IsolatedWorkspace;
    readonly calibrations: ReadonlyArray<{
      readonly workspace: IsolatedWorkspace;
      readonly model?: string;
    }>;
  }): Promise<ExecutorCapabilities>;
  execute(request: ExecutionRequest, capabilities: ExecutorCapabilities): Promise<ExecutionArtifact>;
}

export interface ProbeContext {
  readonly soakRunId: string;
  readonly runDir: string;
  readonly signal: AbortSignal;
  readonly onProcessStarted?: (identity: ProcessIdentity) => Promise<void>;
  readonly onProcessExited?: (identity: ProcessIdentity) => Promise<void>;
}

export interface ProbeArtifact {
  readonly soakRunId: string;
  readonly probeId: string;
  readonly phase: "source" | "live";
  readonly status: "completed" | "failed" | "timed-out" | "cancelled";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly artifactPath: string;
}

export interface SoakProbe {
  readonly id: string;
  readonly phase: "source" | "live";
  run(context: ProbeContext): Promise<ProbeArtifact>;
}

export interface LedgerEvent {
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: string;
  readonly runId: string;
  readonly pairId?: string;
  readonly executionId?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface RunSummary {
  readonly runId: string;
  readonly status: RunStatus;
  readonly admittedPairs: number;
  readonly completedPairs: number;
  readonly completedExecutions: number;
  readonly failedExecutions: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export type RunStatus =
  | "initializing"
  | "running"
  | "draining"
  | "stopping"
  | "completed"
  | "failed";

export interface SoakModules {
  readonly scenarios: ScenarioProvider;
  readonly executor: HeadlessExecutor;
  readonly cache?: SoakCache;
  readonly grader?: SoakGrader;
  readonly reporter?: SoakReporter;
  readonly probes?: ReadonlyArray<SoakProbe>;
  readonly processManager?: import("./process.js").ProcessManager;
  /** Public-safe integration snapshot included in the immutable resume hash. */
  readonly snapshot?: Readonly<Record<string, unknown>>;
}
