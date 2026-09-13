import { describe, expect, it } from '@effect/vitest';

import { decodeArchitectPlanControl } from '../src/domain/architect-plan.js';
import { TESTER_TURN_OUTCOMES, decodeTesterTurnControl } from '../src/domain/tester-outcomes.js';

describe('Tester control envelope', () => {
  it('accepts only observed, retry_required, and blocked', () => {
    expect(TESTER_TURN_OUTCOMES).toEqual(['observed', 'retry_required', 'blocked']);
    for (const outcome of TESTER_TURN_OUTCOMES) {
      const decoded = decodeTesterTurnControl({ schemaVersion: 1, outcome });
      expect(decoded.ok, outcome).toBe(true);
    }
    for (const outcome of ['passed', 'failed', 'approved', 'mutated']) {
      const decoded = decodeTesterTurnControl({ schemaVersion: 1, outcome });
      expect(decoded.ok, outcome).toBe(false);
    }
  });

  it('rejects unknown fields, wrong schema versions, and non-objects', () => {
    expect(
      decodeTesterTurnControl({ schemaVersion: 1, outcome: 'observed', veredict: 'pass' }).ok,
    ).toBe(false);
    expect(decodeTesterTurnControl({ schemaVersion: 2, outcome: 'observed' }).ok).toBe(false);
    expect(decodeTesterTurnControl('observed').ok).toBe(false);
    expect(decodeTesterTurnControl(null).ok).toBe(false);
  });

  it('does not let a plan grant application-data mutation authority', () => {
    const plan = decodeArchitectPlanControl({
      schemaVersion: 1,
      outcome: 'plan_ready',
      acceptanceCriteria: ['the change works'],
      runtimeValidation: 'not_required',
      execution: 'sequential',
      testerScenarioAuthority: 'mutation',
    });
    expect(plan.ok).toBe(false);
    const valid = decodeArchitectPlanControl({
      schemaVersion: 1,
      outcome: 'plan_ready',
      acceptanceCriteria: ['the change works'],
      runtimeValidation: 'not_required',
      execution: 'sequential',
    });
    expect(valid.ok).toBe(true);
  });
});
