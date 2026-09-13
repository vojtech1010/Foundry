import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Effect, Layer, Schema } from 'effect';

import { RunGit, RunWorkspaceBlocked } from '../application/git-provisioning/index.js';
import { GitCommitId } from '../domain/run-locations.js';

import type {
  BranchObservation,
  CommitExistsOptions,
  CreateBranchOptions,
  CreateWorktreeOptions,
  FetchSourceOptions,
  ImplementationObservation,
  InspectRepositoryOptions,
  ObserveImplementationOptions,
  ReadBranchOptions,
  ReadWorktreeOptions,
  RepositoryIdentityObservation,
  WorktreeObservation,
} from '../application/git-provisioning/index.js';

interface GitOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly spawnFailed: boolean;
}

function bound(text: string): string {
  return text.trim().replaceAll(/\s+/gu, ' ').trim().slice(0, 400);
}

function runGit(args: ReadonlyArray<string>, cwd: string): GitOutcome {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? 1,
    spawnFailed: result.error !== undefined,
  };
}

function blocked(runId: string, problem: string, detail: string): RunWorkspaceBlocked {
  return new RunWorkspaceBlocked({
    message: `Run "${runId}" cannot own its workspace: ${detail} A person must investigate before this run continues.`,
    runId,
    problem,
  });
}

function successfulGitOutput(
  outcome: GitOutcome,
  runId: string,
  problem: string,
  description: string,
  cwd: string,
): Effect.Effect<string, RunWorkspaceBlocked> {
  if (outcome.spawnFailed) {
    return Effect.fail(
      blocked(
        runId,
        problem,
        `Git ${description} could not run in ${cwd}: ${bound(outcome.stderr)}.`,
      ),
    );
  }
  if (outcome.exitCode !== 0) {
    return Effect.fail(
      blocked(
        runId,
        problem,
        `Git ${description} failed in ${cwd} with exit code ${outcome.exitCode}: ${bound(outcome.stderr)}.`,
      ),
    );
  }
  return Effect.succeed(outcome.stdout);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isCommitId(value: string): boolean {
  return Schema.is(GitCommitId)(value);
}

const inspectRepository = Effect.fn('runGit.inspectRepository')(function* (
  options: InspectRepositoryOptions,
): Effect.fn.Return<RepositoryIdentityObservation, RunWorkspaceBlocked> {
  const { repositoryRoot, remote, runId } = options;
  const gitDirectoryOutput = yield* successfulGitOutput(
    runGit(['rev-parse', '--absolute-git-dir'], repositoryRoot),
    runId,
    'the target repository has no usable Git directory',
    'rev-parse --absolute-git-dir',
    repositoryRoot,
  );
  const remoteUrlOutput = yield* successfulGitOutput(
    runGit(['remote', 'get-url', remote], repositoryRoot),
    runId,
    'the configured source remote is not available',
    `remote get-url ${remote}`,
    repositoryRoot,
  );
  const topLevelOutput = yield* successfulGitOutput(
    runGit(['rev-parse', '--show-toplevel'], repositoryRoot),
    runId,
    'the target repository has no usable work tree root',
    'rev-parse --show-toplevel',
    repositoryRoot,
  );
  return {
    repositoryRoot: canonicalPath(topLevelOutput.trim()),
    gitDirectory: canonicalPath(join(repositoryRoot, gitDirectoryOutput.trim())),
    remoteUrl: remoteUrlOutput.trim(),
  };
});

const fetchSource = Effect.fn('runGit.fetchSource')(function* (
  options: FetchSourceOptions,
): Effect.fn.Return<{ readonly commit: string }, RunWorkspaceBlocked> {
  const { repositoryRoot, remote, branch, runId } = options;
  yield* successfulGitOutput(
    runGit(['fetch', '--no-tags', remote, branch], repositoryRoot),
    runId,
    'the configured source branch could not be fetched',
    `fetch ${remote} ${branch}`,
    repositoryRoot,
  );
  const resolved = yield* successfulGitOutput(
    runGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], repositoryRoot),
    runId,
    'the fetched source commit could not be resolved',
    'rev-parse FETCH_HEAD',
    repositoryRoot,
  );
  const commit = resolved.trim();
  if (!isCommitId(commit)) {
    return yield* blocked(
      runId,
      'Git reported an invalid source commit',
      `Git returned "${bound(commit)}" instead of a full source commit.`,
    );
  }
  return { commit };
});

const commitExists = Effect.fn('runGit.commitExists')(function* (
  options: CommitExistsOptions,
): Effect.fn.Return<boolean, RunWorkspaceBlocked> {
  const outcome = yield* Effect.sync(() =>
    runGit(['cat-file', '-e', `${options.commit}^{commit}`], options.repositoryRoot),
  );
  if (outcome.spawnFailed) {
    return yield* blocked(
      options.runId,
      'the target repository could not be inspected',
      `Git cat-file could not run in ${options.repositoryRoot}: ${bound(outcome.stderr)}.`,
    );
  }
  return outcome.exitCode === 0;
});

