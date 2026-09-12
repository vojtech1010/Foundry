import { Effect } from 'effect';

import { NOT_AVAILABLE } from '../domain/public-commands.js';
import { PRODUCT_NAME } from '../domain/workflow.js';
import { checkProjectProfile } from './profile-check/index.js';
import { checkReadiness } from './readiness/index.js';
import { previewRunLocations } from './preview-run-locations/index.js';
import {
  InvalidRunRequest,
  readRunWorkflowState,
  recordRunIdentity,
} from './run-identity/index.js';

import type { PublicCommandInvocation } from '../domain/public-commands.js';
import type {
  RunHistoryConflict,
  RunHistoryIntegrityError,
  RunHistoryStorage,
  RunHistoryStorageError,
} from './run-history/index.js';
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
import type {
  RecordedRunIdentityReport,
  RunIdentityError,
  RunIdentityStore,
  RunProgressReport,
  RunStateUnavailable,
} from './run-identity/index.js';
import type { RepositoryHostIdentity, RepositoryLeaseStore } from './repository-lease/index.js';

export interface StubCommandReport {
  readonly availability: typeof NOT_AVAILABLE;
  readonly message: string;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
}

export type PublicCommandReport =
  | StubCommandReport
  | DoctorReport
  | PreviewLocationsReport
  | ProfileCheckReport
  | RecordedRunIdentityReport
  | RunProgressReport;

export type PublicCommandError =
  | ReadinessError
  | PreviewLocationsError
  | ProfileCheckError
  | RunIdentityError
  | RunStateUnavailable
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

export const executePublicCommand = Effect.fn('executePublicCommand')(function* (
  invocation: PublicCommandInvocation,
): Effect.fn.Return<
  PublicCommandReport,
  PublicCommandError,
  | ReadinessHost
  | ReadinessFiles
  | ReadinessGit
  | ProjectCommandProcess
  | RunIdentityStore
  | RunHistoryStorage
  | RepositoryLeaseStore
  | RepositoryHostIdentity
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
    return yield* recordRunIdentity({ configArg, cwd, requestArg, taskId, runId });
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
