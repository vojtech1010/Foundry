import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';

import type { Schema } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunGit } from '../src/application/git-provisioning/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import {
  handleTesterTurn,
  validateTesterTurnControl,
} from '../src/application/tester-validation/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RUN_ID, seedVerifyingRun } from './fixtures/checks-runtime-run.js';

function stubGit(): Layer.Layer<RunGit> {
  const unused = (name: string) =>
    Effect.die(new Error(`tester validation must not call RunGit.${name}`));
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
  const base = mkdtempSync(join(tmpdir(), `foundry-tester-${label}-`));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function seedTesting(runDirectory: string) {
  return Effect.gen(function* () {
    yield* seedVerifyingRun({ runDirectory, runtimeValidationRequired: true });
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'workflow-transition',
          payload: {
            route: 'checks-passed-testing',
            from: 'verifying',
            to: 'testing',
            checkpoint: null,
          },
        } as const),
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function history(runDirectory: string) {
  return readVerifiedRunHistory({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

function handle(runDirectory: string, control: Schema.Json, retriesRemaining = 1) {
  return handleTesterTurn({
    runDirectory,
    runId: RUN_ID,
    control,
    commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    testerRetriesRemaining: retriesRemaining,
    retryReason: 'the test requested another observation',
  }).pipe(Effect.provide(Live));
}

describe('Tester control validation', () => {
  it('accepts observation outcomes and names the envelope error otherwise', () => {
    expect(validateTesterTurnControl({ schemaVersion: 1, outcome: 'observed' })).toEqual({
      ok: true,
      problem: '',
    });
    const invalid = validateTesterTurnControl({ schemaVersion: 1, outcome: 'passed' });
    expect(invalid.ok).toBe(false);
    expect(invalid.problem.length).toBeGreaterThan(0);
  });
});

describe('Tester observations settle without pass/fail verdicts', () => {
  it.effect('observed settles the stage to reviewing without involving Coder', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('observed');
      try {
        yield* seedTesting(fixture.runDirectory);
        const disposition = yield* handle(fixture.runDirectory, {
          schemaVersion: 1,
          outcome: 'observed',
        });
        expect(disposition).toEqual({ kind: 'observed' });
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('reviewing');
        expect(after.derived.roleSessions.some((session) => session.role === 'coder')).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('retry_required records a retry and keeps the stage at the same commit', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('retry');
      try {
        yield* seedTesting(fixture.runDirectory);
        const disposition = yield* handle(fixture.runDirectory, {
          schemaVersion: 1,
          outcome: 'retry_required',
        });
        expect(disposition).toEqual({ kind: 'retry-required' });
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('testing');
        expect(after.derived.implementation?.commit).toBe(
          'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
        );
        expect(
          after.derived.attempts.some(
            (attempt) => attempt.kind === 'retry' && attempt.role === 'tester',
          ),
        ).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('retry_required without budget is refused rather than relabelled', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('no-budget');
      try {
        yield* seedTesting(fixture.runDirectory);
        const disposition = yield* handle(
          fixture.runDirectory,
          { schemaVersion: 1, outcome: 'retry_required' },
          0,
        );
        expect(disposition.kind).toBe('control-invalid');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('testing');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('blocked retains a validation limitation and routes to Reviewer', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('blocked');
      try {
        yield* seedTesting(fixture.runDirectory);
        const disposition = yield* handle(fixture.runDirectory, {
          schemaVersion: 1,
          outcome: 'blocked',
        });
        expect(disposition.kind).toBe('blocked');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('reviewing');
        expect(after.derived.validationLimitations).toHaveLength(1);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('rejects pass/fail or malformed controls without changing state', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('invalid');
      try {
        yield* seedTesting(fixture.runDirectory);
        const passed = yield* handle(fixture.runDirectory, {
          schemaVersion: 1,
          outcome: 'passed',
        });
        expect(passed.kind).toBe('control-invalid');
        const extra = yield* handle(fixture.runDirectory, {
          schemaVersion: 1,
          outcome: 'observed',
          passed: true,
        });
        expect(extra.kind).toBe('control-invalid');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('testing');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