const readBranch = Effect.fn('runGit.readBranch')(function* (
  options: ReadBranchOptions,
): Effect.fn.Return<BranchObservation, RunWorkspaceBlocked> {
  const outcome = yield* Effect.sync(() =>
    runGit(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${options.branch}`],
      options.repositoryRoot,
    ),
  );
  if (outcome.spawnFailed) {
    return yield* blocked(
      options.runId,
      'the target repository could not be inspected',
      `Git rev-parse could not run in ${options.repositoryRoot}: ${bound(outcome.stderr)}.`,
    );
  }
  if (outcome.exitCode === 1) {
    return { exists: false, commit: null };
  }
  if (outcome.exitCode !== 0) {
    return yield* blocked(
      options.runId,
      'the task branch could not be inspected',
      `Git rev-parse failed for branch "${options.branch}" with exit code ${outcome.exitCode}: ${bound(outcome.stderr)}.`,
    );
  }
  const commit = outcome.stdout.trim();
  if (!isCommitId(commit)) {
    return yield* blocked(
      options.runId,
      'the task branch points at an invalid commit',
      `Branch "${options.branch}" resolved to "${bound(commit)}" instead of a full commit.`,
    );
  }
  return { exists: true, commit };
});

const createBranch = Effect.fn('runGit.createBranch')(function* (
  options: CreateBranchOptions,
): Effect.fn.Return<void, RunWorkspaceBlocked> {
  yield* successfulGitOutput(
    runGit(['branch', options.branch, options.commit], options.repositoryRoot),
    options.runId,
    'the task branch could not be created without moving another branch',
    `branch ${options.branch} ${options.commit}`,
    options.repositoryRoot,
  );
});

interface ParsedWorktree {
  readonly path: string;
  readonly headCommit: string | null;
  readonly checkedOutBranch: string | null;
}

function parseWorktreeList(output: string): ReadonlyArray<ParsedWorktree> {
  const entries: Array<ParsedWorktree> = [];
  let path: string | null = null;
  let headCommit: string | null = null;
  let checkedOutBranch: string | null = null;
  const flush = (): void => {
    if (path === null) {
      return;
    }
    entries.push({ path, headCommit, checkedOutBranch });
    path = null;
    headCommit = null;
    checkedOutBranch = null;
  };
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    if (trimmed.startsWith('worktree ')) {
      flush();
      path = trimPathLine(trimmed.slice('worktree '.length));
      continue;
    }
    if (trimmed.startsWith('HEAD ')) {
      const value = trimmed.slice('HEAD '.length);
      headCommit = isCommitId(value) ? value : null;
      continue;
    }
    if (trimmed.startsWith('branch refs/heads/')) {
      checkedOutBranch = trimmed.slice('branch refs/heads/'.length);
      continue;
    }
  }
  flush();
  return entries;
}

function trimPathLine(path: string): string {
  return path.trim();
}

const readWorktree = Effect.fn('runGit.readWorktree')(function* (
  options: ReadWorktreeOptions,
): Effect.fn.Return<WorktreeObservation, RunWorkspaceBlocked> {
  const output = yield* successfulGitOutput(
    runGit(['worktree', 'list', '--porcelain'], options.repositoryRoot),
    options.runId,
    'the repository worktrees could not be inspected',
    'worktree list --porcelain',
    options.repositoryRoot,
  );
  const wanted = canonicalPath(options.workspace);
  for (const entry of parseWorktreeList(output)) {
    if (canonicalPath(entry.path) === wanted) {
      return {
        registered: true,
        checkedOutBranch: entry.checkedOutBranch,
        headCommit: entry.headCommit,
      };
    }
  }
  return { registered: false, checkedOutBranch: null, headCommit: null };
});

const createWorktree = Effect.fn('runGit.createWorktree')(function* (
  options: CreateWorktreeOptions,
): Effect.fn.Return<void, RunWorkspaceBlocked> {
  yield* successfulGitOutput(
    runGit(['worktree', 'add', options.workspace, options.branch], options.repositoryRoot),
    options.runId,
    'the run-owned worktree could not be created',
    `worktree add ${options.workspace} ${options.branch}`,
    options.repositoryRoot,
  );
});

const observeImplementation = Effect.fn('runGit.observeImplementation')(function* (
  options: ObserveImplementationOptions,
): Effect.fn.Return<ImplementationObservation, RunWorkspaceBlocked> {
  const { workspace, runId } = options;
  const workspaceExists = yield* Effect.sync(() => {
    try {
      return statSync(workspace).isDirectory();
    } catch {
      return false;
    }
  });
  if (!workspaceExists) {
    return {
      workspaceExists: false,
      currentBranch: null,
      headCommit: null,
      clean: false,
      baseIsAncestor: false,
    };
  }
  const branchOutcome = yield* Effect.sync(() =>
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspace),
  );
  const headOutcome = yield* Effect.sync(() => runGit(['rev-parse', 'HEAD'], workspace));
  const statusOutcome = yield* Effect.sync(() => runGit(['status', '--porcelain'], workspace));
  if (branchOutcome.spawnFailed || headOutcome.spawnFailed || statusOutcome.spawnFailed) {
    return yield* blocked(
      runId,
      'the assigned worktree could not be inspected',
      `Git could not inspect the assigned worktree at ${workspace}.`,
    );
  }
  if (branchOutcome.exitCode !== 0 || headOutcome.exitCode !== 0) {
    return {
      workspaceExists: true,
      currentBranch: null,
      headCommit: null,
      clean: false,
      baseIsAncestor: false,
    };
  }
  const currentBranch = branchOutcome.stdout.trim() === 'HEAD' ? null : branchOutcome.stdout.trim();
  const headCommit = headOutcome.stdout.trim();
  const ancestorOutcome = yield* Effect.sync(() =>
    runGit(['merge-base', '--is-ancestor', options.baseCommit, headCommit], workspace),
  );
  return {
    workspaceExists: true,
    currentBranch,
    headCommit: isCommitId(headCommit) ? headCommit : null,
    clean: statusOutcome.exitCode === 0 && statusOutcome.stdout.trim().length === 0,
    baseIsAncestor: ancestorOutcome.exitCode === 0,
  };
});

export const RunGitLive: Layer.Layer<RunGit> = Layer.succeed(
  RunGit,
  RunGit.of({
    inspectRepository,
    fetchSource,
    commitExists,
    readBranch,
    createBranch,
    readWorktree,
    createWorktree,
    observeImplementation,
  }),
);
