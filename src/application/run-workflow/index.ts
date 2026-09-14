import { DateTime, Duration, Effect, Layer, Option, Ref, Result, Schema } from 'effect';
import { dirname, join } from 'node:path';

import { decodeReviewerTurnControl } from '../../domain/reviewer-outcomes.js';
import { REQUEST_NORMALIZED_FILENAME } from '../../domain/run-identity.js';
import { RUN_STORAGE_DIRECTORY_NAME } from '../../domain/readiness.js';
import { describeRunCleanupReport } from '../../domain/run-cleanup.js';
import { decodeTesterTurnControl } from '../../domain/tester-outcomes.js';
import { workerWorkspacePath } from '../../domain/parallel-workers.js';
import {
  REPOSITORY_LEASE_FILENAME,
  RepositoryLeaseJson,
  classifyRepositoryLeaseOwner,
  repositoryLeaseExpired,
} from '../../domain/repository-lease.js';
import { isActiveWorkflowState, isTerminalWorkflowState } from '../../domain/workflow.js';
import {
  admitArchitectPlan,
  resumeArchitectPlan,
  validateArchitectPlanControl,
} from '../architect-plan/index.js';
import {
  CoderTurnControlSchema,
  CoderTurnRejected,
  handleCoderTurn,
  validateCoderTurnControl,
} from '../coder-result/index.js';
import { applyDecision, scanForDecision } from '../decision-commands/index.js';
import { publishDecisionDraftPr, reconcilePublication } from '../decision-publication/index.js';
import { bootstrapRoleGuidance } from '../guidance/index.js';
import { reconcileHandoff } from '../handoff/index.js';
import {
  recordIntegrationCompleted,
  recordIntegrationDeclaration,
  verifyAggregate,
} from '../parallel-integration/index.js';
import {
  ParallelWorkersTurnError,
  WorkerTurnRunner,
  runObjectiveWorkers,
} from '../parallel-workers/index.js';
import { prepareAndHoldApplicationRuntime } from '../project-runtime/index.js';
import { runProjectVerification } from '../project-verification/index.js';
import { classifyRecovery, classifyRoleFailure } from '../recovery/index.js';
import { RepositoryHostIdentity, RepositoryLeaseStore } from '../repository-lease/index.js';
import { buildRolePacket } from '../role-packets/index.js';
import { startGovernedRoleTurn } from '../role-permissions/index.js';
import { handleReviewerTurn } from '../reviewer-outcomes/index.js';
import {
  RoleConversationError,
  RoleHostLauncher,
  launchOptionsForRole,
  stopRoleSession,
} from '../role-conversations/index.js';
import { publishResultPr } from '../result-publication/index.js';
import { RunGit } from '../git-provisioning/index.js';
import { describePublicationReadiness } from '../readiness/index.js';
import { RunIdentityStore, RunIdentityStorageError } from '../run-identity/index.js';
import { disposeRunResources } from '../run-cleanup/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';
import { handleTesterTurn, validateTesterTurnControl } from '../tester-validation/index.js';
import { routeAfterProjectChecks } from '../validation-routing/index.js';
import {
  recordCleanupProgress,
  recordWorkflowAttempt,
  transitionWorkflow,
} from '../workflow-transitions/index.js';

import type { ProjectConfiguration } from '../../domain/project-configuration.js';
import type { PlannedObjective } from '../../domain/architect-plan.js';
import type { RoleHostControl, RoleHostSessionState } from '../../domain/role-host.js';
import type { RoleTurnLocations } from '../../domain/role-permissions.js';
import type {
  EvidenceManifestEntry,
  RunHistoryDerivedState,
  WorkflowTransitionPayload,
} from '../../domain/run-history.js';
import type { WorkflowRole, WorkflowState } from '../../domain/workflow.js';
import type { WorkerTurnTarget } from '../parallel-workers/index.js';
import type { HeldApplicationRuntime } from '../project-runtime/index.js';
import type {
  RecoveryClassification,
  RecoveryFacts,
  RecoveryDisposition,
} from '../recovery/index.js';
import type { ResultPublicationReport } from '../result-publication/index.js';
import type { RoleConversationFailureReason } from '../role-conversations/index.js';
import type { ImplementationObservation, WorktreeObservation } from '../git-provisioning/index.js';
import type { WorkerWorktreeDisposal } from '../run-cleanup/index.js';
import type { VerifiedRunHistory } from '../run-history/index.js';

export const MAX_RUN_STEPS = 128;

export class RunWorkflowError extends Schema.TaggedError<RunWorkflowError>()('RunWorkflowError', {
  message: Schema.String,
  runId: Schema.String,
  kind: Schema.Literals(['blocked', 'failed', 'publish_failed']),
}) {}

export interface AdvanceRunOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly configDirectory: string;
  readonly configuration: ProjectConfiguration;
  readonly allowResume: boolean;
}

/**
 * The decision outcome of a resume that found a run waiting for a human. A
 * non-null `problem` is an integrity stop: the durable state is unchanged and
 * the problem is reported instead of guessing.
 */
export interface RunWorkflowDecisionReport {
  readonly applied: 'accept' | 'correct' | 'abandon' | null;
  readonly waiting: boolean;
  readonly draftPrUrl: string | null;
  readonly problem: string | null;
}

/**
 * The disposition chosen for a resumable run before it advanced. A non-null
 * `problem` is a `human_recovery` integrity stop: durable state is not advanced
 * and the problem is reported instead of guessing.
 */
export interface RunWorkflowRecoveryReport {
  readonly disposition: RecoveryDisposition;
  readonly reason: string;
  readonly problem: string | null;
}

export interface RunWorkflowOutcome {
  readonly workflowState: WorkflowState;
  readonly stages: ReadonlyArray<WorkflowState>;
  readonly testerSkipped: boolean;
  readonly decision: RunWorkflowDecisionReport | null;
  readonly recovery: RunWorkflowRecoveryReport | null;
  readonly resultPublication: ResultPublicationReport | null;
}

function errorMessage(error: { readonly message: string }): string {
  return error.message;
}

function roleControlValidator(
  role: WorkflowRole,
): (control: Schema.Json) => { readonly ok: boolean; readonly problem: string } {
  switch (role) {
    case 'architect':
      return validateArchitectPlanControl;
    case 'coder':
      return validateCoderTurnControl;
    case 'tester':
      return validateTesterTurnControl;
    case 'reviewer':
      return (control) => {
        const decoded = decodeReviewerTurnControl(control);
        return decoded.ok ? { ok: true, problem: '' } : { ok: false, problem: decoded.problem };
      };
  }
}

