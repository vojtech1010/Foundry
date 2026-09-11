import { Effect } from 'effect';

import { NOT_AVAILABLE } from '../domain/public-commands.js';
import { PRODUCT_NAME } from '../domain/workflow.js';

import type { PublicCommandInvocation } from '../domain/public-commands.js';

export interface PublicCommandReport {
  readonly availability: typeof NOT_AVAILABLE;
  readonly message: string;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
}

export const executePublicCommand = Effect.fn('executePublicCommand')(function* (
  invocation: PublicCommandInvocation,
): Effect.fn.Return<PublicCommandReport> {
  yield* Effect.logDebug(`Reporting public command ${invocation.command} as unavailable`);
  return {
    availability: NOT_AVAILABLE,
    message: `${PRODUCT_NAME} ${invocation.command} is not available yet.`,
    runId: invocation.runId,
    taskId: invocation.taskId,
  };
});
