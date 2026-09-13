import { Context, Effect, Schema } from 'effect';

import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';

import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';
import type { SourceFrozenPayload, WorktreeReadyPayload } from '../../domain/run-history.js';

export class RunWorkspaceBlocked extends Schema.TaggedError<RunWorkspaceBlocked>()(
  'RunWorkspaceBlocked',
  {
    message: Schema.String,
    runId: Schema.optional(Schema.String),
    problem: Schema.String,
  },
) {}

export interface RepositoryIdentityObservation {
  readonly repositoryRoot: string;
  readonly gitDirectory: string;
  readonly remoteUrl: string;
}

export interface BranchObservation {
  readonly exists: boolean;
  readonly commit: string | null;
}

export interface WorktreeObservation {
  readonly registered: boolean;
  readonly checkedOutBranch: string | null;
  readonly headCommit: string | null;
}

export interface ImplementationObservation {
  readonly workspaceExists: boolean;
  readonly currentBranch: string | null;
  readonly headCommit: string | null;
  readonly clean: boolean;
  readonly baseIsAncestor: boolean;
}

export interface InspectRepositoryOptions {
  readonly repositoryRoot: string;
  readonly remote: string;
  readonly runId: string;
}

export interface FetchSourceOptions {
  readonly repositoryRoot: string;
  readonly remote: string;
  readonly branch: string;
  readonly runId: string;
}

export interface CommitExistsOptions {
  readonly repositoryRoot: string;
  readonly commit: string;
  readonly runId: string;
}

export interface ReadBranchOptions {
  readonly repositoryRoot: string;
  readonly branch: string;
  readonly runId: string;
}

export interface CreateBranchOptions {
  readonly repositoryRoot: string;
  readonly branch: string;
  readonly commit: string;
  readonly runId: string;
}

export interface ReadWorktreeOptions {
  readonly repositoryRoot: string;
  readonly workspace: string;
  readonly runId: string;
}

export interface CreateWorktreeOptions {
  readonly repositoryRoot: string;
  readonly workspace: string;
  readonly branch: string;
  readonly runId: string;
}

export interface ObserveImplementationOptions {
  readonly workspace: string;
  readonly taskBranch: string;
  readonly baseCommit: string;
  readonly runId: string;
}

export interface FetchedSource {
  readonly commit: string;
}

export class RunGit extends Context.Service<
  RunGit,
  {
    readonly inspectRepository: (
      options: InspectRepositoryOptions,
    ) => Effect.Effect<RepositoryIdentityObservation, RunWorkspaceBlocked>;
    readonly fetchSource: (
      options: FetchSourceOptions,
    ) => Effect.Effect<FetchedSource, RunWorkspaceBlocked>;
    readonly commitExists: (
      options: CommitExistsOptions,
    ) => Effect.Effect<boolean, RunWorkspaceBlocked>;
    readonly readBranch: (
      options: ReadBranchOptions,
    ) => Effect.Effect<BranchObservation, RunWorkspaceBlocked>;
    readonly createBranch: (
      options: CreateBranchOptions,
    ) => Effect.Effect<void, RunWorkspaceBlocked>;
    readonly readWorktree: (
      options: ReadWorktreeOptions,
    ) => Effect.Effect<WorktreeObservation, RunWorkspaceBlocked>;
    readonly createWorktree: (
      options: CreateWorktreeOptions,
    ) => Effect.Effect<void, RunWorkspaceBlocked>;
    readonly observeImplementation: (
      options: ObserveImplementationOptions,
    ) => Effect.Effect<ImplementationObservation, RunWorkspaceBlocked>;
  }
>()('foundry/application/git-provisioning/RunGit') {}

export interface ProvisionRunWorkspaceOptions {
  readonly runId: string;
  readonly runDirectory: string;
  readonly targetRepository: string;
  readonly sourceRemote: string;
  readonly sourceBranch: string;
  readonly taskBranch: string;
  readonly workspace: string;
}

function blocked(runId: string, problem: string, message: string): RunWorkspaceBlocked {
  return new RunWorkspaceBlocked({
    message: `Run "${runId}" cannot own its workspace: ${message} A person must investigate before this run continues.`,
    runId,
    problem,
  });
}

