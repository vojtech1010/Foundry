import { Effect, Option, Schema } from 'effect';
import { join } from 'node:path';

import { decisionOptionCommand } from '../../domain/decision-publication.js';
import { InspectForwardEventSchema } from '../../domain/inspection.js';
import {
  decodeReviewerTurnControl,
  labelReviewerDecisionOptions,
} from '../../domain/reviewer-outcomes.js';
import { RUN_HISTORY_FILENAME } from '../../domain/run-history.js';
import { decodeTesterTurnControl } from '../../domain/tester-outcomes.js';
import { isTerminalWorkflowState } from '../../domain/workflow.js';
import { readVerifiedRunHistory } from '../run-history/index.js';
import { readRunWorkflowState } from '../run-identity/index.js';

import type {
  InspectAvailabilityEntry,
  InspectCapture,
  InspectCaptures,
  InspectCheckReport,
  InspectControlRejection,
  InspectCorrection,
  InspectDecision,
  InspectFailures,
  InspectForwardDecisionRecords,
  InspectImplementation,
  InspectJournal,
  InspectPlan,
  InspectPlanCriterion,
  InspectPublication,
  InspectPublicationCheckpoint,
  InspectPublicationTransition,
  InspectReviewer,
  InspectSections,
  InspectTester,
  RunInspectReport,
} from '../../domain/inspection.js';
import type { FindingRecord } from '../../domain/findings.js';
import type { ReviewerTurnOutcome } from '../../domain/reviewer-outcomes.js';
import type {
  PlanAcceptedPayload,
  RunEvent,
  RunHistoryDerivedState,
  WorkflowTransitionPayload,
} from '../../domain/run-history.js';
import type { RoleHostRole } from '../../domain/role-host.js';
import type { WorkflowState } from '../../domain/workflow.js';
import type { ReadinessFiles } from '../readiness/index.js';
import type {
  RunHistoryConflict,
  RunHistoryIntegrityError,
  RunHistoryStorage,
  RunHistoryStorageError,
  VerifiedRunHistory,
} from '../run-history/index.js';
import type { RunStateUnavailable } from '../run-identity/index.js';

export interface ReadRunInspectOptions {
  readonly configArg: string;
  readonly cwd: string;
  readonly runId: string;
}

export interface BuildRunInspectReportOptions {
  readonly runDirectory: string;
  readonly history: VerifiedRunHistory;
}

export type RunInspectError =
  | RunStateUnavailable
  | RunHistoryIntegrityError
  | RunHistoryStorageError
  | RunHistoryConflict;

export type { RunInspectReport } from '../../domain/inspection.js';

const SHA256_IN_TEXT = /sha256:([0-9a-f]{64})/u;

const BYTE_LENGTH_IN_TEXT = /bytes:(\d+)/u;

const PUBLICATION_ROUTES: ReadonlySet<string> = new Set([
  'human-decision-required',
  'publication-unavailable',
  'draft-pr-reconciled',
  'publication-unresolved',
  'human-accepted',
  'human-corrected',
]);

const DECISION_STATES: ReadonlySet<WorkflowState> = new Set([
  'human_decision_required',
  'publishing',
  'publish_failed',
]);

function available(detail: string): InspectAvailabilityEntry {
  return { availability: 'available', detail };
}

function emptyNotProven(detail: string): InspectAvailabilityEntry {
  return { availability: 'empty-not-proven', detail };
}

function unavailable(detail: string): InspectAvailabilityEntry {
  return { availability: 'unavailable', detail };
}

function resultCommitOf(derived: RunHistoryDerivedState): string | null {
  const implementation = derived.implementation;
  if (implementation === null) {
    return null;
  }
  return implementation.commit ?? implementation.baseCommit;
}

function checkNamesForCommit(
  derived: RunHistoryDerivedState,
  commit: string | null,
): ReadonlyArray<string> {
  if (commit === null) {
    return [];
  }
  const names: Array<string> = [];
  for (const report of derived.verifications) {
    if (report.commit !== commit) {
      continue;
    }
    for (const execution of report.executions) {
      if (!names.includes(execution.name)) {
        names.push(execution.name);
      }
    }
  }
  return names;
}

