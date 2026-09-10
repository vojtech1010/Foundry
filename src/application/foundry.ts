import { Effect } from 'effect';

import { PRODUCT_NAME, WORKFLOW_ROLES } from '../domain/workflow.js';

export const summarizeFoundry = Effect.fn('summarizeFoundry')(function* () {
  yield* Effect.logDebug('Preparing Foundry summary');
  return `${PRODUCT_NAME}: ${WORKFLOW_ROLES.join(' -> ')}`;
});
