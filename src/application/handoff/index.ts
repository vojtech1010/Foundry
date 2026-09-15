import { Effect, Result, Schema } from 'effect';
import { join } from 'node:path';

import { FindingRecordSchema } from '../../domain/findings.js';
import { VerificationExecutionSchema } from '../../domain/project-verification.js';
import { RuntimeLifecycleRecordSchema } from '../../domain/project-runtime.js';
import {
  REVIEWER_TURN_OUTCOMES,
  decodeReviewerTurnControl,
} from '../../domain/reviewer-outcomes.js';
import { RoleHostRuntimeIdentitySchema } from '../../domain/role-host.js';
import {
  CleanupProgressPayloadSchema,
  EVIDENCE_MANIFEST_KINDS,
  RolePermissionViolationPayloadSchema,
  UtcInstant,
  ValidationLimitationPayloadSchema,
} from '../../domain/run-history.js';
import { GitCommitId } from '../../domain/run-locations.js';
import { Identifier, Sha256Hex } from '../../domain/run-identity.js';
import { decodeTesterTurnControl } from '../../domain/tester-outcomes.js';
import {
  WORKFLOW_TRANSITION_ROUTE_KINDS,
  WorkflowAttemptSchema,
  WorkflowStateSchema,
} from '../../domain/workflow.js';
import {
  RunHistoryConflict,
  RunHistoryStorage,
  readVerifiedRunHistory,
} from '../run-history/index.js';

import type {
  RunEvent,
  RunHistoryDerivedState,
  WorkflowTransitionPayload,
} from '../../domain/run-history.js';
import type { RunHistoryStorageError } from '../run-history/index.js';
import type { RunHistoryIntegrityError } from '../run-history/index.js';
import type { WorkflowState } from '../../domain/workflow.js';

export const HANDOFF_SCHEMA_VERSION = 1 as const;

export const HANDOFF_FILENAME = 'handoff.json' as const;

export const HANDOFF_KINDS = ['change', 'no_change'] as const;

export type HandoffKind = (typeof HANDOFF_KINDS)[number];

export const HANDOFF_COMPLETION_STATES = ['completed', 'completed_no_change'] as const;

export type HandoffCompletionState = (typeof HANDOFF_COMPLETION_STATES)[number];

export const HANDOFF_TESTER_STATUSES = ['observed', 'skipped', 'limitation', 'missing'] as const;

export type HandoffTesterStatus = (typeof HANDOFF_TESTER_STATUSES)[number];

const HandoffRepositorySchema = Schema.Struct({
  repositoryRoot: Schema.NonEmptyString,
  gitDirectory: Schema.NonEmptyString,
  remoteUrl: Schema.NonEmptyString,
});

const HandoffSourceSchema = Schema.Struct({
  commit: GitCommitId,
  branch: Schema.NonEmptyString,
  remote: Schema.NonEmptyString,
  taskBranch: Schema.NonEmptyString,
  baseCommit: GitCommitId,
  repository: HandoffRepositorySchema,
});

const HandoffCriterionSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
});

const HandoffObjectiveSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  affectedPaths: Schema.Array(Schema.NonEmptyString),
  criterionIds: Schema.Array(Schema.NonEmptyString),
});

const HandoffPlanSchema = Schema.Struct({
  outcome: Schema.Literals(['plan_ready', 'no_change_candidate']),
  runtimeValidationRequired: Schema.Boolean,
  executionMode: Schema.Literals(['sequential', 'parallel']),
  criteria: Schema.Array(HandoffCriterionSchema),
  objectives: Schema.Array(HandoffObjectiveSchema),
});

const HandoffTesterSchema = Schema.Struct({
  required: Schema.Boolean,
  status: Schema.Literals(HANDOFF_TESTER_STATUSES),
  detail: Schema.NonEmptyString,
  commit: Schema.NullOr(Schema.NonEmptyString),
  narrative: Schema.NullOr(Schema.String),
  runtime: Schema.NullOr(RuntimeLifecycleRecordSchema),
});