function latestSettledSession(
  derived: RunHistoryDerivedState,
  role: RoleHostRole,
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
  session: RunHistoryDerivedState['roleSessions'][number] | null,
): ReviewerTurnOutcome | null {
  const observation = session?.lastObservation ?? null;
  if (observation === null || observation.control === null) {
    return null;
  }
  const decoded = decodeReviewerTurnControl(observation.control);
  return decoded.ok ? decoded.control.outcome : null;
}

function testerOutcomeOf(session: RunHistoryDerivedState['roleSessions'][number]): string | null {
  const observation = session.lastObservation;
  if (observation === null || observation.control === null) {
    return null;
  }
  const decoded = decodeTesterTurnControl(observation.control);
  return decoded.ok ? decoded.control.outcome : null;
}

function transitionEvents(
  events: ReadonlyArray<RunEvent>,
): ReadonlyArray<{ readonly payload: WorkflowTransitionPayload; readonly occurredAt: string }> {
  const found: Array<{ readonly payload: WorkflowTransitionPayload; readonly occurredAt: string }> =
    [];
  for (const event of events) {
    if (event.type === 'workflow-transition') {
      found.push({ payload: event.payload, occurredAt: event.occurredAt });
    }
  }
  return found;
}

function cloneFinding(finding: FindingRecord): FindingRecord {
  return { ...finding, evidence: [...finding.evidence] };
}

function planSection(
  plan: PlanAcceptedPayload | null,
  resultCommit: string | null,
  checks: ReadonlyArray<string>,
  reviewerOutcome: ReviewerTurnOutcome | null,
): InspectPlan | null {
  if (plan === null) {
    return null;
  }
  const objectives = plan.execution.objectives;
  return {
    outcome: plan.outcome,
    runtimeValidationRequired: plan.runtimeValidationRequired,
    executionMode: plan.execution.mode,
    criteria: plan.criteria.map((criterion): InspectPlanCriterion => {
      return {
        id: criterion.id,
        text: criterion.text,
        objectiveIds: objectives
          .filter((objective) => objective.criterionIds.includes(criterion.id))
          .map((objective) => objective.id),
        resultCommit,
        checks: [...checks],
        reviewerOutcome,
      };
    }),
    objectives: objectives.map((objective) => ({
      id: objective.id,
      title: objective.title,
      affectedPaths: [...objective.affectedPaths],
      criterionIds: [...objective.criterionIds],
    })),
  };
}

function implementationSection(derived: RunHistoryDerivedState): InspectImplementation | null {
  const implementation = derived.implementation;
  if (implementation === null) {
    return null;
  }
  return {
    taskBranch: implementation.taskBranch,
    baseCommit: implementation.baseCommit,
    commit: implementation.commit,
    changedFiles: [...implementation.changedFiles],
    noChangeCandidate: implementation.noChangeCandidate,
  };
}

function checkReports(derived: RunHistoryDerivedState): ReadonlyArray<InspectCheckReport> {
  return derived.verifications.map((report) => ({
    attempt: report.attempt,
    commit: report.commit,
    result: report.result,
    profileHash: report.profileHash,
    commandMs: report.commandMs,
    executions: report.executions.map((execution) => ({
      kind: execution.kind,
      name: execution.name,
      command: [execution.executable, ...execution.arguments].join(' '),
      expectedExitCode: execution.expectedExitCode,
      actualExitCode: execution.actualExitCode,
      timedOut: execution.timedOut,
      passed:
        !execution.timedOut &&
        execution.actualExitCode === execution.expectedExitCode &&
        execution.trackedMutation === null &&
        execution.reconstructionError === null,
      logPath: execution.log.path,
      logSha256: execution.log.sha256,
      logByteLength: execution.log.byteLength,
      logRetainedByteLength: execution.log.retainedByteLength,
      logTruncated: execution.log.truncated,
      logRedactionCount: execution.log.redactionCount,
    })),
  }));
}

