import { isActiveWorkflowState, isTerminalWorkflowState } from '../../domain/workflow.js';

import type { RoleHostSessionState } from '../../domain/role-host.js';
import type { RunHistoryDerivedState } from '../../domain/run-history.js';
import type { RecoveryDisposition } from '../../domain/run-history.js';
import type { WorkflowRole, WorkflowState } from '../../domain/workflow.js';
import type { RoleConversationFailureReason } from '../role-conversations/index.js';
import type { ImplementationObservation, WorktreeObservation } from '../git-provisioning/index.js';

export type { RecoveryDisposition };

/**
 * One disposition chosen from durable evidence before a resumable run advances.
 * The disposition never performs the action itself; the caller owns the
 * transition and this record only explains why the choice was made.
 */
export interface RecoveryClassification {
  readonly disposition: RecoveryDisposition;
  readonly reason: string;
}

/**
 * The observed repository lease for the target repository. `none` means no lease
 * record exists, `expired-dead` means the recorded owner is provably gone,
 * `live` means another process still holds it, `indeterminate` means ownership
 * cannot be verified, and `unobserved` means the lease store is unavailable.
 */
export type RecoveryLeaseObservation =
  | 'none'
  | 'expired-dead'
  | 'live'
  | 'indeterminate'
  | 'unobserved';

/**
 * Durable and observed facts gathered around a resumable run. Every observation
 * is nullable so the classifier can treat a missing or unverifiable fact as
 * ambiguity instead of guessing. `journalIntact` is false when the canonical
 * history could not be verified, and `failureReason` carries a role-conversation
 * failure tag when a stage failed before it could block.
 */
export interface RecoveryFacts {
  readonly journalIntact: boolean;
  readonly lease: RecoveryLeaseObservation;
  readonly worktree: WorktreeObservation | null;
  readonly implementation: ImplementationObservation | null;
  readonly observationProblem: string | null;
  readonly failureReason: RoleConversationFailureReason | null;
}

const RETRYABLE_ROLE_FAILURES: ReadonlySet<RoleConversationFailureReason> = new Set([
  'session-missing',
  'turn-timeout',
  'empty-narrative',
]);

const HUMAN_RECOVERY_ROLE_FAILURES: ReadonlySet<RoleConversationFailureReason> = new Set([
  'session-mismatch',
  'lost-session',
  'sequence-regression',
  'narrative-changed',
  'ambiguous-submission',
  'permission-profile-unavailable',
]);

function classified(disposition: RecoveryDisposition, reason: string): RecoveryClassification {
  return { disposition, reason };
}

function humanRecovery(reason: string): RecoveryClassification {
  return classified('human_recovery', reason);
}

/**
 * Maps a typed role-conversation failure to a recovery disposition. A failure
 * that leaves no owned operation which cannot be observed again is safe to
 * retry; a failure that leaves session identity or submission state ambiguous is
 * an integrity stop. The mapping is consumed from the error tags so the
 * conversation layer keeps sole ownership of its own failure vocabulary.
 */
export function classifyRoleFailure(
  reason: RoleConversationFailureReason | null,
): RecoveryClassification {
  if (reason === null) {
    return classified(
      'blocked',
      'The stage failed without an owned-role failure reason; an operational fix is required before resume.',
    );
  }
  if (RETRYABLE_ROLE_FAILURES.has(reason)) {
    return classified(
      'retry',
      `The ${reason} role failure left no owned operation that cannot be observed again; retrying the stage is safe.`,
    );
  }
  if (HUMAN_RECOVERY_ROLE_FAILURES.has(reason)) {
    return humanRecovery(
      `The ${reason} role failure leaves the owned session identity or submission state ambiguous.`,
    );
  }
  return humanRecovery(
    `The ${reason} role failure is not classified as safe to retry, so a person must investigate the owned session.`,
  );
}

