import { Effect, Schema } from 'effect';
import { join } from 'node:path';

import {
  FINDING_COMPANION_SCHEMA_VERSION,
  FindingCompanionDocumentSchema,
  ReviewResultDocumentSchema,
  isBlockingSeverity,
} from '../../domain/findings.js';
import { appendRunEvent } from '../run-history/index.js';

import type { FindingRecord, ReviewResultEntry } from '../../domain/findings.js';
import type {
  ProjectVerificationReport,
  VerificationExecution,
} from '../../domain/project-verification.js';
import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';

export const FindingCompanionJson = Schema.fromJsonString(FindingCompanionDocumentSchema);

export const ReviewResultJson = Schema.fromJsonString(ReviewResultDocumentSchema);

export function commandEvidence(execution: VerificationExecution): ReadonlyArray<string> {
  const argv = [execution.executable, ...execution.arguments].join(' ');
  return [
    `command ${execution.name}: ${argv}`,
    `expected exit ${execution.expectedExitCode}`,
    `actual exit ${execution.actualExitCode ?? '(none)'}${execution.timedOut ? ' (timed out)' : ''}`,
    `log ${execution.log.path} sha256:${execution.log.sha256} bytes:${execution.log.byteLength} retained:${execution.log.retainedByteLength} truncated:${execution.log.truncated} redactions:${execution.log.redactionCount}`,
  ];
}

/**
 * A failed deterministic project command is a product finding. A bootstrap
 * failure, an owned-state mutation, or an unverifiable reconstruction is an
 * environment/operational failure instead and never becomes a Coder finding.
 */
export function isFailedProjectCommand(execution: VerificationExecution): boolean {
  if (execution.kind !== 'gate') {
    return false;
  }
  if (execution.trackedMutation !== null || execution.reconstructed) {
    return false;
  }
  if (execution.reconstructionError !== null || execution.actualExitCode === null) {
    return false;
  }
  return execution.timedOut || execution.actualExitCode !== execution.expectedExitCode;
}

function isPassing(execution: VerificationExecution): boolean {
  return (
    !execution.timedOut &&
    execution.actualExitCode === execution.expectedExitCode &&
    execution.trackedMutation === null &&
    execution.reconstructionError === null
  );
}

/**
 * A non-passing execution that is not a product finding: bootstrap failure,
 * tracked-state mutation, or an unverifiable reconstruction. These stay
 * separate from Coder findings and route through recovery instead.
 */
export function isEnvironmentFailure(execution: VerificationExecution): boolean {
  return !isPassing(execution) && !isFailedProjectCommand(execution);
}

export function environmentFailures(
  report: ProjectVerificationReport,
): ReadonlyArray<VerificationExecution> {
  return report.executions.filter(isEnvironmentFailure);
}

export interface FailedCheckFindingOptions {
  readonly report: ProjectVerificationReport;
  readonly nextIndex: number;
}

export function checkFindings(options: FailedCheckFindingOptions): ReadonlyArray<FindingRecord> {
  const failed = options.report.executions.filter(isFailedProjectCommand);
  return failed.map((execution, offset) => {
    const id = `FND-${String(options.nextIndex + offset).padStart(3, '0')}`;
    const status = execution.timedOut
      ? 'timed out'
      : `exited with code ${execution.actualExitCode ?? '(none)'}`;
    const description = `Required command "${execution.name}" ${status}; the deterministic gate failed.`;
    const detail = [
      `The deterministic project command "${execution.name}" did not pass.`,
      '',
      `- executable: ${execution.executable}`,
      `- arguments: ${execution.arguments.join(' ') || '(none)'}`,
      `- expected exit code: ${execution.expectedExitCode}`,
      `- actual exit code: ${execution.actualExitCode ?? '(none)'}`,
      `- timed out: ${execution.timedOut ? 'yes' : 'no'}`,
      `- duration ms: ${execution.durationMs}`,
      `- log: ${execution.log.path} (sha256 ${execution.log.sha256})`,
    ].join('\n');
    return {
      id,
      category: 'check' as const,
      source: 'failed-check' as const,
      owner: 'coder' as const,
      severity: 'high' as const,
      blocking: true,
      commit: options.report.commit,
      description,
      detail,
      evidence: commandEvidence(execution),
    } satisfies FindingRecord;
  });
}

export interface ReviewerCorrectionFindingOptions {
  readonly id: string;
  readonly commit: string;
  readonly narrative: string;
  readonly evidence: ReadonlyArray<string>;
}

/**
 * One blocking correction brief per `changes_requested` turn. The complete,
 * unmodified Reviewer Markdown is retained as the required outcome so a caller
 * cannot substitute a summary or parse the prose into synthetic evidence.
 */
export function reviewerCorrectionFinding(
  options: ReviewerCorrectionFindingOptions,
): FindingRecord {
  return {
    id: options.id,
    category: 'review',
    source: 'reviewer-changes-requested',
    owner: 'coder',
    severity: 'high',
    blocking: true,
    commit: options.commit,
    description:
      'Reviewer requested changes; every medium-or-higher finding in the brief must be closed.',
    detail: options.narrative,
    evidence: [...options.evidence],
  } satisfies FindingRecord;
}

