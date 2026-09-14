import { Effect, Result, Schema } from 'effect';

import { executePublicCommand } from '../application/public-commands.js';
import {
  INVALID_INVOCATION_KIND,
  NOT_AVAILABLE,
  PUBLIC_COMMANDS,
  REPORT_FAILURE_KINDS,
  REPORT_SCHEMA_VERSION,
  exitCodeForOutcome,
  isNonProductCommand,
  isPublicCommand,
} from '../domain/public-commands.js';
import { PUBLICATION_CAPABILITIES } from '../domain/readiness.js';
import { RunInspectReportSchema } from '../domain/inspection.js';
import { CleanupListReportSchema, CleanupRunReportSchema } from '../domain/retention-cleanup.js';
import { DiagnosticBundleReportSchema } from '../domain/diagnostic-bundle.js';
import { Identifier } from '../domain/run-identity.js';
import { RECOVERY_DISPOSITIONS } from '../domain/run-history.js';
import {
  CLEANUP_OUTCOMES,
  WorkflowAttemptSchema,
  WorkflowStateSchema,
} from '../domain/workflow.js';

import type { PublicCommand, PublicCommandInvocation } from '../domain/public-commands.js';
import type { ReportFailureKind } from '../domain/public-commands.js';
import type { DiagnosticBundleReport } from '../domain/diagnostic-bundle.js';
import type { PublicCommandError, PublicCommandReport } from '../application/public-commands.js';
import type { RunInspectReport } from '../application/inspect/index.js';
import type { RunGit } from '../application/git-provisioning/index.js';
import type { GuidanceGit, GuidanceSnapshotStore } from '../application/guidance/index.js';
import type { ProjectCommandProcess } from '../application/profile-check/index.js';
import type {
  OwnedProjectProcess,
  ProjectEvidenceStore,
} from '../application/project-commands/index.js';
import type { RunHistoryStorage } from '../application/run-history/index.js';
import type {
  RepositoryHostIdentity,
  RepositoryLeaseStore,
} from '../application/repository-lease/index.js';
import type {
  PublicationProbe,
  ReadinessFiles,
  ReadinessGit,
  ReadinessHost,
} from '../application/readiness/index.js';
import type { RunIdentityStore } from '../application/run-identity/index.js';
import type { RoleHostLauncher } from '../application/role-conversations/index.js';
import type { RoleTurnResourceObserver } from '../application/role-permissions/index.js';

const UNKNOWN_COMMAND_LABEL = 'foundry';

const BOOLEAN_FLAGS = ['--json', '--dry-run', '--abandon', '--list'] as const;

type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];

const VALUE_FLAGS = [
  '--config',
  '--request',
  '--task-id',
  '--run-id',
  '--reason',
  '--output',
  '--confirm',
] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

type FlagName = BooleanFlag | ValueFlag;

function isFlagName(token: string): token is FlagName {
  return BOOLEAN_FLAGS.some((flag) => flag === token) || VALUE_FLAGS.some((flag) => flag === token);
}

function isBooleanFlag(token: FlagName): token is BooleanFlag {
  return BOOLEAN_FLAGS.some((flag) => flag === token);
}

interface RawArgv {
  readonly command: string | undefined;
  readonly booleans: ReadonlySet<BooleanFlag>;
  readonly values: ReadonlyMap<ValueFlag, string>;
  readonly error: string | undefined;
}

function tokenizeArgv(argv: ReadonlyArray<string>): RawArgv {
  let command: string | undefined;
  let error: string | undefined;
  const booleans = new Set<BooleanFlag>();
  const values = new Map<ValueFlag, string>();

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    index += 1;
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith('--')) {
      if (command === undefined) {
        command = token;
      } else {
        error ??= `Unexpected argument: ${token}`;
      }
      continue;
    }
    if (token.includes('=')) {
      error ??= `Flag values must be separate arguments: ${token}`;
      continue;
    }
    if (!isFlagName(token)) {
      error ??= `Unknown flag: ${token}`;
      continue;
    }
    if (isBooleanFlag(token)) {
      if (booleans.has(token)) {
        error ??= `Duplicate flag: ${token}`;
      } else {
        booleans.add(token);
      }
      continue;
    }
    const value = argv[index];
    index += value === undefined ? 0 : 1;
    if (value === undefined) {
      error ??= `Missing value for flag: ${token}`;
      continue;
    }
    if (values.has(token)) {
      error ??= `Duplicate flag: ${token}`;
      continue;
    }
    values.set(token, value);
  }

  return { command, booleans, values, error };
}

const PathValue = Schema.NonEmptyString;

const Invocation = Schema.Union([
  Schema.Struct({
    command: Schema.Literal('run'),
    config: PathValue,
    request: PathValue,
    taskId: Identifier,
    runId: Identifier,
  }),
  Schema.Struct({
    command: Schema.Literal('resume'),
    config: PathValue,
    runId: Identifier,
    abandon: Schema.Literal(true),
    reason: PathValue,
  }),
  Schema.Struct({
    command: Schema.Literal('resume'),
    config: PathValue,
    runId: Identifier,
  }),
  Schema.Struct({
    command: Schema.Literal('status'),
    config: PathValue,
    runId: Identifier,
  }),
  Schema.Struct({
    command: Schema.Literal('inspect'),
    config: PathValue,
    runId: Identifier,
  }),
  Schema.Struct({
    command: Schema.Literal('doctor'),
    config: PathValue,
  }),
  Schema.Struct({
    command: Schema.Literal('init'),
    config: PathValue,
    taskId: Identifier,
    dryRun: Schema.Literal(true),
  }),
  Schema.Struct({
    command: Schema.Literal('profile-check'),
    config: PathValue,
  }),
  Schema.Struct({
    command: Schema.Literal('diagnostic-bundle'),
    config: PathValue,
    runId: Identifier,
    output: PathValue,
  }),
  Schema.Struct({
    command: Schema.Literal('cleanup'),
    config: PathValue,
    list: Schema.Literal(true),
  }),
  Schema.Struct({
    command: Schema.Literal('cleanup'),
    config: PathValue,
    runId: Identifier,
    confirm: Identifier,
  }),
]);

const ReportError = Schema.Struct({
  kind: Schema.Literals(REPORT_FAILURE_KINDS),
  message: Schema.String,
  retryable: Schema.Boolean,
  runId: Schema.optional(Schema.String),
});