function stagesOf(history: VerifiedRunHistory): ReadonlyArray<WorkflowState> {
  const stages: Array<WorkflowState> = [];
  for (const event of history.events) {
    if (event.type === 'workflow-transition') {
      stages.push(event.payload.to);
    }
  }
  return stages;
}

function summaryOf(history: VerifiedRunHistory): RunWorkflowOutcome {
  return {
    workflowState: history.derived.state ?? 'blocked',
    stages: stagesOf(history),
    testerSkipped: history.derived.testerSkips.length > 0,
    decision: null,
    recovery: null,
    resultPublication: null,
  };
}

function lastWorkflowTransition(history: VerifiedRunHistory): WorkflowTransitionPayload | null {
  for (let index = history.events.length - 1; index >= 0; index -= 1) {
    const event = history.events[index];
    if (event !== undefined && event.type === 'workflow-transition') {
      return event.payload;
    }
  }
  return null;
}

/**
 * The role attempt a stage should run. A stage re-entered by a `resume`
 * transition reattaches to the latest recorded session for its role instead of
 * allocating a new attempt, so recovery observes the same owned operation and
 * never resubmits a prompt whose submission already started. Every other
 * re-entry (a control retry, a correction, a retest) allocates the next attempt.
 */
function roleAttempt(history: VerifiedRunHistory, role: WorkflowRole): number {
  const sessions = history.derived.roleSessions.filter((session) => session.role === role);
  const latest = sessions[sessions.length - 1];
  if (latest === undefined) {
    return 1;
  }
  const last = lastWorkflowTransition(history);
  if (last !== null && last.route === 'resume' && last.to === history.derived.state) {
    return latest.attempt;
  }
  return latest.attempt + 1;
}

function retriesUsed(history: RunHistoryDerivedState, role: WorkflowRole): number {
  return history.attempts.filter((attempt) => attempt.kind === 'retry' && attempt.role === role)
    .length;
}

function repairsUsed(
  history: RunHistoryDerivedState,
  role: WorkflowRole,
  state: WorkflowState,
): number {
  return history.attempts.filter(
    (attempt) => attempt.kind === 'repair' && attempt.role === role && attempt.state === state,
  ).length;
}

/**
 * Automatic correction rounds are consumed only by Reviewer `changes_requested`
 * (`correction-required`). A human-directed `correct` decision reruns the gates
 * without spending an automatic round, so it never affects this budget.
 */
export function correctionRoundsUsed(history: VerifiedRunHistory): number {
  let used = 0;
  for (const event of history.events) {
    if (event.type === 'workflow-transition' && event.payload.route === 'correction-required') {
      used += 1;
    }
  }
  return used;
}

function testerObservationOutcome(control: RoleHostControl | null): string | null {
  if (control === null) {
    return null;
  }
  const decoded = decodeTesterTurnControl(control);
  return decoded.ok ? decoded.control.outcome : null;
}

function latestSettledTester(history: RunHistoryDerivedState): RoleHostSessionState | null {
  let latest: RoleHostSessionState | null = null;
  for (const session of history.roleSessions) {
    if (session.role !== 'tester') {
      continue;
    }
    if (session.lastObservation !== null && session.lastObservation.status === 'settled') {
      latest = session;
    }
  }
  return latest;
}

/**
 * Worker worktrees that this run durably provisioned, derived from the accepted
 * plan and the recorded worker events. Terminal cleanup disposes these
 * alongside the run worktree; a run that never ran parallel objectives reports
 * none.
 */
export function workerWorktreesFor(
  history: VerifiedRunHistory | null,
  runId: string,
): ReadonlyArray<WorkerWorktreeDisposal> {
  const ready = history?.derived.worktreeReady ?? null;
  const plan = history?.derived.acceptedPlan ?? null;
  if (ready === null || plan === null || plan.execution.mode !== 'parallel') {
    return [];
  }
  const recorded = new Set(
    (history?.derived.objectiveWorkers ?? []).map((worker) => worker.objectiveId),
  );
  return plan.execution.objectives
    .filter((objective) => recorded.has(objective.id))
    .map((objective) => ({
      name: objective.id,
      workspace: workerWorkspacePath(ready.workspace, objective.id, runId),
    }));
}

const CAPTURE_SHA256_REFERENCE = /sha256:([0-9a-f]{64})/u;

const CAPTURE_BYTES_REFERENCE = /bytes:(\d+)/u;

/**
 * Captures the settled Tester turn observed for the current result head. Foundry
 * already retains the content-bound evidence the Tester consumes: every
 * commit-bound verification log and tracked-mutation diff is content-addressed
 * by its `sha256`, while finding evidence references stay name-only unless they
 * carry a content hash. Entries keep history order, so identical content under
 * different labels is recorded twice and then counted as one observation
 * downstream by its shared hash.
 */
