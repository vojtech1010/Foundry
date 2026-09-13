import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import { ProjectCommandProcess } from '../src/application/project-commands/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { ReadinessHost } from '../src/application/readiness/index.js';
import { routeAfterProjectChecks } from '../src/application/validation-routing/index.js';
import { GuidanceLive } from '../src/platform/guidance.js';
import { RunGitLive } from '../src/platform/git-provisioning.js';
import { ProjectCommandsPlatformLive } from '../src/platform/project-commands.js';
import {
  PublicationProbeLive,
  ReadinessFilesLive,
  ReadinessGitLive,
} from '../src/platform/readiness.js';
import { RepositoryLeaseLive } from '../src/platform/repository-lease.js';
import { RoleTurnResourceObserverLive } from '../src/platform/role-permissions.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import {
  IMPLEMENTED_COMMIT,
  RUN_ID,
  goldenConfigurationDocument,
  passingVerificationReport,
  seedVerifyingRun,
} from './fixtures/checks-runtime-run.js';
import { scriptedRoleHostLauncher } from './fixtures/role-host/role-host-launcher.js';

import type { RunEvent } from '../src/domain/run-history.js';
import type { RoleHostRole } from '../src/domain/role-host.js';
import type { ScriptedRoleTurn } from './fixtures/role-host/role-host-launcher.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

interface Fixture {
  readonly base: string;
  readonly target: string;
  readonly configPath: string;
  readonly requestPath: string;
  readonly cleanup: () => void;
}

