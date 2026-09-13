import { Schema } from 'effect';

import { GitCommitId } from './run-locations.js';
import { REVIEWER_DECISION_ACTIONS, labelReviewerDecisionOptions } from './reviewer-outcomes.js';

import type { LabeledReviewerDecisionOption, ReviewerDecision } from './reviewer-outcomes.js';

export const FOUNDRY_DECIDE_COMMAND = '/foundry decide' as const;

export const DECISION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const DECISION_NONCE_PATTERN = /^[0-9a-f]{32}$/u;

export const DECISION_OPTION_ID_PATTERN = /^OPT-\d{3}$/u;

export const DecisionId = Schema.String.check(Schema.isPattern(DECISION_ID_PATTERN));

export type DecisionId = (typeof DecisionId)['Type'];

export const DecisionNonce = Schema.String.check(Schema.isPattern(DECISION_NONCE_PATTERN));

export type DecisionNonce = (typeof DecisionNonce)['Type'];

export const DecisionOptionId = Schema.String.check(Schema.isPattern(DECISION_OPTION_ID_PATTERN));

export type DecisionOptionId = (typeof DecisionOptionId)['Type'];

export const DecisionOpenedOptionSchema = Schema.Struct({
  id: DecisionOptionId,
  label: Schema.NonEmptyString,
  action: Schema.Literals(REVIEWER_DECISION_ACTIONS),
});

export type DecisionOpenedOption = (typeof DecisionOpenedOptionSchema)['Type'];

/**
 * Durable evidence that Foundry opened a decision for one reviewable result
 * commit. The nonce is unpredictable and one-use: a person must quote both the
 * decision ID and the nonce to authenticate a choice.
 */
export const DecisionOpenedPayloadSchema = Schema.Struct({
  decisionId: DecisionId,
  nonce: DecisionNonce,
  question: Schema.NonEmptyString,
  recommendation: Schema.NullOr(Schema.NonEmptyString),
  options: Schema.Array(DecisionOpenedOptionSchema),
  resultCommit: GitCommitId,
});

export type DecisionOpenedPayload = (typeof DecisionOpenedPayloadSchema)['Type'];

export const PUBLICATION_CHECKPOINT_STAGES = [
  'pre-push',
  'pushed',
  'pull-request-located',
  'pull-request-created',
  'url-recorded',
] as const;

export type PublicationCheckpointStage = (typeof PUBLICATION_CHECKPOINT_STAGES)[number];

/**
 * One durable step of the publication transaction. Only `url-recorded` may
 * carry the authoritative draft PR URL; earlier stages describe what happened
 * so recovery can resume without inferring success from a branch or PR alone.
 */
export const PublicationCheckpointPayloadSchema = Schema.Struct({
  stage: Schema.Literals(PUBLICATION_CHECKPOINT_STAGES),
  draftPrUrl: Schema.NullOr(Schema.NonEmptyString),
  decisionId: DecisionId,
  detail: Schema.String,
});

export type PublicationCheckpointPayload = (typeof PublicationCheckpointPayloadSchema)['Type'];

export function labeledDecisionOptions(
  decision: ReviewerDecision,
): ReadonlyArray<LabeledReviewerDecisionOption> {
  return labelReviewerDecisionOptions(decision.options);
}

export function decisionOptionCommand(input: {
  readonly runId: string;
  readonly decisionId: string;
  readonly optionId: string;
  readonly nonce: string;
}): string {
  return `${FOUNDRY_DECIDE_COMMAND} ${input.runId} ${input.decisionId} ${input.optionId} ${input.nonce}`;
}

export function exactDecisionCommands(input: {
  readonly runId: string;
  readonly decisionId: string;
  readonly nonce: string;
  readonly options: ReadonlyArray<LabeledReviewerDecisionOption>;
}): ReadonlyArray<string> {
  return input.options.map((option) =>
    decisionOptionCommand({
      runId: input.runId,
      decisionId: input.decisionId,
      optionId: option.id,
      nonce: input.nonce,
    }),
  );
}

export interface DecisionDraftPrBodyInput {
  readonly runId: string;
  readonly decisionId: string;
  readonly nonce: string;
  readonly question: string;
  readonly recommendation: string | null;
  readonly options: ReadonlyArray<LabeledReviewerDecisionOption>;
  readonly sourceCommit: string;
  readonly resultCommit: string;
  readonly criteria: ReadonlyArray<{ readonly id: string; readonly text: string }>;
}

/**
 * Renders the decision workspace body. It must read as a request for human
 * judgment, list one exact authenticated command per labelled option, and never
 * imply approval, completion, or merge readiness.
 */
export function renderDecisionDraftPrBody(input: DecisionDraftPrBodyInput): string {
  const lines = [
    `# Human judgment requested for ${input.runId}`,
    '',
    'Foundry stopped and created this draft pull request because a person must',
    'choose among the labelled options below. This is a request for human',
    'judgment, not an approval, and it does not mean the work is complete.',
    '',
    '## Question',
    '',
    input.question,
    '',
    '## Options',
    '',
  ];
  for (const option of input.options) {
    lines.push(
      `- \`${option.id}\` (${option.action}) — ${option.label}`,
      `  \`${decisionOptionCommand({
        runId: input.runId,
        decisionId: input.decisionId,
        optionId: option.id,
        nonce: input.nonce,
      })}\``,
      '',
    );
  }
  lines.push(
    '## Reviewer recommendation',
    '',
    input.recommendation ?? 'No Reviewer recommendation was recorded.',
    '',
    '## Result',
    '',
    `- Source commit: \`${input.sourceCommit}\``,
    `- Result commit: \`${input.resultCommit}\``,
    '',
    '## Acceptance criteria',
    '',
  );
  if (input.criteria.length === 0) {
    lines.push('- None recorded.', '');
  } else {
    for (const criterion of input.criteria) {
      lines.push(`- \`${criterion.id}\` — ${criterion.text}`);
    }
    lines.push('');
  }
  lines.push(
    '## Recovering this run',
    '',
    `Run ID: \`${input.runId}\`. The commands above are the only decisions Foundry`,
    'accepts for this run.',
    '',
    'Foundry never force-pushes, merges, closes, or rewrites history.',
    '',
  );
  return lines.join('\n');
}