const StubReportData = Schema.Struct({
  availability: Schema.Literal(NOT_AVAILABLE),
  message: Schema.String,
  runId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
});

const PublicationCapabilityReadinessData = Schema.Struct({
  capability: Schema.Literals(PUBLICATION_CAPABILITIES),
  state: Schema.Literals(['granted', 'denied', 'unknown']),
});

const PublicationReadinessData = Schema.Struct({
  configured: Schema.Boolean,
  eligible: Schema.Boolean,
  repository: Schema.NullOr(Schema.String),
  repositoryScope: Schema.Literals(['repository', 'broad', 'unknown']),
  reason: Schema.NullOr(Schema.String),
  capabilities: Schema.Array(PublicationCapabilityReadinessData),
});

const DoctorReportData = Schema.Struct({
  readiness: Schema.Literal('ready'),
  host: Schema.Struct({
    platform: Schema.String,
    nodeVersion: Schema.String,
    npmVersion: Schema.String,
    gitVersion: Schema.String,
  }),
  config: Schema.Struct({
    path: Schema.String,
    schemaVersion: Schema.Number,
  }),
  storage: Schema.Struct({
    path: Schema.String,
    ignored: Schema.Literal(true),
  }),
  repository: Schema.Struct({
    path: Schema.String,
    remote: Schema.String,
    branch: Schema.String,
    commit: Schema.String,
  }),
  roleHost: Schema.Struct({
    protocol: Schema.String,
    adapterVersion: Schema.String,
    resumable: Schema.Literal(true),
    availableRoles: Schema.Array(Schema.String),
    filesystemProfiles: Schema.Array(Schema.String),
    networkProfiles: Schema.Array(Schema.String),
  }),
  publication: Schema.optional(PublicationReadinessData),
});

const InitPreviewReportData = Schema.Struct({
  taskId: Schema.String,
  source: Schema.Struct({
    remote: Schema.String,
    branch: Schema.String,
    commit: Schema.String,
  }),
  branch: Schema.String,
  workspace: Schema.String,
  roleHarness: Schema.Struct({
    protocol: Schema.String,
    command: Schema.NonEmptyArray(Schema.String),
  }),
  artifacts: Schema.Struct({
    root: Schema.String,
  }),
});

const ProfileCheckReportData = Schema.Struct({
  profileCheck: Schema.Literal('passed'),
  repository: Schema.Struct({
    path: Schema.String,
  }),
  commands: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      command: Schema.Array(Schema.String),
      exitCode: Schema.Number,
    }),
  ),
});

const RunProvenanceData = Schema.Struct({
  repositoryRoot: Schema.String,
  gitDirectory: Schema.String,
  remoteUrl: Schema.String,
  sourceRemote: Schema.String,
  sourceBranch: Schema.String,
  sourceCommit: Schema.String,
  taskBranch: Schema.String,
  workspace: Schema.String,
  headCommit: Schema.String,
});

const RecordedRequestData = Schema.Struct({
  sourcePath: Schema.String,
  originalPath: Schema.String,
  normalizedPath: Schema.String,
  identityPath: Schema.String,
  originalByteLength: Schema.Number,
  originalContentHash: Schema.String,
  normalizedByteLength: Schema.Number,
  normalizedPromptHash: Schema.String,
});

const RecordedRunReportData = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  runDirectory: Schema.String,
  provenance: RunProvenanceData,
  request: RecordedRequestData,
});

const RunWorkflowDecisionData = Schema.Struct({
  applied: Schema.NullOr(Schema.Literals(['accept', 'correct', 'abandon'])),
  waiting: Schema.Boolean,
  draftPrUrl: Schema.NullOr(Schema.String),
});

const RunWorkflowRecoveryData = Schema.Struct({
  disposition: Schema.Literals(RECOVERY_DISPOSITIONS),
  reason: Schema.String,
});

const RunWorkflowReportData = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  runDirectory: Schema.String,
  request: RecordedRequestData,
  provenance: RunProvenanceData,
  workflowState: WorkflowStateSchema,
  outcome: WorkflowStateSchema,
  stages: Schema.Array(WorkflowStateSchema),
  testerSkipped: Schema.Boolean,
  decision: Schema.optional(RunWorkflowDecisionData),
  recovery: Schema.optional(RunWorkflowRecoveryData),
  resultPullRequest: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
});

const StatusMeasureData = Schema.Struct({
  available: Schema.Boolean,
  total: Schema.NullOr(Schema.Number),
  detail: Schema.String,
});

const StatusCountsData = Schema.Struct({
  roleAttempts: Schema.Number,
  retries: Schema.Number,
  repairs: Schema.Number,
  controlRepairs: Schema.Number,
  corrections: Schema.Number,
  findings: Schema.Number,
});

const StatusActiveRoleData = Schema.Struct({
  role: Schema.String,
  attempt: Schema.Number,
});

const StatusLastEventData = Schema.Struct({
  revision: Schema.Number,
  type: Schema.String,
  occurredAt: Schema.String,
  detail: Schema.String,
});

const StatusCleanupProgressData = Schema.Struct({
  outcome: Schema.Literals(CLEANUP_OUTCOMES),
  detail: Schema.String,
});

const RunStatusReportData = Schema.Struct({
  runId: Schema.String,
  workflowState: WorkflowStateSchema,
  checkpoint: Schema.NullOr(WorkflowStateSchema),
  activeRole: Schema.NullOr(StatusActiveRoleData),
  startedAt: Schema.NullOr(Schema.String),
  elapsedMs: Schema.NullOr(Schema.Number),
  lastEvent: Schema.NullOr(StatusLastEventData),
  branch: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
  counts: StatusCountsData,
  usage: Schema.Struct({
    tokens: StatusMeasureData,
    cost: StatusMeasureData,
  }),
  attempts: Schema.Array(WorkflowAttemptSchema),
  cleanupProgress: Schema.NullOr(StatusCleanupProgressData),
  provenance: Schema.NullOr(RunProvenanceData),
  historyPath: Schema.String,
  revision: Schema.Number,
  eventHash: Schema.NullOr(Schema.String),
});

const InspectReportData = RunInspectReportSchema;

const CleanupListReportData = CleanupListReportSchema;

