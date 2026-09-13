import { Schema } from 'effect';

import { GitCommitId } from './run-locations.js';

/**
 * Foundry owns finding records. A finding is immutable, bound to the exact
 * commit it describes, and never re-used to justify a different result head.
 */
export const FINDING_CATEGORIES = ['check', 'review'] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_SOURCES = ['failed-check', 'reviewer-changes-requested'] as const;

export type FindingSource = (typeof FINDING_SOURCES)[number];

export const FINDING_SEVERITIES = ['low', 'medium', 'high'] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_OWNERS = ['coder'] as const;

export type FindingOwner = (typeof FINDING_OWNERS)[number];

export const FINDING_ID_PATTERN = /^FND-\d{3,}$/u;

export const FindingId = Schema.String.check(Schema.isPattern(FINDING_ID_PATTERN));

export const FINDING_DESCRIPTION_MAX_LENGTH = 512 as const;

/**
 * A closed short summary. The `REVIEW_RESULT` companion titles must equal this
 * value, so the machine index can never drift from the durable record.
 */
export const FindingDescription = Schema.NonEmptyString.check(
  Schema.isMaxLength(FINDING_DESCRIPTION_MAX_LENGTH),
);

export const FINDING_COMPANION_SCHEMA_VERSION = 1 as const;

export const FindingRecordSchema = Schema.Struct({
  id: FindingId,
  category: Schema.Literals(FINDING_CATEGORIES),
  source: Schema.Literals(FINDING_SOURCES),
  owner: Schema.Literals(FINDING_OWNERS),
  severity: Schema.Literals(FINDING_SEVERITIES),
  blocking: Schema.Boolean,
  commit: GitCommitId,
  description: FindingDescription,
  detail: Schema.NonEmptyString,
  evidence: Schema.Array(Schema.NonEmptyString),
});

export type FindingRecord = (typeof FindingRecordSchema)['Type'];

/**
 * The only machine-readable shape allowed inside a `REVIEW_RESULT` companion
 * envelope. It deliberately stays smaller than a finding record: the durable
 * detail and evidence live in the per-finding `<findingId>.json` companion.
 */
export const ReviewResultEntrySchema = Schema.Struct({
  id: FindingId,
  severity: Schema.Literals(FINDING_SEVERITIES),
  title: FindingDescription,
});

export type ReviewResultEntry = (typeof ReviewResultEntrySchema)['Type'];

export const FindingCompanionDocumentSchema = Schema.Struct({
  schemaVersion: Schema.Literal(FINDING_COMPANION_SCHEMA_VERSION),
  finding: FindingRecordSchema,
});

export type FindingCompanionDocument = (typeof FindingCompanionDocumentSchema)['Type'];

export const ReviewResultDocumentSchema = Schema.Struct({
  schemaVersion: Schema.Literal(FINDING_COMPANION_SCHEMA_VERSION),
  result: Schema.Array(ReviewResultEntrySchema),
});

export type ReviewResultDocument = (typeof ReviewResultDocumentSchema)['Type'];

export function isBlockingSeverity(severity: FindingSeverity): boolean {
  return severity !== 'low';
}

export function renderFindingId(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`A finding index must be a positive integer; received ${String(index)}.`);
  }
  return `FND-${String(index).padStart(3, '0')}`;
}

export function parseFindingId(id: string): number | null {
  if (!FINDING_ID_PATTERN.test(id)) {
    return null;
  }
  const parsed = Number.parseInt(id.slice(4), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}
