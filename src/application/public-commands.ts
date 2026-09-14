import { Effect } from 'effect';
import { dirname, join, resolve } from 'node:path';

import { NOT_AVAILABLE } from '../domain/public-commands.js';
import {
  REQUEST_IDENTITY_FILENAME,
  REQUEST_NORMALIZED_FILENAME,
  REQUEST_ORIGINAL_FILENAME,
} from '../domain/run-identity.js';
import { PRODUCT_NAME } from '../domain/workflow.js';
import { abandonRun } from './abandonment/index.js';
import { checkProjectProfile } from './profile-check/index.js';
import { checkReadiness } from './readiness/index.js';
import { previewRunLocations } from './preview-run-locations/index.js';
import { createDiagnosticBundle } from './diagnostic-bundle/index.js';
import { readRunInspect } from './inspect/index.js';
import { readRetentionCleanupList, runRetentionCleanup } from './retention-cleanup/index.js';
import type { RetentionCleanupError } from './retention-cleanup/index.js';
import { advanceRun, RunWorkflowError } from './run-workflow/index.js';
import {
  InvalidRunRequest,
  RunIdentityStore,
  RunStateUnavailable,
  readRetainedRunIdentity,
  reconcileRunReports,
  recordRunIdentity,
  resolveRunContext,
} from './run-identity/index.js';
import { readRunStatus } from './status/index.js';

import type { PublicCommandInvocation } from '../domain/public-commands.js';
import type { AbandonReport } from './abandonment/index.js';
import type { RunWorkflowOutcome } from './run-workflow/index.js';
import type { RequestIdentityDocument } from '../domain/run-identity.js';
import type { RecoveryDisposition } from '../domain/run-history.js';
import type { WorkflowState } from '../domain/workflow.js';
import type { IllegalWorkflowTransition } from './workflow-transitions/index.js';
import type {
  RunHistoryConflict,
  RunHistoryIntegrityError,
  RunHistoryStorage,
  RunHistoryStorageError,
} from './run-history/index.js';
import type { RunGit, RunWorkspaceBlocked } from './git-provisioning/index.js';
import type { GuidanceGit, GuidanceSnapshotStore } from './guidance/index.js';
import type {
  DoctorReport,
  PublicationProbe,
  ReadinessError,
  ReadinessFiles,
  ReadinessGit,
  ReadinessHost,
} from './readiness/index.js';
import type {
  PreviewLocationsError,
  PreviewLocationsReport,
} from './preview-run-locations/index.js';
import type { CleanupListReport, CleanupRunReport } from '../domain/retention-cleanup.js';
import type {
  ProfileCheckError,
  ProfileCheckReport,
  ProjectCommandProcess,
} from './profile-check/index.js';
import type { OwnedProjectProcess, ProjectEvidenceStore } from './project-commands/index.js';
import type {
  RecordedRequestFiles,
  RecordedRunIdentityReport,
  RunIdentityError,
  RunIdentityStore as RunIdentityStoreService,
  RunProvenance,
} from './run-identity/index.js';
import type { RunStatusReport } from './status/index.js';
import type { RunInspectError, RunInspectReport } from './inspect/index.js';
import type {
  CreateDiagnosticBundleError,
  DiagnosticBundleReport,
} from './diagnostic-bundle/index.js';
import type { RepositoryHostIdentity, RepositoryLeaseStore } from './repository-lease/index.js';
import type { RoleHostCapabilityError, RoleHostLauncher } from './role-conversations/index.js';
import type { RoleTurnResourceObserver } from './role-permissions/index.js';

export interface StubCommandReport {
  readonly availability: typeof NOT_AVAILABLE;
  readonly message: string;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
}

/**
 * The authenticated human-decision outcome of a resume, included in the
 * success report only when no integrity problem was recorded.
 */
export interface RunWorkflowDecision {
  readonly applied: 'accept' | 'correct' | 'abandon' | null;
  readonly waiting: boolean;
  readonly draftPrUrl: string | null;
}

