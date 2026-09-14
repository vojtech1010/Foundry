import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunGit, RunWorkspaceBlocked } from '../../src/application/git-provisioning/index.js';
import { RunGitLive } from '../../src/platform/git-provisioning.js';

const RUN_ID = 'RUN-PARITY';

const TASK_BRANCH = 'foundry/parity';

function git(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

interface RepositoryFixture {
  readonly target: string;
  readonly remote: string;
  readonly commit: string;
  readonly cleanup: () => void;
}

function setupRepository(label: string): RepositoryFixture {
  const base = mkdtempSync(join(tmpdir(), `foundry parity ${label} `));
  const target = join(base, 'target repository');
  const remote = join(base, 'remote.git');
  mkdirSync(target, { recursive: true });
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', target], { encoding: 'utf8' });
  git(target, ['config', 'user.email', 'parity@example.com']);
  git(target, ['config', 'user.name', 'Foundry Parity']);
  writeFileSync(join(target, 'README.md'), '# parity\n');
  git(target, ['add', 'README.md']);
  git(target, ['commit', '-m', 'initial']);
  git(target, ['remote', 'add', 'origin', remote]);
  git(target, ['push', '-u', 'origin', 'main']);
  return {
    target,
    remote,
    commit: git(target, ['rev-parse', 'HEAD']),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

describe('temporary Git repository parity', () => {
  it.effect('provisions a branch and worktree from a platform temp repository path', () => {
    const fixture = setupRepository('workspace');
    return Effect.gen(function* () {
      const runGit = yield* RunGit;

      const identity = yield* runGit.inspectRepository({
        repositoryRoot: fixture.target,
        remote: 'origin',
        runId: RUN_ID,
      });
      expect(identity.repositoryRoot).toBe(realpathSync(fixture.target));
      expect(identity.remoteUrl).toBe(fixture.remote);

      const missing = yield* runGit.readBranch({
        repositoryRoot: fixture.target,
        branch: TASK_BRANCH,
        runId: RUN_ID,
      });
      expect(missing).toEqual({ exists: false, commit: null });

      yield* runGit.createBranch({
        repositoryRoot: fixture.target,
        branch: TASK_BRANCH,
        commit: fixture.commit,
        runId: RUN_ID,
      });
      const created = yield* runGit.readBranch({
        repositoryRoot: fixture.target,
        branch: TASK_BRANCH,
        runId: RUN_ID,
      });
      expect(created).toEqual({ exists: true, commit: fixture.commit });

      const refused = yield* runGit
        .createBranch({
          repositoryRoot: fixture.target,
          branch: TASK_BRANCH,
          commit: fixture.commit,
          runId: RUN_ID,
        })
        .pipe(Effect.flip);
      expect(refused).toBeInstanceOf(RunWorkspaceBlocked);
      expect(refused.problem).toBe(
        'the task branch could not be created without moving another branch',
      );

      const workspace = join(fixture.target, '.agent', 'worktrees', RUN_ID);
      const unregistered = yield* runGit.readWorktree({
        repositoryRoot: fixture.target,
        workspace,
        runId: RUN_ID,
      });
      expect(unregistered.registered).toBe(false);

      yield* runGit.createWorktree({
        repositoryRoot: fixture.target,
        workspace,
        branch: TASK_BRANCH,
        runId: RUN_ID,
      });
      const registered = yield* runGit.readWorktree({
        repositoryRoot: fixture.target,
        workspace,
        runId: RUN_ID,
      });
      expect(registered).toEqual({
        registered: true,
        checkedOutBranch: TASK_BRANCH,
        headCommit: fixture.commit,
      });

      const implementation = yield* runGit.observeImplementation({
        workspace,
        taskBranch: TASK_BRANCH,
        baseCommit: fixture.commit,
        runId: RUN_ID,
      });
      expect(implementation.workspaceExists).toBe(true);
      expect(implementation.currentBranch).toBe(TASK_BRANCH);
      expect(implementation.headCommit).toBe(fixture.commit);
      expect(implementation.clean).toBe(true);
      expect(implementation.baseIsAncestor).toBe(true);
    }).pipe(Effect.provide(RunGitLive), Effect.ensuring(Effect.sync(fixture.cleanup)));
  });
});
