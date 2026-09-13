import { createHash } from 'node:crypto';

/**
 * Parallel objective workers are run-owned resources whose names are derived,
 * never agent-selected. The run hash ties a worker branch and worktree to the
 * one run that may own it, so a colliding branch can be classified without
 * trusting a worker's report.
 */
export const WORKER_RUN_HASH_LENGTH = 12;

export const WORKER_NAME_INFIX = '--worker-';

/**
 * The first 12 lowercase hexadecimal characters of SHA-256 over the run ID.
 */
export function workerRunHash(runId: string): string {
  return createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, WORKER_RUN_HASH_LENGTH);
}

export function workerBranchName(taskBranch: string, objectiveId: string, runId: string): string {
  return `${taskBranch}${WORKER_NAME_INFIX}${objectiveId}-${workerRunHash(runId)}`;
}

export function workerWorkspacePath(workspace: string, objectiveId: string, runId: string): string {
  return `${workspace}${WORKER_NAME_INFIX}${objectiveId}-${workerRunHash(runId)}`;
}

/**
 * Reserves a disjoint block of Coder attempt numbers per objective so that
 * concurrently created worker sessions never collide on `(role, attempt)` and a
 * resumed run reproduces the same attempt for the same objective.
 */
export function workerAttemptNumber(
  objectiveIndex: number,
  localAttempt: number,
  maxAttempts: number,
): number {
  return 1 + objectiveIndex * maxAttempts + (localAttempt - 1);
}

export interface WorkerBranchFacts {
  readonly branchExists: boolean;
  readonly branchHead: string | null;
  readonly ownedByThisRun: boolean;
  readonly recordedHead: string | null;
  readonly settled: boolean;
}

export type WorkerBranchDecision =
  | { readonly kind: 'create' }
  | { readonly kind: 'reuse' }
  | { readonly kind: 'blocked'; readonly problem: string };

/**
 * Classifies a worker branch against this run's durable record using the same
 * rule as the top-level task branch: a branch may be reused only when this run
 * durably owns it and Git agrees with the recorded head. Anything else blocks
 * without moving or deleting the branch.
 */
export function decideWorkerBranch(facts: WorkerBranchFacts): WorkerBranchDecision {
  if (!facts.branchExists) {
    if (!facts.ownedByThisRun) {
      return { kind: 'create' };
    }
    if (facts.settled && facts.recordedHead !== null) {
      return {
        kind: 'blocked',
        problem: `the settled worker branch has disappeared from Git while this run still records a commit for it`,
      };
    }
    return { kind: 'create' };
  }
  if (!facts.ownedByThisRun || facts.recordedHead === null) {
    return {
      kind: 'blocked',
      problem: `a worker branch already exists without this run's durable ownership record; the branch was left untouched`,
    };
  }
  if (facts.branchHead !== facts.recordedHead) {
    return {
      kind: 'blocked',
      problem: `the worker branch head ${facts.branchHead ?? 'unknown'} differs from this run's recorded head ${facts.recordedHead}; the branch was left untouched`,
    };
  }
  return { kind: 'reuse' };
}
