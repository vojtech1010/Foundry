import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RunHistoryIntegrityError,
  RunHistoryStorage,
  RunHistoryStorageError,
  appendRunEvent,
  readVerifiedRunHistory,
} from '../../src/application/run-history/index.js';
import {
  RUN_HISTORY_FILENAME,
  RUN_HISTORY_WITNESS_FILENAME,
} from '../../src/domain/run-history.js';
import { RunHistoryLive } from '../../src/platform/run-history.js';

const RUN_ID = 'RUN-PARITY';

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupRunDirectory(label: string): Fixture {
  const base = mkdtempSync(join(tmpdir(), `foundry parity ${label} `));
  const runDirectory = join(
    base,
    'nested directory',
    'a'.repeat(24),
    'b'.repeat(24),
    '.agent',
    'runs',
    RUN_ID,
  );
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function appendCreated(runDirectory: string, createIfMissing: boolean) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing,
    build: () =>
      Effect.succeed({ type: 'run-created', payload: { taskId: 'TASK-PARITY' } } as const),
  }).pipe(Effect.provide(RunHistoryLive));
}

function readVerified(runDirectory: string) {
  return readVerifiedRunHistory({ runDirectory, runId: RUN_ID, createIfMissing: false }).pipe(
    Effect.provide(RunHistoryLive),
  );
}

describe('durable run history parity', () => {
  it.effect('atomically appends on a platform temp path and leaves no temporary files', () => {
    const fixture = setupRunDirectory('atomic');
    return Effect.gen(function* () {
      yield* appendCreated(fixture.runDirectory, true);

      const stream = readFileSync(join(fixture.runDirectory, RUN_HISTORY_FILENAME), 'utf8');
      expect(stream.endsWith('\n')).toBe(true);
      expect(existsSync(join(fixture.runDirectory, RUN_HISTORY_WITNESS_FILENAME))).toBe(true);

      const temporaryFiles = readdirSync(fixture.runDirectory).filter((name) =>
        name.endsWith('.tmp'),
      );
      expect(temporaryFiles).toEqual([]);

      const history = yield* readVerified(fixture.runDirectory);
      expect(history.head.revision).toBe(1);
    }).pipe(Effect.ensuring(Effect.sync(fixture.cleanup)));
  });

  it.effect(
    'keeps the accepted prefix intact and fails closed when an append is interrupted',
    () => {
      const fixture = setupRunDirectory('interrupt');
      return Effect.gen(function* () {
        yield* appendCreated(fixture.runDirectory, true);
        const live = yield* RunHistoryStorage.pipe(Effect.provide(RunHistoryLive));
        const interrupted = RunHistoryStorage.of({
          ...live,
          commitHistory: (options) =>
            Effect.gen(function* () {
              yield* live.commitHistory({
                ...options,
                nextStreamBytes: options.expectedStreamBytes ?? new Uint8Array(),
              });
              return yield* new RunHistoryStorageError({
                message: 'simulated interruption after the witness write',
                runId: RUN_ID,
              });
            }),
        });

        const error = yield* appendRunEvent({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
          build: () =>
            Effect.succeed({
              type: 'cleanup-progress',
              payload: { outcome: 'failed', detail: 'interrupted' },
            } as const),
        }).pipe(Effect.provideService(RunHistoryStorage, interrupted), Effect.flip);
        expect(error).toBeInstanceOf(RunHistoryStorageError);

        const integrity = yield* readVerified(fixture.runDirectory).pipe(Effect.flip);
        expect(integrity).toBeInstanceOf(RunHistoryIntegrityError);
        if (!(integrity instanceof RunHistoryIntegrityError)) {
          throw new Error('Expected a run history integrity error.');
        }
        expect(integrity.message).toContain('witness does not match');
      }).pipe(Effect.ensuring(Effect.sync(fixture.cleanup)));
    },
  );
});