function roleForCheckpoint(state: WorkflowState): WorkflowRole | null {
  switch (state) {
    case 'planning':
      return 'architect';
    case 'coding':
    case 'correcting':
      return 'coder';
    case 'testing':
      return 'tester';
    case 'reviewing':
      return 'reviewer';
    default:
      return null;
  }
}

function latestSessionFor(
  history: RunHistoryDerivedState,
  role: WorkflowRole,
): RoleHostSessionState | null {
  let latest: RoleHostSessionState | null = null;
  for (const session of history.roleSessions) {
    if (session.role === role) {
      latest = session;
    }
  }
  return latest;
}

/**
 * A settled role turn whose control reports `blocked` already produced its
 * stage block deliberately, so recovery must not re-enter the stage. Every role
 * envelope carries a closed `outcome`, so one structural check covers them all
 * without decoding a role-specific schema here.
 */
function reportedBlocked(observation: RoleHostSessionState['lastObservation']): boolean {
  if (observation === null || observation.status !== 'settled') {
    return false;
  }
  const value = observation.control;
  return value !== null && value['outcome'] === 'blocked';
}

/**
 * Classifies how a recorded run should recover from durable evidence. It
 * accepts a settled fact, keeps waiting on an owned in-progress operation,
 * retries only when no submission side effect occurred, blocks when an
 * operational fix is needed, and stops for a person when identity, Git, lock,
 * journal, or submission evidence is ambiguous. It never resumes a run on a
 * blind prerequisite and never treats interrupted Coder files as an accepted
 * implementation.
 */
