import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvalidRunRequest, recordRunIdentity } from '../src/application/run-identity/index.js';
import {
  BRANCH_PROTECTION_NOT_CONFIGURED,
  branchProtectionEvidenceForPublication,
  preflightTaskBranch,
} from '../src/domain/run-locations.js';
import { ReadinessFilesLive, ReadinessGitLive } from '../src/platform/readiness.js';
import { RunGitLive } from '../src/platform/git-provisioning.js';
import { GuidanceLive } from '../src/platform/guidance.js';
import { RepositoryLeaseLive } from '../src/platform/repository-lease.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import { capableRoleHostLauncher } from './fixtures/role-host/role-host-launcher.js';

import type { TaskBranchPreflight } from '../src/domain/run-locations.js';

function expectRejection(preflight: TaskBranchPreflight) {
  expect(preflight._tag).toBe('Rejected');
  if (preflight._tag !== 'Rejected') {
    throw new Error('Expected the task branch to be rejected.');
  }
  return preflight.rejection;
}

describe('task branch preflight rule', () => {
  it('accepts a legal branch that matches neither the source nor a protected branch', () => {
    const preflight = preflightTaskBranch({
      taskBranch: 'foundry/example-change',
      sourceBranch: 'main',
      protection: { _tag: 'Known', protectedBranches: ['main', 'release'] },
    });
    expect(preflight).toEqual({ _tag: 'Accepted', taskBranch: 'foundry/example-change' });
  });

  it('accepts any legal branch when publication is not configured', () => {
    const preflight = preflightTaskBranch({
      taskBranch: 'foundry/example-change',
      sourceBranch: 'main',
      protection: BRANCH_PROTECTION_NOT_CONFIGURED,
    });
    expect(preflight._tag).toBe('Accepted');
  });

  it('rejects a branch equal to the source branch before any protection evidence', () => {
    const rejection = expectRejection(
      preflightTaskBranch({
        taskBranch: 'main',
        sourceBranch: 'main',
        protection: { _tag: 'Known', protectedBranches: ['main'] },
      }),
    );
    expect(rejection._tag).toBe('SourceBranch');
    expect(rejection.message).toContain('must not equal source branch');
  });

  it('rejects illegal Git branch names before consulting protection evidence', () => {
    for (const taskBranch of ['', '@', 'has..dots', 'has space', 'has:colon', 'trailing.']) {
      const rejection = expectRejection(
        preflightTaskBranch({
          taskBranch,
          sourceBranch: 'main',
          protection: { _tag: 'Known', protectedBranches: [taskBranch] },
        }),
      );
      expect(rejection._tag, taskBranch).toBe('IllegalName');
      expect(rejection.message).toContain('is not a legal Git branch name');
    }
  });

  it('rejects a collision with a protected branch reported by GitHub', () => {
    const rejection = expectRejection(
      preflightTaskBranch({
        taskBranch: 'foundry/example-change',
        sourceBranch: 'main',
        protection: { _tag: 'Known', protectedBranches: ['main', 'foundry/example-change'] },
      }),
    );
    expect(rejection._tag).toBe('ProtectedBranch');
    if (rejection._tag !== 'ProtectedBranch') {
      throw new Error('Expected a protected branch rejection.');
    }
    expect(rejection.protectedBranch).toBe('foundry/example-change');
    expect(rejection.message).toContain('collides with a protected branch');
  });

  it('fails closed while protection evidence is uncertain', () => {
    const rejection = expectRejection(
      preflightTaskBranch({
        taskBranch: 'foundry/example-change',
        sourceBranch: 'main',
        protection: { _tag: 'Uncertain', reason: 'the GitHub probe was unreachable' },
      }),
    );
    expect(rejection._tag).toBe('ProtectionUncertain');
    expect(rejection.message).toContain('the GitHub probe was unreachable');
  });

  it('treats configured publication without a resolved probe as uncertain', () => {
    const configured = branchProtectionEvidenceForPublication(true);
    expect(configured._tag).toBe('Uncertain');
    if (configured._tag !== 'Uncertain') {
      throw new Error('Expected uncertain protection evidence.');
    }
    expect(configured.reason.length).toBeGreaterThan(0);
    expect(branchProtectionEvidenceForPublication(false)).toEqual(BRANCH_PROTECTION_NOT_CONFIGURED);
  });
});

const CONFIG_FILENAME = 'foundry.config.json';

