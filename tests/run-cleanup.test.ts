import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { disposeRunResources } from '../src/application/run-cleanup/index.js';
import { HANDOFF_FILENAME, HandoffDocumentSchema } from '../src/application/handoff/index.js';
import { ProjectRuntimeError } from '../src/application/project-runtime/index.js';
import {
  OwnedProjectProcess,
  ProjectCommandProcess,
  ProjectEvidenceStore,
} from '../src/application/project-commands/index.js';
import { ReadinessGit, ReadinessHost } from '../src/application/readiness/index.js';
import {
  RoleHost,
  RoleHostLauncher,
  RoleHostOperationalError,
} from '../src/application/role-conversations/index.js';
import {
  RunIdentityStore,
  RunIdentityStorageError,
} from '../src/application/run-identity/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { buildRunStatus } from '../src/application/status/index.js';
import { decodeProjectConfiguration } from '../src/application/project-configuration.js';
import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { GuidanceLive } from '../src/platform/guidance.js';
import { RunGitLive } from '../src/platform/git-provisioning.js';
import { ProjectCommandsPlatformLive } from '../src/platform/project-commands.js';
import { ReadinessFilesLive, ReadinessGitLive } from '../src/platform/readiness.js';
import { RepositoryLeaseLive } from '../src/platform/repository-lease.js';
import { RoleTurnResourceObserverLive } from '../src/platform/role-permissions.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import {
  CAPABLE_ROLE_HOST_CAPABILITIES,
  scriptedRoleHostLauncher,
} from './fixtures/role-host/role-host-launcher.js';
import { goldenConfigurationDocument } from './fixtures/checks-runtime-run.js';

import type { RuntimeLifecycleRecord } from '../src/domain/project-runtime.js';
import type { RunCleanupResource } from '../src/domain/run-cleanup.js';
import type { RunEventDraft } from '../src/domain/run-history.js';
import type { HeldApplicationRuntime } from '../src/application/project-runtime/index.js';
import type { RunStatusReport } from '../src/application/status/index.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);
const HandoffDocumentJson = Schema.fromJsonString(HandoffDocumentSchema);

const RUN_ID = 'RUN-CLEANUP';
const WORKSPACE = '/target/.agent/worktrees/RUN-CLEANUP';
const TASK_BRANCH = 'foundry/TASK-CLEANUP';
const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OCCURRED_AT = '2026-09-13T00:00:00.000Z';
const RUNTIME_IDENTITY = {
  adapterVersion: 'test',
  provider: 'test',
  model: 'test',
  toolProfile: 'test',
};

function runtimeRecord(cleanup: RuntimeLifecycleRecord['cleanup']): RuntimeLifecycleRecord {
  return {
    repository: '/target',
    commit: FROZEN_COMMIT,
    baseUrl: 'http://127.0.0.1:3000',
    runtimeKind: 'application',
    startedAt: OCCURRED_AT,
    readyAt: OCCURRED_AT,
    stoppedAt: OCCURRED_AT,
    outcome: 'ready',
    cleanup,
    dataPreserved: true,
    stages: [],
  };
}

function heldRuntime(dispose: HeldApplicationRuntime['dispose']): HeldApplicationRuntime {
  return { baseUrl: 'http://127.0.0.1:3000', record: runtimeRecord('not_owned'), dispose };
}

interface UnitFixture {
  readonly runDirectory: string;
  readonly removed: Array<string>;
  readonly cleanup: () => void;
}

function setupUnitFixture(): UnitFixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-run-cleanup-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    removed: [],
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function fakeStore(fixture: UnitFixture, failRemoval = false): Layer.Layer<RunIdentityStore> {
  return Layer.succeed(
    RunIdentityStore,
    RunIdentityStore.of({
      statPath: () => Effect.succeed({ exists: false, isRegularFile: false }),
      readFileBytes: () => Effect.succeed(new Uint8Array()),
      ensureParentDirectory: () => Effect.void,
      createRunDirectoryExclusive: () => Effect.void,
      writeFileBytes: () => Effect.void,
      removeDirectory: (path: string) =>
        failRemoval
          ? Effect.fail(new RunIdentityStorageError({ message: 'removal refused', runId: RUN_ID }))
          : Effect.sync(() => {
              fixture.removed.push(path);
            }),
      listRuns: () => Effect.succeed([]),
    }),
  );
}