function testerSection(
  derived: RunHistoryDerivedState,
  resultCommit: string | null,
): InspectTester {
  const required = derived.acceptedPlan?.runtimeValidationRequired ?? false;
  const session = latestSettledSession(derived, 'tester');
  const narrative = session?.lastObservation?.narrative ?? null;
  const limitation =
    resultCommit === null
      ? null
      : (derived.validationLimitations.find((entry) => entry.commit === resultCommit) ?? null);
  const skip =
    resultCommit === null
      ? null
      : (derived.testerSkips.find((entry) => entry.verificationCommit === resultCommit) ?? null);
  const observed = session !== null && testerOutcomeOf(session) === 'observed';

  let status: InspectTester['status'] = 'missing';
  let detail = required
    ? 'The accepted plan required live application validation, but no settled observation, explicit skip, or retained limitation is recorded.'
    : 'The accepted plan did not require live application validation and no explicit skip record was found.';
  if (limitation !== null) {
    status = 'limitation';
    detail = limitation.reason;
  } else if (skip !== null) {
    status = 'skipped';
    detail = skip.reason;
  } else if (observed) {
    status = 'observed';
    detail = 'Tester observed the prepared application read-only.';
  }

  return {
    required,
    status,
    detail,
    commit: resultCommit,
    narrative,
    limitations: derived.validationLimitations.map((entry) => ({
      reason: entry.reason,
      commit: entry.commit,
    })),
    skips: derived.testerSkips.map((entry) => ({
      reason: entry.reason,
      verificationCommit: entry.verificationCommit,
    })),
    runtimes: derived.runtimeLifecycles.map((record) => ({
      commit: record.commit,
      outcome: record.outcome,
      cleanup: record.cleanup,
      dataPreserved: record.dataPreserved,
    })),
  };
}

function reviewerSection(derived: RunHistoryDerivedState): InspectReviewer | null {
  const session = latestSettledSession(derived, 'reviewer');
  const narrative = session?.lastObservation?.narrative ?? null;
  if (session === null || narrative === null) {
    return null;
  }
  return {
    outcome: reviewerOutcomeOf(session),
    attempt: session.attempt,
    narrative,
    model: session.runtimeIdentity.model,
  };
}

function failuresSection(derived: RunHistoryDerivedState): InspectFailures {
  const controlRejections: ReadonlyArray<InspectControlRejection> = derived.roleControlRepairs.map(
    (repair) => ({
      sessionId: repair.sessionId,
      generation: repair.generation,
      sequence: repair.sequence,
      problem: repair.problem,
      resolved: repair.observation !== null,
    }),
  );
  return {
    attempts: derived.attempts.map((attempt) => ({ ...attempt })),
    controlRejections,
    permissionViolations: derived.permissionViolations.map((violation) => ({ ...violation })),
  };
}