const freezeSource = Effect.fn('provisionRunSource.freezeSource')(function* (
  options: ProvisionRunWorkspaceOptions,
): Effect.fn.Return<
  SourceFrozenPayload,
  RunWorkspaceBlocked | RunHistoryError,
  RunGit | RunHistoryStorage
> {
  const git = yield* RunGit;
  const { runId } = options;

  const identity = yield* git.inspectRepository({
    repositoryRoot: options.targetRepository,
    remote: options.sourceRemote,
    runId,
  });
  const fetched = yield* git.fetchSource({
    repositoryRoot: options.targetRepository,
    remote: options.sourceRemote,
    branch: options.sourceBranch,
    runId,
  });
  const payload: SourceFrozenPayload = {
    repository: {
      repositoryRoot: identity.repositoryRoot,
      gitDirectory: identity.gitDirectory,
      remoteUrl: identity.remoteUrl,
    },
    sourceRemote: options.sourceRemote,
    sourceBranch: options.sourceBranch,
    sourceCommit: fetched.commit,
    taskBranch: options.taskBranch,
    workspace: options.workspace,
    expectedHead: fetched.commit,
  };

  const appended = yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId,
    createIfMissing: false,
    build: () => Effect.succeed({ type: 'source-frozen', payload } as const),
  });
  return appended.event.payload;
});

const verifyFrozenSource = Effect.fn('provisionRunSource.verifyFrozenSource')(function* (
  options: ProvisionRunWorkspaceOptions,
  frozen: SourceFrozenPayload,
): Effect.fn.Return<SourceFrozenPayload, RunWorkspaceBlocked, RunGit> {
  const git = yield* RunGit;
  const { runId } = options;

  const identity = yield* git.inspectRepository({
    repositoryRoot: options.targetRepository,
    remote: options.sourceRemote,
    runId,
  });
  if (
    identity.repositoryRoot !== frozen.repository.repositoryRoot ||
    identity.gitDirectory !== frozen.repository.gitDirectory ||
    identity.remoteUrl !== frozen.repository.remoteUrl
  ) {
    return yield* blocked(
      runId,
      'the recorded repository identity no longer matches Git',
      `Recorded repository identity ${frozen.repository.repositoryRoot} (${frozen.repository.remoteUrl}) does not match the current repository ${identity.repositoryRoot} (${identity.remoteUrl}).`,
    );
  }
  const present = yield* git.commitExists({
    repositoryRoot: options.targetRepository,
    commit: frozen.sourceCommit,
    runId,
  });
  if (!present) {
    return yield* blocked(
      runId,
      'the frozen source commit is no longer present',
      `Frozen source commit ${frozen.sourceCommit} can no longer be resolved in the target repository.`,
    );
  }
  return frozen;
});

