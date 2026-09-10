import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { summarizeFoundry } from '../src/application/foundry.js';
import { WORKFLOW_ROLES } from '../src/domain/workflow.js';

describe('Foundry skeleton', () => {
  it.effect('describes the four-role workflow', () =>
    Effect.gen(function* () {
      expect(yield* summarizeFoundry()).toBe('Foundry: architect -> coder -> tester -> reviewer');
      expect(WORKFLOW_ROLES).toHaveLength(4);
    }),
  );
});