const CleanupRunReportData = CleanupRunReportSchema;

const DiagnosticBundleReportData = DiagnosticBundleReportSchema;

const AbandonReportData = Schema.Struct({
  runId: Schema.String,
  workflowState: Schema.Literal('abandoned'),
  reason: Schema.String,
  cleanup: Schema.NullOr(StatusCleanupProgressData),
});

const ReportData = Schema.Union([
  StubReportData,
  DoctorReportData,
  InitPreviewReportData,
  ProfileCheckReportData,
  RunWorkflowReportData,
  RecordedRunReportData,
  RunStatusReportData,
  InspectReportData,
  CleanupListReportData,
  CleanupRunReportData,
  DiagnosticBundleReportData,
  AbandonReportData,
]);

const SuccessEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(REPORT_SCHEMA_VERSION),
  command: Schema.String,
  ok: Schema.Literal(true),
  data: ReportData,
});

const FailureEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(REPORT_SCHEMA_VERSION),
  command: Schema.String,
  ok: Schema.Literal(false),
  error: ReportError,
});

export const ReportEnvelope = Schema.Union([SuccessEnvelope, FailureEnvelope]);

export type ReportEnvelopeValue = (typeof ReportEnvelope)['Type'];

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
}

class InvalidInvocation extends Schema.TaggedError<InvalidInvocation>()('InvalidInvocation', {
  command: Schema.String,
  message: Schema.String,
  json: Schema.Boolean,
  runId: Schema.optional(Schema.String),
}) {}

interface DecodedInvocation {
  readonly invocation: (typeof Invocation)['Type'];
  readonly json: boolean;
}

interface InvocationCandidate {
  command: string;
  config?: string | undefined;
  request?: string | undefined;
  taskId?: string | undefined;
  runId?: string | undefined;
  reason?: string | undefined;
  output?: string | undefined;
  confirm?: string | undefined;
  dryRun?: boolean | undefined;
  abandon?: boolean | undefined;
  list?: boolean | undefined;
}

function buildCandidate(command: PublicCommand, raw: RawArgv): InvocationCandidate {
  const candidate: InvocationCandidate = { command };

  const config = raw.values.get('--config');
  if (config !== undefined) {
    candidate.config = config;
  }
  const request = raw.values.get('--request');
  if (request !== undefined) {
    candidate.request = request;
  }
  const taskId = raw.values.get('--task-id');
  if (taskId !== undefined) {
    candidate.taskId = taskId;
  }
  const runId = raw.values.get('--run-id');
  if (runId !== undefined) {
    candidate.runId = runId;
  }
  const reason = raw.values.get('--reason');
  if (reason !== undefined) {
    candidate.reason = reason;
  }
  const output = raw.values.get('--output');
  if (output !== undefined) {
    candidate.output = output;
  }
  const confirm = raw.values.get('--confirm');
  if (confirm !== undefined) {
    candidate.confirm = confirm;
  }

  if (raw.booleans.has('--dry-run')) {
    candidate.dryRun = true;
  }
  if (raw.booleans.has('--abandon')) {
    candidate.abandon = true;
  }
  if (raw.booleans.has('--list')) {
    candidate.list = true;
  }

  return candidate;
}

function validRunId(value: string | undefined): string | undefined {
  return value !== undefined && Schema.is(Identifier)(value) ? value : undefined;
}

const decodeInvocation = Effect.fn('decodeInvocation')(function* (
  argv: ReadonlyArray<string>,
): Effect.fn.Return<DecodedInvocation, InvalidInvocation> {
  const raw = tokenizeArgv(argv);
  const json = raw.booleans.has('--json');
  const runId = validRunId(raw.values.get('--run-id'));
  const attempted = raw.command;
  const command = attempted ?? UNKNOWN_COMMAND_LABEL;

  if (raw.error !== undefined) {
    return yield* new InvalidInvocation({ command, message: raw.error, json, runId });
  }
  if (attempted === undefined) {
    return yield* new InvalidInvocation({
      command: UNKNOWN_COMMAND_LABEL,
      message: `Missing command. Expected one of: ${PUBLIC_COMMANDS.join(', ')}.`,
      json,
      runId,
    });
  }
  if (isNonProductCommand(attempted)) {
    return yield* new InvalidInvocation({
      command: attempted,
      message: `Command "${attempted}" is not part of the Foundry product.`,
      json,
      runId,
    });
  }
  if (!isPublicCommand(attempted)) {
    return yield* new InvalidInvocation({
      command: attempted,
      message: `Unknown command: ${attempted}.`,
      json,
      runId,
    });
  }

  const decoded = yield* Schema.decodeUnknownEffect(Invocation, {
    onExcessProperty: 'error',
  })(buildCandidate(attempted, raw)).pipe(
    Effect.mapError(
      (error) =>
        new InvalidInvocation({
          command: attempted,
          message: `Invalid invocation: ${error.message.replaceAll(/\s+/gu, ' ').trim()}`,
          json,
          runId,
        }),
    ),
  );

  if ('confirm' in decoded && decoded.confirm !== decoded.runId) {
    return yield* new InvalidInvocation({
      command: attempted,
      message: 'Value for --confirm must match --run-id.',
      json,
      runId: decoded.runId,
    });
  }

  return { invocation: decoded, json };
});

function renderProvenanceLines(
  provenance: {
    readonly repositoryRoot: string;
    readonly gitDirectory: string;
    readonly remoteUrl: string;
    readonly sourceRemote: string;
    readonly sourceBranch: string;
    readonly sourceCommit: string;
    readonly taskBranch: string;
    readonly workspace: string;
    readonly headCommit: string;
  } | null,
): ReadonlyArray<string> {
  if (provenance === null) {
    return ['data.provenance: null'];
  }
  return [
    `data.provenance.repositoryRoot: ${provenance.repositoryRoot}`,
    `data.provenance.gitDirectory: ${provenance.gitDirectory}`,
    `data.provenance.remoteUrl: ${provenance.remoteUrl}`,
    `data.provenance.sourceRemote: ${provenance.sourceRemote}`,
    `data.provenance.sourceBranch: ${provenance.sourceBranch}`,
    `data.provenance.sourceCommit: ${provenance.sourceCommit}`,
    `data.provenance.taskBranch: ${provenance.taskBranch}`,
    `data.provenance.workspace: ${provenance.workspace}`,
    `data.provenance.headCommit: ${provenance.headCommit}`,
  ];
}

