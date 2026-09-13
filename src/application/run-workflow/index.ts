import { DateTime, Duration, Effect, Option, Ref, Result, Schema } from 'effect';
import { dirname, join } from 'node:path';

import { decodeReviewerTurnControl } from '../../domain/reviewer-outcomes.js';
import { REQUEST_NORMALIZED_FILENAME } from '../../domain/run-identity.js';
import { describeRunCleanupReport } from '../../domain/run-cleanup.js';
import { decodeTesterTurnControl } from '../../domain/tester-outcomes.js';
import { isActiveWorkflowState, isTerminalWorkflowState } from '../../domain/workflow.js';
import {
  admitArchitectPlan,
  resumeArchitectPlan,
  validateArchitectPlanControl,
} from '../architect-plan/index.js';
import {
  CoderTurnRejected,
  handleCoderTurn,
  validateCoderTurnControl,
} from '../coder-result/index.js';
import { GitHubPublication, publishDecisionDraftPr } from '../decision-publication/index.js';
import { bootstrapRoleGuidance } from '../guidance/index.js';
import { reconcileHandoff } from '../handoff/index.js';
import { prepareAndHoldApplicationRuntime } from '../project-runtime/index.js';
import { runProjectVerification } from '../project-verification/index.js';
import { buildRolePacket } from '../role-packets/index.js';
import { startGovernedRoleTurn } from '../role-permissions/index.js';
import { handleReviewerTurn } from '../reviewer-outcomes/index.js';
import { RoleHostLauncher } from '../role-conversations/index.js';
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
import type { RoleHostControl, RoleHostSessionState } from '../../domain/role-host.js';
import type { RoleTurnLocations } from '../../domain/role-permissions.js';
import type { RunHistoryDerivedState } from '../../domain/run-history.js';
import type { WorkflowRole, WorkflowState } from '../../domain/workflow.js';
import type { HeldApplicationRuntime } from '../project-runtime/index.js';
import type { VerifiedRunHistory } from '../run-history/index.js';

export const MAX_RUN_STEPS = 128;

export class RunWorkflowError extends Schema.TaggedError<RunWorkflowError>()('RunWorkflowError', {
  message: Schema.String,
  runId: Schema.String,
  kind: Schema.Literals(['blocked', 'failed']),
}) {}

export interface AdvanceRunOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly configDirectory: string;
  readonly configuration: ProjectConfiguration;
  readonly allowResume: boolean;
}

export interface RunWorkflowOutcome {
  readonly workflowState: WorkflowState;
  readonly stages: ReadonlyArray<WorkflowState>;
  readonly testerSkipped: boolean;
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
  };
}

function countSessions(history: RunHistoryDerivedState, role: WorkflowRole): number {
  return history.roleSessions.filter((session) => session.role === role).length;
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

function correctionRoundsUsed(history: VerifiedRunHistory): number {
  let used = 0;
  for (const event of history.events) {
    if (
      event.type === 'workflow-transition' &&
      (event.payload.route === 'correction-required' || event.payload.route === 'human-corrected')
    ) {
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
    const worktree = history.derived.worktreeReady?.workspace ?? null;
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
    const hostLayer = launcher.launch({
      command: configuration.roleHarness.command,
      cwd: configuration.targetRepository,
      environmentAllowlist: configuration.roleHarness.environmentAllowlist,
      timeoutMs: configuration.timeouts.commandMs,
      maxOutputBytes: configuration.artifacts.maxRoleHandoffBytes,
    });
    const governedTurn = {
      runDirectory,
      runId,
      role,
      attempt,
      generation,
      locations,
      environmentAllowlist: configuration.roleHarness.environmentAllowlist,
      prompt,
      deadline,
      pollMs: configuration.timeouts.pollMs,
      turnTimeoutMs: configuration.timeouts.roleMs,
      controlRepair: {
        maxRepairs: configuration.limits.maxControlRepairsPerAttempt,
        validate: roleControlValidator(role),
      },
    };
    return yield* startGovernedRoleTurn(governedTurn).pipe(Effect.provide(hostLayer));
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
    const attempt = countSessions(history.derived, 'architect') + 1;
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

  const runCoder = Effect.fn('advanceRun.runCoder')(function* (history: VerifiedRunHistory) {
    const prompt = yield* promptFor('coder', history);
    const attempt = countSessions(history.derived, 'coder') + 1;
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
    if (plan.runtimeValidationRequired && report.result === 'passed') {
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
    const attempt = countSessions(history.derived, 'tester') + 1;
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
    const disposition = yield* handleTesterTurn({
      runDirectory,
      runId,
      control: settled.control,
      commit,
      testerRetriesRemaining: retriesRemaining,
      retryReason: 'Tester requested another independent observation of the same commit.',
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
    const attempt = countSessions(history.derived, 'reviewer') + 1;
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
   * GitHub adapter is optional in the environment so a run without a wired
   * adapter fails publication durably instead of silently guessing; the
   * application function owns every checkpoint, push, and PR transition.
   */
  const runPublishing = Effect.fn('advanceRun.runPublishing')(function* () {
    const github = yield* Effect.serviceOption(GitHubPublication);
    if (Option.isNone(github)) {
      yield* transitionWorkflow({
        runDirectory,
        runId,
        request: { route: 'publication-unresolved', cannotReconcileSafely: true },
      });
      return;
    }
    yield* publishDecisionDraftPr({ runDirectory, runId, configuration }).pipe(
      Effect.provideService(GitHubPublication, github.value),
    );
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

  const blockOnFailure = Effect.fn('advanceRun.blockOnFailure')(function* (message: string) {
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
      return summaryOf(after);
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
          yield* transitionWorkflow({
            runDirectory,
            runId,
            request: { route: 'resume', prerequisiteValid: true },
          });
          resumed = true;
          continue;
        }
        return summaryOf(history);
      }
      if (!isActiveWorkflowState(state)) {
        return summaryOf(history);
      }
      const step = yield* runStage(state, history).pipe(Effect.result);
      if (Result.isFailure(step)) {
        return yield* blockOnFailure(errorMessage(step.failure));
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
    const disposal = yield* disposeRunResources({
      runDirectory,
      runId,
      configuration,
      runtime,
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

  const finalize = Effect.gen(function* () {
    const completed = yield* body.pipe(Effect.result);
    const summary = Result.isSuccess(completed)
      ? completed.success
      : yield* blockOnFailure(errorMessage(completed.failure));

    yield* disposeOwnedResources(summary);

    /**
     * A completed or no-change run owns exactly one canonical handoff. The write
     * is idempotent: it reconciles from verified history, so an already-settled
     * run (including `resume`) rewrites identical bytes or repairs a missing
     * report. A run that is not terminally successful has no handoff and this is
     * a no-op.
     */
    yield* reconcileHandoff({ runDirectory, runId });
    return summary;
  });

  return yield* finalize.pipe(Effect.ensuring(disposeRuntime().pipe(Effect.ignore)));
});
