import { describe, expect, it } from '@effect/vitest';

import {
  REVIEWER_TURN_OUTCOMES,
  decodeReviewerTurnControl,
  labelReviewerDecisionOptions,
} from '../src/domain/reviewer-outcomes.js';

import type { Schema } from 'effect';

function decisionControl(
  overrides: { readonly decision: Schema.Json } = {
    decision: {
      question: 'Should Foundry keep the stricter bound?',
      options: [
        { label: 'Keep it', action: 'accept' },
        { label: 'Relax it', action: 'correct' },
      ],
    },
  },
) {
  return {
    schemaVersion: 1,
    outcome: 'human_decision_required',
    ...overrides,
  };
}

describe('Reviewer control envelope', () => {
  it('accepts exactly the documented outcome set', () => {
    expect(REVIEWER_TURN_OUTCOMES).toEqual([
      'approved',
      'changes_requested',
      'retest_requested',
      'human_decision_required',
      'blocked',
    ]);
    for (const outcome of REVIEWER_TURN_OUTCOMES) {
      const control =
        outcome === 'human_decision_required' ? decisionControl() : { schemaVersion: 1, outcome };
      expect(decodeReviewerTurnControl(control).ok, outcome).toBe(true);
    }
    expect(decodeReviewerTurnControl({ schemaVersion: 1, outcome: 'passed' }).ok).toBe(false);
    expect(decodeReviewerTurnControl({ schemaVersion: 1, outcome: 'rejected' }).ok).toBe(false);
  });

  it('rejects unknown fields and a missing decision on a human decision', () => {
    expect(
      decodeReviewerTurnControl({ schemaVersion: 1, outcome: 'approved', approved: true }).ok,
    ).toBe(false);
    const missing = decodeReviewerTurnControl({
      schemaVersion: 1,
      outcome: 'human_decision_required',
    });
    expect(missing.ok).toBe(false);
  });

  it('requires a precise question and at least two labeled options', () => {
    const oneOption = decisionControl({
      decision: {
        question: 'Which way?',
        options: [{ label: 'Only one', action: 'accept' }],
      },
    });
    expect(decodeReviewerTurnControl(oneOption).ok).toBe(false);

    const emptyQuestion = decisionControl({
      decision: {
        question: '   ',
        options: [
          { label: 'A', action: 'accept' },
          { label: 'B', action: 'abandon' },
        ],
      },
    });
    expect(decodeReviewerTurnControl(emptyQuestion).ok).toBe(false);

    const emptyLabel = decisionControl({
      decision: {
        question: 'Which way?',
        options: [
          { label: '', action: 'accept' },
          { label: 'B', action: 'abandon' },
        ],
      },
    });
    expect(decodeReviewerTurnControl(emptyLabel).ok).toBe(false);
  });

  it('rejects unknown decision actions and oversized plain strings', () => {
    const badAction = decisionControl({
      decision: {
        question: 'Which way?',
        options: [
          { label: 'A', action: 'approve' },
          { label: 'B', action: 'abandon' },
        ],
      },
    });
    expect(decodeReviewerTurnControl(badAction).ok).toBe(false);

    const oversized = decisionControl({
      decision: {
        question: 'q'.repeat(4_097),
        options: [
          { label: 'A', action: 'accept' },
          { label: 'B', action: 'abandon' },
        ],
      },
    });
    expect(decodeReviewerTurnControl(oversized).ok).toBe(false);
  });

  it('assigns stable labeled option identifiers by order', () => {
    expect(
      labelReviewerDecisionOptions([
        { label: 'First', action: 'accept' },
        { label: 'Second', action: 'correct' },
      ]),
    ).toEqual([
      { id: 'OPT-001', label: 'First', action: 'accept' },
      { id: 'OPT-002', label: 'Second', action: 'correct' },
    ]);
  });
});
