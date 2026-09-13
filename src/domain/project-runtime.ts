import { Schema } from 'effect';

export const RUNTIME_STAGE_NAMES = [
  'reset',
  'build',
  'start',
  'readiness',
  'stop',
  'cleanup',
] as const;

export type RuntimeStageName = (typeof RUNTIME_STAGE_NAMES)[number];

export const RUNTIME_STAGE_OUTCOMES = ['succeeded', 'failed', 'timed_out', 'skipped'] as const;

export type RuntimeStageOutcome = (typeof RUNTIME_STAGE_OUTCOMES)[number];

export const RUNTIME_LIFECYCLE_OUTCOMES = ['ready', 'failed', 'timed_out'] as const;

export type RuntimeLifecycleOutcome = (typeof RUNTIME_LIFECYCLE_OUTCOMES)[number];

export const RUNTIME_CLEANUP_DISPOSITIONS = ['disposed', 'forced', 'not_owned', 'failed'] as const;

export type RuntimeCleanupDisposition = (typeof RUNTIME_CLEANUP_DISPOSITIONS)[number];

export const RUNTIME_KIND = 'application' as const;

export const RUNTIME_DATA_POLICY_PRESERVED = true as const;

const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const RuntimeInstant = Schema.String.check(Schema.isPattern(UTC_INSTANT_PATTERN));

export const RuntimeStageRecordSchema = Schema.Struct({
  name: Schema.Literals(RUNTIME_STAGE_NAMES),
  outcome: Schema.Literals(RUNTIME_STAGE_OUTCOMES),
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  detail: Schema.String,
});

export type RuntimeStageRecord = (typeof RuntimeStageRecordSchema)['Type'];

export const RuntimeLifecycleRecordSchema = Schema.Struct({
  repository: Schema.NonEmptyString,
  commit: Schema.NonEmptyString,
  baseUrl: Schema.NonEmptyString,
  runtimeKind: Schema.Literal(RUNTIME_KIND),
  startedAt: RuntimeInstant,
  readyAt: Schema.NullOr(RuntimeInstant),
  stoppedAt: Schema.NullOr(RuntimeInstant),
  outcome: Schema.Literals(RUNTIME_LIFECYCLE_OUTCOMES),
  cleanup: Schema.Literals(RUNTIME_CLEANUP_DISPOSITIONS),
  dataPreserved: Schema.Boolean,
  stages: Schema.Array(RuntimeStageRecordSchema),
});

export type RuntimeLifecycleRecord = (typeof RuntimeLifecycleRecordSchema)['Type'];

export function runtimeStageOf(
  record: RuntimeLifecycleRecord,
  name: RuntimeStageName,
): RuntimeStageRecord | null {
  return record.stages.find((stage) => stage.name === name) ?? null;
}