const HandoffCaptureSchema = Schema.Struct({
  label: Schema.NonEmptyString,
  kind: Schema.Literals(EVIDENCE_MANIFEST_KINDS),
  sha256: Schema.NullOr(Schema.NonEmptyString),
  byteLength: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  criterionIds: Schema.Array(Schema.NonEmptyString),
  hashed: Schema.Boolean,
  duplicated: Schema.Boolean,
});

const HandoffReviewerSchema = Schema.Struct({
  outcome: Schema.NullOr(Schema.Literals(REVIEWER_TURN_OUTCOMES)),
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  narrative: Schema.NonEmptyString,
  runtimeIdentity: RoleHostRuntimeIdentitySchema,
});

const HandoffCorrectionSchema = Schema.Struct({
  route: Schema.Literals(WORKFLOW_TRANSITION_ROUTE_KINDS),
  from: Schema.NullOr(WorkflowStateSchema),
  to: WorkflowStateSchema,
  at: UtcInstant,
});

const HandoffControlRepairSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  problem: Schema.NonEmptyString,
  narrativeHash: Sha256Hex,
  controlHash: Sha256Hex,
  resolved: Schema.Boolean,
});

const HandoffHumanDecisionSchema = Schema.Struct({
  applied: Schema.Boolean,
  route: Schema.NullOr(Schema.Literals(['human-accepted', 'human-corrected'])),
  evidenceRetained: Schema.Boolean,
  detail: Schema.NonEmptyString,
});

const HandoffMergeSchema = Schema.Struct({
  commit: Schema.NonEmptyString,
  sourceBranch: Schema.NonEmptyString,
  fastForward: Schema.Boolean,
});

const HandoffPublicationSchema = Schema.Struct({
  created: Schema.Boolean,
  url: Schema.NullOr(Schema.NonEmptyString),
  kind: Schema.Literals(['result', 'none']),
  merged: Schema.NullOr(HandoffMergeSchema),
  reason: Schema.NonEmptyString,
});

export const HandoffDocumentSchema = Schema.Struct({
  schemaVersion: Schema.Literal(HANDOFF_SCHEMA_VERSION),
  runId: Identifier,
  kind: Schema.Literals(HANDOFF_KINDS),
  outcome: Schema.Literals(HANDOFF_COMPLETION_STATES),
  completedAt: UtcInstant,
  source: Schema.NullOr(HandoffSourceSchema),
  resultCommit: Schema.NullOr(Schema.NonEmptyString),
  verifiedCommit: Schema.NullOr(Schema.NonEmptyString),
  changedFiles: Schema.Array(Schema.NonEmptyString),
  plan: Schema.NullOr(HandoffPlanSchema),
  checks: Schema.Array(VerificationExecutionSchema),
  captures: Schema.Array(HandoffCaptureSchema),
  tester: HandoffTesterSchema,
  reviewer: Schema.NullOr(HandoffReviewerSchema),
  findings: Schema.Array(FindingRecordSchema),
  corrections: Schema.Array(HandoffCorrectionSchema),
  attempts: Schema.Array(WorkflowAttemptSchema),
  controlRepairs: Schema.Array(HandoffControlRepairSchema),
  permissionViolations: Schema.Array(RolePermissionViolationPayloadSchema),
  limitations: Schema.Array(ValidationLimitationPayloadSchema),
  runtime: Schema.Array(RuntimeLifecycleRecordSchema),
  retentionCleanup: Schema.NullOr(CleanupProgressPayloadSchema),
  warnings: Schema.Array(Schema.NonEmptyString),
  humanDecision: HandoffHumanDecisionSchema,
  publication: HandoffPublicationSchema,
  missingCoverage: Schema.Array(Schema.NonEmptyString),
  coverageComplete: Schema.Boolean,
});

export type HandoffDocument = (typeof HandoffDocumentSchema)['Type'];

