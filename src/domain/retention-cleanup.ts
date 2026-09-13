import { Schema } from 'effect';

import { CLEANUP_OUTCOMES, WorkflowStateSchema, isTerminalWorkflowState } from './workflow.js';

import type { WorkflowState } from './workflow.js';

export const RETENTION_CLEANUP_SCHEMA_VERSION = 1 as const;

export const MILLIS_PER_DAY = 86_400_000;

export const CLEANUP_RUN_CHECKS = [
  'state',
  'history',
  'workers',
  'workspaces',
  'branches',
  'ownership',
] as const;

export type CleanupRunCheck = (typeof CLEANUP_RUN_CHECKS)[number];

export const RETENTION_OWNERSHIP_STATES = ['owned', 'uncertain'] as const;

export type RetentionOwnershipState = (typeof RETENTION_OWNERSHIP_STATES)[number];

export const RETENTION_ELIGIBILITIES = [
  'eligible',
  'within-retention',
  'not-terminal',
  'uncertain',
] as const;

export type RetentionEligibility = (typeof RETENTION_ELIGIBILITIES)[number];

export const CLEANUP_RUN_OUTCOMES = ['succeeded', 'warning', 'failed'] as const;

export type CleanupRunOutcome = (typeof CLEANUP_RUN_OUTCOMES)[number];

export const CLEANUP_RESOURCE_REPORT_KINDS = [
  'runtime',
  'role-session',
  'workspace',
  'worker-worktree',
  'evidence',
] as const;

export type CleanupResourceReportKind = (typeof CLEANUP_RESOURCE_REPORT_KINDS)[number];

export const CLEANUP_RESOURCE_DISPOSITIONS = ['disposed', 'skipped', 'pending', 'failed'] as const;

export type CleanupResourceDisposition = (typeof CLEANUP_RESOURCE_DISPOSITIONS)[number];

export const CLEANUP_GUIDANCE =
  'Never delete .agent/runs by hand. Confirm deletion with cleanup --run-id <id> --confirm <id>, which preserves the task branch and canonical handoff.';

export interface RetentionWindowInput {
  readonly state: WorkflowState | null;
  readonly terminalAtMillis: number | null;
  readonly nowMillis: number;
  readonly retentionDays: number;
}

export interface RetentionWindowResult {
  readonly eligibility: RetentionEligibility;
  readonly ageMs: number | null;
}

export function evaluateRetentionWindow(input: RetentionWindowInput): RetentionWindowResult {
  const { state, terminalAtMillis, nowMillis, retentionDays } = input;
  if (state === null) {
    return { eligibility: 'uncertain', ageMs: null };
  }
  if (!isTerminalWorkflowState(state)) {
    return { eligibility: 'not-terminal', ageMs: null };
  }
  if (terminalAtMillis === null) {
    return { eligibility: 'uncertain', ageMs: null };
  }
  const ageMs = Math.max(0, nowMillis - terminalAtMillis);
  return {
    eligibility: ageMs >= retentionDays * MILLIS_PER_DAY ? 'eligible' : 'within-retention',
    ageMs,
  };
}

export const CleanupEligibleRunSchema = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.NullOr(Schema.String),
  workflowState: WorkflowStateSchema,
  terminalAt: Schema.String,
  retentionDays: Schema.Number,
  ageMs: Schema.Number,
  ownership: Schema.Literals(RETENTION_OWNERSHIP_STATES),
  taskBranch: Schema.NullOr(Schema.String),
  cleanupOutcome: Schema.NullOr(Schema.Literals(CLEANUP_OUTCOMES)),
});

export type CleanupEligibleRun = (typeof CleanupEligibleRunSchema)['Type'];

export const CleanupListReportSchema = Schema.Struct({
  schemaVersion: Schema.Literal(RETENTION_CLEANUP_SCHEMA_VERSION),
  retentionDays: Schema.Number,
  runs: Schema.Array(CleanupEligibleRunSchema),
  guidance: Schema.String,
});

export type CleanupListReport = (typeof CleanupListReportSchema)['Type'];

export const CleanupCheckReportSchema = Schema.Struct({
  check: Schema.Literals(CLEANUP_RUN_CHECKS),
  ok: Schema.Boolean,
  detail: Schema.String,
});

export type CleanupCheckReport = (typeof CleanupCheckReportSchema)['Type'];

export const CleanupResourceReportSchema = Schema.Struct({
  kind: Schema.Literals(CLEANUP_RESOURCE_REPORT_KINDS),
  name: Schema.NonEmptyString,
  disposition: Schema.Literals(CLEANUP_RESOURCE_DISPOSITIONS),
});

export type CleanupResourceReport = (typeof CleanupResourceReportSchema)['Type'];

export const CleanupPreservedSchema = Schema.Struct({
  taskBranch: Schema.NullOr(Schema.String),
  handoffPath: Schema.String,
});

export type CleanupPreserved = (typeof CleanupPreservedSchema)['Type'];

export const CleanupRunReportSchema = Schema.Struct({
  schemaVersion: Schema.Literal(RETENTION_CLEANUP_SCHEMA_VERSION),
  runId: Schema.String,
  outcome: Schema.Literals(CLEANUP_RUN_OUTCOMES),
  checks: Schema.Array(CleanupCheckReportSchema),
  resources: Schema.Array(CleanupResourceReportSchema),
  preserved: CleanupPreservedSchema,
  message: Schema.String,
});

export type CleanupRunReport = (typeof CleanupRunReportSchema)['Type'];

export function cleanupRunOutcomeOf(
  resources: ReadonlyArray<CleanupResourceReport>,
): CleanupRunOutcome {
  if (resources.some((resource) => resource.disposition === 'failed')) {
    return 'failed';
  }
  if (resources.some((resource) => resource.disposition === 'pending')) {
    return 'warning';
  }
  return 'succeeded';
}