/**
 * The recovery disposition chosen before a resumable run advanced, included in
 * the success report only when the disposition was not an integrity stop.
 */
export interface RunWorkflowRecovery {
  readonly disposition: RecoveryDisposition;
  readonly reason: string;
}

export interface RunWorkflowReport {
  readonly runId: string;
  readonly taskId: string;
  readonly runDirectory: string;
  readonly request: RecordedRequestFiles;
  readonly provenance: RunProvenance;
  readonly workflowState: WorkflowState;
  readonly outcome: WorkflowState;
  readonly stages: ReadonlyArray<WorkflowState>;
  readonly testerSkipped: boolean;
  readonly decision?: RunWorkflowDecision;
  readonly recovery?: RunWorkflowRecovery;
  readonly resultPullRequest?: string | null;
}

export type PublicCommandReport =
  | StubCommandReport
  | DoctorReport
  | PreviewLocationsReport
  | ProfileCheckReport
  | RecordedRunIdentityReport
  | RunStatusReport
  | RunInspectReport
  | RunWorkflowReport
  | AbandonReport
  | CleanupListReport
  | CleanupRunReport
  | DiagnosticBundleReport;

export type PublicCommandError =
  | ReadinessError
  | PreviewLocationsError
  | ProfileCheckError
  | RunIdentityError
  | RunStateUnavailable
  | RunWorkspaceBlocked
  | RoleHostCapabilityError
  | RunWorkflowError
  | IllegalWorkflowTransition
  | RunInspectError
  | CreateDiagnosticBundleError
  | RunHistoryIntegrityError
  | RunHistoryStorageError
  | RunHistoryConflict
  | RetentionCleanupError;

function stubReport(invocation: PublicCommandInvocation): StubCommandReport {
  const report: StubCommandReport = {
    availability: NOT_AVAILABLE,
    message: `${PRODUCT_NAME} ${invocation.command} is not available yet.`,
  };
  const withRunId =
    invocation.runId === undefined ? report : { ...report, runId: invocation.runId };
  if (invocation.taskId === undefined) {
    return withRunId;
  }
  return { ...withRunId, taskId: invocation.taskId };
}

function requestFilesOf(
  runDirectory: string,
  identity: RequestIdentityDocument,
): RecordedRequestFiles {
  return {
    sourcePath: identity.sourceRequestPath,
    originalPath: join(runDirectory, REQUEST_ORIGINAL_FILENAME),
    normalizedPath: join(runDirectory, REQUEST_NORMALIZED_FILENAME),
    identityPath: join(runDirectory, REQUEST_IDENTITY_FILENAME),
    originalByteLength: identity.originalByteLength,
    originalContentHash: identity.originalContentHash,
    normalizedByteLength: identity.normalizedByteLength,
    normalizedPromptHash: identity.normalizedPromptHash,
  };
}

function resultPullRequestOf(outcome: RunWorkflowOutcome): string | null {
  const publication = outcome.resultPublication;
  return publication !== null && publication.outcome === 'published' ? publication.url : null;
}

function terminalFailureFor(outcome: RunWorkflowOutcome, runId: string): RunWorkflowError | null {
  if (outcome.workflowState === 'blocked') {
    return new RunWorkflowError({
      message: `Run "${runId}" ended blocked; its evidence is retained for recovery.`,
      runId,
      kind: 'blocked',
    });
  }
  if (outcome.workflowState === 'failed') {
    return new RunWorkflowError({
      message: `Run "${runId}" ended failed after a non-recoverable condition.`,
      runId,
      kind: 'failed',
    });
  }
  return null;
}