function renderInspectHuman(data: RunInspectReport): ReadonlyArray<string> {
  const lines: Array<string> = [
    `data.runId: ${data.runId}`,
    `data.workflowState: ${data.workflowState ?? 'none'}`,
    `data.revision: ${data.revision}`,
    `data.eventHash: ${data.eventHash ?? 'none'}`,
    `data.historyPath: ${data.historyPath}`,
  ];

  const pushSection = (name: string, entry: { availability: string; detail: string }): void => {
    lines.push(
      `data.sections.${name}: ${entry.availability}`,
      `data.sections.${name}.detail: ${entry.detail}`,
    );
  };
  pushSection('plan', data.sections.plan);
  pushSection('implementation', data.sections.implementation);
  pushSection('checks', data.sections.checks);
  pushSection('tester', data.sections.tester);
  pushSection('reviewer', data.sections.reviewer);
  pushSection('failures', data.sections.failures);
  pushSection('findings', data.sections.findings);
  pushSection('corrections', data.sections.corrections);
  pushSection('decision', data.sections.decision);
  pushSection('publication', data.sections.publication);
  pushSection('cleanup', data.sections.cleanup);
  pushSection('journals', data.sections.journals);
  pushSection('captures', data.sections.captures);

  if (data.plan === null) {
    lines.push('data.plan: none');
  } else {
    lines.push(
      `data.plan.outcome: ${data.plan.outcome}`,
      `data.plan.runtimeValidationRequired: ${data.plan.runtimeValidationRequired}`,
      `data.plan.executionMode: ${data.plan.executionMode}`,
    );
    for (const objective of data.plan.objectives) {
      lines.push(
        `data.plan.objectives: ${objective.id} criteria=${objective.criterionIds.join(',')} paths=${objective.affectedPaths.join(',')} title=${objective.title}`,
      );
    }
    for (const criterion of data.plan.criteria) {
      lines.push(
        `data.plan.criteria: ${criterion.id} commit=${criterion.resultCommit ?? 'none'} checks=${criterion.checks.join(',')} reviewer=${criterion.reviewerOutcome ?? 'none'} objectives=${criterion.objectiveIds.join(',')}`,
      );
    }
  }

  if (data.implementation === null) {
    lines.push('data.implementation: none');
  } else {
    lines.push(
      `data.implementation.taskBranch: ${data.implementation.taskBranch}`,
      `data.implementation.baseCommit: ${data.implementation.baseCommit}`,
      `data.implementation.commit: ${data.implementation.commit ?? 'none'}`,
      `data.implementation.noChangeCandidate: ${data.implementation.noChangeCandidate}`,
      `data.implementation.changedFiles: ${data.implementation.changedFiles.join(',')}`,
    );
  }

  for (const report of data.checks) {
    lines.push(
      `data.checks: attempt=${report.attempt} commit=${report.commit} result=${report.result} profileHash=${report.profileHash} commandMs=${report.commandMs}`,
    );
    for (const execution of report.executions) {
      lines.push(
        `data.checks.executions: ${execution.name} kind=${execution.kind} passed=${execution.passed} exit=${execution.actualExitCode ?? 'none'} command=${execution.command} log=${execution.logPath} sha256=${execution.logSha256}`,
      );
    }
  }

  lines.push(
    `data.tester.required: ${data.tester.required}`,
    `data.tester.status: ${data.tester.status}`,
    `data.tester.detail: ${data.tester.detail}`,
    `data.tester.commit: ${data.tester.commit ?? 'none'}`,
    `data.tester.narrative: ${data.tester.narrative ?? 'none'}`,
  );
  for (const limitation of data.tester.limitations) {
    lines.push(`data.tester.limitations: ${limitation.commit} ${limitation.reason}`);
  }
  for (const skip of data.tester.skips) {
    lines.push(`data.tester.skips: ${skip.verificationCommit} ${skip.reason}`);
  }
  for (const runtime of data.tester.runtimes) {
    lines.push(
      `data.tester.runtimes: ${runtime.commit} outcome=${runtime.outcome} cleanup=${runtime.cleanup} dataPreserved=${runtime.dataPreserved}`,
    );
  }

  if (data.reviewer === null) {
    lines.push('data.reviewer: none');
  } else {
    lines.push(
      `data.reviewer.outcome: ${data.reviewer.outcome ?? 'none'}`,
      `data.reviewer.attempt: ${data.reviewer.attempt}`,
      `data.reviewer.model: ${data.reviewer.model}`,
      `data.reviewer.narrative: ${data.reviewer.narrative}`,
    );
  }

  for (const attempt of data.failures.attempts) {
    lines.push(
      `data.failures.attempts: ${attempt.sequence} ${attempt.kind} ${attempt.role} ${attempt.state} ${attempt.reason}`,
    );
  }
  for (const rejection of data.failures.controlRejections) {
    lines.push(
      `data.failures.controlRejections: ${rejection.sessionId} resolved=${rejection.resolved} ${rejection.problem}`,
    );
  }
  for (const violation of data.failures.permissionViolations) {
    lines.push(
      `data.failures.permissionViolations: ${violation.role} attempt=${violation.attempt} kind=${violation.kind} ${violation.detail}`,
    );
  }

  for (const finding of data.findings) {
    lines.push(
      `data.findings: ${finding.id} severity=${finding.severity} blocking=${finding.blocking} commit=${finding.commit} ${finding.description}`,
    );
  }

  for (const correction of data.corrections) {
    lines.push(
      `data.corrections: ${correction.route} ${correction.from ?? 'none'}->${correction.to} at=${correction.at}`,
    );
  }

  if (data.decision === null) {
    lines.push('data.decision: none');
  } else {
    lines.push(
      `data.decision.decisionId: ${data.decision.decisionId ?? 'none'}`,
      `data.decision.question: ${data.decision.question}`,
      `data.decision.recommendation: ${data.decision.recommendation ?? 'none'}`,
      `data.decision.sourceCommit: ${data.decision.sourceCommit ?? 'none'}`,
      `data.decision.resultCommit: ${data.decision.resultCommit ?? 'none'}`,
      `data.decision.draftPrUrl: ${data.decision.draftPrUrl ?? 'none'}`,
      `data.decision.publicationStage: ${data.decision.publicationStage ?? 'none'}`,
      `data.decision.commandsExact: ${data.decision.commandsExact}`,
      `data.decision.commentAccepted: ${data.decision.commentAccepted}`,
      `data.decision.commentAcceptedKnown: ${data.decision.commentAcceptedKnown}`,
    );
    for (const option of data.decision.options) {
      lines.push(`data.decision.options: ${option.id} action=${option.action} ${option.label}`);
    }
    for (const command of data.decision.commands) {
      lines.push(`data.decision.commands: ${command.optionId} ${command.command}`);
    }
    for (const finding of data.decision.unresolvedFindings) {
      lines.push(
        `data.decision.unresolvedFindings: ${finding.id} severity=${finding.severity} commit=${finding.commit} ${finding.description}`,
      );
    }
    for (const limitation of data.decision.unresolvedLimitations) {
      lines.push(`data.decision.unresolvedLimitations: ${limitation.commit} ${limitation.reason}`);
    }
  }

  lines.push(
    `data.publication.state: ${data.publication.state ?? 'none'}`,
    `data.publication.draftPrUrl: ${data.publication.draftPrUrl ?? 'none'}`,
  );
  for (const transition of data.publication.transitions) {
    lines.push(
      `data.publication.transitions: ${transition.route} ${transition.from ?? 'none'}->${transition.to} at=${transition.at}`,
    );
  }
  for (const checkpoint of data.publication.checkpoints) {
    lines.push(
      `data.publication.checkpoints: ${checkpoint.stage} decisionId=${checkpoint.decisionId ?? 'none'} draftPrUrl=${checkpoint.draftPrUrl ?? 'none'} ${checkpoint.detail}`,
    );
  }

  if (data.cleanup === null) {
    lines.push('data.cleanup: none');
  } else {
    lines.push(
      `data.cleanup.outcome: ${data.cleanup.outcome}`,
      `data.cleanup.detail: ${data.cleanup.detail}`,
    );
  }

  for (const journal of data.journals) {
    lines.push(
      `data.journals: ${journal.kind} session=${journal.sessionId} role=${journal.role ?? 'none'} generation=${journal.generation ?? 'none'} ${journal.detail}`,
    );
  }

  for (const capture of data.captures.entries) {
    lines.push(
      `data.captures: ${capture.source} verified=${capture.verified} hash=${capture.contentHash ?? 'none'} bytes=${capture.byteLength ?? 'none'} ${capture.label}`,
    );
  }
  for (const duplicate of data.captures.duplicates) {
    lines.push(
      `data.captures.duplicates: ${duplicate.contentHash} labels=${duplicate.labels.join('|')}`,
    );
  }

  return lines;
}