export function classifyRecovery(
  history: RunHistoryDerivedState,
  facts: RecoveryFacts,
): RecoveryClassification {
  if (!facts.journalIntact) {
    return humanRecovery(
      'The canonical run history could not be verified, so the recorded state is ambiguous.',
    );
  }
  if (facts.observationProblem !== null) {
    return humanRecovery(
      `The recorded workspace identity could not be verified from Git: ${facts.observationProblem}`,
    );
  }
  if (facts.lease === 'indeterminate') {
    return humanRecovery(
      'Repository ownership is neither released nor verifiably dead, so the lock evidence is ambiguous.',
    );
  }
  const state = history.state;
  if (state === null) {
    return humanRecovery('The run has no recorded workflow state to reconcile.');
  }
  if (isTerminalWorkflowState(state)) {
    return classified(
      'accept',
      `The recorded run already settled as "${state}"; resume reconciles the same reports without repeating work.`,
    );
  }
  if (facts.failureReason !== null) {
    return classifyRoleFailure(facts.failureReason);
  }
  if (state !== 'blocked') {
    return classified(
      'blocked',
      `The run is in "${state}", which the blocked-resume classifier does not own; a stage-specific resume path must reconcile it.`,
    );
  }
  if (facts.lease === 'live') {
    return classified(
      'blocked',
      'Repository ownership is held by a live process; correct the lock before this run can resume.',
    );
  }
  const checkpoint = history.checkpoint;
  if (checkpoint === null) {
    return classified(
      'blocked',
      'The blocked run has no recorded checkpoint, so resume cannot choose a stage.',
    );
  }
  if (!isActiveWorkflowState(checkpoint)) {
    return classified(
      'blocked',
      `The recorded checkpoint "${checkpoint}" is not an active stage that resume may re-enter.`,
    );
  }
  const ready = history.worktreeReady;
  const implementation = history.implementation;
  const acceptedHead = implementation === null ? null : implementation.commit;
  if (ready !== null) {
    const worktree = facts.worktree;
    if (worktree === null) {
      return humanRecovery(
        'The recorded worktree could not be observed, so its identity is ambiguous.',
      );
    }
    if (!worktree.registered) {
      return humanRecovery(
        `The recorded worktree ${ready.workspace} is no longer registered to Git.`,
      );
    }
    if (worktree.checkedOutBranch !== ready.taskBranch) {
      return humanRecovery(
        `The recorded worktree ${ready.workspace} is no longer on branch "${ready.taskBranch}".`,
      );
    }
    const implementationHead =
      facts.implementation === null ? null : facts.implementation.headCommit;
    const observedHead = implementationHead ?? worktree.headCommit;
    if (observedHead === null) {
      return humanRecovery(
        `The recorded worktree ${ready.workspace} has no resolvable head commit, so its identity is ambiguous.`,
      );
    }
    if (
      implementationHead !== null &&
      worktree.headCommit !== null &&
      implementationHead !== worktree.headCommit
    ) {
      return humanRecovery(
        `Git reported two different heads (${worktree.headCommit} and ${implementationHead}) for the recorded worktree ${ready.workspace}, so its identity is ambiguous.`,
      );
    }
    /**
     * A changed implementation advances the worktree past the frozen
     * provisioning commit, so identity reconciles against the accepted
     * implementation head from durable history as well. Only a head that matches
     * neither the accepted head nor the provisioning head is ambiguous.
     */
    const knownHeads =
      acceptedHead === null ? [ready.headCommit] : [ready.headCommit, acceptedHead];
    if (!knownHeads.some((head) => head === observedHead)) {
      return humanRecovery(
        `The recorded worktree ${ready.workspace} is at ${observedHead}, which matches neither the accepted head ${acceptedHead ?? 'none'} nor the recorded provisioning head ${ready.headCommit}.`,
      );
    }
  }
  const role = roleForCheckpoint(checkpoint);
  const session = role === null ? null : latestSessionFor(history, role);
  if (role !== null && session !== null && reportedBlocked(session.lastObservation)) {
    return classified(
      'blocked',
      `The settled ${role} attempt reported a blocked outcome; an operational or integrity fix is required before resume.`,
    );
  }
  const observation = session === null ? null : session.lastObservation;
  if (
    role !== null &&
    session !== null &&
    session.submissionStarted !== null &&
    (observation === null || observation.status !== 'settled')
  ) {
    return classified(
      'continue_waiting',
      `The ${role} submission for session "${session.sessionId}" is owned and still in progress; observe the same session again later without resubmitting.`,
    );
  }
  if (
    (checkpoint === 'coding' || checkpoint === 'correcting') &&
    facts.implementation !== null &&
    !facts.implementation.clean
  ) {
    return classified(
      'retry',
      'Interrupted Coder files are evidence, not an accepted implementation; resume the coding stage under the clean-branch rule.',
    );
  }
  if (implementation !== null) {
    return classified(
      'accept',
      acceptedHead === null
        ? 'The no-change implementation is already accepted from durable history; continue automatic validation without repeating the Coder turn.'
        : `The accepted implementation at ${acceptedHead} is reconciled from durable history; continue automatic validation without repeating the Coder turn.`,
    );
  }
  if (role === null) {
    return classified(
      'retry',
      `The "${checkpoint}" stage owns no role submission side effect; resume the deterministic stage.`,
    );
  }
  if (session === null) {
    return classified(
      'retry',
      `No ${role} session was created for the recorded checkpoint; retrying the stage has no submission side effect.`,
    );
  }
  if (observation !== null && observation.status === 'settled') {
    if (checkpoint === 'coding' || checkpoint === 'correcting') {
      return classified(
        'retry',
        'Interrupted Coder files are evidence, not an accepted implementation; resume the coding stage under the clean-branch rule.',
      );
    }
    return classified(
      'accept',
      `The settled ${role} attempt is reconciled from its recorded observation; continue automatic validation without resending the prompt.`,
    );
  }
  if (observation !== null && observation.status === 'lost') {
    return humanRecovery(
      `The owned ${role} session "${session.sessionId}" was lost and cannot be observed again.`,
    );
  }
  if (session.submission !== null) {
    return humanRecovery(
      `The ${role} submission intent for session "${session.sessionId}" has no proven submission side effect; the submission state is ambiguous.`,
    );
  }
  return classified(
    'retry',
    `The ${role} session "${session.sessionId}" was created without a submission side effect; retrying is safe.`,
  );
}