const ensureWorktree = Effect.fn('provisionRunWorktree.ensureWorktree')(function* (
  options: ProvisionRunWorkspaceOptions,
  frozen: SourceFrozenPayload,
): Effect.fn.Return<
  WorktreeReadyPayload,
  RunWorkspaceBlocked | RunHistoryError,
  RunGit | RunHistoryStorage
> {
  const git = yield* RunGit;
  const { runId, taskBranch, workspace } = options;

  const branch = yield* git.readBranch({
    repositoryRoot: options.targetRepository,
    branch: taskBranch,
    runId,
  });
  if (branch.exists) {
    if (branch.commit !== frozen.expectedHead) {
      return yield* blocked(
        runId,
        'the task branch belongs to another commit',
        `Task branch "${taskBranch}" already exists at ${branch.commit ?? 'an unknown commit'} instead of this run's frozen commit ${frozen.expectedHead}; the branch was left untouched.`,
      );
    }
  } else {
    yield* git.createBranch({
      repositoryRoot: options.targetRepository,
      branch: taskBranch,
      commit: frozen.expectedHead,
      runId,
    });
  }

  const registered = yield* git.readWorktree({
    repositoryRoot: options.targetRepository,
    workspace,
    runId,
  });
  if (registered.registered) {
    if (
      registered.checkedOutBranch !== taskBranch ||
      registered.headCommit !== frozen.expectedHead
    ) {
      return yield* blocked(
        runId,
        'the workspace is registered to a different branch or commit',
        `Workspace ${workspace} is already registered${
          registered.checkedOutBranch === null
            ? ' with a detached HEAD'
            : ` to branch "${registered.checkedOutBranch}"`
        } at ${registered.headCommit ?? 'an unknown commit'} instead of branch "${taskBranch}" at ${frozen.expectedHead}; it was left untouched.`,
      );
    }
  } else {
    yield* git.createWorktree({
      repositoryRoot: options.targetRepository,
      workspace,
      branch: taskBranch,
      runId,
    });
  }

  const confirmed = yield* git.readWorktree({
    repositoryRoot: options.targetRepository,
    workspace,
    runId,
  });
  if (
    !confirmed.registered ||
    confirmed.checkedOutBranch !== taskBranch ||
    confirmed.headCommit !== frozen.expectedHead
  ) {
    return yield* blocked(
      runId,
      'Git did not confirm the run-owned worktree',
      `Git did not confirm workspace ${workspace} on branch "${taskBranch}" at ${frozen.expectedHead}.`,
    );
  }

  const payload: WorktreeReadyPayload = {
    taskBranch,
    workspace,
    headCommit: frozen.expectedHead,
    baseCommit: frozen.sourceCommit,
  };
  const appended = yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId,
    createIfMissing: false,
    build: () => Effect.succeed({ type: 'worktree-ready', payload } as const),
  });
  return appended.event.payload;
});

export const provisionRunSource = Effect.fn('provisionRunSource')(function* (
  options: ProvisionRunWorkspaceOptions,
): Effect.fn.Return<
  SourceFrozenPayload,
  RunWorkspaceBlocked | RunHistoryError,
  RunGit | RunHistoryStorage
> {
  const { runId } = options;
  const git = yield* RunGit;
  const history = yield* readVerifiedRunHistory({
    runDirectory: options.runDirectory,
    runId,
    createIfMissing: false,
  });

  const recorded = history.derived.sourceFrozen;
  if (recorded === null) {
    const existingBranch = yield* git.readBranch({
      repositoryRoot: options.targetRepository,
      branch: options.taskBranch,
      runId,
    });
    if (existingBranch.exists) {
      return yield* blocked(
        runId,
        'a task branch exists before this run recorded ownership',
        `Task branch "${options.taskBranch}" already exists at ${existingBranch.commit ?? 'an unknown commit'} but run "${runId}" has no durable ownership record for it; the branch was left untouched.`,
      );
    }
    const existingWorktree = yield* git.readWorktree({
      repositoryRoot: options.targetRepository,
      workspace: options.workspace,
      runId,
    });
    if (existingWorktree.registered) {
      return yield* blocked(
        runId,
        'a workspace exists before this run recorded ownership',
        `Workspace ${options.workspace} is already registered to Git but run "${runId}" has no durable ownership record for it; it was left untouched.`,
      );
    }
  }

  const frozen =
    recorded === null ? yield* freezeSource(options) : yield* verifyFrozenSource(options, recorded);

  if (frozen.taskBranch !== options.taskBranch || frozen.workspace !== options.workspace) {
    return yield* blocked(
      runId,
      'the durable run identity names a different task branch or workspace',
      `Run "${runId}" is already frozen to task branch "${frozen.taskBranch}" and workspace ${frozen.workspace}, not "${options.taskBranch}" and ${options.workspace}.`,
    );
  }

  return frozen;
});

export const provisionRunWorktree = Effect.fn('provisionRunWorktree')(function* (
  options: ProvisionRunWorkspaceOptions,
  frozen: SourceFrozenPayload,
): Effect.fn.Return<
  WorktreeReadyPayload,
  RunWorkspaceBlocked | RunHistoryError,
  RunGit | RunHistoryStorage
> {
  const history = yield* readVerifiedRunHistory({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  const ready = history.derived.worktreeReady;
  if (ready !== null) {
    return ready;
  }
  return yield* ensureWorktree(options, frozen);
});