function correctionsOf(events: ReadonlyArray<RunEvent>): ReadonlyArray<InspectCorrection> {
  const corrections: Array<InspectCorrection> = [];
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

function publicationTransitions(
  events: ReadonlyArray<RunEvent>,
): ReadonlyArray<InspectPublicationTransition> {
  const transitions: Array<InspectPublicationTransition> = [];
  for (const { payload, occurredAt } of transitionEvents(events)) {
    if (!PUBLICATION_ROUTES.has(payload.route)) {
      continue;
    }
    transitions.push({
      route: payload.route,
      from: payload.from,
      to: payload.to,
      at: occurredAt,
    });
  }
  return transitions;
}

function publicationSection(
  events: ReadonlyArray<RunEvent>,
  forward: InspectForwardDecisionRecords,
): InspectPublication {
  const transitions = publicationTransitions(events);
  const checkpoints = [...forward.checkpoints];
  const last = checkpoints[checkpoints.length - 1] ?? null;
  const state = transitions[transitions.length - 1]?.to ?? null;
  return {
    state,
    transitions,
    checkpoints,
    draftPrUrl: last?.draftPrUrl ?? null,
  };
}

function journalsOf(derived: RunHistoryDerivedState): ReadonlyArray<InspectJournal> {
  const journals: Array<InspectJournal> = [];
  for (const session of derived.roleSessions) {
    if (session.submission !== null && session.submissionStarted === null) {
      journals.push({
        kind: 'submission-pending',
        sessionId: session.sessionId,
        role: session.role,
        generation: session.generation,
        detail: `The ${session.role} submission intent for session ${session.sessionId} has no recorded start; it may not have reached the role host.`,
      });
      continue;
    }
    if (
      session.submissionStarted !== null &&
      (session.lastObservation === null || session.lastObservation.status === 'active')
    ) {
      journals.push({
        kind: 'observation-awaiting',
        sessionId: session.sessionId,
        role: session.role,
        generation: session.generation,
        detail: `The ${session.role} session ${session.sessionId} was submitted but has no settled observation.`,
      });
    }
  }
  for (const repair of derived.roleControlRepairs) {
    if (repair.observation === null) {
      journals.push({
        kind: 'control-repair-unresolved',
        sessionId: repair.sessionId,
        role: null,
        generation: repair.generation,
        detail: `A control repair for session ${repair.sessionId} has no settled observation: ${repair.problem}`,
      });
    }
  }
  return journals;
}

function capturesOf(derived: RunHistoryDerivedState): InspectCaptures {
  const entries: Array<InspectCapture> = [];
  for (const report of derived.verifications) {
    for (const execution of report.executions) {
      entries.push({
        source: 'verification-log',
        label: `${execution.name} ${execution.log.path}`,
        contentHash: execution.log.sha256,
        byteLength: execution.log.byteLength,
        verified: true,
      });
      if (execution.trackedMutation !== null) {
        entries.push({
          source: 'tracked-mutation',
          label: `${execution.name} ${execution.trackedMutation.diff.path}`,
          contentHash: execution.trackedMutation.diff.sha256,
          byteLength: execution.trackedMutation.diff.byteLength,
          verified: true,
        });
      }
    }
  }
  for (const finding of derived.findings) {
    for (const evidence of finding.evidence) {
      const contentHash = SHA256_IN_TEXT.exec(evidence)?.[1] ?? null;
      const byteLengthMatch = BYTE_LENGTH_IN_TEXT.exec(evidence)?.[1];
      entries.push({
        source: 'finding-evidence',
        label: evidence,
        contentHash,
        byteLength: byteLengthMatch === undefined ? null : Number.parseInt(byteLengthMatch, 10),
        verified: contentHash !== null,
      });
    }
  }

  const byHash = new Map<string, Array<string>>();
  for (const entry of entries) {
    if (entry.contentHash === null) {
      continue;
    }
    const labels = byHash.get(entry.contentHash) ?? [];
    if (!labels.includes(entry.label)) {
      labels.push(entry.label);
    }
    byHash.set(entry.contentHash, labels);
  }
  const duplicates = [...byHash.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([contentHash, labels]) => ({ contentHash, labels }));

  return { entries, duplicates };
}

function decisionSection(options: {
  readonly runId: string;
  readonly derived: RunHistoryDerivedState;
  readonly events: ReadonlyArray<RunEvent>;
  readonly forward: InspectForwardDecisionRecords;
  readonly resultCommit: string | null;
}): InspectDecision | null {
  const { derived, events, forward, resultCommit } = options;
  const session = latestSettledSession(derived, 'reviewer');
  const control = session?.lastObservation?.control ?? null;
  if (control === null) {
    return null;
  }
  const decoded = decodeReviewerTurnControl(control);
  if (!decoded.ok || decoded.control.outcome !== 'human_decision_required') {
    return null;
  }
  const decision = decoded.control.decision;
  const labeled = labelReviewerDecisionOptions(decision.options);
  const appliedTransition = transitionEvents(events).some(
    ({ payload }) => payload.route === 'human-accepted' || payload.route === 'human-corrected',
  );
  const lastCheckpoint = forward.checkpoints[forward.checkpoints.length - 1] ?? null;
  const unresolvedFindings =
    resultCommit === null
      ? []
      : derived.findings
          .filter(
            (finding) =>
              finding.commit === resultCommit && (finding.blocking || finding.severity !== 'low'),
          )
          .map(cloneFinding);
  const unresolvedLimitations =
    resultCommit === null
      ? []
      : derived.validationLimitations
          .filter((limitation) => limitation.commit === resultCommit)
          .map((limitation) => ({ reason: limitation.reason, commit: limitation.commit }));

  return {
    decisionId: forward.decisionId,
    question: decision.question,
    recommendation: decision.recommendation ?? null,
    options: labeled.map((option) => ({
      id: option.id,
      label: option.label,
      action: option.action,
    })),
    commands: labeled.map((option) => ({
      optionId: option.id,
      action: option.action,
      command: decisionOptionCommand({
        runId: options.runId,
        decisionId: forward.decisionId ?? '<decision-id>',
        optionId: option.id,
        nonce: forward.nonce ?? '<nonce>',
      }),
    })),
    commandsExact: forward.decisionId !== null && forward.nonce !== null,
    unresolvedFindings,
    unresolvedLimitations,
    sourceCommit: derived.sourceFrozen?.sourceCommit ?? null,
    resultCommit: resultCommit ?? forward.resultCommit,
    draftPrUrl: lastCheckpoint?.draftPrUrl ?? null,
    publicationStage: lastCheckpoint?.stage ?? null,
    commentAccepted: forward.applied !== null || appliedTransition,
    commentAcceptedKnown:
      forward.applied !== null ||
      appliedTransition ||
      (derived.state !== null && !DECISION_STATES.has(derived.state)),
  };
}

/**
 * Structurally recognizes the optional decision/publication records. The
 * inspection surface is a read-only consumer of canonical history: records
 * that predate decision publication simply do not match, so their absence
 * degrades to a null or unavailable section rather than a failure.
 */
function readForwardDecisionRecords(events: ReadonlyArray<unknown>): InspectForwardDecisionRecords {
  let decisionId: string | null = null;
  let nonce: string | null = null;
  let resultCommit: string | null = null;
  let applied: InspectForwardDecisionRecords['applied'] = null;
  const checkpoints: Array<InspectPublicationCheckpoint> = [];

  for (const event of events) {
    const decoded = Schema.decodeUnknownOption(InspectForwardEventSchema, {
      onExcessProperty: 'ignore',
    })(event);
    if (Option.isNone(decoded)) {
      continue;
    }
    const value = decoded.value;
    switch (value.type) {
      case 'decision-opened': {
        decisionId = value.payload.decisionId;
        nonce = value.payload.nonce;
        resultCommit = value.payload.resultCommit ?? null;
        break;
      }
      case 'publication-checkpoint': {
        checkpoints.push({
          stage: value.payload.stage,
          draftPrUrl: value.payload.draftPrUrl ?? null,
          decisionId: value.payload.decisionId ?? null,
          detail: value.payload.detail ?? '',
        });
        break;
      }
      case 'decision-applied': {
        applied = { decisionId: value.payload.decisionId, optionId: value.payload.optionId };
        break;
      }
    }
  }

  return { decisionId, nonce, resultCommit, checkpoints, applied };
}

/**
 * Builds a deterministic, read-only inspection report from one verified
 * history snapshot. Every section names its own availability so an empty list
 * can never be read as proof that nothing happened; decision and publication
 * details are enriched only when the optional records are present.
 */
export function buildRunInspectReport(options: BuildRunInspectReportOptions): RunInspectReport {
  const { history, runDirectory } = options;
  const derived = history.derived;
  const events = history.events;
  const forward = readForwardDecisionRecords(events);
  const resultCommit = resultCommitOf(derived);
  const reviewer = reviewerSection(derived);
  const reviewerOutcome = reviewer?.outcome ?? null;
  const criterionChecks = checkNamesForCommit(derived, resultCommit);
  const plan = planSection(derived.acceptedPlan, resultCommit, criterionChecks, reviewerOutcome);
  const implementation = implementationSection(derived);
  const checks = checkReports(derived);
  const tester = testerSection(derived, resultCommit);
  const failures = failuresSection(derived);
  const findings = derived.findings.map(cloneFinding);
  const corrections = correctionsOf(events);
  const decision = decisionSection({
    runId: history.runId,
    derived,
    events,
    forward,
    resultCommit,
  });
  const publication = publicationSection(events, forward);
  const cleanup = derived.cleanupProgress === null ? null : { ...derived.cleanupProgress };
  const journals = journalsOf(derived);
  const captures = capturesOf(derived);
  const state = derived.state;

  const sections: InspectSections = {
    plan:
      plan === null
        ? emptyNotProven(
            'No accepted plan event is recorded; absence of a plan is not proof that planning never happened.',
          )
        : available('The accepted plan criteria and objectives are summarized from plan-accepted.'),
    implementation:
      implementation === null
        ? emptyNotProven(
            'No accepted implementation event is recorded; absence is not proof that no implementation happened.',
          )
        : available('The Git-derived result commit and changed files are summarized.'),
    checks:
      checks.length === 0
        ? emptyNotProven(
            'No verification report is recorded; absence is not proof that checks never ran.',
          )
        : available('Every commit-bound verification report and execution is listed.'),
    tester:
      tester.status === 'observed' || tester.status === 'limitation' || tester.status === 'skipped'
        ? available('The Tester observation, skip, or retained limitation is summarized.')
        : tester.required
          ? unavailable(
              'The accepted plan required live validation, but no settled observation, skip, or limitation exists to summarize.',
            )
          : emptyNotProven(
              'The accepted plan did not require live validation and no explicit skip record exists.',
            ),
    reviewer:
      reviewer === null
        ? emptyNotProven(
            'No settled Reviewer session with a narrative is recorded; absence is not proof that review never ran.',
          )
        : reviewer.outcome === null
          ? unavailable(
              'A settled Reviewer narrative exists, but its control envelope is not a recognized outcome.',
            )
          : available('The Reviewer outcome and narrative are summarized.'),
    failures:
      failures.attempts.length +
        failures.controlRejections.length +
        failures.permissionViolations.length ===
      0
        ? emptyNotProven(
            'No rejected attempt, control rejection, or permission violation is recorded.',
          )
        : available('Rejected attempts, control rejections, and permission violations are listed.'),
    findings:
      findings.length === 0
        ? emptyNotProven('No finding is recorded; absence is not proof that no issue was found.')
        : available('Every recorded finding is listed with its commit and evidence.'),
    corrections:
      corrections.length === 0
        ? emptyNotProven(
            'No correction transition is recorded; absence is not proof that no correction happened.',
          )
        : available('Every correction transition is listed in order.'),
    decision:
      decision !== null
        ? available(
            'The human-decision question, options, unresolved issues, and commands are summarized.',
          )
        : state !== null && DECISION_STATES.has(state)
          ? unavailable(
              'The run is in a decision or publication state, but no settled human-decision envelope is recorded.',
            )
          : emptyNotProven('No human-decision envelope is recorded for this run.'),
    publication:
      publication.transitions.length + publication.checkpoints.length === 0
        ? state !== null && DECISION_STATES.has(state)
          ? unavailable(
              'The run is in a decision or publication state, but no publication checkpoint is recorded.',
            )
          : emptyNotProven('No publication checkpoint or transition is recorded.')
        : available('Publication transitions and checkpoints are listed in order.'),
    cleanup:
      cleanup !== null
        ? available(
            `Cleanup completion is recorded separately from result acceptance: ${cleanup.outcome}.`,
          )
        : state !== null && isTerminalWorkflowState(state)
          ? unavailable(
              'The run is terminal, but no cleanup-progress record exists, so cleanup completion is not distinguished from result completion.',
            )
          : emptyNotProven(
              'No cleanup-progress record is recorded; absence is not proof that no result resources were disposed.',
            ),
    journals:
      journals.length === 0
        ? emptyNotProven(
            'No incomplete or uncertain journal record was detected; absence is not proof that every journal is complete.',
          )
        : available('Incomplete and uncertain journal records are listed.'),
    captures:
      captures.entries.length === 0
        ? emptyNotProven(
            'No bounded evidence reference is recorded; absence is not proof that nothing was captured.',
          )
        : available('Hashed evidence is listable as verified and label-only claims as unverified.'),
  };

  return {
    schemaVersion: 1,
    runId: history.runId,
    workflowState: state,
    checkpoint: derived.checkpoint,
    revision: history.head.revision,
    eventHash: history.head.eventHash,
    historyPath: join(runDirectory, RUN_HISTORY_FILENAME),
    sections,
    plan: plan,
    implementation,
    checks,
    tester,
    reviewer,
    failures,
    findings,
    corrections,
    decision,
    publication,
    cleanup,
    journals,
    captures,
  };
}

export const readRunInspect = Effect.fn('readRunInspect')(function* (
  options: ReadRunInspectOptions,
): Effect.fn.Return<RunInspectReport, RunInspectError, ReadinessFiles | RunHistoryStorage> {
  const progress = yield* readRunWorkflowState(options);
  const history = yield* readVerifiedRunHistory({
    runDirectory: progress.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  return buildRunInspectReport({ runDirectory: progress.runDirectory, history });
});