function gitExec(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

function setupFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-checks-runtime-'));
  const target = join(base, 'target');
  const remote = join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', target], { encoding: 'utf8' });
  gitExec(target, ['config', 'user.email', 'checks@example.com']);
  gitExec(target, ['config', 'user.name', 'Foundry Checks']);
  writeFileSync(join(target, '.gitignore'), '.agent\n');
  writeFileSync(join(target, 'README.md'), '# target\n');
  gitExec(target, ['add', '.gitignore', 'README.md']);
  gitExec(target, ['commit', '-m', 'initial']);
  gitExec(target, ['remote', 'add', 'origin', remote]);
  gitExec(target, ['push', '-u', 'origin', 'main']);
  const configPath = join(base, 'foundry.config.json');
  writeFileSync(configPath, JSON.stringify(goldenConfigurationDocument(target, true)));
  const requestPath = join(base, 'request.md');
  writeFileSync(requestPath, '# Outcome\n\nMake the app observable.\n');
  return {
    base,
    target,
    configPath,
    requestPath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

interface LoadedConfiguration {
  readonly calls: Array<ReadonlyArray<string>>;
  readonly failBootstrap: boolean;
}

function capabilityLayers(options: LoadedConfiguration) {
  return Layer.mergeAll(
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
    PublicationProbeLive,
    Layer.succeed(
      ProjectCommandProcess,
      ProjectCommandProcess.of({
        run: (runOptions: { readonly command: ReadonlyArray<string>; readonly cwd: string }) => {
          options.calls.push([...runOptions.command]);
          const fails = options.failBootstrap && runOptions.command[0] === 'bootstrap-tool';
          return Effect.succeed(
            fails
              ? { exitCode: 1, stdout: '', stderr: 'the bootstrap failed' }
              : { exitCode: 0, stdout: '', stderr: '' },
          );
        },
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
}

function runFlow(
  fixture: Fixture,
  runId: string,
  turns: Partial<Record<RoleHostRole, ScriptedRoleTurn | ReadonlyArray<ScriptedRoleTurn>>>,
  options: LoadedConfiguration,
) {
  const roleHost = scriptedRoleHostLauncher(turns);
  return runCli([
    'run',
    '--config',
    fixture.configPath,
    '--request',
    fixture.requestPath,
    '--task-id',
    'TASK-CHECKS-RUNTIME',
    '--run-id',
    runId,
    '--json',
  ]).pipe(Effect.provide(Layer.mergeAll(capabilityLayers(options), roleHost)));
}

function readHistory(fixture: Fixture, runId: string) {
  return readVerifiedRunHistory({
    runDirectory: join(fixture.target, '.agent', 'runs', runId),
    runId,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

function indexOfEvent(
  events: ReadonlyArray<RunEvent>,
  predicate: (event: RunEvent, index: number) => boolean,
): number {
  return events.findIndex((event, index) => predicate(event, index));
}

const requiredPlan = {
  narrative: 'The plan requires live application validation.',
  control: {
    schemaVersion: 1,
    outcome: 'plan_ready',
    acceptanceCriteria: ['the app is observable'],
    runtimeValidation: 'required',
    execution: 'sequential',
  },
} as const;

const notRequiredPlan = {
  narrative: 'The plan does not require live application validation.',
  control: {
    schemaVersion: 1,
    outcome: 'plan_ready',
    acceptanceCriteria: ['the app is observable'],
    runtimeValidation: 'not_required',
    execution: 'sequential',
  },
} as const;

const observedTester = {
  narrative: 'The application was observed read-only.',
  control: { schemaVersion: 1, outcome: 'observed' },
} as const;

const approvingReviewer = {
  narrative: 'The verified source satisfies the request.',
  control: { schemaVersion: 1, outcome: 'approved' },
} as const;

describe('project checks finish before the application starts', () => {
  it.live('keeps the application stopped and blocks when required checks fail', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const options: LoadedConfiguration = { calls: [], failBootstrap: true };
        const result = yield* runFlow(
          fixture,
          'RUN-CHECKS-FAIL',
          {
            architect: requiredPlan,
            coder: {
              narrative: 'No implementation change is required.',
              control: { schemaVersion: 1, outcome: 'no_change_candidate' },
            },
          },
          options,
        );

        expect(result.exitCode).toBe(1);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(false);
        if (envelope.ok) {
          throw new Error(`Expected a blocked failure envelope: ${result.stdout}`);
        }
        expect(envelope.error.kind).toBe('blocked');

        const history = yield* readHistory(fixture, 'RUN-CHECKS-FAIL');
        expect(history.derived.state).toBe('blocked');
        expect(history.derived.verifications).toHaveLength(1);
        expect(history.derived.verifications[0]?.result).toBe('failed');
        expect(history.derived.runtimeLifecycles).toHaveLength(0);
        expect(history.derived.roleSessions.some((session) => session.role === 'tester')).toBe(
          false,
        );
        expect(options.calls.some((call) => call[0] === 'runtime-tool')).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('orders verification, runtime preparation, and testing, without rerunning checks', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const options: LoadedConfiguration = { calls: [], failBootstrap: false };
        const result = yield* runFlow(
          fixture,
          'RUN-CHECKS-ORDER',
          {
            architect: requiredPlan,
            coder: {
              narrative: 'No implementation change is required.',
              control: { schemaVersion: 1, outcome: 'no_change_candidate' },
            },
            tester: observedTester,
            reviewer: approvingReviewer,
          },
          options,
        );

        expect(result.exitCode).toBe(0);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(true);
        if (!envelope.ok || !('workflowState' in envelope.data)) {
          throw new Error(`Expected a run workflow envelope: ${result.stdout}`);
        }
        expect(envelope.data.workflowState).toBe('completed_no_change');

        const history = yield* readHistory(fixture, 'RUN-CHECKS-ORDER');
        const verificationIndex = indexOfEvent(
          history.events,
          (event) => event.type === 'verification-completed' && event.payload.result === 'passed',
        );
        const readyIndex = indexOfEvent(
          history.events,
          (event, index) =>
            index > verificationIndex &&
            event.type === 'runtime-lifecycle' &&
            event.payload.outcome === 'ready',
        );
        const testingIndex = indexOfEvent(
          history.events,
          (event) =>
            event.type === 'workflow-transition' && event.payload.route === 'checks-passed-testing',
        );
        expect(verificationIndex).toBeGreaterThanOrEqual(0);
        expect(readyIndex).toBeGreaterThan(verificationIndex);
        expect(testingIndex).toBeGreaterThan(readyIndex);

        const count = (executable: string) =>
          options.calls.filter((call) => call[0] === executable).length;
        for (const executable of [
          'bootstrap-tool',
          'fmt',
          'lint-tool',
          'tsc',
          'test-tool',
          'build-tool',
        ]) {
          expect(count(executable)).toBe(1);
        }
        expect(count('runtime-tool')).toBeGreaterThanOrEqual(4);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('records a Tester skip only after the commit-bound checks pass', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const options: LoadedConfiguration = { calls: [], failBootstrap: false };
        const result = yield* runFlow(
          fixture,
          'RUN-CHECKS-SKIP',
          {
            architect: notRequiredPlan,
            coder: {
              narrative: 'No implementation change is required.',
              control: { schemaVersion: 1, outcome: 'no_change_candidate' },
            },
            reviewer: approvingReviewer,
          },
          options,
        );

        expect(result.exitCode).toBe(0);
        const history = yield* readHistory(fixture, 'RUN-CHECKS-SKIP');
        expect(history.derived.state).toBe('completed_no_change');
        expect(history.derived.testerSkips).toHaveLength(1);
        expect(history.derived.roleSessions.some((session) => session.role === 'tester')).toBe(
          false,
        );

        const verificationIndex = indexOfEvent(
          history.events,
          (event) => event.type === 'verification-completed' && event.payload.result === 'passed',
        );
        const skipIndex = indexOfEvent(history.events, (event) => event.type === 'tester-skipped');
        expect(verificationIndex).toBeGreaterThanOrEqual(0);
        expect(skipIndex).toBeGreaterThan(verificationIndex);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

function stubGit(): Layer.Layer<RunGit> {
  const unused = (name: string) =>
    Effect.die(new Error(`checks-before-runtime routing must not call RunGit.${name}`));
  return Layer.succeed(
    RunGit,
    RunGit.of({
      inspectRepository: () => unused('inspectRepository'),
      fetchSource: () => unused('fetchSource'),
      commitExists: () => unused('commitExists'),
      readBranch: () => unused('readBranch'),
      createBranch: () => unused('createBranch'),
      readWorktree: () => unused('readWorktree'),
      createWorktree: () => unused('createWorktree'),
      observeImplementation: () => unused('observeImplementation'),
    }),
  );
}

function appendRuntimeReady(runDirectory: string) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
    build: () =>
      Effect.succeed({
        type: 'runtime-lifecycle',
        payload: {
          repository: '/target',
          commit: IMPLEMENTED_COMMIT,
          baseUrl: 'http://127.0.0.1:3000',
          runtimeKind: 'application' as const,
          startedAt: '2026-09-13T00:00:00.000Z',
          readyAt: '2026-09-13T00:00:01.000Z',
          stoppedAt: '2026-09-13T00:00:02.000Z',
          outcome: 'ready' as const,
          cleanup: 'disposed' as const,
          dataPreserved: true,
          stages: [],
        },
      } as const),
  });
}

function appendVerification(runDirectory: string) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
    build: () =>
      Effect.succeed({ type: 'verification-completed', payload: passingVerificationReport() }),
  });
}

describe('runtime readiness must follow the commit-bound checks', () => {
  it.effect('refuses the testing route when a ready runtime predates verification', () =>
    Effect.gen(function* () {
      const base = mkdtempSync(join(tmpdir(), 'foundry-checks-routing-'));
      const runDirectory = join(base, '.agent', 'runs', RUN_ID);
      mkdirSync(runDirectory, { recursive: true });
      const Live = Layer.mergeAll(RunHistoryLive, stubGit());
      try {
        yield* seedVerifyingRun({ runDirectory, runtimeValidationRequired: true }).pipe(
          Effect.provide(Live),
        );
        yield* appendRuntimeReady(runDirectory).pipe(Effect.provide(Live));
        yield* appendVerification(runDirectory).pipe(Effect.provide(Live));

        const route = yield* routeAfterProjectChecks({
          runDirectory,
          runId: RUN_ID,
          correctionRoundsRemaining: 1,
        }).pipe(Effect.provide(Live));

        expect(route.route).toBe('limitation');
        const history = yield* readVerifiedRunHistory({
          runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(Live));
        expect(history.derived.state).toBe('verifying');
        expect(history.derived.validationLimitations).toHaveLength(1);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }),
  );
});