function failingStopLauncher(): Layer.Layer<RoleHostLauncher> {
  return Layer.succeed(
    RoleHostLauncher,
    RoleHostLauncher.of({
      launch: () =>
        Layer.succeed(
          RoleHost,
          RoleHost.of({
            capabilities: () => Effect.succeed(CAPABLE_ROLE_HOST_CAPABILITIES),
            create: () => Effect.die(new Error('unused create')),
            submit: () => Effect.die(new Error('unused submit')),
            observe: () => Effect.die(new Error('unused observe')),
            stop: () =>
              Effect.fail(
                new RoleHostOperationalError({ message: 'host unavailable', operation: 'stop' }),
              ),
          }),
        ),
    }),
  );
}

function unusedProcess(): Layer.Layer<
  OwnedProjectProcess | ProjectCommandProcess | ProjectEvidenceStore | ReadinessGit
> {
  return Layer.mergeAll(
    Layer.succeed(
      OwnedProjectProcess,
      OwnedProjectProcess.of({
        start: () => Effect.die(new Error('unused start')),
        terminate: () => Effect.die(new Error('unused terminate')),
      }),
    ),
    Layer.succeed(
      ProjectCommandProcess,
      ProjectCommandProcess.of({ run: () => Effect.die(new Error('unused run')) }),
    ),
    Layer.succeed(
      ProjectEvidenceStore,
      ProjectEvidenceStore.of({ write: () => Effect.die(new Error('unused write')) }),
    ),
    Layer.succeed(
      ReadinessGit,
      ReadinessGit.of({ run: () => Effect.die(new Error('unused git')) }),
    ),
  );
}

function emit(runDirectory: string, createIfMissing: boolean, draft: RunEventDraft) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing,
    build: () => Effect.succeed(draft),
  });
}