export interface HandoffCompletion {
  readonly state: HandoffCompletionState;
  readonly route: (typeof WORKFLOW_TRANSITION_ROUTE_KINDS)[number];
  readonly from: WorkflowState | null;
  readonly at: string;
}

function isCompletionState(state: WorkflowState): state is HandoffCompletionState {
  return state === 'completed' || state === 'completed_no_change';
}

/**
 * The single terminal success transition that fixes the report outcome and its
 * durable completion instant. A later terminal transition cannot exist because
 * workflow transitions from a terminal state are refused.
 */
export function completionOf(events: ReadonlyArray<RunEvent>): HandoffCompletion | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== 'workflow-transition') {
      continue;
    }
    if (isCompletionState(event.payload.to)) {
      return {
        state: event.payload.to,
        route: event.payload.route,
        from: event.payload.from,
        at: event.occurredAt,
      };
    }
  }
  return null;
}

function latestVerificationFor(
  derived: RunHistoryDerivedState,
  commit: string | null,
): RunHistoryDerivedState['verifications'][number] | null {
  if (commit === null) {
    return null;
  }
  let latest: RunHistoryDerivedState['verifications'][number] | null = null;
  for (const report of derived.verifications) {
    if (report.commit === commit) {
      latest = report;
    }
  }
  return latest;
}

function latestSettledSession(
  derived: RunHistoryDerivedState,
  role: 'tester' | 'reviewer',
): RunHistoryDerivedState['roleSessions'][number] | null {
  let latest: RunHistoryDerivedState['roleSessions'][number] | null = null;
  for (const session of derived.roleSessions) {
    if (session.role !== role) {
      continue;
    }
    if (session.lastObservation !== null && session.lastObservation.status === 'settled') {
      latest = session;
    }
  }
  return latest;
}

function reviewerOutcomeOf(
  control: RunHistoryDerivedState['roleSessions'][number]['lastObservation'],
): (typeof REVIEWER_TURN_OUTCOMES)[number] | null {
  if (control === null || control.control === null) {
    return null;
  }
  const decoded = decodeReviewerTurnControl(control.control);
  return decoded.ok ? decoded.control.outcome : null;
}

function testerOutcomeOf(
  control: RunHistoryDerivedState['roleSessions'][number]['lastObservation'],
): string | null {
  if (control === null || control.control === null) {
    return null;
  }
  const decoded = decodeTesterTurnControl(control.control);
  return decoded.ok ? decoded.control.outcome : null;
}

function planOf(derived: RunHistoryDerivedState): HandoffDocument['plan'] {
  const plan = derived.acceptedPlan;
  if (plan === null) {
    return null;
  }
  return {
    outcome: plan.outcome,
    runtimeValidationRequired: plan.runtimeValidationRequired,
    executionMode: plan.execution.mode,
    criteria: plan.criteria.map((criterion) => ({ id: criterion.id, text: criterion.text })),
    objectives: plan.execution.objectives.map((objective) => ({
      id: objective.id,
      title: objective.title,
      affectedPaths: [...objective.affectedPaths],
      criterionIds: [...objective.criterionIds],
    })),
  };
}

function sourceOf(derived: RunHistoryDerivedState): HandoffDocument['source'] {
  const frozen = derived.sourceFrozen;
  if (frozen === null) {
    return null;
  }
  return {
    commit: frozen.sourceCommit,
    branch: frozen.sourceBranch,
    remote: frozen.sourceRemote,
    taskBranch: frozen.taskBranch,
    baseCommit: frozen.expectedHead,
    repository: {
      repositoryRoot: frozen.repository.repositoryRoot,
      gitDirectory: frozen.repository.gitDirectory,
      remoteUrl: frozen.repository.remoteUrl,
    },
  };
}

function runtimeFor(
  derived: RunHistoryDerivedState,
  commit: string | null,
): RunHistoryDerivedState['runtimeLifecycles'][number] | null {
  if (commit === null) {
    return null;
  }
  let latest: RunHistoryDerivedState['runtimeLifecycles'][number] | null = null;
  for (const record of derived.runtimeLifecycles) {
    if (record.commit === commit) {
      latest = record;
    }
  }
  return latest;
}

