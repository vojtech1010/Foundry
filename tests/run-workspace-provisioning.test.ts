import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RunGit, RunWorkspaceBlocked } from '../src/application/git-provisioning/index.js';
import { ReadinessHost } from '../src/application/readiness/index.js';
import { RoleHostCapabilityError } from '../src/application/role-conversations/index.js';
import { RoleHostLauncherLive } from '../src/platform/role-host.js';
import { capableRoleHostLauncher } from './fixtures/role-host/role-host-launcher.js';
import {
  readRunWorkflowState,
  reconcileRunReports,
  recordRunIdentity,
} from '../src/application/run-identity/index.js';
import { appendRunEvent } from '../src/application/run-history/index.js';
import {
  IllegalWorkflowTransition,
  transitionWorkflow,
} from '../src/application/workflow-transitions/index.js';
import { ReadinessFilesLive } from '../src/platform/readiness.js';
import { RepositoryLeaseLive } from '../src/platform/repository-lease.js';
import { RunGitLive } from '../src/platform/git-provisioning.js';
import { GuidanceLive } from '../src/platform/guidance.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import { REQUEST_IDENTITY_FILENAME } from '../src/domain/run-identity.js';
import { RUN_HISTORY_FILENAME } from '../src/domain/run-history.js';
import {
  WORKFLOW_STATE_FILENAME,
  WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
  WorkflowProgressDocumentSchema,
} from '../src/domain/workflow.js';

import type { RunEventDraft } from '../src/domain/run-history.js';
import type { ReadinessFiles } from '../src/application/readiness/index.js';
import type { GuidanceGit, GuidanceSnapshotStore } from '../src/application/guidance/index.js';
import type {
  RepositoryHostIdentity,
  RepositoryLeaseStore,
} from '../src/application/repository-lease/index.js';
import type { RoleHostLauncher } from '../src/application/role-conversations/index.js';
import type { RunHistoryStorage } from '../src/application/run-history/index.js';
import type { RunIdentityStore } from '../src/application/run-identity/index.js';

const TASK_ID = 'example-change';

const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/role-host/fake-role-host.mjs', import.meta.url),
);

function git(dir: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', [...args], { cwd: dir, encoding: 'utf8' });
}