function renderDiagnosticBundleHuman(data: DiagnosticBundleReport): ReadonlyArray<string> {
  const lines: Array<string> = [
    `data.runId: ${data.runId}`,
    `data.destination: ${data.destination}`,
    `data.manifestPath: ${data.manifestPath}`,
    `data.manifest.schemaVersion: ${data.manifest.schemaVersion}`,
    `data.manifest.entryCount: ${data.manifest.entryCount}`,
    `data.manifest.totalByteLength: ${data.manifest.totalByteLength}`,
  ];
  for (const entry of data.manifest.entries) {
    lines.push(
      `data.manifest.entries: ${entry.path} source=${entry.source} bytes=${entry.byteLength} originalBytes=${entry.originalByteLength} sha256=${entry.sha256} redactions=${entry.redactionCount} truncated=${entry.truncated}`,
    );
  }
  return lines;
}

function renderHuman(envelope: ReportEnvelopeValue): string {
  const lines = [
    `schemaVersion: ${envelope.schemaVersion}`,
    `command: ${envelope.command}`,
    `ok: ${envelope.ok}`,
  ];
  if (envelope.ok) {
    const data = envelope.data;
    if ('availability' in data) {
      lines.push(`data.availability: ${data.availability}`, `data.message: ${data.message}`);
      if (data.runId !== undefined) {
        lines.push(`data.runId: ${data.runId}`);
      }
      if (data.taskId !== undefined) {
        lines.push(`data.taskId: ${data.taskId}`);
      }
    } else if ('readiness' in data) {
      lines.push(
        `data.readiness: ${data.readiness}`,
        `data.host.platform: ${data.host.platform}`,
        `data.host.nodeVersion: ${data.host.nodeVersion}`,
        `data.host.npmVersion: ${data.host.npmVersion}`,
        `data.host.gitVersion: ${data.host.gitVersion}`,
        `data.config.path: ${data.config.path}`,
        `data.config.schemaVersion: ${data.config.schemaVersion}`,
        `data.storage.path: ${data.storage.path}`,
        `data.storage.ignored: ${data.storage.ignored}`,
        `data.repository.path: ${data.repository.path}`,
        `data.repository.remote: ${data.repository.remote}`,
        `data.repository.branch: ${data.repository.branch}`,
        `data.repository.commit: ${data.repository.commit}`,
        `data.roleHost.protocol: ${data.roleHost.protocol}`,
        `data.roleHost.adapterVersion: ${data.roleHost.adapterVersion}`,
        `data.roleHost.resumable: ${data.roleHost.resumable}`,
        `data.roleHost.availableRoles: ${data.roleHost.availableRoles.join(' ')}`,
        `data.roleHost.filesystemProfiles: ${data.roleHost.filesystemProfiles.join(' ')}`,
        `data.roleHost.networkProfiles: ${data.roleHost.networkProfiles.join(' ')}`,
      );
      if (data.publication !== undefined) {
        lines.push(
          `data.publication.configured: ${data.publication.configured}`,
          `data.publication.eligible: ${data.publication.eligible}`,
          `data.publication.repository: ${data.publication.repository ?? 'none'}`,
          `data.publication.repositoryScope: ${data.publication.repositoryScope}`,
          `data.publication.reason: ${data.publication.reason ?? 'none'}`,
          `data.publication.capabilities: ${data.publication.capabilities
            .map((capability) => `${capability.capability}=${capability.state}`)
            .join(' ')}`,
        );
      }
    } else if ('profileCheck' in data) {
      lines.push(
        `data.profileCheck: ${data.profileCheck}`,
        `data.repository.path: ${data.repository.path}`,
      );
      for (const command of data.commands) {
        lines.push(
          `data.commands: ${command.name} ${command.command.join(' ')} ${command.exitCode}`,
        );
      }
    } else if ('request' in data) {
      lines.push(
        `data.runId: ${data.runId}`,
        `data.taskId: ${data.taskId}`,
        `data.runDirectory: ${data.runDirectory}`,
        ...renderProvenanceLines(data.provenance),
        `data.request.sourcePath: ${data.request.sourcePath}`,
        `data.request.originalPath: ${data.request.originalPath}`,
        `data.request.normalizedPath: ${data.request.normalizedPath}`,
        `data.request.identityPath: ${data.request.identityPath}`,
        `data.request.originalByteLength: ${data.request.originalByteLength}`,
        `data.request.originalContentHash: ${data.request.originalContentHash}`,
        `data.request.normalizedByteLength: ${data.request.normalizedByteLength}`,
        `data.request.normalizedPromptHash: ${data.request.normalizedPromptHash}`,
      );
      if ('workflowState' in data) {
        lines.push(
          `data.workflowState: ${data.workflowState}`,
          `data.outcome: ${data.outcome}`,
          `data.stages: ${data.stages.join(' ')}`,
          `data.testerSkipped: ${data.testerSkipped}`,
          `data.resultPullRequest: ${data.resultPullRequest ?? 'none'}`,
        );
        if (data.decision !== undefined) {
          lines.push(
            `data.decision.applied: ${data.decision.applied ?? 'none'}`,
            `data.decision.waiting: ${data.decision.waiting}`,
            `data.decision.draftPrUrl: ${data.decision.draftPrUrl ?? 'none'}`,
          );
        }
        if (data.recovery !== undefined) {
          lines.push(
            `data.recovery.disposition: ${data.recovery.disposition}`,
            `data.recovery.reason: ${data.recovery.reason}`,
          );
        }
      }
    } else if ('manifest' in data) {
      lines.push(...renderDiagnosticBundleHuman(data));
    } else if ('sections' in data) {
      lines.push(...renderInspectHuman(data));
    } else if ('runs' in data) {
      lines.push(`data.retentionDays: ${data.retentionDays}`, `data.guidance: ${data.guidance}`);
      for (const run of data.runs) {
        lines.push(
          `data.runs: ${run.runId} state=${run.workflowState} terminalAt=${run.terminalAt} ageMs=${run.ageMs} ownership=${run.ownership} taskBranch=${run.taskBranch ?? 'none'} cleanup=${run.cleanupOutcome ?? 'none'} taskId=${run.taskId ?? 'none'}`,
        );
      }
    } else if ('checks' in data) {
      lines.push(
        `data.runId: ${data.runId}`,
        `data.outcome: ${data.outcome}`,
        `data.message: ${data.message}`,
        `data.preserved.taskBranch: ${data.preserved.taskBranch ?? 'none'}`,
        `data.preserved.handoffPath: ${data.preserved.handoffPath}`,
      );
      for (const check of data.checks) {
        lines.push(`data.checks: ${check.check} ok=${check.ok} ${check.detail}`);
      }
      for (const resource of data.resources) {
        lines.push(`data.resources: ${resource.kind} ${resource.name} ${resource.disposition}`);
      }
    } else if ('cleanup' in data) {
      lines.push(
        `data.runId: ${data.runId}`,
        `data.workflowState: ${data.workflowState}`,
        `data.reason: ${data.reason}`,
        data.cleanup === null
          ? 'data.cleanup: none'
          : `data.cleanup: ${data.cleanup.outcome} ${data.cleanup.detail}`,
      );
    } else if ('workflowState' in data) {
      lines.push(
        `data.runId: ${data.runId}`,
        `data.workflowState: ${data.workflowState}`,
        `data.checkpoint: ${data.checkpoint ?? 'none'}`,
        data.activeRole === null
          ? 'data.activeRole: none'
          : `data.activeRole: ${data.activeRole.role} attempt ${data.activeRole.attempt}`,
        `data.startedAt: ${data.startedAt ?? 'unknown'}`,
        `data.elapsedMs: ${data.elapsedMs ?? 'unknown'}`,
        `data.branch: ${data.branch ?? 'unknown'}`,
        `data.commit: ${data.commit ?? 'unknown'}`,
        `data.counts.roleAttempts: ${data.counts.roleAttempts}`,
        `data.counts.retries: ${data.counts.retries}`,
        `data.counts.repairs: ${data.counts.repairs}`,
        `data.counts.controlRepairs: ${data.counts.controlRepairs}`,
        `data.counts.corrections: ${data.counts.corrections}`,
        `data.counts.findings: ${data.counts.findings}`,
        `data.usage.tokens.available: ${data.usage.tokens.available}`,
        `data.usage.tokens.total: ${data.usage.tokens.total ?? 'unknown'}`,
        `data.usage.tokens.detail: ${data.usage.tokens.detail}`,
        `data.usage.cost.available: ${data.usage.cost.available}`,
        `data.usage.cost.total: ${data.usage.cost.total ?? 'unknown'}`,
        `data.usage.cost.detail: ${data.usage.cost.detail}`,
        `data.revision: ${data.revision}`,
        `data.eventHash: ${data.eventHash ?? 'none'}`,
        `data.historyPath: ${data.historyPath}`,
        `data.cleanupProgress: ${data.cleanupProgress === null ? 'none' : data.cleanupProgress.outcome}`,
      );
      for (const attempt of data.attempts) {
        lines.push(
          `data.attempts: ${attempt.sequence} ${attempt.kind} ${attempt.role} ${attempt.state}`,
        );
      }
      if (data.lastEvent === null) {
        lines.push('data.lastEvent: none');
      } else {
        lines.push(
          `data.lastEvent.revision: ${data.lastEvent.revision}`,
          `data.lastEvent.type: ${data.lastEvent.type}`,
          `data.lastEvent.occurredAt: ${data.lastEvent.occurredAt}`,
          `data.lastEvent.detail: ${data.lastEvent.detail}`,
        );
      }
      lines.push(...renderProvenanceLines(data.provenance));
    } else {
      lines.push(
        `data.taskId: ${data.taskId}`,
        `data.source.remote: ${data.source.remote}`,
        `data.source.branch: ${data.source.branch}`,
        `data.source.commit: ${data.source.commit}`,
        `data.branch: ${data.branch}`,
        `data.workspace: ${data.workspace}`,
        `data.roleHarness.protocol: ${data.roleHarness.protocol}`,
        `data.roleHarness.command: ${data.roleHarness.command.join(' ')}`,
        `data.artifacts.root: ${data.artifacts.root}`,
      );
    }
  } else {
    lines.push(
      `error.kind: ${envelope.error.kind}`,
      `error.message: ${envelope.error.message}`,
      `error.retryable: ${envelope.error.retryable}`,
    );
    if (envelope.error.runId !== undefined) {
      lines.push(`error.runId: ${envelope.error.runId}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function failureKindFor(error: PublicCommandError): ReportFailureKind {
  switch (error._tag) {
    case 'RunWorkflowError':
      return error.kind;
    case 'RunStateUnavailable':
    case 'RunHistoryIntegrityError':
    case 'RunHistoryStorageError':
    case 'RunHistoryConflict':
    case 'IllegalWorkflowTransition':
    case 'DiagnosticBundleRefused':
    case 'RepositoryLeaseOwnershipLost':
    case 'RepositoryLeaseStorageError':
    case 'RoleHostCapabilityError':
      return 'failed';
    case 'RunWorkspaceBlocked':
    case 'RepositoryLeaseContended':
    case 'RepositoryLeaseAmbiguous':
    case 'GuidanceSnapshotRejected':
      return 'blocked';
    case 'GuidanceSnapshotInvalid':
    case 'GuidanceStorageError':
      return 'failed';
    case 'RetentionCleanupError':
      return error.kind;
    default:
      return INVALID_INVOCATION_KIND;
  }
}

function renderEnvelope(envelope: ReportEnvelopeValue, json: boolean): string {
  if (!json) {
    return renderHuman(envelope);
  }
  return `${JSON.stringify(Schema.encodeSync(ReportEnvelope)(envelope))}\n`;
}

function toDomainInvocation(
  invocation: (typeof Invocation)['Type'],
  cwd: string,
): PublicCommandInvocation {
  switch (invocation.command) {
    case 'run': {
      return {
        command: 'run',
        runId: invocation.runId,
        taskId: invocation.taskId,
        config: invocation.config,
        request: invocation.request,
        cwd,
      };
    }
    case 'resume': {
      return {
        command: 'resume',
        runId: invocation.runId,
        config: invocation.config,
        cwd,
        abandon: 'abandon' in invocation ? invocation.abandon === true : false,
        reason: 'reason' in invocation ? invocation.reason : undefined,
      };
    }
    case 'status':
    case 'inspect': {
      return {
        command: invocation.command,
        runId: invocation.runId,
        config: invocation.config,
        cwd,
      };
    }
    case 'doctor': {
      return { command: 'doctor', config: invocation.config, cwd };
    }
    case 'init': {
      return {
        command: 'init',
        taskId: invocation.taskId,
        config: invocation.config,
        cwd,
      };
    }
    case 'profile-check': {
      return { command: 'profile-check', config: invocation.config, cwd };
    }
    case 'diagnostic-bundle': {
      return {
        command: 'diagnostic-bundle',
        runId: invocation.runId,
        config: invocation.config,
        output: invocation.output,
        cwd,
      };
    }
    case 'cleanup': {
      if ('runId' in invocation) {
        return {
          command: 'cleanup',
          runId: invocation.runId,
          confirm: invocation.confirm,
          config: invocation.config,
          cwd,
        };
      }
      return { command: 'cleanup', config: invocation.config, cwd };
    }
    default: {
      const exhaustive: never = invocation;
      return exhaustive;
    }
  }
}

function toEnvelopeData(report: PublicCommandReport): (typeof ReportData)['Type'] {
  if ('availability' in report) {
    if (report.runId !== undefined && report.taskId !== undefined) {
      return {
        availability: report.availability,
        message: report.message,
        runId: report.runId,
        taskId: report.taskId,
      };
    }
    if (report.runId !== undefined) {
      return {
        availability: report.availability,
        message: report.message,
        runId: report.runId,
      };
    }
    if (report.taskId !== undefined) {
      return {
        availability: report.availability,
        message: report.message,
        taskId: report.taskId,
      };
    }
    return {
      availability: report.availability,
      message: report.message,
    };
  }
  if ('host' in report) {
    const base: (typeof DoctorReportData)['Type'] = {
      readiness: 'ready',
      host: {
        platform: report.host.platform,
        nodeVersion: report.host.nodeVersion,
        npmVersion: report.host.npmVersion,
        gitVersion: report.host.gitVersion,
      },
      config: {
        path: report.config.path,
        schemaVersion: report.config.schemaVersion,
      },
      storage: {
        path: report.storage.path,
        ignored: report.storage.ignored,
      },
      repository: {
        path: report.repository.path,
        remote: report.repository.remote,
        branch: report.repository.branch,
        commit: report.repository.commit,
      },
      roleHost: {
        protocol: report.roleHost.protocol,
        adapterVersion: report.roleHost.adapterVersion,
        resumable: report.roleHost.resumable,
        availableRoles: [...report.roleHost.availableRoles],
        filesystemProfiles: [...report.roleHost.filesystemProfiles],
        networkProfiles: [...report.roleHost.networkProfiles],
      },
    };
    if (!('publication' in report)) {
      return base;
    }
    return {
      ...base,
      publication: Schema.decodeUnknownSync(PublicationReadinessData)(report.publication),
    };
  }
  if ('profileCheck' in report) {
    return {
      profileCheck: report.profileCheck,
      repository: {
        path: report.repository.path,
      },
      commands: report.commands.map((command) => ({
        name: command.name,
        command: [...command.command],
        exitCode: command.exitCode,
      })),
    };
  }
  if ('request' in report) {
    const request = {
      sourcePath: report.request.sourcePath,
      originalPath: report.request.originalPath,
      normalizedPath: report.request.normalizedPath,
      identityPath: report.request.identityPath,
      originalByteLength: report.request.originalByteLength,
      originalContentHash: report.request.originalContentHash,
      normalizedByteLength: report.request.normalizedByteLength,
      normalizedPromptHash: report.request.normalizedPromptHash,
    };
    if ('workflowState' in report) {
      const workflowReport = {
        runId: report.runId,
        taskId: report.taskId,
        runDirectory: report.runDirectory,
        request,
        provenance: { ...report.provenance },
        workflowState: report.workflowState,
        outcome: report.outcome,
        stages: [...report.stages],
        testerSkipped: report.testerSkipped,
        resultPullRequest: report.resultPullRequest ?? null,
      };
      if (report.decision === undefined && report.recovery === undefined) {
        return workflowReport;
      }
      const decisionData =
        report.decision === undefined
          ? null
          : {
              applied: report.decision.applied,
              waiting: report.decision.waiting,
              draftPrUrl: report.decision.draftPrUrl,
            };
      const recoveryData =
        report.recovery === undefined
          ? null
          : {
              disposition: report.recovery.disposition,
              reason: report.recovery.reason,
            };
      if (decisionData !== null && recoveryData !== null) {
        return { ...workflowReport, decision: decisionData, recovery: recoveryData };
      }
      if (decisionData !== null) {
        return { ...workflowReport, decision: decisionData };
      }
      if (recoveryData !== null) {
        return { ...workflowReport, recovery: recoveryData };
      }
      return workflowReport;
    }
    return {
      runId: report.runId,
      taskId: report.taskId,
      runDirectory: report.runDirectory,
      provenance: { ...report.provenance },
      request,
    };
  }
  if ('manifest' in report) {
    return Schema.decodeUnknownSync(DiagnosticBundleReportData)(report);
  }
  if ('sections' in report) {
    return Schema.decodeUnknownSync(InspectReportData)(report);
  }
  if ('runs' in report) {
    return {
      schemaVersion: report.schemaVersion,
      retentionDays: report.retentionDays,
      runs: report.runs.map((run) => ({ ...run })),
      guidance: report.guidance,
    };
  }
  if ('checks' in report) {
    return {
      schemaVersion: report.schemaVersion,
      runId: report.runId,
      outcome: report.outcome,
      checks: report.checks.map((check) => ({ ...check })),
      resources: report.resources.map((resource) => ({ ...resource })),
      preserved: { ...report.preserved },
      message: report.message,
    };
  }
  if ('cleanup' in report) {
    return {
      runId: report.runId,
      workflowState: 'abandoned',
      reason: report.reason,
      cleanup: report.cleanup === null ? null : { ...report.cleanup },
    };
  }
  if ('workflowState' in report) {
    return {
      runId: report.runId,
      workflowState: report.workflowState,
      checkpoint: report.checkpoint,
      activeRole:
        report.activeRole === null
          ? null
          : { role: report.activeRole.role, attempt: report.activeRole.attempt },
      startedAt: report.startedAt,
      elapsedMs: report.elapsedMs,
      lastEvent:
        report.lastEvent === null
          ? null
          : {
              revision: report.lastEvent.revision,
              type: report.lastEvent.type,
              occurredAt: report.lastEvent.occurredAt,
              detail: report.lastEvent.detail,
            },
      branch: report.branch,
      commit: report.commit,
      counts: { ...report.counts },
      usage: {
        tokens: { ...report.usage.tokens },
        cost: { ...report.usage.cost },
      },
      attempts: report.attempts.map((attempt) => ({ ...attempt })),
      cleanupProgress: report.cleanupProgress === null ? null : { ...report.cleanupProgress },
      provenance: report.provenance === null ? null : { ...report.provenance },
      historyPath: report.historyPath,
      revision: report.revision,
      eventHash: report.eventHash,
    };
  }
  return {
    taskId: report.taskId,
    source: {
      remote: report.source.remote,
      branch: report.source.branch,
      commit: report.source.commit,
    },
    branch: report.branch,
    workspace: report.workspace,
    roleHarness: {
      protocol: report.roleHarness.protocol,
      command: [...report.roleHarness.command],
    },
    artifacts: {
      root: report.artifacts.root,
    },
  };
}

export const runCli = Effect.fn('runCli')(function* (
  argv: ReadonlyArray<string>,
): Effect.fn.Return<
  CliResult,
  never,
  | ReadinessHost
  | ReadinessFiles
  | ReadinessGit
  | PublicationProbe
  | ProjectCommandProcess
  | ProjectEvidenceStore
  | OwnedProjectProcess
  | RunIdentityStore
  | RunHistoryStorage
  | RepositoryLeaseStore
  | RepositoryHostIdentity
  | RoleHostLauncher
  | RoleTurnResourceObserver
  | RunGit
  | GuidanceGit
  | GuidanceSnapshotStore
> {
  const decoded = yield* decodeInvocation(argv).pipe(Effect.result);

  if (Result.isFailure(decoded)) {
    const error = decoded.failure;
    const envelope: ReportEnvelopeValue = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: error.command,
      ok: false,
      error: {
        kind: INVALID_INVOCATION_KIND,
        message: error.message,
        retryable: false,
        runId: error.runId,
      },
    };
    return {
      exitCode: exitCodeForOutcome({ ok: false, kind: INVALID_INVOCATION_KIND }),
      stdout: renderEnvelope(envelope, error.json),
    };
  }

  const { invocation, json } = decoded.success;
  const cwd = yield* Effect.sync(() => process.cwd());
  const outcome = yield* executePublicCommand(toDomainInvocation(invocation, cwd)).pipe(
    Effect.result,
  );

  if (Result.isFailure(outcome)) {
    const failureValue = outcome.failure;
    const errorRunId = 'runId' in failureValue ? failureValue.runId : undefined;
    const invocationRunId = 'runId' in invocation ? invocation.runId : undefined;
    const failureKind = failureKindFor(failureValue);
    const failure: ReportEnvelopeValue = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: invocation.command,
      ok: false,
      error: {
        kind: failureKind,
        message: failureValue.message,
        retryable: false,
        runId: errorRunId ?? invocationRunId,
      },
    };
    return {
      exitCode: exitCodeForOutcome({ ok: false, kind: failureKind }),
      stdout: renderEnvelope(failure, json),
    };
  }

  const envelope: ReportEnvelopeValue = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    command: invocation.command,
    ok: true,
    data: toEnvelopeData(outcome.success),
  };
  return {
    exitCode: exitCodeForOutcome({ ok: true }),
    stdout: renderEnvelope(envelope, json),
  };
});
