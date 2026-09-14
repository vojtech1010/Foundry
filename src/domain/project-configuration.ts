import type { RoleHostRole } from './role-host.js';

export const PROJECT_CONFIGURATION_SCHEMA_VERSION = 1 as const;

export const ROLE_HARNESS_PROTOCOL = 'foundry-role-host-v1' as const;

/**
 * Harnesses Foundry knows how to launch. The configuration names one per
 * role; the exact launch argv and the accepted model catalog per harness are
 * hardcoded in the role-host adapter (see `src/platform/role-host.ts`), never
 * carried in configuration. The legacy `roleHarness` block left the
 * configuration document in task 054: per-role selection is the only
 * harness-related configuration.
 */
export const ROLE_HARNESS_NAMES = ['codex', 'opencode'] as const;

export type RoleHarnessName = (typeof ROLE_HARNESS_NAMES)[number];

/**
 * The exact provider credential names the Foundry process reads from its own
 * environment and forwards to bundled harnesses at launch. Both shipped
 * harnesses serve OpenAI models, so the set is one name; it is documented in
 * `docs/features/protocol-contracts.md`, and any addition is a deliberate
 * catalog change, never per-project configuration. Credential values never
 * reach configuration, prompts, or logs.
 */
export const BUNDLED_CREDENTIAL_ENVIRONMENT_NAMES: ReadonlyArray<string> = ['OPENAI_API_KEY'];

/**
 * The per-role harness and model selection carried in configuration. `model`
 * is stored trimmed and must be non-empty; whether the trimmed value names a
 * real model is decided by the harness adapter against its own catalog at
 * launch time, never by inventing a substitute.
 */
export interface RoleHarnessSelection {
  readonly harness: RoleHarnessName;
  readonly model: string;
}

/** Every role names its harness and model; missing roles fail closed. */
export type RoleHarnessSelections = {
  readonly [role in RoleHostRole]: RoleHarnessSelection;
};

export const PUBLICATION_DRAFT = true as const;

export const PUBLICATION_MAINTAINERS_CAN_MODIFY = false as const;

export const RUNTIME_DATA_POLICY = 'preserve' as const;

export const RUNTIME_TESTER_ACCESS = 'read_only' as const;

export const TASK_ID_PLACEHOLDER = '<task-id>' as const;

export const VERIFICATION_COMMANDS = ['formatCheck', 'lint', 'typecheck', 'test', 'build'] as const;

export type VerificationCommand = (typeof VERIFICATION_COMMANDS)[number];

export type CommandVector = readonly [string, ...Array<string>];

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

export const HARDCODED_ARTIFACT_BOUNDS: ArtifactConfiguration = {
  retentionDays: 30,
  maxRequestBytes: 262144,
  maxGuidanceBytes: 1048576,
  maxRoleHandoffBytes: 262144,
  maxEvidenceBytes: 26214400,
  maxTerminalCaptureBytes: 10485760,
  maxRunBytes: 104857600,
  redactionPatterns: [],
};

export interface ProjectConfiguration {
  readonly schemaVersion: typeof PROJECT_CONFIGURATION_SCHEMA_VERSION;
  readonly targetRepository: string;
  readonly sourceRemote: string;
  readonly sourceBranch: string;
  readonly taskBranchPolicy: string;
  readonly roles: RoleHarnessSelections;
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