export const executePublicCommand = Effect.fn('executePublicCommand')(function* (
  invocation: PublicCommandInvocation,
): Effect.fn.Return<
  PublicCommandReport,
  PublicCommandError,
  | ReadinessHost
  | ReadinessFiles
  | ReadinessGit
  | PublicationProbe
  | ProjectCommandProcess
  | ProjectEvidenceStore
  | OwnedProjectProcess
  | RunIdentityStoreService
  | RunHistoryStorage
  | RepositoryLeaseStore
  | RepositoryHostIdentity
  | RoleHostLauncher
  | RoleTurnResourceObserver
  | RunGit
  | GuidanceGit
  | GuidanceSnapshotStore
> {
  if (invocation.command === 'run') {
    const configArg = invocation.config;
    const cwd = invocation.cwd;
    const requestArg = invocation.request;
    const taskId = invocation.taskId;
    const runId = invocation.runId;
    if (
      configArg === undefined ||
      cwd === undefined ||
      requestArg === undefined ||
      taskId === undefined ||
      runId === undefined
    ) {
      return yield* new InvalidRunRequest({
        message: 'The run command requires --config, --request, --task-id, and --run-id.',
        runId,
      });
    }
    const configDirectory = dirname(resolve(cwd, configArg));
    const recorded = yield* recordRunIdentity({ configArg, cwd, requestArg, taskId, runId });
    const context = yield* resolveRunContext({ configArg, cwd, runId });
    const outcome = yield* advanceRun({
      runDirectory: recorded.runDirectory,
      runId,
      configDirectory,
      configuration: context.configuration,
      allowResume: false,
    });
    const recovery = outcome.recovery;
    if (recovery !== null && recovery.problem !== null) {
      return yield* new RunWorkflowError({
        message: `Run "${runId}" stopped for human recovery: ${recovery.problem}`,
        runId,
        kind: 'blocked',
      });
    }
    const terminalFailure = terminalFailureFor(outcome, runId);
    if (terminalFailure !== null) {
      return yield* terminalFailure;
    }
    const progress = yield* reconcileRunReports({ runDirectory: recorded.runDirectory, runId });
    const report: RunWorkflowReport = {
      runId,
      taskId,
      runDirectory: recorded.runDirectory,
      request: recorded.request,
      provenance: recorded.provenance,
      workflowState: progress.workflowState,
      outcome: outcome.workflowState,
      stages: outcome.stages,
      testerSkipped: outcome.testerSkipped,
      resultPullRequest: resultPullRequestOf(outcome),
    };
    if (recovery === null) {
      return report;
    }
    return {
      ...report,
      recovery: { disposition: recovery.disposition, reason: recovery.reason },
    } satisfies RunWorkflowReport;
  }
  if (invocation.command === 'resume') {
    const configArg = invocation.config;
    const cwd = invocation.cwd;
    const runId = invocation.runId;
    if (configArg === undefined || cwd === undefined || runId === undefined) {
      return stubReport(invocation);
    }
    if (invocation.abandon === true) {
      const reason = invocation.reason;
      if (reason === undefined) {
        return stubReport(invocation);
      }
      const context = yield* resolveRunContext({ configArg, cwd, runId });
      return yield* abandonRun({
        runDirectory: context.runDirectory,
        runId,
        configuration: context.configuration,
        reason,
      });
    }
    const configDirectory = dirname(resolve(cwd, configArg));
    const context = yield* resolveRunContext({ configArg, cwd, runId });
    const store = yield* RunIdentityStore;
    const identity = yield* readRetainedRunIdentity(
      store,
      join(context.runDirectory, REQUEST_IDENTITY_FILENAME),
      runId,
    );
    if (identity === null) {
      return yield* new RunStateUnavailable({
        message: `Run "${runId}" has no retained request identity and cannot be resumed.`,
        runId,
      });
    }
    const outcome = yield* advanceRun({
      runDirectory: context.runDirectory,
      runId,
      configDirectory,
      configuration: context.configuration,
      allowResume: true,
    });
    const recovery = outcome.recovery;
    if (recovery !== null && recovery.problem !== null) {
      return yield* new RunWorkflowError({
        message: `Run "${runId}" stopped for human recovery: ${recovery.problem}`,
        runId,
        kind: 'blocked',
      });
    }
    const terminalFailure = terminalFailureFor(outcome, runId);
    if (terminalFailure !== null) {
      return yield* terminalFailure;
    }
    const decision = outcome.decision;
    if (decision !== null && decision.problem !== null) {
      return yield* new RunWorkflowError({
        message: `Run "${runId}" stopped for human recovery: ${decision.problem}`,
        runId,
        kind: 'blocked',
      });
    }
    const progress = yield* reconcileRunReports({ runDirectory: context.runDirectory, runId });
    if (progress.provenance === null) {
      return yield* new RunStateUnavailable({
        message: `Run "${runId}" has no durable provisioning provenance to resume.`,
        runId,
      });
    }
    const report: RunWorkflowReport = {
      runId,
      taskId: identity.taskId,
      runDirectory: context.runDirectory,
      request: requestFilesOf(context.runDirectory, identity),
      provenance: progress.provenance,
      workflowState: progress.workflowState,
      outcome: outcome.workflowState,
      stages: outcome.stages,
      testerSkipped: outcome.testerSkipped,
      resultPullRequest: resultPullRequestOf(outcome),
    };
    const withRecovery: RunWorkflowReport =
      recovery === null
        ? report
        : {
            ...report,
            recovery: { disposition: recovery.disposition, reason: recovery.reason },
          };
    if (decision === null) {
      return withRecovery;
    }
    return {
      ...withRecovery,
      decision: {
        applied: decision.applied,
        waiting: decision.waiting,
        draftPrUrl: decision.draftPrUrl,
      },
    };
  }
  if (invocation.command === 'status') {
    const configArg = invocation.config;
    const cwd = invocation.cwd;
    const runId = invocation.runId;
    if (configArg === undefined || cwd === undefined || runId === undefined) {
      return stubReport(invocation);
    }
    return yield* readRunStatus({ configArg, cwd, runId });
  }
  if (invocation.command === 'inspect') {
    const configArg = invocation.config;
    const cwd = invocation.cwd;
    const runId = invocation.runId;
    if (configArg === undefined || cwd === undefined || runId === undefined) {
      return stubReport(invocation);
    }
    return yield* readRunInspect({ configArg, cwd, runId });
  }
  if (invocation.command === 'diagnostic-bundle') {
    const configArg = invocation.config;
    const cwd = invocation.cwd;
    const runId = invocation.runId;
    const output = invocation.output;
    if (
      configArg === undefined ||
      cwd === undefined ||
      runId === undefined ||
      output === undefined
    ) {
      return stubReport(invocation);
    }
    return yield* createDiagnosticBundle({ configArg, cwd, runId, output });
  }
  if (invocation.command === 'doctor') {
    const configArg = invocation.config;
    const cwd = invocation.cwd;
    if (configArg === undefined || cwd === undefined) {
      return stubReport(invocation);
    }
    return yield* checkReadiness({ configArg, cwd });
  }
  if (invocation.command === 'init') {
    const configArg = invocation.config;
    const cwd = invocation.cwd;
    const taskId = invocation.taskId;
    if (configArg === undefined || cwd === undefined || taskId === undefined) {
      return stubReport(invocation);
    }
    return yield* previewRunLocations({ configArg, cwd, taskId });
  }
  if (invocation.command === 'profile-check') {
    const configArg = invocation.config;
    const cwd = invocation.cwd;
    if (configArg === undefined || cwd === undefined) {
      return stubReport(invocation);
    }
    return yield* checkProjectProfile({ configArg, cwd });
  }
  if (invocation.command === 'cleanup') {
    const configArg = invocation.config;
    const cwd = invocation.cwd;
    if (configArg === undefined || cwd === undefined) {
      return stubReport(invocation);
    }
    const runId = invocation.runId;
    if (runId === undefined) {
      return yield* readRetentionCleanupList({ configArg, cwd });
    }
    const confirm = invocation.confirm;
    if (confirm === undefined) {
      return stubReport(invocation);
    }
    return yield* runRetentionCleanup({ configArg, cwd, runId, confirm });
  }
  return stubReport(invocation);
});
