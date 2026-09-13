import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunGit } from '../src/application/git-provisioning/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import {
  ProjectValidationRoutingError,
  routeAfterProjectChecks,
} from '../src/application/validation-routing/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import {
  IMPLEMENTED_COMMIT,
  RUN_ID,
  passingVerificationReport,
  seedVerifyingRun,
} from './fixtures/checks-runtime-run.js';

import type { VerificationCompletedPayload } from '../src/domain/run-history.js';

function stubGit(): Layer.Layer<RunGit> {
  const unused = (name: string) =>
    Effect.die(new Error(`validation routing must not call RunGit.${name}`));
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

const Live = Layer.mergeAll(RunHistoryLive, stubGit());

function setupFixture(label: string) {
  const base = mkdtempSync(join(tmpdir(), `foundry-routing-${label}-`));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function appendVerification(runDirectory: string, report: VerificationCompletedPayload) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
    build: () => Effect.succeed({ type: 'verification-completed', payload: report } as const),
  });
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

describe('plan-controlled validation routing', () => {
  it.effect('records an explicit Tester skip and routes to reviewing when not required', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('skip');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: false,
        }).pipe(Effect.provide(Live));
        yield* appendVerification(fixture.runDirectory, passingVerificationReport()).pipe(
          Effect.provide(Live),
        );

        const route = yield* routeAfterProjectChecks({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          correctionRoundsRemaining: 1,
        }).pipe(Effect.provide(Live));

        expect(route).toEqual({ route: 'reviewing', testerSkipped: true });
        const history = yield* readVerifiedRunHistory({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(Live));
        expect(history.derived.state).toBe('reviewing');
        expect(history.derived.testerSkips).toHaveLength(1);
        expect(history.derived.testerSkips[0]?.reason).toContain('does not require');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('routes to testing when the plan requires runtime and a prepared runtime exists', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('required');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: true,
        }).pipe(Effect.provide(Live));
        yield* appendVerification(fixture.runDirectory, passingVerificationReport()).pipe(
          Effect.provide(Live),
        );
        yield* appendRuntimeReady(fixture.runDirectory).pipe(Effect.provide(Live));

        const route = yield* routeAfterProjectChecks({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          correctionRoundsRemaining: 1,
        }).pipe(Effect.provide(Live));

        expect(route).toEqual({ route: 'testing' });
        const history = yield* readVerifiedRunHistory({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(Live));
        expect(history.derived.state).toBe('testing');
        expect(history.derived.testerSkips).toHaveLength(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('records a limitation instead of skipping a required stage without a runtime', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('limitation');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: true,
        }).pipe(Effect.provide(Live));
        yield* appendVerification(fixture.runDirectory, passingVerificationReport()).pipe(
          Effect.provide(Live),
        );

        const route = yield* routeAfterProjectChecks({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          correctionRoundsRemaining: 1,
        }).pipe(Effect.provide(Live));

        expect(route.route).toBe('limitation');
        const history = yield* readVerifiedRunHistory({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(Live));
        expect(history.derived.state).toBe('verifying');
        expect(history.derived.testerSkips).toHaveLength(0);
        expect(history.derived.validationLimitations).toHaveLength(1);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('routes failed checks to a bounded correction when a round remains', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('correction');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: false,
        }).pipe(Effect.provide(Live));
        const base = passingVerificationReport();
        const failed = {
          ...base,
          result: 'failed' as const,
          executions: [{ ...base.executions[0]!, actualExitCode: 1 }],
        };
        yield* appendVerification(fixture.runDirectory, failed).pipe(Effect.provide(Live));

        const route = yield* routeAfterProjectChecks({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          correctionRoundsRemaining: 1,
        }).pipe(Effect.provide(Live));

        expect(route.route).toBe('correcting');
        if (route.route === 'correcting') {
          expect(route.findings.length).toBeGreaterThanOrEqual(1);
        }
        const history = yield* readVerifiedRunHistory({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(Live));
        expect(history.derived.state).toBe('correcting');
        expect(history.derived.findings.length).toBeGreaterThanOrEqual(1);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('routes an exhausted correction budget to Reviewer while retaining findings', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('exhausted');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: false,
        }).pipe(Effect.provide(Live));
        const base = passingVerificationReport();
        const failed = {
          ...base,
          result: 'failed' as const,
          executions: [{ ...base.executions[0]!, actualExitCode: 2 }],
        };
        yield* appendVerification(fixture.runDirectory, failed).pipe(Effect.provide(Live));

        const route = yield* routeAfterProjectChecks({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          correctionRoundsRemaining: 0,
        }).pipe(Effect.provide(Live));

        expect(route.route).toBe('reviewing');
        const history = yield* readVerifiedRunHistory({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(Live));
        expect(history.derived.state).toBe('reviewing');
        expect(history.derived.findings).toHaveLength(1);
        expect(history.derived.findings[0]?.category).toBe('check');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('separates environment failures from Coder findings and blocks for recovery', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('environment');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: false,
        }).pipe(Effect.provide(Live));
        const base = passingVerificationReport();
        const failed = {
          ...base,
          result: 'failed' as const,
          executions: [{ ...base.executions[0]!, kind: 'bootstrap' as const, actualExitCode: 1 }],
        };
        yield* appendVerification(fixture.runDirectory, failed).pipe(Effect.provide(Live));

        const route = yield* routeAfterProjectChecks({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          correctionRoundsRemaining: 2,
        }).pipe(Effect.provide(Live));

        expect(route.route).toBe('blocked');
        const history = yield* readVerifiedRunHistory({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(Live));
        expect(history.derived.state).toBe('blocked');
        expect(history.derived.findings).toHaveLength(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses to route without a commit-bound verification report', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('missing');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: false,
        }).pipe(Effect.provide(Live));

        const error = yield* routeAfterProjectChecks({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          correctionRoundsRemaining: 1,
        }).pipe(Effect.provide(Live), Effect.flip);

        expect(error).toBeInstanceOf(ProjectValidationRoutingError);
        expect(error.message).toContain('commit-bound verification report');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
