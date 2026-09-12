export const PROJECT_CONFIGURATION_SCHEMA_VERSION = 1 as const;

export const ROLE_HARNESS_PROTOCOL = 'foundry-role-host-v1' as const;

export const PUBLICATION_DRAFT = true as const;

export const PUBLICATION_MAINTAINERS_CAN_MODIFY = false as const;

export const RUNTIME_DATA_POLICY = 'preserve' as const;

export const RUNTIME_TESTER_ACCESS = 'read_only' as const;

export const TASK_ID_PLACEHOLDER = '<task-id>' as const;

export const VERIFICATION_COMMANDS = ['formatCheck', 'lint', 'typecheck', 'test', 'build'] as const;

export type VerificationCommand = (typeof VERIFICATION_COMMANDS)[number];

export type CommandVector = readonly [string, ...Array<string>];

export interface RoleHarnessConfiguration {
  readonly protocol: typeof ROLE_HARNESS_PROTOCOL;
  readonly command: CommandVector;
  readonly environmentAllowlist: ReadonlyArray<string>;
}

export interface TimeoutConfiguration {
  readonly roleMs: number;
  readonly settleMs: number;
  readonly pollMs: number;
  readonly commandMs: number;
  readonly runtimeReadinessMs: number;
  readonly cleanupMs: number;
  readonly leaseMs: number;
}

export interface RetryBudgetConfiguration {
  readonly architect: number;
  readonly coder: number;
  readonly tester: number;
  readonly reviewer: number;
}

export interface OperationalRetryBudgetConfiguration {
  readonly git: number;
  readonly runtime: number;
  readonly publication: number;
  readonly cleanup: number;
}

export interface LimitConfiguration {
  readonly maxParallelCoders: number;
  readonly maxCorrectionRounds: number;
  readonly maxControlRepairsPerAttempt: number;
}

export interface ProjectCommandConfiguration {
  readonly bootstrap: CommandVector | null;
  readonly formatCheck: CommandVector;
  readonly lint: CommandVector;
  readonly typecheck: CommandVector;
  readonly test: CommandVector;
  readonly build: CommandVector;
}

export interface ProjectProfileConfiguration {
  readonly guidancePaths: ReadonlyArray<string>;
  readonly commands: ProjectCommandConfiguration;
}

export interface RuntimeProfileConfiguration {
  readonly reset: CommandVector;
  readonly build: CommandVector;
  readonly start: CommandVector;
  readonly readiness: CommandVector;
  readonly stop: CommandVector;
  readonly baseUrl: string;
  readonly environmentAllowlist: ReadonlyArray<string>;
  readonly dataPolicy: typeof RUNTIME_DATA_POLICY;
  readonly testerAccess: typeof RUNTIME_TESTER_ACCESS;
}

export interface DecisionPublicationConfiguration {
  readonly remote: string;
  readonly draft: typeof PUBLICATION_DRAFT;
  readonly maintainersCanModify: typeof PUBLICATION_MAINTAINERS_CAN_MODIFY;
}

export interface ArtifactConfiguration {
  readonly retentionDays: number;
  readonly maxRequestBytes: number;
  readonly maxGuidanceBytes: number;
  readonly maxRoleHandoffBytes: number;
  readonly maxEvidenceBytes: number;
  readonly maxTerminalCaptureBytes: number;
  readonly maxRunBytes: number;
  readonly redactionPatterns: ReadonlyArray<string>;
}

export interface ProjectConfiguration {
  readonly schemaVersion: typeof PROJECT_CONFIGURATION_SCHEMA_VERSION;
  readonly targetRepository: string;
  readonly sourceRemote: string;
  readonly sourceBranch: string;
  readonly taskBranchPolicy: string;
  readonly roleHarness: RoleHarnessConfiguration;
  readonly timeouts: TimeoutConfiguration;
  readonly retryBudgets: RetryBudgetConfiguration;
  readonly operationalRetryBudgets: OperationalRetryBudgetConfiguration;
  readonly limits: LimitConfiguration;
  readonly projectProfile: ProjectProfileConfiguration;
  readonly runtimeProfile: RuntimeProfileConfiguration | null;
  readonly decisionPublication: DecisionPublicationConfiguration | null;
  readonly artifacts: ArtifactConfiguration;
}

export function hasExactlyOneTaskIdPlaceholder(taskBranchPolicy: string): boolean {
  return taskBranchPolicy.split(TASK_ID_PLACEHOLDER).length === 2;
}

export function publicationRemoteMatchesSource(
  sourceRemote: string,
  publicationRemote: string,
): boolean {
  return publicationRemote === sourceRemote;
}