function gitIn(dir: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

interface RepositoryFixture {
  readonly base: string;
  readonly target: string;
  readonly remote: string;
  readonly home: string;
  readonly configPath: string;
  readonly requestPath: string;
  readonly runDirectory: (runId: string) => string;
  readonly cleanup: () => void;
}

function goldenDocument(
  targetRepository: string,
  roleHarnessCommand: ReadonlyArray<string> = ['foundry-role-host'],
) {
  return {
    schemaVersion: 1,
    targetRepository,
    sourceRemote: 'origin',
    sourceBranch: 'main',
    taskBranchPolicy: 'foundry/<task-id>',
    roleHarness: {
      protocol: 'foundry-role-host-v1',
      command: roleHarnessCommand,
      environmentAllowlist: [],
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
    decisionPublication: null,
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

function setupRepositoryFixture(
  label: string,
  roleHarnessCommand: ReadonlyArray<string> = ['foundry-role-host'],
): RepositoryFixture {
  const base = mkdtempSync(join(tmpdir(), `foundry-workspace-${label}-`));
  const target = join(base, 'target');
  const remote = join(base, 'remote.git');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', target], { encoding: 'utf8' });
  git(target, ['config', 'user.email', 'workspace@example.com']);
  git(target, ['config', 'user.name', 'Foundry Workspace']);
  writeFileSync(join(target, '.gitignore'), '.agent\n');
  writeFileSync(join(target, 'README.md'), '# target\n');
  git(target, ['add', '.gitignore', 'README.md']);
  git(target, ['commit', '-m', 'initial']);
  git(target, ['remote', 'add', 'origin', remote]);
  git(target, ['push', '-u', 'origin', 'main']);
  const configPath = join(home, 'foundry.config.json');
  writeFileSync(configPath, JSON.stringify(goldenDocument(target, roleHarnessCommand)));
  const requestPath = join(home, 'request.md');
  writeFileSync(requestPath, `# Outcome\n\n${label}\n`);
  return {
    base,
    target,
    remote,
    home,
    configPath,
    requestPath,
    runDirectory: (runId: string) => join(target, '.agent', 'runs', runId),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const integrationHost = Layer.succeed(
  ReadinessHost,
  ReadinessHost.of({
    platform: Effect.succeed('linux'),
    nodeVersion: Effect.succeed('v24.14.0'),
    npmVersion: Effect.succeed('11.9.0'),
    gitVersionOutput: Effect.succeed('git version 2.53.0\n'),
  }),
);

const AppBase = Layer.mergeAll(
  integrationHost,
  ReadinessFilesLive,
  RunIdentityLive,
  RunHistoryLive,
  RepositoryLeaseLive,
  RunGitLive,
  GuidanceLive,
);

const AppLive = Layer.mergeAll(AppBase, capableRoleHostLauncher());

type AppRequirements =
  | ReadinessHost
  | ReadinessFiles
  | RunIdentityStore
  | RunHistoryStorage
  | RepositoryLeaseStore
  | RepositoryHostIdentity
  | RoleHostLauncher
  | RunGit
  | GuidanceGit
  | GuidanceSnapshotStore;

function record(
  fixture: RepositoryFixture,
  options: { readonly runId: string; readonly taskId?: string },
  layer: Layer.Layer<AppRequirements> = AppLive,
) {
  return recordRunIdentity({
    configArg: fixture.configPath,
    cwd: fixture.target,
    requestArg: fixture.requestPath,
    taskId: options.taskId ?? TASK_ID,
    runId: options.runId,
  }).pipe(Effect.provide(layer));
}

function transition(
  runDirectory: string,
  runId: string,
  request: Parameters<typeof transitionWorkflow>[0]['request'],
) {
  return transitionWorkflow({ runDirectory, runId, request }).pipe(Effect.provide(AppLive));
}

function appendAcceptedPlan(runDirectory: string, runId: string) {
  return appendRunEvent({
    runDirectory,
    runId,
    createIfMissing: false,
    build: () =>
      Effect.succeed({
        type: 'plan-accepted',
        payload: {
          outcome: 'plan_ready' as const,
          criteria: [{ id: 'AC-001', text: 'the seeded criterion' }],
          runtimeValidationRequired: false,
          execution: {
            mode: 'sequential' as const,
            objectives: [
              {
                id: 'OBJ-001',
                title: 'Implement the accepted plan',
                affectedPaths: ['.'],
                criterionIds: ['AC-001'],
              },
            ],
          },
        },
      } as const),
  }).pipe(Effect.provide(AppLive));
}

function failingRunGit(name: 'createWorktree' | 'createBranch'): Layer.Layer<RunGit> {
  return Layer.effect(
    RunGit,
    Effect.gen(function* () {
      const live = yield* RunGit;
      const fail = (runId: string) =>
        Effect.fail(
          new RunWorkspaceBlocked({
            message: `Injected ${name} failure for run "${runId}".`,
            runId,
            problem: `injected ${name} failure`,
          }),
        );
      if (name === 'createWorktree') {
        return RunGit.of({ ...live, createWorktree: (options) => fail(options.runId) });
      }
      return RunGit.of({ ...live, createBranch: (options) => fail(options.runId) });
    }),
  ).pipe(Layer.provide(RunGitLive));
}

describe('run-owned workspace provisioning', () => {
  it.effect('freezes the source, confirms the worktree, and leaves the checkout alone', () =>
    Effect.gen(function* () {
      const fixture = setupRepositoryFixture('success');
      try {
        const beforeHead = gitIn(fixture.target, ['rev-parse', 'HEAD']).trim();
        const beforeBranch = gitIn(fixture.target, ['branch', '--show-current']).trim();
        const beforeStatus = gitIn(fixture.target, ['status', '--porcelain']);

        const report = yield* record(fixture, { runId: 'RUN-OWN-1' });

        const workspace = join(fixture.target, '.agent', 'worktrees', TASK_ID);
        const taskBranch = `foundry/${TASK_ID}`;
        expect(report.provenance).toMatchObject({
          repositoryRoot: realpathSync(fixture.target),
          remoteUrl: realpathSync(fixture.remote),
          sourceRemote: 'origin',
          sourceBranch: 'main',
          sourceCommit: beforeHead,
          taskBranch,
          workspace,
          headCommit: beforeHead,
        });
        expect(report.provenance.gitDirectory).toContain('.git');

        expect(existsSync(workspace)).toBe(true);
        expect(gitIn(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(taskBranch);
        expect(gitIn(workspace, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead);
        expect(gitIn(workspace, ['status', '--porcelain'])).toBe('');

        expect(gitIn(fixture.target, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead);
        expect(gitIn(fixture.target, ['branch', '--show-current']).trim()).toBe(beforeBranch);
        expect(gitIn(fixture.target, ['status', '--porcelain'])).toBe(beforeStatus);

        const history = readFileSync(join(report.runDirectory, RUN_HISTORY_FILENAME), 'utf8');
        expect(history).toContain('"type":"run-created"');
        expect(history).toContain('"type":"source-frozen"');
        expect(history).toContain('"type":"worktree-ready"');
        expect(history).toContain('"route":"run-created"');

        const progress = yield* readRunWorkflowState({
          configArg: fixture.configPath,
          cwd: fixture.target,
          runId: 'RUN-OWN-1',
        }).pipe(Effect.provide(AppLive));
        expect(progress.workflowState).toBe('planning');
        expect(progress.provenance?.sourceCommit).toBe(beforeHead);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('later forward source movement does not rewrite the run or its worktree', () =>
    Effect.gen(function* () {
      const fixture = setupRepositoryFixture('drift');
      try {
        const frozen = gitIn(fixture.target, ['rev-parse', 'HEAD']).trim();
        const report = yield* record(fixture, { runId: 'RUN-OWN-DRIFT' });

        const mover = join(fixture.base, 'mover');
        execFileSync('git', ['clone', '--branch', 'main', fixture.remote, mover], {
          encoding: 'utf8',
        });
        git(mover, ['config', 'user.email', 'mover@example.com']);
        git(mover, ['config', 'user.name', 'Remote Mover']);
        writeFileSync(join(mover, 'later.txt'), 'forward movement\n');
        git(mover, ['add', 'later.txt']);
        git(mover, ['commit', '-m', 'later']);
        git(mover, ['push', 'origin', 'main']);
        const moved = gitIn(fixture.remote, ['rev-parse', 'main']).trim();
        expect(moved).not.toBe(frozen);

        const progress = yield* readRunWorkflowState({
          configArg: fixture.configPath,
          cwd: fixture.target,
          runId: 'RUN-OWN-DRIFT',
        }).pipe(Effect.provide(AppLive));
        expect(progress.workflowState).toBe('planning');
        expect(progress.provenance?.sourceCommit).toBe(frozen);
        expect(gitIn(report.provenance.workspace, ['rev-parse', 'HEAD']).trim()).toBe(frozen);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('blocks a colliding branch without moving it and reports blocked progress', () =>
    Effect.gen(function* () {
      const fixture = setupRepositoryFixture('collision');
      try {
        const collidingCommit = gitIn(fixture.target, ['rev-parse', 'HEAD']).trim();
        git(fixture.target, ['branch', `foundry/${TASK_ID}`, collidingCommit]);
        const before = gitIn(fixture.target, ['rev-parse', `foundry/${TASK_ID}`]).trim();

        const error = yield* record(fixture, { runId: 'RUN-OWN-COLLIDE' }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(RunWorkspaceBlocked);
        if (!(error instanceof RunWorkspaceBlocked)) {
          throw new Error('Expected a RunWorkspaceBlocked error.');
        }
        expect(error.problem).toContain('ownership');

        expect(gitIn(fixture.target, ['rev-parse', `foundry/${TASK_ID}`]).trim()).toBe(before);
        expect(existsSync(join(fixture.target, '.agent', 'worktrees', TASK_ID))).toBe(false);

        const runDirectory = fixture.runDirectory('RUN-OWN-COLLIDE');
        expect(existsSync(join(runDirectory, RUN_HISTORY_FILENAME))).toBe(true);
        const progress = yield* readRunWorkflowState({
          configArg: fixture.configPath,
          cwd: fixture.target,
          runId: 'RUN-OWN-COLLIDE',
        }).pipe(Effect.provide(AppLive));
        expect(progress.workflowState).toBe('blocked');
        expect(progress.provenance).toBeNull();
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('resumes a partial provision only when ownership and the recorded head match Git', () =>
    Effect.gen(function* () {
      const fixture = setupRepositoryFixture('retry');
      try {
        const frozen = gitIn(fixture.target, ['rev-parse', 'HEAD']).trim();
        const partial = Layer.mergeAll(
          integrationHost,
          ReadinessFilesLive,
          RunIdentityLive,
          RunHistoryLive,
          RepositoryLeaseLive,
          failingRunGit('createWorktree'),
          GuidanceLive,
          capableRoleHostLauncher(),
        );
        const error = yield* record(fixture, { runId: 'RUN-OWN-RETRY' }, partial).pipe(Effect.flip);
        expect(error).toBeInstanceOf(RunWorkspaceBlocked);

        const runDirectory = fixture.runDirectory('RUN-OWN-RETRY');
        const history = readFileSync(join(runDirectory, RUN_HISTORY_FILENAME), 'utf8');
        expect(history).toContain('"type":"run-created"');
        expect(history).toContain('"type":"source-frozen"');
        expect(history).not.toContain('"type":"worktree-ready"');
        expect(gitIn(fixture.target, ['rev-parse', `foundry/${TASK_ID}`]).trim()).toBe(frozen);

        const blocked = yield* readRunWorkflowState({
          configArg: fixture.configPath,
          cwd: fixture.target,
          runId: 'RUN-OWN-RETRY',
        }).pipe(Effect.provide(AppLive));
        expect(blocked.workflowState).toBe('blocked');

        const resumed = yield* record(fixture, { runId: 'RUN-OWN-RETRY' });
        expect(resumed.provenance.sourceCommit).toBe(frozen);
        expect(gitIn(fixture.target, ['rev-parse', `foundry/${TASK_ID}`]).trim()).toBe(frozen);
        expect(
          gitIn(resumed.provenance.workspace, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
        ).toBe(`foundry/${TASK_ID}`);

        const planned = yield* readRunWorkflowState({
          configArg: fixture.configPath,
          cwd: fixture.target,
          runId: 'RUN-OWN-RETRY',
        }).pipe(Effect.provide(AppLive));
        expect(planned.workflowState).toBe('planning');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('blocks when the recorded head no longer matches the retried branch', () =>
    Effect.gen(function* () {
      const fixture = setupRepositoryFixture('moved');
      try {
        const partial = Layer.mergeAll(
          integrationHost,
          ReadinessFilesLive,
          RunIdentityLive,
          RunHistoryLive,
          RepositoryLeaseLive,
          failingRunGit('createWorktree'),
          GuidanceLive,
          capableRoleHostLauncher(),
        );
        yield* record(fixture, { runId: 'RUN-OWN-MOVED' }, partial).pipe(Effect.flip);

        writeFileSync(join(fixture.target, 'moved.txt'), 'moved\n');
        git(fixture.target, ['add', 'moved.txt']);
        git(fixture.target, ['commit', '-m', 'move branch elsewhere']);
        const movedCommit = gitIn(fixture.target, ['rev-parse', 'HEAD']).trim();
        git(fixture.target, ['branch', '-f', `foundry/${TASK_ID}`, movedCommit]);

        const error = yield* record(fixture, { runId: 'RUN-OWN-MOVED' }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(RunWorkspaceBlocked);
        if (!(error instanceof RunWorkspaceBlocked)) {
          throw new Error('Expected a RunWorkspaceBlocked error.');
        }
        expect(error.problem).toContain('another commit');
        expect(gitIn(fixture.target, ['rev-parse', `foundry/${TASK_ID}`]).trim()).toBe(movedCommit);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect(
    'rejects implementation results that are not a clean commit on the assigned branch',
    () =>
      Effect.gen(function* () {
        const fixture = setupRepositoryFixture('commit');
        try {
          const report = yield* record(fixture, { runId: 'RUN-OWN-COMMIT' });
          const workspace = report.provenance.workspace;
          const runDirectory = report.runDirectory;
          yield* appendAcceptedPlan(runDirectory, 'RUN-OWN-COMMIT');
          yield* transition(runDirectory, 'RUN-OWN-COMMIT', {
            route: 'plan-accepted',
          });

          writeFileSync(join(workspace, 'scratch.txt'), 'uncommitted\n');
          const dirty = yield* transition(runDirectory, 'RUN-OWN-COMMIT', {
            route: 'implementation-ready',
            branchClean: true,
            candidateCommit: report.provenance.sourceCommit,
            noChangeCandidateValidated: false,
          }).pipe(Effect.flip);
          expect(dirty).toBeInstanceOf(IllegalWorkflowTransition);
          if (!(dirty instanceof IllegalWorkflowTransition)) {
            throw new Error('Expected an IllegalWorkflowTransition.');
          }
          expect(dirty.reason).toContain('uncommitted');

          rmSync(join(workspace, 'scratch.txt'));
          writeFileSync(join(workspace, 'change.txt'), 'implemented\n');
          git(workspace, ['add', 'change.txt']);
          git(workspace, ['commit', '-m', 'implement']);
          const head = gitIn(workspace, ['rev-parse', 'HEAD']).trim();
          expect(head).not.toBe(report.provenance.sourceCommit);

          const mismatched = yield* transition(runDirectory, 'RUN-OWN-COMMIT', {
            route: 'implementation-ready',
            branchClean: true,
            candidateCommit: report.provenance.sourceCommit,
            noChangeCandidateValidated: false,
          }).pipe(Effect.flip);
          expect(mismatched).toBeInstanceOf(IllegalWorkflowTransition);
          if (!(mismatched instanceof IllegalWorkflowTransition)) {
            throw new Error('Expected an IllegalWorkflowTransition.');
          }
          expect(mismatched.reason).toContain('supplied candidate commit');

          git(workspace, ['checkout', '--detach']);
          const detached = yield* transition(runDirectory, 'RUN-OWN-COMMIT', {
            route: 'implementation-ready',
            branchClean: true,
            candidateCommit: head,
            noChangeCandidateValidated: false,
          }).pipe(Effect.flip);
          expect(detached).toBeInstanceOf(IllegalWorkflowTransition);
          if (!(detached instanceof IllegalWorkflowTransition)) {
            throw new Error('Expected an IllegalWorkflowTransition.');
          }
          expect(detached.reason).toContain('detached HEAD');

          git(workspace, ['checkout', `foundry/${TASK_ID}`]);
          const accepted = yield* transition(runDirectory, 'RUN-OWN-COMMIT', {
            route: 'implementation-ready',
            branchClean: true,
            candidateCommit: head,
            noChangeCandidateValidated: false,
          });
          expect(accepted.previousState).toBe('coding');
          expect(accepted.workflowState).toBe('verifying');
        } finally {
          fixture.cleanup();
        }
      }),
  );

  it.effect('rejects an incapable role host before provisioning any run-owned resource', () =>
    Effect.gen(function* () {
      const fixture = setupRepositoryFixture('incapable', [
        process.execPath,
        FIXTURE_PATH,
        'not-resumable',
        join(tmpdir(), 'foundry-role-host-incapable.log'),
      ]);
      try {
        const error = yield* record(
          fixture,
          { runId: 'RUN-INC' },
          Layer.mergeAll(AppBase, RoleHostLauncherLive),
        ).pipe(Effect.flip);

        expect(error).toBeInstanceOf(RoleHostCapabilityError);
        if (!(error instanceof RoleHostCapabilityError)) {
          throw new Error('Expected a RoleHostCapabilityError.');
        }
        expect(error.reason).toBe('not-resumable');
        expect(error.runId).toBe('RUN-INC');

        expect(existsSync(fixture.runDirectory('RUN-INC'))).toBe(false);
        expect(existsSync(join(fixture.target, '.agent', 'runs'))).toBe(false);
        expect(existsSync(join(fixture.target, '.agent', 'worktrees', TASK_ID))).toBe(false);
        expect(gitIn(fixture.target, ['branch', '--list', `foundry/${TASK_ID}`]).trim()).toBe('');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function partialRunDirectory(base: string, runId: string): string {
  return join(base, '.agent', 'runs', runId);
}

function seedPartialHistory(
  runDirectory: string,
  runId: string,
  drafts: ReadonlyArray<RunEventDraft>,
) {
  return Effect.gen(function* () {
    for (const [index, draft] of drafts.entries()) {
      yield* appendRunEvent({
        runDirectory,
        runId,
        createIfMissing: index === 0,
        build: () => Effect.succeed(draft),
      });
    }
  }).pipe(Effect.provide(RunHistoryLive));
}

function writePartialIdentity(
  runDirectory: string,
  runId: string,
  taskId: string,
  requestPath: string,
) {
  const originalText = readFileSync(requestPath, 'utf8');
  writeFileSync(
    join(runDirectory, REQUEST_IDENTITY_FILENAME),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        taskId,
        sourceRequestPath: requestPath,
        originalByteLength: Buffer.byteLength(originalText, 'utf8'),
        originalContentHash: sha256Hex(originalText),
        normalizedByteLength: Buffer.byteLength(originalText, 'utf8'),
        normalizedPromptHash: sha256Hex(originalText),
      },
      null,
      2,
    )}\n`,
  );
}

const RUN_CREATED_DRAFT: RunEventDraft = {
  type: 'run-created',
  payload: { taskId: TASK_ID },
};

const SOURCE_FROZEN_DRAFT: RunEventDraft = {
  type: 'source-frozen',
  payload: {
    repository: {
      repositoryRoot: '/target',
      gitDirectory: '/target/.git',
      remoteUrl: 'https://example.invalid/target.git',
    },
    sourceRemote: 'origin',
    sourceBranch: 'main',
    sourceCommit: SOURCE_COMMIT,
    taskBranch: `foundry/${TASK_ID}`,
    workspace: `/target/.agent/worktrees/${TASK_ID}`,
    expectedHead: SOURCE_COMMIT,
  },
};

const WORKTREE_READY_DRAFT: RunEventDraft = {
  type: 'worktree-ready',
  payload: {
    taskBranch: `foundry/${TASK_ID}`,
    workspace: `/target/.agent/worktrees/${TASK_ID}`,
    headCommit: SOURCE_COMMIT,
    baseCommit: SOURCE_COMMIT,
  },
};

const GUIDANCE_FROZEN_DRAFT: RunEventDraft = {
  type: 'guidance-frozen',
  payload: {
    sourceCommit: SOURCE_COMMIT,
    manifestPath: 'guidance-manifest.json',
    aggregateHash: 'f'.repeat(64),
    files: [],
  },
};

describe('provisioning progress cannot leak planning', () => {
  function setupPartialFixture(label: string) {
    const base = mkdtempSync(join(tmpdir(), `foundry-partial-${label}-`));
    const target = join(base, 'target');
    const home = join(base, 'home');
    mkdirSync(target, { recursive: true });
    mkdirSync(home, { recursive: true });
    const configPath = join(home, 'foundry.config.json');
    writeFileSync(configPath, JSON.stringify(goldenDocument(target)));
    const requestPath = join(home, 'request.md');
    writeFileSync(requestPath, 'partial ask\n');
    return {
      base,
      target,
      configPath,
      requestPath,
      cleanup: () => rmSync(base, { recursive: true, force: true }),
    };
  }

  it.effect('derives blocked for run-created and source-frozen prefixes through status', () =>
    Effect.gen(function* () {
      const fixture = setupPartialFixture('status');
      try {
        const runId = 'RUN-PARTIAL';
        const runDirectory = partialRunDirectory(fixture.target, runId);
        mkdirSync(runDirectory, { recursive: true });
        writePartialIdentity(runDirectory, runId, TASK_ID, fixture.requestPath);
        yield* seedPartialHistory(runDirectory, runId, [RUN_CREATED_DRAFT]);

        const genesisOnly = yield* readRunWorkflowState({
          configArg: fixture.configPath,
          cwd: fixture.target,
          runId,
        }).pipe(Effect.provide(Layer.mergeAll(ReadinessFilesLive, RunHistoryLive)));
        expect(genesisOnly.workflowState).toBe('blocked');
        expect(genesisOnly.provenance).toBeNull();

        yield* seedPartialHistory(runDirectory, runId, [SOURCE_FROZEN_DRAFT]);
        const frozenOnly = yield* readRunWorkflowState({
          configArg: fixture.configPath,
          cwd: fixture.target,
          runId,
        }).pipe(Effect.provide(Layer.mergeAll(ReadinessFilesLive, RunHistoryLive)));
        expect(frozenOnly.workflowState).toBe('blocked');
        expect(frozenOnly.provenance).toBeNull();

        const durable = readFileSync(join(runDirectory, WORKFLOW_STATE_FILENAME), 'utf8');
        expect(durable).toContain('"state": "blocked"');
        expect(durable).not.toContain('"state": "planning"');

        yield* seedPartialHistory(runDirectory, runId, [
          GUIDANCE_FROZEN_DRAFT,
          WORKTREE_READY_DRAFT,
        ]);
        const readyOnly = yield* reconcileRunReports({ runDirectory, runId }).pipe(
          Effect.provide(RunHistoryLive),
        );
        expect(readyOnly.workflowState).toBe('blocked');

        yield* seedPartialHistory(runDirectory, runId, [
          {
            type: 'workflow-transition',
            payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
          },
        ]);
        const planned = yield* readRunWorkflowState({
          configArg: fixture.configPath,
          cwd: fixture.target,
          runId,
        }).pipe(Effect.provide(Layer.mergeAll(ReadinessFilesLive, RunHistoryLive)));
        expect(planned.workflowState).toBe('planning');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('replaces a forged stale planning report with the derived blocked state', () =>
    Effect.gen(function* () {
      const fixture = setupPartialFixture('forged');
      try {
        const runId = 'RUN-FORGED';
        const runDirectory = partialRunDirectory(fixture.target, runId);
        mkdirSync(runDirectory, { recursive: true });
        writePartialIdentity(runDirectory, runId, TASK_ID, fixture.requestPath);
        yield* seedPartialHistory(runDirectory, runId, [RUN_CREATED_DRAFT, SOURCE_FROZEN_DRAFT]);
        writeFileSync(
          join(runDirectory, WORKFLOW_STATE_FILENAME),
          `${JSON.stringify(
            {
              schemaVersion: WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
              runId,
              state: 'planning',
              checkpoint: null,
              attempts: [],
            },
            null,
            2,
          )}\n`,
        );

        const report = yield* reconcileRunReports({ runDirectory, runId }).pipe(
          Effect.provide(RunHistoryLive),
        );
        expect(report.workflowState).toBe('blocked');
        const document = Schema.decodeUnknownSync(WorkflowProgressDocumentSchema, {
          onExcessProperty: 'error',
        })(JSON.parse(readFileSync(join(runDirectory, WORKFLOW_STATE_FILENAME), 'utf8')));
        expect(document.state).toBe('blocked');
        expect(document.runId).toBe(runId);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