function testerOf(
  derived: RunHistoryDerivedState,
  commit: string | null,
): HandoffDocument['tester'] {
  const required = derived.acceptedPlan?.runtimeValidationRequired ?? false;
  const session = latestSettledSession(derived, 'tester');
  const narrative = session?.lastObservation?.narrative ?? null;
  const runtime = runtimeFor(derived, commit);

  const limitation =
    commit === null
      ? null
      : (derived.validationLimitations.find((l) => l.commit === commit) ?? null);
  if (limitation !== null) {
    return {
      required,
      status: 'limitation',
      detail: limitation.reason,
      commit: limitation.commit,
      narrative,
      runtime,
    };
  }

  const skip =
    commit === null
      ? null
      : (derived.testerSkips.find((s) => s.verificationCommit === commit) ?? null);
  if (skip !== null) {
    return {
      required,
      status: 'skipped',
      detail: skip.reason,
      commit: skip.verificationCommit,
      narrative,
      runtime,
    };
  }

  if (session !== null && testerOutcomeOf(session.lastObservation) === 'observed') {
    return {
      required,
      status: 'observed',
      detail: 'Tester observed the prepared application read-only.',
      commit,
      narrative,
      runtime,
    };
  }

  return {
    required,
    status: 'missing',
    detail: required
      ? 'The accepted plan required live application validation, but no settled observation, explicit skip, or retained limitation is recorded.'
      : 'The accepted plan did not require live application validation and no explicit skip record was found.',
    commit,
    narrative,
    runtime,
  };
}

function reviewerOf(derived: RunHistoryDerivedState): HandoffDocument['reviewer'] {
  const session = latestSettledSession(derived, 'reviewer');
  const narrative = session?.lastObservation?.narrative ?? null;
  if (session === null || narrative === null) {
    return null;
  }
  return {
    outcome: reviewerOutcomeOf(session.lastObservation),
    attempt: session.attempt,
    narrative,
    runtimeIdentity: {
      adapterVersion: session.runtimeIdentity.adapterVersion,
      provider: session.runtimeIdentity.provider,
      model: session.runtimeIdentity.model,
      toolProfile: session.runtimeIdentity.toolProfile,
    },
  };
}

function transitionEvents(events: ReadonlyArray<RunEvent>): ReadonlyArray<{
  readonly payload: WorkflowTransitionPayload;
  readonly occurredAt: string;
}> {
  const found: Array<{ readonly payload: WorkflowTransitionPayload; readonly occurredAt: string }> =
    [];
  for (const event of events) {
    if (event.type === 'workflow-transition') {
      found.push({ payload: event.payload, occurredAt: event.occurredAt });
    }
  }
  return found;
}

function correctionsOf(events: ReadonlyArray<RunEvent>): HandoffDocument['corrections'] {
  const corrections: Array<HandoffDocument['corrections'][number]> = [];
  for (const { payload, occurredAt } of transitionEvents(events)) {
    if (payload.route === 'correction-required' || payload.route === 'human-corrected') {
      corrections.push({
        route: payload.route,
        from: payload.from,
        to: payload.to,
        at: occurredAt,
      });
    }
  }
  return corrections;
}

function humanDecisionOf(
  events: ReadonlyArray<RunEvent>,
  completion: HandoffCompletion,
): HandoffDocument['humanDecision'] {
  let appliedRoute: 'human-accepted' | 'human-corrected' | null = null;
  let evidenceRetained = false;
  for (const event of events) {
    if (event.type === 'workflow-transition') {
      if (event.payload.route === 'human-accepted' || event.payload.route === 'human-corrected') {
        appliedRoute = event.payload.route;
      }
    } else if (event.type === 'decision-applied') {
      evidenceRetained = true;
    }
  }
  const applied = appliedRoute !== null || completion.route === 'human-accepted';
  const route = appliedRoute ?? (completion.route === 'human-accepted' ? 'human-accepted' : null);
  return {
    applied,
    route,
    evidenceRetained: applied && evidenceRetained,
    detail: applied
      ? evidenceRetained
        ? 'An authenticated human decision was applied; the canonical event stream retains its comment, author, body hash, and permission snapshot.'
        : 'An authenticated human decision was applied; the canonical event stream does not retain the decision comment evidence.'
      : 'No authenticated human decision was applied; Reviewer approval completed the run locally.',
  };
}

