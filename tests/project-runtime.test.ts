import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeProjectConfiguration } from '../src/application/project-configuration.js';
import {
  OwnedProjectProcess,
  ProjectCommandError,
  ProjectCommandProcess,
  ProjectEvidenceStore,
} from '../src/application/project-commands/index.js';
import { runApplicationRuntime } from '../src/application/project-runtime/index.js';
import { ReadinessGit } from '../src/application/readiness/index.js';
import { readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import {
  IMPLEMENTED_COMMIT,
  RUN_ID,
  goldenConfigurationDocument,
  seedVerifyingRun,
} from './fixtures/checks-runtime-run.js';

import type { ProjectConfiguration } from '../src/domain/project-configuration.js';
import type { ProjectRuntimeResult } from '../src/application/project-runtime/index.js';
import type {
  OwnedProcessHandle,
  ProjectCommandResult,
} from '../src/application/project-commands/index.js';

type Script = () => Effect.Effect<ProjectCommandResult, ProjectCommandError>;

interface RuntimeWorld {
  readonly layer: Layer.Layer<
    ReadinessGit | ProjectCommandProcess | ProjectEvidenceStore | OwnedProjectProcess
  >;
  readonly calls: Array<ReadonlyArray<string>>;
  readonly starts: Array<ReadonlyArray<string>>;
  readonly terminations: { count: number };
  readonly state: { status: string };
}

function buildRuntimeWorld(options: {
  readonly handlers: Record<string, Script>;
  readonly disposition?: 'disposed' | 'forced' | 'not_owned' | 'failed';
  readonly state?: { status: string };
}): RuntimeWorld {
  const calls: Array<ReadonlyArray<string>> = [];
  const starts: Array<ReadonlyArray<string>> = [];
  const terminations = { count: 0 };
  const state = options.state ?? { status: '' };
  const layer = Layer.mergeAll(
    Layer.succeed(
      ReadinessGit,
      ReadinessGit.of({
        run: (args: ReadonlyArray<string>) =>
          Effect.sync(() => {
            if (args[0] === 'rev-parse') {
              return { stdout: `${IMPLEMENTED_COMMIT}\n`, exitCode: 0 };
            }
            if (args[0] === 'status') {
              return { stdout: state.status, exitCode: 0 };
            }
            if (args[0] === 'reset') {
              state.status = '';
              return { stdout: '', exitCode: 0 };
            }
            return { stdout: '', exitCode: 0 };
          }),
      }),
    ),
    Layer.succeed(
      ProjectCommandProcess,
      ProjectCommandProcess.of({
        run: (runOptions) => {
          calls.push([...runOptions.command]);
          const subcommand = runOptions.command[1] ?? '';
          const handler = options.handlers[subcommand];
          if (handler === undefined) {
            return Effect.fail(
              new ProjectCommandError({
                message: `Unexpected runtime command ${runOptions.command.join(' ')}`,
              }),
            );
          }
          return handler();
        },
      }),
    ),
    Layer.succeed(ProjectEvidenceStore, ProjectEvidenceStore.of({ write: () => Effect.void })),
    Layer.succeed(
      OwnedProjectProcess,
      OwnedProjectProcess.of({
        start: (startOptions) => {
          starts.push([...startOptions.command]);
          const handle: OwnedProcessHandle = {
            id: 'owned-1',
            pid: 4242,
            command: [...startOptions.command],
          };
          return Effect.succeed(handle);
        },
        terminate: () =>
          Effect.sync(() => {
            terminations.count += 1;
            return {
              disposition: options.disposition ?? 'disposed',
              detail: 'test termination',
            };
          }),
      }),
    ),
  );
  return { layer, calls, starts, terminations, state };
}

function setupFixture(label: string) {
  const base = mkdtempSync(join(tmpdir(), `foundry-runtime-${label}-`));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function configurationOf(
  document: ReturnType<typeof goldenConfigurationDocument>,
): Effect.Effect<ProjectConfiguration, unknown> {
  return decodeProjectConfiguration(document, '/target');
}

function recordOf(result: ProjectRuntimeResult) {
  if (result.status === 'skipped') {
    throw new Error('Expected a prepared or failed runtime record.');
  }
  return result.record;
}

const succeed = (): Script => () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' });

describe('Foundry-owned application runtime', () => {
  it.effect('omits the stage when there is no application profile', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('noprofile');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: false,
        }).pipe(Effect.provide(RunHistoryLive));
        const world = buildRuntimeWorld({ handlers: {} });
        const configuration = yield* configurationOf(goldenConfigurationDocument('/target', false));
        const result = yield* runApplicationRuntime({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          repositoryPath: '/target',
          configDirectory: '/target',
          commit: IMPLEMENTED_COMMIT,
          configuration,
        }).pipe(Effect.provide(world.layer), Effect.provide(RunHistoryLive));

        expect(result.status).toBe('skipped');
        expect(world.calls).toHaveLength(0);
        expect(world.starts).toHaveLength(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('owns reset, build, start, readiness, stop and cleanup in order', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('success');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: true,
        }).pipe(Effect.provide(RunHistoryLive));
        const world = buildRuntimeWorld({
          handlers: { reset: succeed(), build: succeed(), ready: succeed(), stop: succeed() },
        });
        const configuration = yield* configurationOf(goldenConfigurationDocument('/target', true));
        const result = yield* runApplicationRuntime({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          repositoryPath: '/target',
          configDirectory: '/target',
          commit: IMPLEMENTED_COMMIT,
          configuration,
        }).pipe(Effect.provide(world.layer), Effect.provide(RunHistoryLive));

        expect(result.status).toBe('prepared');
        expect(recordOf(result).outcome).toBe('ready');
        expect(recordOf(result).dataPreserved).toBe(true);
        expect(recordOf(result).cleanup).toBe('disposed');
        expect(recordOf(result).stages.map((stage) => stage.name)).toEqual([
          'reset',
          'build',
          'start',
          'readiness',
          'stop',
          'cleanup',
        ]);
        expect(world.starts).toEqual([['runtime-tool', 'start']]);
        expect(world.terminations.count).toBe(1);

        const history = yield* readVerifiedRunHistory({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(RunHistoryLive));
        expect(history.derived.runtimeLifecycles).toHaveLength(1);
        expect(history.derived.runtimeLifecycles[0]?.outcome).toBe('ready');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('polls readiness until it succeeds within the budget', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('poll');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: true,
        }).pipe(Effect.provide(RunHistoryLive));
        let readinessCalls = 0;
        const world = buildRuntimeWorld({
          handlers: {
            reset: succeed(),
            build: succeed(),
            ready: () =>
              Effect.sync(() => {
                readinessCalls += 1;
                return readinessCalls >= 3
                  ? { exitCode: 0, stdout: 'ready', stderr: '' }
                  : { exitCode: 1, stdout: 'not ready', stderr: '' };
              }),
            stop: succeed(),
          },
        });
        const configuration = yield* configurationOf(goldenConfigurationDocument('/target', true));
        const result = yield* runApplicationRuntime({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          repositoryPath: '/target',
          configDirectory: '/target',
          commit: IMPLEMENTED_COMMIT,
          configuration,
        }).pipe(Effect.provide(world.layer), Effect.provide(RunHistoryLive));

        expect(readinessCalls).toBe(3);
        expect(result.status).toBe('prepared');
        expect(recordOf(result).outcome).toBe('ready');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('records a timed-out readiness and still stops and cleans up', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('expiry');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: true,
        }).pipe(Effect.provide(RunHistoryLive));
        const world = buildRuntimeWorld({
          handlers: {
            reset: succeed(),
            build: succeed(),
            ready: () => Effect.succeed({ exitCode: 1, stdout: 'nope', stderr: '' }),
            stop: succeed(),
          },
        });
        const configuration = yield* configurationOf(goldenConfigurationDocument('/target', true));
        const result = yield* runApplicationRuntime({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          repositoryPath: '/target',
          configDirectory: '/target',
          commit: IMPLEMENTED_COMMIT,
          configuration,
        }).pipe(Effect.provide(world.layer), Effect.provide(RunHistoryLive));

        expect(result.status).toBe('failed');
        expect(recordOf(result).outcome).toBe('failed');
        const readiness = recordOf(result).stages.find((stage) => stage.name === 'readiness');
        expect(readiness?.outcome).toBe('timed_out');
        expect(world.terminations.count).toBe(1);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('fails before starting when reset mutates tracked state', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('mutation');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: true,
        }).pipe(Effect.provide(RunHistoryLive));
        const state = { status: '' };
        const world = buildRuntimeWorld({
          state,
          handlers: {
            reset: () =>
              Effect.sync(() => {
                state.status = ' M tracked.txt\n';
                return { exitCode: 0, stdout: '', stderr: '' };
              }),
          },
        });
        const configuration = yield* configurationOf(goldenConfigurationDocument('/target', true));
        const result = yield* runApplicationRuntime({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          repositoryPath: '/target-reset-mutation',
          configDirectory: '/target',
          commit: IMPLEMENTED_COMMIT,
          configuration,
        }).pipe(Effect.provide(world.layer), Effect.provide(RunHistoryLive));

        expect(result.status).toBe('failed');
        expect(recordOf(result).outcome).toBe('failed');
        expect(world.starts).toHaveLength(0);
        const reset = recordOf(result).stages.find((stage) => stage.name === 'reset');
        expect(reset?.outcome).toBe('failed');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('records a forced owned-process cleanup', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('forced');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: true,
        }).pipe(Effect.provide(RunHistoryLive));
        const world = buildRuntimeWorld({
          handlers: { reset: succeed(), build: succeed(), ready: succeed(), stop: succeed() },
          disposition: 'forced',
        });
        const configuration = yield* configurationOf(goldenConfigurationDocument('/target', true));
        const result = yield* runApplicationRuntime({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          repositoryPath: '/target',
          configDirectory: '/target',
          commit: IMPLEMENTED_COMMIT,
          configuration,
        }).pipe(Effect.provide(world.layer), Effect.provide(RunHistoryLive));

        expect(recordOf(result).cleanup).toBe('forced');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