export interface RecordFindingOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly finding: FindingRecord;
}

/**
 * Persists a Foundry-owned finding as a durable event. Reviewer or check
 * routing calls this before it transitions to `correcting`, so Coder can never
 * begin from a correction the history does not contain.
 */
export const recordFinding = Effect.fn('findings.recordFinding')(function* (
  options: RecordFindingOptions,
): Effect.fn.Return<FindingRecord, RunHistoryError, RunHistoryStorage> {
  yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
    build: () => Effect.succeed({ type: 'finding-recorded', payload: options.finding } as const),
  });
  return options.finding;
});

export function currentHeadFindings(
  findings: ReadonlyArray<FindingRecord>,
  commit: string | null,
): ReadonlyArray<FindingRecord> {
  if (commit === null) {
    return [];
  }
  return findings.filter((finding) => finding.commit === commit);
}

export function olderFindings(
  findings: ReadonlyArray<FindingRecord>,
  commit: string | null,
): ReadonlyArray<FindingRecord> {
  if (commit === null) {
    return [...findings];
  }
  return findings.filter((finding) => finding.commit !== commit);
}

function findingSignature(finding: FindingRecord): string {
  return JSON.stringify({
    category: finding.category,
    commit: finding.commit,
    description: finding.description,
    detail: finding.detail,
    evidence: finding.evidence,
    owner: finding.owner,
    severity: finding.severity,
    source: finding.source,
  });
}

/**
 * Findings are immutable and idempotent: re-deriving the same failed command
 * for the same commit never appends a duplicate record.
 */
export function findingAlreadyRecorded(
  existing: ReadonlyArray<FindingRecord>,
  candidate: FindingRecord,
): boolean {
  const signature = findingSignature(candidate);
  return existing.some((finding) => findingSignature(finding) === signature);
}

export function findingCompanionFilename(finding: FindingRecord): string {
  return `${finding.id}.json`;
}

/**
 * Companions sit beside the attempt artifact (for example `review.md`) that
 * produced the finding. They are closed JSON documents, never narrative.
 */
export function findingCompanionPath(artifactDirectory: string, finding: FindingRecord): string {
  return join(artifactDirectory, findingCompanionFilename(finding));
}

export function renderFindingCompanion(finding: FindingRecord): string {
  return `${JSON.stringify({
    schemaVersion: FINDING_COMPANION_SCHEMA_VERSION,
    finding: {
      id: finding.id,
      category: finding.category,
      source: finding.source,
      owner: finding.owner,
      severity: finding.severity,
      blocking: finding.blocking,
      commit: finding.commit,
      description: finding.description,
      detail: finding.detail,
      evidence: finding.evidence,
    },
  })}\n`;
}

export function renderReviewResultDocument(findings: ReadonlyArray<FindingRecord>): string {
  return `${JSON.stringify({
    schemaVersion: FINDING_COMPANION_SCHEMA_VERSION,
    result: findings.map(
      (finding) =>
        ({
          id: finding.id,
          severity: finding.severity,
          title: finding.description,
        }) satisfies ReviewResultEntry,
    ),
  })}\n`;
}

export type ReviewResultValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: string };

export function validateReviewResultEntries(
  entries: ReadonlyArray<ReviewResultEntry>,
  findings: ReadonlyArray<FindingRecord>,
): ReviewResultValidation {
  const byId = new Map(findings.map((finding) => [finding.id, finding] as const));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      return { ok: false, problem: `the REVIEW_RESULT repeats the finding id "${entry.id}"` };
    }
    seen.add(entry.id);
    const finding = byId.get(entry.id);
    if (finding === undefined) {
      return {
        ok: false,
        problem: `the REVIEW_RESULT references "${entry.id}", which is not one of the recorded findings`,
      };
    }
    if (entry.severity !== finding.severity) {
      return {
        ok: false,
        problem: `the REVIEW_RESULT severity for "${entry.id}" does not match the recorded finding`,
      };
    }
    if (entry.title !== finding.description) {
      return {
        ok: false,
        problem: `the REVIEW_RESULT title for "${entry.id}" does not match the recorded finding description`,
      };
    }
  }
  for (const finding of findings) {
    if (!seen.has(finding.id)) {
      return {
        ok: false,
        problem: `the REVIEW_RESULT omits the recorded finding "${finding.id}"`,
      };
    }
  }
  return { ok: true };
}

export function reviewResultEntries(
  findings: ReadonlyArray<FindingRecord>,
): ReadonlyArray<ReviewResultEntry> {
  return findings.map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    title: finding.description,
  }));
}

export function blockingFindings(
  findings: ReadonlyArray<FindingRecord>,
): ReadonlyArray<FindingRecord> {
  return findings.filter((finding) => finding.blocking || isBlockingSeverity(finding.severity));
}