function warningsOf(derived: RunHistoryDerivedState): ReadonlyArray<string> {
  const warnings: Array<string> = [];
  for (const lifecycle of derived.runtimeLifecycles) {
    if (lifecycle.cleanup === 'failed' || lifecycle.cleanup === 'forced') {
      warnings.push(
        `Runtime cleanup for ${lifecycle.commit} recorded the disposition "${lifecycle.cleanup}".`,
      );
    }
  }
  const cleanup = derived.cleanupProgress;
  if (cleanup !== null && cleanup.outcome !== 'succeeded') {
    warnings.push(`Retention cleanup recorded "${cleanup.outcome}": ${cleanup.detail}`);
  }
  return warnings;
}

function latestManifest(
  derived: RunHistoryDerivedState,
): RunHistoryDerivedState['evidenceManifests'][number] | null {
  const manifests = derived.evidenceManifests ?? [];
  return manifests[manifests.length - 1] ?? null;
}

function contentHashCounts(
  entries: RunHistoryDerivedState['evidenceManifests'][number]['entries'],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.sha256 !== null) {
      counts.set(entry.sha256, (counts.get(entry.sha256) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Projects the latest settled Tester capture manifest into the handoff. A
 * hashed capture is distinguished from a name-only claim, and identical content
 * under different labels is marked duplicated so it counts as one observation.
 */
function capturesOf(derived: RunHistoryDerivedState): HandoffDocument['captures'] {
  const manifest = latestManifest(derived);
  if (manifest === null) {
    return [];
  }
  const counts = contentHashCounts(manifest.entries);
  return manifest.entries.map((entry) => ({
    label: entry.label,
    kind: entry.kind,
    sha256: entry.sha256,
    byteLength: entry.byteLength,
    criterionIds: [...entry.criterionIds],
    hashed: entry.sha256 !== null,
    duplicated: entry.sha256 !== null && (counts.get(entry.sha256) ?? 0) > 1,
  }));
}

/**
 * Criteria whose only manifest support is discounted: a name-only claim, an
 * informational note, or content that is duplicated under another label. Such a
 * criterion has no independent evidence even though a capture names it, so it
 * is reported unproven. A criterion with no manifest entry is left alone:
 * captures are optional, and their absence never fails an otherwise proven
 * result.
 */
function discountedCriterionIds(derived: RunHistoryDerivedState): ReadonlyArray<string> {
  const manifest = latestManifest(derived);
  if (manifest === null) {
    return [];
  }
  const counts = contentHashCounts(manifest.entries);
  const named = new Set<string>();
  const independentlyProven = new Set<string>();
  for (const entry of manifest.entries) {
    const independent =
      entry.sha256 !== null && entry.kind !== 'note' && (counts.get(entry.sha256) ?? 0) === 1;
    for (const criterionId of entry.criterionIds) {
      named.add(criterionId);
      if (independent) {
        independentlyProven.add(criterionId);
      }
    }
  }
  return [...named].filter((criterionId) => !independentlyProven.has(criterionId)).sort();
}

/**
 * Records the publication surface of a completed run from durable evidence
 * only. A no-change run never publishes. A changed run whose exact result pull
 * request is recorded names it; a changed run with a recorded publication
 * attempt is reported unsettled so a later resume reconciles the same run; and
 * a changed run with no attempt completed locally. Handoff never infers a
 * result pull request, and it never records the decision draft channel here.
 */
function publicationOf(
  kind: HandoffKind,
  derived: RunHistoryDerivedState,
): HandoffDocument['publication'] {
  if (kind === 'no_change') {
    return {
      created: false,
      url: null,
      kind: 'none',
      merged: null,
      reason: 'A completed no-change run records no Coder commit and creates no pull request.',
    };
  }
  const merged = derived.resultMergeRecorded ?? null;
  if (merged !== null) {
    return {
      created: false,
      url: null,
      kind: 'result',
      merged: {
        commit: merged.commit,
        sourceBranch: merged.sourceBranch,
        fastForward: merged.fastForward,
      },
      reason: `Reviewer approval recorded a direct merge of the accepted commit ${merged.commit} into "${merged.sourceBranch}".`,
    };
  }
  const recorded = derived.resultPrRecorded ?? null;
  if (recorded !== null) {
    return {
      created: true,
      url: recorded.url,
      kind: 'result',
      merged: null,
      reason: `Reviewer approval recorded result pull request ${recorded.url} for the accepted commit ${recorded.commit}.`,
    };
  }
  const attempted = (derived.resultPrCheckpoints ?? []).length > 0;
  if (attempted) {
    return {
      created: false,
      url: null,
      kind: 'result',
      merged: null,
      reason:
        'Reviewer approval completed the run locally; result publication is not settled, so resume the same run to reconcile it in place without a duplicate pull request.',
    };
  }
  return {
    created: false,
    url: null,
    kind: 'none',
    merged: null,
    reason:
      'Reviewer approval completes the run locally; no result pull request is recorded. A draft decision pull request remains the only channel for a recorded human_decision_required outcome.',
  };
}

/**
 * Builds the deterministic handoff document for a completed run. Every field is
 * derived from verified canonical history, never from a Coder-reported file
 * list, role prose, or a current wall-clock instant, so rebuilding the report
 * for the same history produces byte-identical output.
 */
export function buildHandoff(
  runId: string,
  derived: RunHistoryDerivedState,
  completion: HandoffCompletion,
  events: ReadonlyArray<RunEvent>,
): HandoffDocument {
  const kind: HandoffKind = completion.state === 'completed_no_change' ? 'no_change' : 'change';
  const source = sourceOf(derived);
  const plan = planOf(derived);
  const implementation = derived.implementation;
  const resultCommit = kind === 'change' ? (implementation?.commit ?? null) : null;
  const verifiedCommit =
    implementation === null ? null : (implementation.commit ?? implementation.baseCommit);
  const checks = latestVerificationFor(derived, verifiedCommit)?.executions ?? [];
  const tester = testerOf(derived, verifiedCommit);
  const reviewer = reviewerOf(derived);
  const humanDecision = humanDecisionOf(events, completion);
  const testerRequired = plan?.runtimeValidationRequired ?? false;

  const missingCoverage: Array<string> = [];
  if (source === null) {
    missingCoverage.push('The frozen source record is unavailable.');
  }
  if (plan === null) {
    missingCoverage.push('The accepted plan is unavailable.');
  }
  if (kind === 'change' && resultCommit === null) {
    missingCoverage.push('The completed change has no recorded Coder result commit.');
  }
  if (verifiedCommit === null) {
    missingCoverage.push('No Git-derived result commit is recorded to bind verification evidence.');
  } else if (checks.length === 0) {
    missingCoverage.push(
      `No commit-bound verification report is recorded for the result commit ${verifiedCommit}.`,
    );
  }
  if (testerRequired && tester.status === 'missing') {
    missingCoverage.push(
      'The accepted plan required live application validation, but no Tester observation, explicit skip, or retained limitation is recorded.',
    );
  }
  if (reviewer === null) {
    missingCoverage.push('The Reviewer outcome is unavailable.');
  }
  if (humanDecision.applied && !humanDecision.evidenceRetained) {
    missingCoverage.push(
      'An authenticated human decision is recorded as applied, but its evidence is not retained in the canonical event stream.',
    );
  }
  for (const criterionId of discountedCriterionIds(derived)) {
    missingCoverage.push(
      `Criterion ${criterionId} is supported only by discounted captures (name-only, informational, or duplicated content) with no independent evidence.`,
    );
  }

  const captures = capturesOf(derived);

  const publication = publicationOf(kind, derived);

  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    runId,
    kind,
    outcome: completion.state,
    completedAt: completion.at,
    source,
    resultCommit,
    verifiedCommit,
    changedFiles: implementation === null ? [] : [...implementation.changedFiles],
    plan,
    checks: [...checks],
    captures,
    tester,
    reviewer,
    findings: derived.findings.map((finding) => ({ ...finding, evidence: [...finding.evidence] })),
    corrections: correctionsOf(events),
    attempts: derived.attempts.map((attempt) => ({ ...attempt })),
    controlRepairs: derived.roleControlRepairs.map((repair) => ({
      sessionId: repair.sessionId,
      generation: repair.generation,
      problem: repair.problem,
      narrativeHash: repair.narrativeHash,
      controlHash: repair.controlHash,
      resolved: repair.observation !== null,
    })),
    permissionViolations: derived.permissionViolations.map((violation) => ({ ...violation })),
    limitations: derived.validationLimitations.map((limitation) => ({ ...limitation })),
    runtime: derived.runtimeLifecycles.map((record) => ({
      ...record,
      stages: record.stages.map((stage) => ({ ...stage })),
    })),
    retentionCleanup: derived.cleanupProgress === null ? null : { ...derived.cleanupProgress },
    warnings: [...warningsOf(derived)],
    humanDecision,
    publication,
    missingCoverage,
    coverageComplete: missingCoverage.length === 0,
  };
}

export function encodeHandoff(document: HandoffDocument): Uint8Array {
  const encoded = Schema.encodeSync(HandoffDocumentSchema)(document);
  return new TextEncoder().encode(`${JSON.stringify(encoded, null, 2)}\n`);
}

export interface ReconcileHandoffOptions {
  readonly runDirectory: string;
  readonly runId: string;
}

export interface HandoffResult {
  readonly path: string;
  readonly document: HandoffDocument;
  readonly bytes: Uint8Array;
}

const MAX_HANDOFF_ATTEMPTS = 8;

/**
 * Atomically writes or reconciles the canonical handoff for a completed run.
 * A run that is not `completed` or `completed_no_change` has no handoff and
 * returns `null`. Rebasing on a contended revision retries from verified history
 * so the report always agrees with the accepted result.
 */
export const reconcileHandoff = Effect.fn('reconcileHandoff')(function* (
  options: ReconcileHandoffOptions,
): Effect.fn.Return<
  HandoffResult | null,
  RunHistoryIntegrityError | RunHistoryStorageError | RunHistoryConflict,
  RunHistoryStorage
> {
  const storage = yield* RunHistoryStorage;
  const { runDirectory, runId } = options;
  const path = join(runDirectory, HANDOFF_FILENAME);

  for (let attempt = 1; attempt <= MAX_HANDOFF_ATTEMPTS; attempt += 1) {
    const history = yield* readVerifiedRunHistory({
      runDirectory,
      runId,
      createIfMissing: false,
    });
    const completion = completionOf(history.events);
    if (completion === null) {
      return null;
    }
    const document = buildHandoff(runId, history.derived, completion, history.events);
    const bytes = encodeHandoff(document);
    const replaced = yield* storage
      .replaceDerivedReports({
        runDirectory,
        runId,
        expectedStreamBytes: history.streamBytes,
        expectedWitnessBytes: history.witnessBytes,
        writes: [{ path, bytes }],
        removals: [],
      })
      .pipe(Effect.result);

    if (Result.isSuccess(replaced)) {
      return { path, document, bytes };
    }
    if (replaced.failure._tag !== 'RunHistoryConflict') {
      return yield* replaced.failure;
    }
  }

  return yield* new RunHistoryConflict({
    message: `Run "${runId}" handoff is still contended after ${MAX_HANDOFF_ATTEMPTS} reconciliation attempts.`,
    runId,
  });
});
