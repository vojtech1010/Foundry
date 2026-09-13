import { Effect } from 'effect';
import { dirname, join, resolve } from 'node:path';

import { NOT_AVAILABLE } from '../domain/public-commands.js';
import {
  REQUEST_IDENTITY_FILENAME,
  REQUEST_NORMALIZED_FILENAME,
  REQUEST_ORIGINAL_FILENAME,
} from '../domain/run-identity.js';
import { PRODUCT_NAME } from '../domain/workflow.js';
import { checkProjectProfile } from './profile-check/index.js';
import { checkReadiness } from './readiness/index.js';
import { previewRunLocations } from './preview-run-locations/index.js';
import { advanceRun, RunWorkflowError } from './run-workflow/index.js';
import {
  InvalidRunRequest,
  RunIdentityStore,
  RunStateUnavailable,
  readRetainedRunIdentity,
  readRunWorkflowState,
  reconcileRunReports,
  recordRunIdentity,
  resolveRunContext,
} from './run-identity/index.js';

import type { PublicCommandInvocation } from '../domain/public-commands.js';
import type { RunWorkflowOutcome } from './run-workflow/index.js';
import type { RequestIdentityDocument } from '../domain/run-identity.js';
import type { WorkflowState } from '../domain/workflow.js';
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
  ReadinessError,
  ReadinessFiles,
  ReadinessGit,
  ReadinessHost,
} from './readiness/index.js';
import type {
  PreviewLocationsError,
  PreviewLocationsReport,
} from './preview-run-locations/index.js';
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
  RunProgressReport,
  RunProvenance,
} from './run-identity/index.js';
import type { RepositoryHostIdentity, RepositoryLeaseStore } from './repository-lease/index.js';
import type { RoleHostCapabilityError, RoleHostLauncher } from './role-conversations/index.js';
import type { RoleTurnResourceObserver } from './role-permissions/index.js';

export interface StubCommandReport {
  readonly availability: typeof NOT_AVAILABLE;
  readonly message: string;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
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
}

export type PublicCommandReport =
  | StubCommandReport
  | DoctorReport
  | PreviewLocationsReport
  | ProfileCheckReport
  | RecordedRunIdentityReport
  | RunProgressReport
  | RunWorkflowReport;

export type PublicCommandError =
  | ReadinessError
  | PreviewLocationsError
  | ProfileCheckError
  | RunIdentityError
  | RunStateUnavailable
  | RunWorkspaceBlocked
  | RoleHostCapabilityError
  | RunWorkflowError
  | RunHistoryIntegrityError
  | RunHistoryStorageError
  | RunHistoryConflict;

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
    const terminalFailure = terminalFailureFor(outcome, runId);
    if (terminalFailure !== null) {
      return yield* terminalFailure;
    }
    const progress = yield* reconcileRunReports({ runDirectory: recorded.runDirectory, runId });
    return {
      runId,
      taskId,
      runDirectory: recorded.runDirectory,
      request: recorded.request,
      provenance: recorded.provenance,
      workflowState: progress.workflowState,
      outcome: outcome.workflowState,
      stages: outcome.stages,
      testerSkipped: outcome.testerSkipped,
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
      return stubReport(invocation);
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
    const terminalFailure = terminalFailureFor(outcome, runId);
    if (terminalFailure !== null) {
      return yield* terminalFailure;
    }
    const progress = yield* reconcileRunReports({ runDirectory: context.runDirectory, runId });
    if (progress.provenance === null) {
      return yield* new RunStateUnavailable({
        message: `Run "${runId}" has no durable provisioning provenance to resume.`,
        runId,
      });
    }
    return {
      runId,
      taskId: identity.taskId,
      runDirectory: context.runDirectory,
      request: requestFilesOf(context.runDirectory, identity),
      provenance: progress.provenance,
      workflowState: progress.workflowState,
      outcome: outcome.workflowState,
      stages: outcome.stages,
      testerSkipped: outcome.testerSkipped,
    } satisfies RunWorkflowReport;
  }
  if (invocation.command === 'status') {
    const configArg = invocation.config;
    const cwd = invocation.cwd;
    const runId = invocation.runId;
    if (configArg === undefined || cwd === undefined || runId === undefined) {
      return stubReport(invocation);
    }
    return yield* readRunWorkflowState({ configArg, cwd, runId });
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
  return stubReport(invocation);
});