function observedCaptureEntries(
  derived: RunHistoryDerivedState,
  commit: string,
): ReadonlyArray<EvidenceManifestEntry> {
  const entries: Array<EvidenceManifestEntry> = [];
  const seen = new Set<string>();
  const add = (entry: EvidenceManifestEntry): void => {
    const key = `${entry.sha256 ?? ''}\u0000${entry.kind}\u0000${entry.label}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push(entry);
  };
  for (const report of derived.verifications) {
    if (report.commit !== commit) {
      continue;
    }
    for (const execution of report.executions) {
      add({
        sha256: execution.log.sha256,
        byteLength: execution.log.byteLength,
        label: `${execution.name} ${execution.log.path}`,
        kind: 'log',
        criterionIds: [],
      });
      if (execution.trackedMutation !== null) {
        add({
          sha256: execution.trackedMutation.diff.sha256,
          byteLength: execution.trackedMutation.diff.byteLength,
          label: `${execution.name} ${execution.trackedMutation.diff.path}`,
          kind: 'log',
          criterionIds: [],
        });
      }
    }
  }
  for (const finding of derived.findings) {
    if (finding.commit !== commit) {
      continue;
    }
    for (const evidence of finding.evidence) {
      const sha256 = CAPTURE_SHA256_REFERENCE.exec(evidence)?.[1] ?? null;
      const bytesMatch = CAPTURE_BYTES_REFERENCE.exec(evidence)?.[1];
      add({
        sha256,
        byteLength: bytesMatch === undefined ? null : Number.parseInt(bytesMatch, 10),
        label: evidence,
        kind: 'capture',
        criterionIds: [],
      });
    }
  }
  return entries;
}

const decodeRequestText = Effect.fn('advanceRun.decodeRequestText')(function* (
  store: RunIdentityStore['Service'],
  runDirectory: string,
  runId: string,
): Effect.fn.Return<string, RunIdentityStorageError> {
  const bytes = yield* store.readFileBytes(join(runDirectory, REQUEST_NORMALIZED_FILENAME));
  return yield* Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    catch: () =>
      new RunIdentityStorageError({
        message: `The retained operator request under ${runDirectory} is not valid UTF-8.`,
        runId,
      }),
  });
});

const writeAttachments = Effect.fn('advanceRun.writeAttachments')(function* (
  store: RunIdentityStore['Service'],
  runDirectory: string,
  role: WorkflowRole,
  attachments: ReadonlyArray<{ readonly name: string; readonly content: string }>,
): Effect.fn.Return<void, RunIdentityStorageError> {
  for (const attachment of attachments) {
    const path = join(runDirectory, 'packets', role, attachment.name);
    yield* store.ensureParentDirectory(dirname(path));
    yield* store.writeFileBytes(path, new TextEncoder().encode(attachment.content));
  }
});

export const advanceRun = Effect.fn('advanceRun')(function* (options: AdvanceRunOptions) {
  const runId = options.runId;
  const configuration = options.configuration;
  const runDirectory = options.runDirectory;

  const runtimeRef = yield* Ref.make<HeldApplicationRuntime | null>(null);
  const store = yield* RunIdentityStore;

  const disposeRuntime = Effect.fn('advanceRun.disposeRuntime')(function* () {
    const current = yield* Ref.get(runtimeRef);
    if (current === null) {
      return;
    }
    yield* Ref.set(runtimeRef, null);
    yield* current.dispose;
  });

  const promptFor = Effect.fn('advanceRun.promptFor')(function* (
    role: WorkflowRole,
    history: VerifiedRunHistory,
  ) {
    const request = yield* decodeRequestText(store, runDirectory, runId);
    const guidance = yield* bootstrapRoleGuidance({ runDirectory, runId, role });
    const packet = buildRolePacket({
      role,
      request,
      guidance: guidance.promptSection,
      history: history.derived,
      configuration,
    });
    if (!packet.ok) {
      return yield* new RunWorkflowError({
        message: `Cannot assemble the ${role} role packet: ${packet.problem}.`,
        runId,
        kind: 'blocked',
      });
    }
    yield* writeAttachments(store, runDirectory, role, packet.attachments);
    return packet.prompt;
  });

  const performRoleTurn = Effect.fn('advanceRun.performRoleTurn')(function* (
    role: WorkflowRole,
    attempt: number,
    prompt: string,
    runtimeBaseUrl: string | null,
    coderWorktree: string | null = null,
    stopAfterSettle = false,
  ) {
    const launcher = yield* RoleHostLauncher;
    const history = yield* readVerifiedRunHistory({
      runDirectory,
      runId,
      createIfMissing: false,
    });
    const existing = history.derived.roleSessions.find(
      (session) => session.role === role && session.attempt === attempt,
    );
    const generation = existing?.generation ?? attempt;
    const worktree = coderWorktree ?? history.derived.worktreeReady?.workspace ?? null;
    const locations: RoleTurnLocations = {
      projectRoot: configuration.targetRepository,
      runDirectory,
      scratchDirectory: join(runDirectory, 'scratch', role, String(attempt)),
      worktree: role === 'coder' ? worktree : null,
      runtimeBaseUrl: role === 'tester' ? runtimeBaseUrl : null,
    };
    const now = yield* DateTime.now;
    const deadline = DateTime.formatIso(
      DateTime.addDuration(Duration.millis(configuration.timeouts.roleMs))(now),
    );
    const launchOptions = launchOptionsForRole({
      configuration,
      role,
      cwd: configuration.targetRepository,
    });
    const hostLayer = launcher.launch(launchOptions);
    const governedTurn = {
      runDirectory,
      runId,
      role,
      attempt,
      generation,
      locations,
      environmentAllowlist: launchOptions.environmentAllowlist,
      prompt,
      deadline,
      pollMs: configuration.timeouts.pollMs,
      turnTimeoutMs: configuration.timeouts.roleMs,
      controlRepair: {
        maxRepairs: configuration.limits.maxControlRepairsPerAttempt,
        validate: roleControlValidator(role),
      },
    };
    return yield* Effect.gen(function* () {
      const settled = yield* startGovernedRoleTurn(governedTurn);
      if (stopAfterSettle) {
        yield* stopRoleSession({ runDirectory, runId, role, attempt, generation }).pipe(
          Effect.ignore,
        );
      }
      return settled;
    }).pipe(Effect.provide(hostLayer));
  });

  /**
   * A settled turn whose control envelope is still invalid has already spent
   * its bounded same-session control repair inside the conversation layer.
   * Foundry maps the remaining failure onto the ordinary role retry budget so a
   * repair is never repeated in a fresh session; when no retry remains the run
   * blocks instead of looping.
   */
  const recordControlRetry = Effect.fn('advanceRun.recordControlRetry')(function* (
    role: WorkflowRole,
    problem: string,
  ) {
    const history = yield* readVerifiedRunHistory({
      runDirectory,
      runId,
      createIfMissing: false,
    });
    const retries = retriesUsed(history.derived, role);
    if (retries >= configuration.retryBudgets[role]) {
      return yield* new RunWorkflowError({
        message: `The ${role} control envelope for run "${runId}" remained invalid after same-session repair and no ${role} retry remains: ${problem}`,
        runId,
        kind: 'blocked',
      });
    }
    yield* recordWorkflowAttempt({
      runDirectory,
      runId,
      attempt: {
        kind: 'retry',
        role,
        reason: `${role} control envelope remained invalid after same-session repair: ${problem}`,
        retriesRemaining: configuration.retryBudgets[role] - retries,
      },
    });
  });

  const runArchitect = Effect.fn('advanceRun.runArchitect')(function* (
    history: VerifiedRunHistory,
  ) {
    const resumeRouting = yield* resumeArchitectPlan({ runDirectory, runId });
    if (resumeRouting.outcome === 'admitted') {
      return;
    }
    const prompt = yield* promptFor('architect', history);
    const attempt = roleAttempt(history, 'architect');
    const settled = yield* performRoleTurn('architect', attempt, prompt, null);
    if (!settled.controlValid) {
      yield* recordControlRetry('architect', settled.controlProblem ?? 'invalid control envelope');
      return;
    }
    const admission = yield* admitArchitectPlan({
      runDirectory,
      runId,
      control: settled.control,
      controlRepairsRemaining: Math.max(
        0,
        configuration.limits.maxControlRepairsPerAttempt -
          repairsUsed(history.derived, 'architect', 'planning'),
      ),
      retriesRemaining: Math.max(
        0,
        configuration.retryBudgets.architect - retriesUsed(history.derived, 'architect'),
      ),
    });
    if (admission.outcome === 'blocked') {
      yield* transitionWorkflow({
        runDirectory,
        runId,
        request: {
          route: 'block-run',
          recoverablePrerequisite: true,
          reason: 'Architect reported that the request cannot be planned.',
        },
      });
    }
  });

  const performWorkerTurn = Effect.fn('advanceRun.performWorkerTurn')(function* (
    target: WorkerTurnTarget,
    basePrompt: string,
    objectives: ReadonlyArray<PlannedObjective>,
  ) {
    const objective = objectives.find((candidate) => candidate.id === target.objectiveId);
    const objectiveSection =
      objective === undefined
        ? ''
        : `\n\n## Assigned parallel objective\n\n${objective.id}: ${objective.title}\nAffected paths: ${objective.affectedPaths.join(', ')}\nAcceptance criteria: ${objective.criterionIds.join(', ')}\n`;
    const settled = yield* performRoleTurn(
      'coder',
      target.attempt,
      `${basePrompt}${objectiveSection}`,
      null,
      target.workspace,
      true,
    );
    const identity = {
      sessionId: settled.session.sessionId,
      attempt: target.attempt,
      generation: settled.session.generation,
    } as const;
    if (!settled.controlValid) {
      return {
        kind: 'control-invalid',
        ...identity,
        problem: settled.controlProblem ?? 'invalid control envelope',
      } as const;
    }
    const decoded = Schema.decodeUnknownResult(CoderTurnControlSchema)(settled.control);
    if (Result.isFailure(decoded)) {
      return { kind: 'control-invalid', ...identity, problem: decoded.failure.message } as const;
    }
    if (decoded.success.outcome === 'blocked') {
      return {
        kind: 'blocked',
        ...identity,
        problem: 'the objective Coder reported that the objective cannot be implemented',
      } as const;
    }
    return { kind: 'settled', ...identity } as const;
  });

  /**
   * Parallel plans run one Coder worker per accepted objective from the same
   * frozen source, each in its own branch, worktree, and session. Once every
   * objective has a verified commit, Foundry records the accepted set and
   * declared integration order, runs the Lead Coder turn, verifies the aggregate
   * against those contributions with Git, and accepts only the combined commit
   * for checks. A failing objective stops queued work and blocks without a
   * partial aggregate.
   */
  const runParallelObjectives = Effect.fn('advanceRun.runParallelObjectives')(function* (
    history: VerifiedRunHistory,
    objectives: ReadonlyArray<PlannedObjective>,
  ) {
    const ready = history.derived.worktreeReady;
    if (ready === null) {
      return yield* new RunWorkflowError({
        message: `Run "${runId}" cannot run parallel objectives without durable worktree readiness.`,
        runId,
        kind: 'blocked',
      });
    }
    const basePrompt = yield* promptFor('coder', history);
    const runnerLayer = Layer.effect(
      WorkerTurnRunner,
      Effect.sync(() =>
        WorkerTurnRunner.of({
          run: (target) =>
            performWorkerTurn(target, basePrompt, objectives).pipe(
              Effect.mapError(
                (error) =>
                  new ParallelWorkersTurnError({
                    message: error.message,
                    runId,
                    objectiveId: target.objectiveId,
                    reason: error._tag,
                  }),
              ),
            ),
        }),
      ),
    );
    const report = yield* runObjectiveWorkers({
      runDirectory,
      runId,
      repositoryRoot: configuration.targetRepository,
      taskBranch: ready.taskBranch,
      baseCommit: ready.baseCommit,
      workspace: ready.workspace,
      maxParallelCoders: configuration.limits.maxParallelCoders,
      coderRetryBudget: configuration.retryBudgets.coder,
      objectives,
    }).pipe(Effect.provide(runnerLayer));
    const failed = report.objectives.filter((outcome) => !outcome.settled);
    if (failed.length > 0) {
      const reason = `Parallel objective workers settled with incomplete objectives: ${failed
        .map(
          (outcome) =>
            `${outcome.objectiveId} (${outcome.attempts} attempt(s)${
              outcome.problem === null ? '' : `: ${outcome.problem}`
            })`,
        )
        .join(
          '; ',
        )}; the run stopped queued work, drained the active workers, and disposed the worker resources it owned.`;
      yield* transitionWorkflow({
        runDirectory,
        runId,
        request: {
          route: 'block-run',
          recoverablePrerequisite: true,
          reason: reason.slice(0, 500),
        },
      });
      return;
    }

    /**
     * Every objective has a verified commit. Fix the accepted objective/commit
     * set and the declared integration order before Lead Coder starts so worker
     * arrival order cannot silently redefine the plan.
     */
    const declaration = yield* recordIntegrationDeclaration({ runDirectory, runId, objectives });
    const afterWorkers = yield* readVerifiedRunHistory({
      runDirectory,
      runId,
      createIfMissing: false,
    });
    const maxCoderAttempt = afterWorkers.derived.roleSessions
      .filter((session) => session.role === 'coder')
      .reduce((highest, session) => Math.max(highest, session.attempt), 0);
    const integrationSection = declaration.declaredOrder
      .map(
        (objectiveId, index) =>
          `- ${objectiveId}: accepted commit ${declaration.commits[index] ?? 'unknown'}`,
      )
      .join('\n');
    const leadPrompt = `${yield* promptFor('coder', afterWorkers)}\n\n## Lead Coder integration\n\nIntegrate every accepted objective commit in the declared order, resolve overlap, complete any remaining plan work, and commit the single aggregate result. Do not check or review a partial combination.\n${integrationSection}\n`;
    const settled = yield* performRoleTurn('coder', maxCoderAttempt + 1, leadPrompt, null);
    if (!settled.controlValid) {
      yield* recordControlRetry('coder', settled.controlProblem ?? 'invalid control envelope');
      return;
    }

    /**
     * The aggregate is verified against the accepted contributions before it is
     * accepted, so a partial or drifted combination never enters checks. The
     * Lead Coder turn itself is not authority: only Git ancestry plus the
     * declared records decide inclusion and order.
     */
    const verification = yield* verifyAggregate({
      runId,
      workspace: ready.workspace,
      baseCommit: ready.baseCommit,
      declaration,
    });

    const handled = yield* handleCoderTurn({
      runDirectory,
      runId,
      control: settled.control,
    }).pipe(Effect.result);
    if (Result.isFailure(handled)) {
      if (handled.failure instanceof CoderTurnRejected) {
        yield* recordControlRetry('coder', handled.failure.problem);
        return;
      }
      return yield* handled.failure;
    }
    if (handled.success.outcome === 'blocked') {
      yield* transitionWorkflow({
        runDirectory,
        runId,
        request: {
          route: 'block-run',
          recoverablePrerequisite: true,
          reason: 'Lead Coder reported that the integrated objective plan cannot be implemented.',
        },
      });
      return;
    }

    yield* recordIntegrationCompleted({ runDirectory, runId, verification });
  });

  const runCoder = Effect.fn('advanceRun.runCoder')(function* (history: VerifiedRunHistory) {
    const plan = history.derived.acceptedPlan;
    if (
      plan !== null &&
      plan.execution.mode === 'parallel' &&
      plan.execution.objectives.length > 1
    ) {
      yield* runParallelObjectives(history, plan.execution.objectives);
      return;
    }
    const prompt = yield* promptFor('coder', history);
    const attempt = roleAttempt(history, 'coder');
    const settled = yield* performRoleTurn('coder', attempt, prompt, null);
    if (!settled.controlValid) {
      yield* recordControlRetry('coder', settled.controlProblem ?? 'invalid control envelope');
      return;
    }
    const handled = yield* handleCoderTurn({
      runDirectory,
      runId,
      control: settled.control,
    }).pipe(Effect.result);
    if (Result.isSuccess(handled)) {
      if (handled.success.outcome === 'blocked') {
        yield* transitionWorkflow({
          runDirectory,
          runId,
          request: {
            route: 'block-run',
            recoverablePrerequisite: true,
            reason: 'Coder reported that the accepted plan cannot be implemented.',
          },
        });
      }
      return;
    }
    if (handled.failure instanceof CoderTurnRejected) {
      yield* recordControlRetry('coder', handled.failure.problem);
      return;
    }
    return yield* handled.failure;
  });

  const runVerification = Effect.fn('advanceRun.runVerification')(function* (
    history: VerifiedRunHistory,
  ) {
    const plan = history.derived.acceptedPlan;
    const implementation = history.derived.implementation;
    const worktree = history.derived.worktreeReady?.workspace;
    if (plan === null || implementation === null || worktree === undefined) {
      return yield* new RunWorkflowError({
        message: `Run "${runId}" cannot verify without a durable plan, implementation, and worktree.`,
        runId,
        kind: 'blocked',
      });
    }
    const commit = implementation.commit ?? implementation.baseCommit;
    const report = yield* runProjectVerification({
      runDirectory,
      runId,
      repositoryPath: worktree,
      configDirectory: options.configDirectory,
      commit,
      configuration,
    });
    if (
      plan.runtimeValidationRequired &&
      report.result === 'passed' &&
      configuration.runtimeProfile !== null
    ) {
      const prepared = yield* prepareAndHoldApplicationRuntime({
        runDirectory,
        runId,
        repositoryPath: worktree,
        configDirectory: options.configDirectory,
        commit,
        configuration,
      });
      if (prepared.status === 'prepared') {
        yield* disposeRuntime();
        yield* Ref.set(runtimeRef, prepared.runtime);
      }
    }
    const route = yield* routeAfterProjectChecks({
      runDirectory,
      runId,
      correctionRoundsRemaining: Math.max(
        0,
        configuration.limits.maxCorrectionRounds - correctionRoundsUsed(history),
      ),
    });
    if (route.route === 'limitation') {
      yield* transitionWorkflow({
        runDirectory,
        runId,
        request: {
          route: 'tester-settled',
          observationsSettled: false,
          runtimeLimitationRetained: true,
        },
      });
    }
  });

  const runTesting = Effect.fn('advanceRun.runTesting')(function* (history: VerifiedRunHistory) {
    const implementation = history.derived.implementation;
    const commit =
      implementation === null ? null : (implementation.commit ?? implementation.baseCommit);
    if (implementation === null || commit === null) {
      return yield* new RunWorkflowError({
        message: `Run "${runId}" cannot test without a recorded result commit.`,
        runId,
        kind: 'blocked',
      });
    }
    const plan = history.derived.acceptedPlan;
    const worktree = history.derived.worktreeReady?.workspace;
    let held = yield* Ref.get(runtimeRef);
    if (
      held === null &&
      plan?.runtimeValidationRequired === true &&
      configuration.runtimeProfile !== null &&
      worktree !== undefined
    ) {
      const prepared = yield* prepareAndHoldApplicationRuntime({
        runDirectory,
        runId,
        repositoryPath: worktree,
        configDirectory: options.configDirectory,
        commit,
        configuration,
      });
      if (prepared.status === 'prepared') {
        yield* Ref.set(runtimeRef, prepared.runtime);
        held = prepared.runtime;
      }
    }
    if (held === null) {
      const reason = `The required live runtime for ${commit} is no longer prepared; the limitation is retained for Reviewer.`;
      yield* appendRunEvent({
        runDirectory,
        runId,
        createIfMissing: false,
        build: () =>
          Effect.succeed({ type: 'validation-limitation', payload: { reason, commit } } as const),
      });
      yield* transitionWorkflow({
        runDirectory,
        runId,
        request: {
          route: 'tester-settled',
          observationsSettled: false,
          runtimeLimitationRetained: true,
        },
      });
      return;
    }
    const prompt = yield* promptFor('tester', history);
    const attempt = roleAttempt(history, 'tester');
    const baseUrl = held.baseUrl;
    const settled = yield* performRoleTurn('tester', attempt, prompt, baseUrl);
    if (!settled.controlValid) {
      yield* recordControlRetry('tester', settled.controlProblem ?? 'invalid control envelope');
      return;
    }
    const outcome = testerObservationOutcome(settled.control);
    const retriesRemaining = Math.max(
      0,
      configuration.retryBudgets.tester - retriesUsed(history.derived, 'tester'),
    );
    if (outcome === 'observed' || outcome === 'blocked') {
      yield* disposeRuntime();
    }
    const captures = observedCaptureEntries(history.derived, commit);
    const disposition = yield* handleTesterTurn({
      runDirectory,
      runId,
      control: settled.control,
      commit,
      testerRetriesRemaining: retriesRemaining,
      retryReason: 'Tester requested another independent observation of the same commit.',
      captures,
    });
    if (disposition.kind === 'control-invalid') {
      yield* recordControlRetry('tester', disposition.problem);
    }
  });

  const runReviewing = Effect.fn('advanceRun.runReviewing')(function* (
    history: VerifiedRunHistory,
  ) {
    const plan = history.derived.acceptedPlan;
    const implementation = history.derived.implementation;
    const commit =
      implementation === null ? null : (implementation.commit ?? implementation.baseCommit);
    const verification =
      commit === null
        ? undefined
        : [...history.derived.verifications].reverse().find((report) => report.commit === commit);
    const testerSettled = latestSettledTester(history.derived);
    const observed =
      testerSettled !== null &&
      testerObservationOutcome(testerSettled.lastObservation?.control ?? null) === 'observed';
    const runtimeReady =
      commit !== null &&
      history.derived.runtimeLifecycles.some(
        (record) => record.commit === commit && record.outcome === 'ready',
      );
    const testerRequired = plan?.runtimeValidationRequired ?? false;
    const publicationReport = yield* describePublicationReadiness(
      configuration.decisionPublication,
      configuration.targetRepository,
    );
    const assessment = {
      reviewableCommit:
        implementation !== null && !implementation.noChangeCandidate ? implementation.commit : null,
      evidenceCommitMatches: commit !== null && verification !== undefined,
      checksPassed: verification?.result === 'passed',
      testerRequired,
      runtimeEvidencePresent: testerRequired ? observed && runtimeReady : true,
      noChangeCandidate: implementation?.noChangeCandidate ?? false,
      correctionRoundsRemaining: Math.max(
        0,
        configuration.limits.maxCorrectionRounds - correctionRoundsUsed(history),
      ),
      testerRetriesRemaining: Math.max(
        0,
        configuration.retryBudgets.tester - retriesUsed(history.derived, 'tester'),
      ),
      publicationEligible: publicationReport.eligible,
    };
    const prompt = yield* promptFor('reviewer', history);
    const attempt = roleAttempt(history, 'reviewer');
    const settled = yield* performRoleTurn('reviewer', attempt, prompt, null);
    if (!settled.controlValid) {
      yield* recordControlRetry('reviewer', settled.controlProblem ?? 'invalid control envelope');
      return;
    }
    const disposition = yield* handleReviewerTurn({
      runDirectory,
      runId,
      control: settled.control,
      assessment,
      narrative: settled.narrative,
      correctionReason: 'Reviewer requested a bounded correction.',
      blockedReason: 'Reviewer reported an operational or integrity problem.',
    });
    if (disposition.kind === 'control-invalid') {
      yield* recordControlRetry('reviewer', disposition.problem);
    }
  });

  /**
   * Executes the publication transaction for a recorded human decision. The
   * composition root always provides the GitHub adapter; `configuration`
   * `decisionPublication === null` remains the real gate, and the application
   * function owns every checkpoint, push, and PR transition.
   */
  const runPublishing = Effect.fn('advanceRun.runPublishing')(function* () {
    yield* publishDecisionDraftPr({ runDirectory, runId, configuration });
  });

  /**
   * Resumes a run waiting for an authenticated human decision. Only a resume
   * scans the owned decision pull request; an integrity problem or a still
   * waiting decision returns a typed report without changing durable state.
   * `correct` is routed to `correcting` so the body loop reruns every later
   * gate; `accept` and `abandon` settle the run.
   */
  const runDecisionResume = Effect.fn('advanceRun.runDecisionResume')(function* () {
    const scan = yield* scanForDecision({ runDirectory, runId, configuration }).pipe(Effect.result);
    if (Result.isFailure(scan)) {
      return {
        applied: null,
        waiting: false,
        draftPrUrl: null,
        problem: errorMessage(scan.failure),
      } satisfies RunWorkflowDecisionReport;
    }
    const outcome = scan.success;
    if (outcome.kind === 'waiting') {
      return {
        applied: null,
        waiting: true,
        draftPrUrl: outcome.draftPrUrl,
        problem: null,
      } satisfies RunWorkflowDecisionReport;
    }
    if (outcome.kind !== 'applied') {
      return {
        applied: null,
        waiting: false,
        draftPrUrl: outcome.draftPrUrl,
        problem: outcome.problem,
      } satisfies RunWorkflowDecisionReport;
    }
    const applied = yield* applyDecision(
      { runDirectory, runId },
      { decisionId: outcome.decisionId, option: outcome.option, evidence: outcome.evidence },
    ).pipe(Effect.result);
    if (Result.isFailure(applied)) {
      return {
        applied: null,
        waiting: false,
        draftPrUrl: outcome.draftPrUrl,
        problem: errorMessage(applied.failure),
      } satisfies RunWorkflowDecisionReport;
    }
    return {
      applied: outcome.option.action,
      waiting: false,
      draftPrUrl: outcome.draftPrUrl,
      problem: null,
    } satisfies RunWorkflowDecisionReport;
  });

  const runStage = Effect.fn('advanceRun.runStage')(function* (
    state: WorkflowState,
    history: VerifiedRunHistory,
  ) {
    switch (state) {
      case 'planning':
        yield* runArchitect(history);
        return;
      case 'coding':
      case 'correcting':
        yield* runCoder(history);
        return;
      case 'verifying':
        yield* runVerification(history);
        return;
      case 'testing':
        yield* runTesting(history);
        return;
      case 'reviewing':
        yield* runReviewing(history);
        return;
      case 'publishing':
        yield* runPublishing();
        return;
      default:
        return;
    }
  });

  /**
   * Observes the repository lease for the target repository. The lease store is
   * optional, so a caller without it reports an unobserved lock rather than
   * guessing; a live or indeterminate lease blocks recovery.
   */
  const observeRecoveryLease = Effect.fn('advanceRun.observeRecoveryLease')(function* () {
    const store = yield* Effect.serviceOption(RepositoryLeaseStore);
    const identity = yield* Effect.serviceOption(RepositoryHostIdentity);
    if (Option.isNone(store) || Option.isNone(identity)) {
      return 'unobserved' as const;
    }
    const leasePath = join(
      configuration.targetRepository,
      RUN_STORAGE_DIRECTORY_NAME,
      REPOSITORY_LEASE_FILENAME,
    );
    const state = yield* store.value.statPath(leasePath).pipe(Effect.result);
    if (Result.isFailure(state)) {
      return 'indeterminate' as const;
    }
    const fileState = state.success;
    if (fileState.kind === 'missing') {
      return 'none' as const;
    }
    if (fileState.kind === 'not-regular-file') {
      return 'indeterminate' as const;
    }
    const text = yield* Effect.try({
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(fileState.bytes),
      catch: () => 'not-utf8' as const,
    }).pipe(Effect.result);
    if (Result.isFailure(text)) {
      return 'indeterminate' as const;
    }
    const decoded = Schema.decodeUnknownResult(RepositoryLeaseJson)(text.success);
    if (Result.isFailure(decoded)) {
      return 'indeterminate' as const;
    }
    const record = decoded.success;
    const now = yield* DateTime.now;
    if (!repositoryLeaseExpired(record, now)) {
      return 'live' as const;
    }
    const hostIdentity = yield* identity.value.hostIdentity;
    const processObservation = yield* identity.value.probeProcess(record.processId);
    return classifyRepositoryLeaseOwner(record, hostIdentity, processObservation) === 'dead'
      ? ('expired-dead' as const)
      : ('indeterminate' as const);
  });

  const observeRecoveryFacts = Effect.fn('advanceRun.observeRecoveryFacts')(function* (
    history: VerifiedRunHistory,
    failureReason: RoleConversationFailureReason | null,
  ): Effect.fn.Return<RecoveryFacts, never, RunGit> {
    const ready = history.derived.worktreeReady;
    let worktree: WorktreeObservation | null = null;
    let implementation: ImplementationObservation | null = null;
    let observationProblem: string | null = null;
    if (ready !== null) {
      const git = yield* RunGit;
      const observedWorktree = yield* git
        .readWorktree({
          repositoryRoot: configuration.targetRepository,
          workspace: ready.workspace,
          runId,
        })
        .pipe(Effect.result);
      if (Result.isFailure(observedWorktree)) {
        observationProblem = observedWorktree.failure.message;
      } else {
        worktree = observedWorktree.success;
        const observedImplementation = yield* git
          .observeImplementation({
            workspace: ready.workspace,
            taskBranch: ready.taskBranch,
            baseCommit: ready.baseCommit,
            runId,
          })
          .pipe(Effect.result);
        if (Result.isFailure(observedImplementation)) {
          observationProblem = observedImplementation.failure.message;
        } else {
          implementation = observedImplementation.success;
        }
      }
    }
    const lease = yield* observeRecoveryLease();
    return {
      journalIntact: true,
      lease,
      worktree,
      implementation,
      observationProblem,
      failureReason,
    };
  });

  const recordRecoveryDisposition = Effect.fn('advanceRun.recordRecoveryDisposition')(function* (
    classification: RecoveryClassification,
  ) {
    yield* appendRunEvent({
      runDirectory,
      runId,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'recovery-recorded',
          payload: {
            disposition: classification.disposition,
            reason: classification.reason,
          },
        } as const),
    });
  });

  const recoveryReportOf = (
    classification: RecoveryClassification,
    problem: string | null,
  ): RunWorkflowRecoveryReport => ({
    disposition: classification.disposition,
    reason: classification.reason,
    problem,
  });

  const blockOnFailure = Effect.fn('advanceRun.blockOnFailure')(function* (
    message: string,
    failureReason: RoleConversationFailureReason | null = null,
  ) {
    const result = yield* readVerifiedRunHistory({
      runDirectory,
      runId,
      createIfMissing: false,
    }).pipe(Effect.result);
    if (Result.isFailure(result)) {
      return yield* new RunWorkflowError({ message, runId, kind: 'failed' });
    }
    const history = result.success;
    const state = history.derived.state;
    if (state !== null && isActiveWorkflowState(state)) {
      const classification = classifyRoleFailure(failureReason);
      yield* recordRecoveryDisposition(classification);
      const blocked = yield* transitionWorkflow({
        runDirectory,
        runId,
        request: {
          route: 'block-run',
          recoverablePrerequisite: true,
          reason: message.slice(0, 500),
        },
      }).pipe(Effect.result);
      if (Result.isFailure(blocked)) {
        return summaryOf(history);
      }
      const after = yield* readVerifiedRunHistory({
        runDirectory,
        runId,
        createIfMissing: false,
      });
      return {
        ...summaryOf(after),
        recovery: recoveryReportOf(
          classification,
          classification.disposition === 'human_recovery' ? classification.reason : null,
        ),
      };
    }
    return summaryOf(history);
  });

  const body = Effect.gen(function* () {
    let steps = 0;
    let resumed = false;
    while (steps < MAX_RUN_STEPS) {
      steps += 1;
      const history = yield* readVerifiedRunHistory({
        runDirectory,
        runId,
        createIfMissing: false,
      });
      const state = history.derived.state;
      if (state === null) {
        return summaryOf(history);
      }
      if (state === 'blocked') {
        const checkpoint = history.derived.checkpoint;
        if (
          options.allowResume &&
          !resumed &&
          checkpoint !== null &&
          isActiveWorkflowState(checkpoint)
        ) {
          /**
           * The recorded checkpoint is not a blind prerequisite. Foundry
           * reconciles the checkpoint against durable Git, lock, journal, and
           * owned-session evidence before it resumes: a settled fact is
           * accepted, an owned in-progress operation keeps waiting, a proven
           * side-effect-free attempt retries, and ambiguous evidence stops for a
           * person instead of guessing.
           */
          const facts = yield* observeRecoveryFacts(history, null);
          const classification = classifyRecovery(history.derived, facts);
          yield* recordRecoveryDisposition(classification);
          if (
            classification.disposition === 'accept' ||
            classification.disposition === 'retry' ||
            classification.disposition === 'continue_waiting'
          ) {
            yield* transitionWorkflow({
              runDirectory,
              runId,
              request: { route: 'resume', prerequisiteValid: true },
            });
            resumed = true;
            continue;
          }
          const after = yield* readVerifiedRunHistory({
            runDirectory,
            runId,
            createIfMissing: false,
          });
          return {
            ...summaryOf(after),
            recovery: recoveryReportOf(
              classification,
              classification.disposition === 'human_recovery' ? classification.reason : null,
            ),
          };
        }
        return summaryOf(history);
      }
      if (state === 'human_decision_required') {
        if (!options.allowResume) {
          return summaryOf(history);
        }
        const decision = yield* runDecisionResume();
        if (decision.problem !== null || decision.applied === null) {
          return { ...summaryOf(history), decision };
        }
        if (decision.applied === 'correct') {
          continue;
        }
        const after = yield* readVerifiedRunHistory({
          runDirectory,
          runId,
          createIfMissing: false,
        });
        return { ...summaryOf(after), decision };
      }
      if (state === 'publish_failed') {
        /**
         * An interrupted decision publication is recovered in the same run. The
         * reconciliation owns the resume transition and re-enters
         * `human_decision_required` only after the journal and GitHub agree on
         * the exact draft URL; every other outcome leaves the run durable in
         * `publish_failed` for a later resume.
         */
        if (!options.allowResume || resumed) {
          return summaryOf(history);
        }
        const reconciliation = yield* reconcilePublication({
          runDirectory,
          runId,
          configuration,
        }).pipe(Effect.result);
        if (Result.isSuccess(reconciliation) && reconciliation.success.outcome === 'reconciled') {
          resumed = true;
          continue;
        }
        const after = yield* readVerifiedRunHistory({
          runDirectory,
          runId,
          createIfMissing: false,
        });
        return summaryOf(after);
      }
      if (state === 'completed') {
        /**
         * A completed run whose result publication is uncertain resumes the
         * same run: the recorded result-publication journal is reconciled in
         * place by the same idempotent publication, never a second run or a
         * duplicate result pull request. A settled run returns its summary.
         */
        const resultSettled =
          (history.derived.resultPrRecorded ?? null) !== null ||
          (history.derived.resultMergeRecorded ?? null) !== null;
        const unsettled =
          configuration.decisionPublication !== null &&
          !resultSettled &&
          (history.derived.resultPrCheckpoints ?? []).length > 0;
        if (options.allowResume && !resumed && unsettled) {
          const reconciled = yield* publishResultPr({
            runDirectory,
            runId,
            configuration,
          }).pipe(Effect.result);
          const after = yield* readVerifiedRunHistory({
            runDirectory,
            runId,
            createIfMissing: false,
          });
          const resultPublication: ResultPublicationReport = Result.isSuccess(reconciled)
            ? reconciled.success
            : { outcome: 'uncertain', problem: errorMessage(reconciled.failure) };
          resumed = true;
          return { ...summaryOf(after), resultPublication };
        }
        return summaryOf(history);
      }
      if (!isActiveWorkflowState(state) && state !== 'publishing') {
        return summaryOf(history);
      }
      const step = yield* runStage(state, history).pipe(Effect.result);
      if (Result.isFailure(step)) {
        return yield* blockOnFailure(
          errorMessage(step.failure),
          step.failure instanceof RoleConversationError ? step.failure.reason : null,
        );
      }
    }
    return yield* blockOnFailure(
      `Run "${runId}" did not settle within ${MAX_RUN_STEPS} workflow steps.`,
    );
  });

  const disposeOwnedResources = Effect.fn('advanceRun.disposeOwnedResources')(function* (
    summary: RunWorkflowOutcome,
  ) {
    if (!isTerminalWorkflowState(summary.workflowState)) {
      return;
    }
    const runtime = yield* Ref.get(runtimeRef);
    const history = yield* readVerifiedRunHistory({
      runDirectory,
      runId,
      createIfMissing: false,
    }).pipe(Effect.orElseSucceed(() => null));
    const disposal = yield* disposeRunResources({
      runDirectory,
      runId,
      configuration,
      runtime,
      workerWorktrees: workerWorktreesFor(history, runId),
    });
    if (disposal === null) {
      return;
    }
    yield* Ref.set(runtimeRef, null);
    yield* recordCleanupProgress({
      runDirectory,
      runId,
      outcome: disposal.outcome,
      detail: describeRunCleanupReport(disposal.resources),
    }).pipe(Effect.ignore);
  });

  /**
   * Publishes the ordinary result pull request for an approved changed result
   * once the run has settled. The composition root always provides the GitHub
   * adapter, and publication is idempotent, so an uncertain transaction never
   * fails an otherwise-complete run: the run reports the outcome and a later
   * `resume` reconciles in place.
   */
  const publishApprovedResult = Effect.fn('advanceRun.publishApprovedResult')(function* (
    summary: RunWorkflowOutcome,
  ) {
    if (summary.workflowState !== 'completed') {
      return null;
    }
    const published = yield* publishResultPr({ runDirectory, runId, configuration }).pipe(
      Effect.result,
    );
    if (Result.isFailure(published)) {
      return {
        outcome: 'uncertain',
        problem: errorMessage(published.failure),
      } satisfies ResultPublicationReport;
    }
    return published.success;
  });

  const finalize = Effect.gen(function* () {
    const completed = yield* body.pipe(Effect.result);
    const summary = Result.isSuccess(completed)
      ? completed.success
      : yield* blockOnFailure(errorMessage(completed.failure));

    yield* disposeOwnedResources(summary);

    /**
     * After the owned resources are released, an approved changed result is
     * published from the owning repository (the task branch survives cleanup).
     * Publication runs before the handoff so the canonical report sees the
     * settled result pull request.
     */
    const resultPublication = yield* publishApprovedResult(summary);
    const settled: RunWorkflowOutcome = { ...summary, resultPublication };

    /**
     * A completed or no-change run owns exactly one canonical handoff. The write
     * is idempotent: it reconciles from verified history, so an already-settled
     * run (including `resume`) rewrites identical bytes or repairs a missing
     * report. A run that is not terminally successful has no handoff and this is
     * a no-op.
     */
    yield* reconcileHandoff({ runDirectory, runId });
    return settled;
  });

  return yield* finalize.pipe(Effect.ensuring(disposeRuntime().pipe(Effect.ignore)));
});
