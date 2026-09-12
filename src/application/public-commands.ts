import { Effect } from 'effect';

import { NOT_AVAILABLE } from '../domain/public-commands.js';
import { PRODUCT_NAME } from '../domain/workflow.js';
import { checkReadiness } from './readiness/index.js';
import { previewRunLocations } from './preview-run-locations/index.js';

import type { PublicCommandInvocation } from '../domain/public-commands.js';
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

export interface StubCommandReport {
  readonly availability: typeof NOT_AVAILABLE;
  readonly message: string;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
}

export type PublicCommandReport = StubCommandReport | DoctorReport | PreviewLocationsReport;

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
  ReadinessError | PreviewLocationsError,
  ReadinessHost | ReadinessFiles | ReadinessGit
> {
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
  return stubReport(invocation);
});
