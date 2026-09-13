import { Effect, Schema } from 'effect';

import {
  compileExecutionPlan,
  decodeArchitectPlanControl,
  labelAcceptanceCriteria,
  planRequiresImplementation,
  planRuntimeValidationRequired,
} from '../../domain/architect-plan.js';
import { appendRunEvent } from '../run-history/index.js';
import { recordWorkflowAttempt } from '../workflow-transitions/index.js';

import type { AcceptanceCriterion, CompiledExecutionPlan } from '../../domain/architect-plan.js';
import type { PlanAcceptedPayload } from '../../domain/run-history.js';

import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';
import type { IllegalWorkflowAttempt } from '../workflow-transitions/index.js';
import type { RunStateUnavailable } from '../run-identity/index.js';

export class ArchitectPlanRejected extends Schema.TaggedError<ArchitectPlanRejected>()(
  'ArchitectPlanRejected',
  {
    message: Schema.String,
    runId: Schema.String,
    problem: Schema.String,
  },
) {}

export interface AcceptedArchitectPlan {
  readonly outcome: 'plan_ready' | 'no_change_candidate';
  readonly criteria: ReadonlyArray<AcceptanceCriterion>;
  readonly runtimeValidationRequired: boolean;
  readonly requiresImplementation: boolean;
  readonly execution: CompiledExecutionPlan;
}

export type ArchitectPlanAcceptance =
  | {
      readonly outcome: 'accepted';
      readonly plan: AcceptedArchitectPlan;
      readonly planEvent: PlanAcceptedPayload;
    }
  | { readonly outcome: 'blocked' }
  | { readonly outcome: 'repair-required'; readonly problem: string }
  | { readonly outcome: 'retry-required'; readonly problem: string };

export interface AcceptArchitectPlanOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly control: Schema.Json;
  readonly controlRepairsRemaining: number;
  readonly retriesRemaining: number;
  readonly repairReason: string;
  readonly retryReason: string;
}

function planAcceptedPayload(plan: AcceptedArchitectPlan): PlanAcceptedPayload {
  return {
    outcome: plan.outcome,
    criteria: plan.criteria.map((criterion) => ({ id: criterion.id, text: criterion.text })),
    runtimeValidationRequired: plan.runtimeValidationRequired,
    execution: {
      mode: plan.execution.mode,
      objectives: plan.execution.objectives.map((objective) => ({
        id: objective.id,
        title: objective.title,
        affectedPaths: [...objective.affectedPaths],
        criterionIds: [...objective.criterionIds],
      })),
    },
  };
}

/**
 * Validates the Architect's control envelope and, when a plan or no-change
 * candidate is accepted, compiles it into a durable execution plan. A missing
 * or invalid envelope consumes at most one same-session repair before the
 * ordinary retry budget. The Markdown narrative remains evidence in the
 * recorded role session; readiness is never inferred from prose or file
 * presence.
 */
export const acceptArchitectPlan = Effect.fn('acceptArchitectPlan')(function* (
  options: AcceptArchitectPlanOptions,
): Effect.fn.Return<
  ArchitectPlanAcceptance,
  ArchitectPlanRejected | IllegalWorkflowAttempt | RunStateUnavailable | RunHistoryError,
  RunHistoryStorage
> {
  const runId = options.runId;
  const decoded = decodeArchitectPlanControl(options.control);
  if (!decoded.ok) {
    const reason = `${options.repairReason} The Architect control envelope is missing or invalid: ${decoded.problem}`;
    if (options.controlRepairsRemaining >= 1) {
      yield* recordWorkflowAttempt({
        runDirectory: options.runDirectory,
        runId,
        attempt: {
          kind: 'repair',
          role: 'architect',
          reason,
          repairsRemaining: options.controlRepairsRemaining,
        },
      });
      return { outcome: 'repair-required', problem: decoded.problem };
    }
    if (options.retriesRemaining >= 1) {
      yield* recordWorkflowAttempt({
        runDirectory: options.runDirectory,
        runId,
        attempt: {
          kind: 'retry',
          role: 'architect',
          reason: `${options.retryReason} The Architect control envelope remained invalid: ${decoded.problem}`,
          retriesRemaining: options.retriesRemaining,
        },
      });
      return { outcome: 'retry-required', problem: decoded.problem };
    }
    return yield* new ArchitectPlanRejected({
      message: `The Architect control envelope for run "${runId}" is invalid and no repair or retry remains: ${decoded.problem}`,
      runId,
      problem: decoded.problem,
    });
  }

  const control = decoded.control;
  if (control.outcome === 'blocked') {
    return { outcome: 'blocked' };
  }

  const plan: AcceptedArchitectPlan = {
    outcome: control.outcome,
    criteria: labelAcceptanceCriteria(control.acceptanceCriteria),
    runtimeValidationRequired: planRuntimeValidationRequired(control),
    requiresImplementation: planRequiresImplementation(control),
    execution: compileExecutionPlan(control),
  };
  const planEvent = planAcceptedPayload(plan);

  yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId,
    createIfMissing: false,
    build: (history) =>
      Effect.gen(function* () {
        if (history.derived.state !== 'planning') {
          return yield* new ArchitectPlanRejected({
            message: `Cannot accept an Architect plan for run "${runId}" outside the planning stage; the recorded state is "${history.derived.state ?? 'none'}".`,
            runId,
            problem: 'accepted plan outside the planning stage',
          });
        }
        if (history.derived.acceptedPlan !== null) {
          return yield* new ArchitectPlanRejected({
            message: `Run "${runId}" already has an accepted plan.`,
            runId,
            problem: 'a second accepted plan',
          });
        }
        return { type: 'plan-accepted', payload: planEvent } as const;
      }),
  });

  return { outcome: 'accepted', plan, planEvent };
});