function goldenDocument(targetRepository: string, publicationConfigured: boolean) {
  return {
    schemaVersion: 1,
    targetRepository,
    sourceRemote: 'origin',
    sourceBranch: 'main',
    taskBranchPolicy: 'foundry/<task-id>',
    roleHarness: {
      protocol: 'foundry-role-host-v1',
      command: ['foundry-role-host'],
      environmentAllowlist: ['OPENAI_API_KEY'],
    },
    roles: {
      architect: { harness: 'codex', model: 'gpt-5-codex' },
      coder: { harness: 'codex', model: 'gpt-5-codex' },
      lead_coder: { harness: 'opencode', model: 'openai/gpt-5' },
      tester: { harness: 'opencode', model: 'openai/gpt-5' },
      reviewer: { harness: 'codex', model: 'gpt-5-codex' },
    },
    timeouts: {
      roleMs: 1800000,
      settleMs: 30000,
      pollMs: 100,
      commandMs: 900000,
      runtimeReadinessMs: 120000,
      cleanupMs: 30000,
      leaseMs: 60000,
    },
    retryBudgets: { architect: 1, coder: 2, tester: 1, reviewer: 1 },
    operationalRetryBudgets: { git: 2, runtime: 1, publication: 2, cleanup: 1 },
    limits: { maxParallelCoders: 4, maxCorrectionRounds: 2, maxControlRepairsPerAttempt: 1 },
    projectProfile: {
      guidancePaths: [],
      commands: {
        bootstrap: ['npm', 'ci'],
        formatCheck: ['npm', 'run', 'format:check'],
        lint: ['npm', 'run', 'lint'],
        typecheck: ['npm', 'run', 'typecheck'],
        test: ['npm', 'test'],
        build: ['npm', 'run', 'build'],
      },
    },
    runtimeProfile: null,
    decisionPublication: publicationConfigured
      ? { remote: 'origin', draft: true, maintainersCanModify: false }
      : null,
    artifacts: {
      retentionDays: 30,
      maxRequestBytes: 262144,
      maxGuidanceBytes: 1048576,
      maxRoleHandoffBytes: 262144,
      maxEvidenceBytes: 26214400,
      maxTerminalCaptureBytes: 10485760,
      maxRunBytes: 104857600,
      redactionPatterns: [],
    },
  };
}

function gitExec(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

interface LiveFixture {
  readonly base: string;
  readonly target: string;
  readonly configPath: string;
  readonly requestPath: string;
  readonly cleanup: () => void;
}

function setupLiveFixture(publicationConfigured: boolean): LiveFixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-branch-preflight-'));
  const target = join(base, 'target');
  const remote = join(base, 'remote.git');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', target], { encoding: 'utf8' });
  gitExec(target, ['config', 'user.email', 'preflight@example.com']);
  gitExec(target, ['config', 'user.name', 'Foundry Preflight']);
  writeFileSync(join(target, '.gitignore'), '.agent\n');
  writeFileSync(join(target, 'README.md'), '# target\n');
  gitExec(target, ['add', '.gitignore', 'README.md']);
  gitExec(target, ['commit', '-m', 'initial']);
  gitExec(target, ['remote', 'add', 'origin', remote]);
  gitExec(target, ['push', '-u', 'origin', 'main']);
  const configPath = join(home, CONFIG_FILENAME);
  writeFileSync(configPath, JSON.stringify(goldenDocument(target, publicationConfigured)));
  const requestPath = join(home, 'request.md');
  writeFileSync(requestPath, '# Outcome\n\nShip it.\n');
  return {
    base,
    target,
    configPath,
    requestPath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const LiveLayers = Layer.mergeAll(
  ReadinessFilesLive,
  ReadinessGitLive,
  RunIdentityLive,
  RunHistoryLive,
  RepositoryLeaseLive,
  GuidanceLive,
  RunGitLive,
  capableRoleHostLauncher(),
);

describe('live run preflight with a real repository', () => {
  it.effect('rejects a protected task-branch collision before any Git mutation', () =>
    Effect.gen(function* () {
      const fixture = setupLiveFixture(true);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const error = yield* recordRunIdentity({
            configArg: fixture.configPath,
            cwd: '/',
            requestArg: fixture.requestPath,
            taskId: 'TASK-1',
            runId: 'RUN-1',
            protection: { _tag: 'Known', protectedBranches: ['main', 'foundry/TASK-1'] },
          }).pipe(Effect.provide(LiveLayers), Effect.flip);

          expect(error).toBeInstanceOf(InvalidRunRequest);
          expect(error.message).toContain('collides with a protected branch');
          expect(existsSync(join(fixture.target, '.agent', 'worktrees'))).toBe(false);
          expect(gitExec(fixture.target, ['branch', '--list', 'foundry/TASK-1']).trim()).toBe('');
        }),
        Effect.sync(fixture.cleanup),
      );
    }),
  );

  it.effect('fails closed for configured publication without a resolved protection probe', () =>
    Effect.gen(function* () {
      const fixture = setupLiveFixture(true);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const error = yield* recordRunIdentity({
            configArg: fixture.configPath,
            cwd: '/',
            requestArg: fixture.requestPath,
            taskId: 'TASK-1',
            runId: 'RUN-1',
          }).pipe(Effect.provide(LiveLayers), Effect.flip);

          expect(error).toBeInstanceOf(InvalidRunRequest);
          expect(error.message).toContain('cannot be checked against GitHub protected branches');
          expect(existsSync(join(fixture.target, '.agent', 'worktrees'))).toBe(false);
        }),
        Effect.sync(fixture.cleanup),
      );
    }),
  );
});
