import { describe, expect, it } from '@effect/vitest';
import { Duration, Effect, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeProjectConfiguration } from '../src/application/project-configuration.js';
import {
  ProjectCommandError,
  ProjectCommandProcess,
  ProjectEvidenceStore,
} from '../src/application/project-commands/index.js';
import {
  ProjectVerificationError,
  runProjectVerification,
} from '../src/application/project-verification/index.js';
import { ReadinessGit } from '../src/application/readiness/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import {
  FROZEN_COMMIT,
  IMPLEMENTED_COMMIT,
  RUN_ID,
  goldenConfigurationDocument,
  seedVerifyingRun,
} from './fixtures/checks-runtime-run.js';

import type { ProjectConfiguration } from '../src/domain/project-configuration.js';
import type { ProjectCommandResult } from '../src/application/project-commands/index.js';

interface RepoState {
  head: string;
  status: string;
}

type Script = () => Effect.Effect<ProjectCommandResult, ProjectCommandError>;

interface World {
  readonly layer: Layer.Layer<ReadinessGit | ProjectCommandProcess | ProjectEvidenceStore>;
  readonly calls: Array<ReadonlyArray<string>>;
  readonly gitCalls: Array<ReadonlyArray<string>>;
}

function buildWorld(handlers: Record<string, Script>): World {
  const state: RepoState = { head: IMPLEMENTED_COMMIT, status: '' };
  const calls: Array<ReadonlyArray<string>> = [];
  const gitCalls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(
      ReadinessGit,
      ReadinessGit.of({
        run: (args: ReadonlyArray<string>) =>
          Effect.sync(() => {
            gitCalls.push([...args]);
            if (args[0] === 'rev-parse') {
              return { stdout: `${state.head}\n`, exitCode: 0 };
            }
            if (args[0] === 'status') {
              return { stdout: state.status, exitCode: 0 };
            }
            if (args[0] === 'diff') {
              return { stdout: '', exitCode: 0 };
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
        run: (options) => {
          calls.push([...options.command]);
          const handler = handlers[options.command[0] ?? ''];
          if (handler === undefined) {
            return Effect.fail(
              new ProjectCommandError({
                message: `Unexpected project command ${options.command.join(' ')}`,
              }),
            );
          }
          return handler();
        },
      }),
    ),
    Layer.succeed(ProjectEvidenceStore, ProjectEvidenceStore.of({ write: () => Effect.void })),
  );
  return { layer, calls, gitCalls };
}

function setupFixture(label: string) {
  const base = mkdtempSync(join(tmpdir(), `foundry-verification-${label}-`));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function configurationOf(
  document: ReturnType<typeof goldenConfigurationDocument>,
  target: string,
): Effect.Effect<ProjectConfiguration, unknown> {
  return decodeProjectConfiguration(document, target);
}

describe('commit-bound project verification', () => {
  it.effect('runs bootstrap then all five gates in order against the recorded commit', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('order');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: false,
        }).pipe(Effect.provide(RunHistoryLive));
        const world = buildWorld({
          'bootstrap-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          fmt: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          'lint-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          tsc: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          'test-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          'build-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
        });
        const configuration = yield* configurationOf(
          goldenConfigurationDocument('/target'),
          '/target',
        );
        const report = yield* runProjectVerification({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          repositoryPath: '/target-1',
          configDirectory: '/target',
          commit: IMPLEMENTED_COMMIT,
          configuration,
        }).pipe(Effect.provide(world.layer), Effect.provide(RunHistoryLive));

        expect(report.result).toBe('passed');
        expect(report.commit).toBe(IMPLEMENTED_COMMIT);
        expect(report.attempt).toBe(1);
        expect(report.executions.map((execution) => execution.name)).toEqual([
          'bootstrap',
          'formatCheck',
          'lint',
          'typecheck',
          'test',
          'build',
        ]);
        expect(world.calls.map((call) => call[0])).toEqual([
          'bootstrap-tool',
          'fmt',
          'lint-tool',
          'tsc',
          'test-tool',
          'build-tool',
        ]);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('runs every gate after a failure so Coder sees the complete failure set', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('multi');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: false,
        }).pipe(Effect.provide(RunHistoryLive));
        const world = buildWorld({
          'bootstrap-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          fmt: () => Effect.succeed({ exitCode: 1, stdout: 'fmt failed', stderr: '' }),
          'lint-tool': () => Effect.succeed({ exitCode: 1, stdout: 'lint failed', stderr: '' }),
          tsc: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          'test-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          'build-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
        });
        const configuration = yield* configurationOf(
          goldenConfigurationDocument('/target'),
          '/target',
        );
        const report = yield* runProjectVerification({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          repositoryPath: '/target-2',
          configDirectory: '/target',
          commit: IMPLEMENTED_COMMIT,
          configuration,
        }).pipe(Effect.provide(world.layer), Effect.provide(RunHistoryLive));

        expect(report.result).toBe('failed');
        expect(report.executions).toHaveLength(6);
        const failed = report.executions.filter((execution) => execution.actualExitCode !== 0);
        expect(failed.map((execution) => execution.name)).toEqual(['formatCheck', 'lint']);
        expect(world.calls).toHaveLength(6);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('stops at a failed bootstrap without running any gate', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('bootstrap');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: false,
        }).pipe(Effect.provide(RunHistoryLive));
        const world = buildWorld({
          'bootstrap-tool': () =>
            Effect.succeed({ exitCode: 1, stdout: 'install failed', stderr: '' }),
          fmt: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
        });
        const configuration = yield* configurationOf(
          goldenConfigurationDocument('/target'),
          '/target',
        );
        const report = yield* runProjectVerification({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          repositoryPath: '/target-3',
          configDirectory: '/target',
          commit: IMPLEMENTED_COMMIT,
          configuration,
        }).pipe(Effect.provide(world.layer), Effect.provide(RunHistoryLive));

        expect(report.result).toBe('failed');
        expect(report.executions.map((execution) => execution.name)).toEqual(['bootstrap']);
        expect(world.calls).toHaveLength(1);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses to trust a HEAD that differs from the accepted commit', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('head');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: false,
        }).pipe(Effect.provide(RunHistoryLive));
        const world = buildWorld({});
        const configuration = yield* configurationOf(
          goldenConfigurationDocument('/target'),
          '/target',
        );
        const error = yield* runProjectVerification({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          repositoryPath: '/target-4',
          configDirectory: '/target',
          commit: FROZEN_COMMIT,
          configuration,
        }).pipe(Effect.provide(world.layer), Effect.provide(RunHistoryLive), Effect.flip);

        expect(error).toBeInstanceOf(ProjectVerificationError);
        expect(error.message).toContain('does not match the accepted implementation commit');
        expect(world.calls).toHaveLength(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('reuses a completed report inside the same process for the same commit', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('cache');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: false,
        }).pipe(Effect.provide(RunHistoryLive));
        const world = buildWorld({
          'bootstrap-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          fmt: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          'lint-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          tsc: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          'test-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          'build-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
        });
        const configuration = yield* configurationOf(
          goldenConfigurationDocument('/target'),
          '/target',
        );
        const run = () =>
          runProjectVerification({
            runDirectory: fixture.runDirectory,
            runId: RUN_ID,
            repositoryPath: '/target-5',
            configDirectory: '/target',
            commit: IMPLEMENTED_COMMIT,
            configuration,
          }).pipe(Effect.provide(world.layer), Effect.provide(RunHistoryLive));

        const first = yield* run();
        const callsAfterFirst = world.calls.length;
        const second = yield* run();
        expect(second).toEqual(first);
        expect(world.calls.length).toBe(callsAfterFirst);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('records a timed-out gate and continues to later gates', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('timeout');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: false,
        }).pipe(Effect.provide(RunHistoryLive));
        const world = buildWorld({
          'bootstrap-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          fmt: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          'lint-tool': () => Effect.never,
          tsc: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          'test-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
          'build-tool': () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
        });
        const document = goldenConfigurationDocument('/target');
        const configuration = yield* configurationOf(
          { ...document, timeouts: { ...document.timeouts, commandMs: 50 } },
          '/target',
        );
        const fiber = yield* runProjectVerification({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          repositoryPath: '/target-6',
          configDirectory: '/target',
          commit: IMPLEMENTED_COMMIT,
          configuration,
        }).pipe(Effect.provide(world.layer), Effect.provide(RunHistoryLive), Effect.forkChild);
        yield* TestClock.adjust(Duration.millis(500));
        const report = yield* Fiber.join(fiber);

        expect(report.result).toBe('failed');
        const lint = report.executions.find((execution) => execution.name === 'lint');
        expect(lint?.timedOut).toBe(true);
        expect(report.executions.map((execution) => execution.name)).toEqual([
          'bootstrap',
          'formatCheck',
          'lint',
          'typecheck',
          'test',
          'build',
        ]);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
