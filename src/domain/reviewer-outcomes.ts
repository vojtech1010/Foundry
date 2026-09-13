import { Result, Schema } from 'effect';

export const REVIEWER_CONTROL_SCHEMA_VERSION = 1 as const;

export const REVIEWER_TURN_OUTCOMES = [
  'approved',
  'changes_requested',
  'retest_requested',
  'human_decision_required',
  'blocked',
] as const;

export type ReviewerTurnOutcome = (typeof REVIEWER_TURN_OUTCOMES)[number];

export const REVIEWER_DECISION_ACTIONS = ['accept', 'correct', 'abandon'] as const;

export type ReviewerDecisionAction = (typeof REVIEWER_DECISION_ACTIONS)[number];

export const REVIEWER_DECISION_MIN_OPTIONS = 2 as const;

export const REVIEWER_DECISION_MAX_OPTIONS = 100 as const;

export const REVIEWER_PLAIN_STRING_MAX_BYTES = 4_096 as const;

const PlainString = Schema.NonEmptyString;

export const ReviewerDecisionOptionSchema = Schema.Struct({
  label: PlainString,
  action: Schema.Literals(REVIEWER_DECISION_ACTIONS),
});

export type ReviewerDecisionOption = (typeof ReviewerDecisionOptionSchema)['Type'];

export const ReviewerDecisionSchema = Schema.Struct({
  question: PlainString,
  options: Schema.Array(ReviewerDecisionOptionSchema),
  recommendation: Schema.optional(PlainString),
});

export type ReviewerDecision = (typeof ReviewerDecisionSchema)['Type'];

export interface LabeledReviewerDecisionOption {
  readonly id: string;
  readonly label: string;
  readonly action: ReviewerDecisionAction;
}

export function reviewerOptionIdentifier(index: number): string {
  return `OPT-${String(index + 1).padStart(3, '0')}`;
}

export function labelReviewerDecisionOptions(
  options: ReadonlyArray<ReviewerDecisionOption>,
): ReadonlyArray<LabeledReviewerDecisionOption> {
  return options.map((option, index) => ({
    id: reviewerOptionIdentifier(index),
    label: option.label,
    action: option.action,
  }));
}

const ApprovedControl = Schema.Struct({
  schemaVersion: Schema.Literal(REVIEWER_CONTROL_SCHEMA_VERSION),
  outcome: Schema.Literal('approved'),
});

const ChangesRequestedControl = Schema.Struct({
  schemaVersion: Schema.Literal(REVIEWER_CONTROL_SCHEMA_VERSION),
  outcome: Schema.Literal('changes_requested'),
});

const RetestRequestedControl = Schema.Struct({
  schemaVersion: Schema.Literal(REVIEWER_CONTROL_SCHEMA_VERSION),
  outcome: Schema.Literal('retest_requested'),
});

const HumanDecisionControl = Schema.Struct({
  schemaVersion: Schema.Literal(REVIEWER_CONTROL_SCHEMA_VERSION),
  outcome: Schema.Literal('human_decision_required'),
  decision: ReviewerDecisionSchema,
});

const BlockedControl = Schema.Struct({
  schemaVersion: Schema.Literal(REVIEWER_CONTROL_SCHEMA_VERSION),
  outcome: Schema.Literal('blocked'),
});

export const ReviewerTurnControlSchema = Schema.Union([
  ApprovedControl,
  ChangesRequestedControl,
  RetestRequestedControl,
  HumanDecisionControl,
  BlockedControl,
]);

export type ReviewerTurnControl = (typeof ReviewerTurnControlSchema)['Type'];

export type ReviewerControlDecoding =
  | { readonly ok: true; readonly control: ReviewerTurnControl }
  | { readonly ok: false; readonly problem: string };

const DECODE_OPTIONS = { onExcessProperty: 'error' } as const;

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Semantic validation that Schema cannot express: trimmed non-empty plain
 * strings, bounded UTF-8 byte length, and at least two labeled decision
 * options. Structural decoding happens first so unknown fields are rejected.
 */
export function reviewerDecisionProblems(decision: ReviewerDecision): ReadonlyArray<string> {
  const problems: Array<string> = [];
  if (decision.question.trim().length === 0) {
    problems.push('the decision question must not be empty');
  }
  if (textByteLength(decision.question) > REVIEWER_PLAIN_STRING_MAX_BYTES) {
    problems.push(`the decision question exceeds ${REVIEWER_PLAIN_STRING_MAX_BYTES} UTF-8 bytes`);
  }
  if (
    decision.options.length < REVIEWER_DECISION_MIN_OPTIONS ||
    decision.options.length > REVIEWER_DECISION_MAX_OPTIONS
  ) {
    problems.push(
      `a human decision requires between ${REVIEWER_DECISION_MIN_OPTIONS} and ${REVIEWER_DECISION_MAX_OPTIONS} labeled options`,
    );
  }
  for (const option of decision.options) {
    if (option.label.trim().length === 0) {
      problems.push('every decision option requires a non-empty label');
    }
    if (textByteLength(option.label) > REVIEWER_PLAIN_STRING_MAX_BYTES) {
      problems.push(
        `decision option labels must not exceed ${REVIEWER_PLAIN_STRING_MAX_BYTES} UTF-8 bytes`,
      );
    }
  }
  if (
    decision.recommendation !== undefined &&
    textByteLength(decision.recommendation) > REVIEWER_PLAIN_STRING_MAX_BYTES
  ) {
    problems.push(
      `the decision recommendation must not exceed ${REVIEWER_PLAIN_STRING_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return problems;
}

export function decodeReviewerTurnControl(input: Schema.Json): ReviewerControlDecoding {
  const result = Schema.decodeUnknownResult(ReviewerTurnControlSchema, DECODE_OPTIONS)(input);
  if (Result.isFailure(result)) {
    return { ok: false, problem: result.failure.message };
  }
  const control = result.success;
  if (control.outcome === 'human_decision_required') {
    const problems = reviewerDecisionProblems(control.decision);
    if (problems.length > 0) {
      return { ok: false, problem: problems.join('; ') };
    }
  }
  return { ok: true, control };
}