function seedHistory(fixture: UnitFixture, withRoleSessions: boolean) {
  return Effect.gen(function* () {
    yield* emit(fixture.runDirectory, true, {
      type: 'run-created',
      payload: { taskId: 'TASK-CLEANUP' },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'source-frozen',
      payload: {
        repository: {
          repositoryRoot: '/target',
          gitDirectory: '/target/.git',
          remoteUrl: 'https://example.invalid/target.git',
        },
        sourceRemote: 'origin',
        sourceBranch: 'main',
        sourceCommit: FROZEN_COMMIT,
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        expectedHead: FROZEN_COMMIT,
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'guidance-frozen',
      payload: {
        sourceCommit: FROZEN_COMMIT,
        manifestPath: 'guidance-manifest.json',
        aggregateHash: 'f'.repeat(64),
        files: [],
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'worktree-ready',
      payload: {
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        headCommit: FROZEN_COMMIT,
        baseCommit: FROZEN_COMMIT,
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
    });
    if (withRoleSessions) {
      for (const [role, attempt] of [
        ['architect', 1],
        ['reviewer', 2],
      ] as const) {
        yield* emit(fixture.runDirectory, false, {
          type: 'role-session-created',
          payload: {
            role,
            attempt,
            generation: attempt,
            sessionId: `session-${role}`,
            ownershipToken: `owner-${role}`,
            sequence: 0,
            runtimeIdentity: RUNTIME_IDENTITY,
            workingDirectory: WORKSPACE,
          },
        });
      }
    }
  }).pipe(Effect.provide(RunHistoryLive));
}

function options(fixture: UnitFixture, runtime: HeldApplicationRuntime | null) {
  const configuration = Effect.runSync(
    decodeProjectConfiguration(goldenConfigurationDocument('/target', false), '/target'),
  );
  return {
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    configuration,
    runtime,
  };
}

function unitLayers(
  fixture: UnitFixture,
  roleHost: Layer.Layer<RoleHostLauncher>,
  failRemoval = false,
) {
  return Layer.mergeAll(RunHistoryLive, fakeStore(fixture, failRemoval), roleHost, unusedProcess());
}

describe('disposeRunResources', () => {
  it.live('releases the runtime, role sessions, and worktree with a succeeded outcome', () =>
    Effect.gen(function* () {
      const fixture = setupUnitFixture();
      try {
        yield* seedHistory(fixture, true);
        const report = yield* disposeRunResources(
          options(fixture, heldRuntime(Effect.succeed(runtimeRecord('disposed')))),
        ).pipe(Effect.provide(unitLayers(fixture, scriptedRoleHostLauncher({}))));
        expect(report).not.toBeNull();
        expect(report?.outcome).toBe('succeeded');
        expect(resourceOf(report?.resources ?? [], 'runtime')?.disposition).toBe('disposed');
        expect(fixture.removed).toEqual([WORKSPACE]);
        const stopped = (report?.resources ?? []).filter(
          (resource) => resource.kind === 'role-session',
        );
        expect(stopped).toHaveLength(2);
        expect(stopped.every((resource) => resource.disposition === 'disposed')).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('reports a warning when a role session cannot be stopped', () =>
    Effect.gen(function* () {
      const fixture = setupUnitFixture();
      try {
        yield* seedHistory(fixture, true);
        const report = yield* disposeRunResources(options(fixture, null)).pipe(
          Effect.provide(unitLayers(fixture, failingStopLauncher())),
        );
        expect(report?.outcome).toBe('warning');
        const sessions = (report?.resources ?? []).filter(
          (resource) => resource.kind === 'role-session',
        );
        expect(sessions.every((resource) => resource.disposition === 'pending')).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('reports a failure naming the worktree when it cannot be removed', () =>
    Effect.gen(function* () {
      const fixture = setupUnitFixture();
      try {
        yield* seedHistory(fixture, false);
        const report = yield* disposeRunResources(options(fixture, null)).pipe(
          Effect.provide(unitLayers(fixture, scriptedRoleHostLauncher({}), true)),
        );
        expect(report?.outcome).toBe('failed');
        const workspace = resourceOf(report?.resources ?? [], 'workspace');
        expect(workspace?.name).toBe(WORKSPACE);
        expect(workspace?.disposition).toBe('failed');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('reports a failure when the owned runtime cannot be disposed', () =>
    Effect.gen(function* () {
      const fixture = setupUnitFixture();
      try {
        yield* seedHistory(fixture, false);
        const report = yield* disposeRunResources(
          options(
            fixture,
            heldRuntime(Effect.fail(new ProjectRuntimeError({ message: 'no stop' }))),
          ),
        ).pipe(Effect.provide(unitLayers(fixture, scriptedRoleHostLauncher({}))));
        expect(report?.outcome).toBe('failed');
        expect(resourceOf(report?.resources ?? [], 'runtime')?.disposition).toBe('failed');
        expect(fixture.removed).toEqual([WORKSPACE]);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('leaves an already-cleaned run untouched', () =>
    Effect.gen(function* () {
      const fixture = setupUnitFixture();
      try {
        yield* seedHistory(fixture, false);
        yield* emit(fixture.runDirectory, false, {
          type: 'cleanup-progress',
          payload: { outcome: 'succeeded', detail: 'already done' },
        }).pipe(Effect.provide(RunHistoryLive));
        const report = yield* disposeRunResources(options(fixture, null)).pipe(
          Effect.provide(unitLayers(fixture, scriptedRoleHostLauncher({}))),
        );
        expect(report).toBeNull();
        expect(fixture.removed).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

function resourceOf(
  resources: ReadonlyArray<RunCleanupResource>,
  kind: RunCleanupResource['kind'],
): RunCleanupResource | undefined {
  return resources.find((resource) => resource.kind === kind);
}

interface IntegrationFixture {
  readonly base: string;
  readonly target: string;
  readonly remote: string;
  readonly configPath: string;
  readonly requestPath: string;
  readonly cleanup: () => void;
}

function gitExec(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

function setupFixture(): IntegrationFixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-run-cleanup-live-'));
  const target = join(base, 'target');
  const remote = join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', target], { encoding: 'utf8' });
  gitExec(target, ['config', 'user.email', 'cleanup@example.com']);
  gitExec(target, ['config', 'user.name', 'Foundry Cleanup']);
  writeFileSync(join(target, '.gitignore'), '.agent\n');
  writeFileSync(join(target, 'README.md'), '# target\n');
  gitExec(target, ['add', '.gitignore', 'README.md']);
  gitExec(target, ['commit', '-m', 'initial']);
  gitExec(target, ['remote', 'add', 'origin', remote]);
  gitExec(target, ['push', '-u', 'origin', 'main']);
  const configPath = join(base, 'foundry.config.json');
  writeFileSync(configPath, JSON.stringify(goldenConfigurationDocument(target, false)));
  const requestPath = join(base, 'request.md');
  writeFileSync(requestPath, '# Outcome\n\nKeep the result while releasing resources.\n');
  return {
    base,
    target,
    remote,
    configPath,
    requestPath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const capabilityLayers = Layer.mergeAll(
  Layer.succeed(
    ReadinessHost,
    ReadinessHost.of({
      platform: Effect.succeed('linux'),
      nodeVersion: Effect.succeed('v24.0.0'),
      npmVersion: Effect.succeed('11.0.0'),
      gitVersionOutput: Effect.succeed('git version 2.45.0'),
    }),
  ),
  ReadinessFilesLive,
  ReadinessGitLive,
  Layer.succeed(
    ProjectCommandProcess,
    ProjectCommandProcess.of({
      run: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
    }),
  ),
  ProjectCommandsPlatformLive,
  RunIdentityLive,
  RunHistoryLive,
  RepositoryLeaseLive,
  RoleTurnResourceObserverLive,
  RunGitLive,
  GuidanceLive,
);

function runNoChange(fixture: IntegrationFixture, runId: string) {
  const roleHost = scriptedRoleHostLauncher({
    architect: {
      narrative: 'The frozen source already satisfies the request.',
      control: {
        schemaVersion: 1,
        outcome: 'no_change_candidate',
        acceptanceCriteria: ['the result is preserved'],
        runtimeValidation: 'not_required',
      },
    },
    reviewer: {
      narrative: 'The verified source already satisfies the request.',
      control: { schemaVersion: 1, outcome: 'approved' },
    },
  });
  return runCli([
    'run',
    '--config',
    fixture.configPath,
    '--request',
    fixture.requestPath,
    '--task-id',
    'TASK-CLEANUP',
    '--run-id',
    runId,
    '--json',
  ]).pipe(Effect.provide(Layer.mergeAll(capabilityLayers, roleHost)));
}

function readHistory(fixture: IntegrationFixture, runId: string) {
  return readVerifiedRunHistory({
    runDirectory: join(fixture.target, '.agent', 'runs', runId),
    runId,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

describe('end of run disposal', () => {
  it.live('ends a completed run with cleanup progress and preserves the result', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const runId = 'RUN-CLEANUP-LIVE';
        const result = yield* runNoChange(fixture, runId);
        expect(result.exitCode).toBe(0);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(true);
        if (!envelope.ok || !('workflowState' in envelope.data)) {
          throw new Error(`Expected a run envelope: ${result.stdout}`);
        }
        expect(envelope.data.workflowState).toBe('completed_no_change');

        const history = yield* readHistory(fixture, runId);
        expect(history.derived.state).toBe('completed_no_change');
        const last = history.events[history.events.length - 1];
        expect(last?.type).toBe('cleanup-progress');
        expect(history.derived.cleanupProgress?.outcome).toBe('succeeded');
        expect(
          history.derived.roleSessions.every((session) => session.stopDisposition !== null),
        ).toBe(true);

        const workspace = history.derived.worktreeReady?.workspace ?? null;
        expect(workspace).not.toBeNull();
        expect(existsSync(workspace ?? '')).toBe(false);

        const taskBranch = history.derived.worktreeReady?.taskBranch ?? null;
        expect(taskBranch).not.toBeNull();
        expect(
          gitExec(fixture.target, [
            'rev-parse',
            '--verify',
            `refs/heads/${taskBranch ?? ''}`,
          ]).trim().length,
        ).toBeGreaterThan(0);

        const handoff = Schema.decodeUnknownSync(HandoffDocumentJson)(
          readFileSync(join(fixture.target, '.agent', 'runs', runId, HANDOFF_FILENAME), 'utf8'),
        );
        expect(handoff.outcome).toBe('completed_no_change');
        expect(handoff.resultCommit).toBeNull();
        expect(handoff.source?.taskBranch).toBe(taskBranch);
        expect(handoff.retentionCleanup?.outcome).toBe('succeeded');

        const status: RunStatusReport = buildRunStatus({
          runDirectory: join(fixture.target, '.agent', 'runs', runId),
          history,
          nowMillis: Date.parse(OCCURRED_AT),
        });
        expect(status.workflowState).toBe('completed_no_change');
        expect(status.cleanupProgress?.outcome).toBe('succeeded');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
