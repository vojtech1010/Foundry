import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';

import {
  ProjectCommandError,
  ProjectCommandProcess,
  ProjectEvidenceStore,
  runGuardedProjectCommand,
} from '../src/application/project-commands/index.js';
import { ReadinessGit } from '../src/application/readiness/index.js';

interface RepoState {
  head: string;
  status: string;
  diff: string;
}

interface EvidenceWrite {
  readonly path: string;
  readonly bytes: Uint8Array;
}

interface World {
  readonly layer: Layer.Layer<ReadinessGit | ProjectCommandProcess | ProjectEvidenceStore>;
  readonly state: RepoState;
  readonly gitCalls: Array<ReadonlyArray<string>>;
  readonly writes: Array<EvidenceWrite>;
}

type Script = (
  state: RepoState,
) => Effect.Effect<
  { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  ProjectCommandError
>;

function buildWorld(scripts: ReadonlyArray<Script>): World {
  const state: RepoState = { head: 'a'.repeat(40), status: '', diff: '' };
  const gitCalls: Array<ReadonlyArray<string>> = [];
  const writes: Array<EvidenceWrite> = [];
  let scriptIndex = 0;
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
              return { stdout: state.diff, exitCode: 0 };
            }
            if (args[0] === 'reset') {
              state.head = args[2] ?? state.head;
              state.status = '';
              state.diff = '';
              return { stdout: 'HEAD is now at recorded commit\n', exitCode: 0 };
            }
            return { stdout: '', exitCode: 0 };
          }),
      }),
    ),
    Layer.succeed(
      ProjectCommandProcess,
      ProjectCommandProcess.of({
        run: () => {
          const script = scripts[scriptIndex];
          scriptIndex += 1;
          if (script === undefined) {
            return Effect.fail(new ProjectCommandError({ message: 'unexpected command' }));
          }
          return script(state);
        },
      }),
    ),
    Layer.succeed(
      ProjectEvidenceStore,
      ProjectEvidenceStore.of({
        write: (options) =>
          Effect.sync(() => {
            writes.push({ path: options.path, bytes: options.bytes });
          }),
      }),
    ),
  );
  return { layer, state, gitCalls, writes };
}

function command(overrides?: {
  readonly reconstruct?: boolean;
  readonly redactionPatterns?: ReadonlyArray<string>;
  readonly maxLogBytes?: number;
  readonly maxDiffBytes?: number;
}) {
  return {
    kind: 'gate' as const,
    name: 'lint' as const,
    command: ['lint-tool', '--strict'],
    cwd: '/target',
    repositoryPath: '/target',
    timeoutMs: 1000,
    maxLogBytes: overrides?.maxLogBytes ?? 65536,
    maxDiffBytes: overrides?.maxDiffBytes ?? 65536,
    redactionPatterns: overrides?.redactionPatterns ?? [],
    evidenceDirectory: '/target/.agent/runs/RUN/evidence',
    reconstruct: overrides?.reconstruct ?? true,
  };
}

describe('guarded project commands', () => {
  it.effect('passes a clean command and records bounded log metadata', () =>
    Effect.gen(function* () {
      const world = buildWorld([() => Effect.succeed({ exitCode: 0, stdout: 'ok', stderr: '' })]);
      const outcome = yield* runGuardedProjectCommand(command()).pipe(Effect.provide(world.layer));

      expect(outcome.exitCode).toBe(0);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.mutation).toBeNull();
      expect(outcome.reconstructed).toBe(false);
      expect(outcome.log.byteLength).toBeGreaterThan(0);
      expect(outcome.log.truncated).toBe(false);
      expect(world.writes).toHaveLength(1);
    }),
  );

  it.effect('fails a zero-exit command that changes tracked state and reconstructs', () =>
    Effect.gen(function* () {
      const world = buildWorld([
        (state) =>
          Effect.sync(() => {
            state.status = ' M tracked.txt\n';
            state.diff = 'diff --git a/tracked.txt b/tracked.txt\n+changed\n';
            return { exitCode: 0, stdout: '', stderr: '' };
          }),
      ]);
      const outcome = yield* runGuardedProjectCommand(command()).pipe(Effect.provide(world.layer));

      expect(outcome.exitCode).toBe(0);
      expect(outcome.mutation).not.toBeNull();
      expect(outcome.mutation?.diff).toContain('+changed');
      expect(outcome.reconstructed).toBe(true);
      expect(outcome.reconstructionError).toBeNull();
      expect(world.state.status).toBe('');
      expect(world.gitCalls.some((args) => args[0] === 'reset')).toBe(true);
    }),
  );

  it.effect('does not reconstruct when reconstruction is disabled', () =>
    Effect.gen(function* () {
      const world = buildWorld([
        (state) =>
          Effect.sync(() => {
            state.status = ' M tracked.txt\n';
            return { exitCode: 0, stdout: '', stderr: '' };
          }),
      ]);
      const outcome = yield* runGuardedProjectCommand(command({ reconstruct: false })).pipe(
        Effect.provide(world.layer),
      );

      expect(outcome.mutation).not.toBeNull();
      expect(outcome.reconstructed).toBe(false);
      expect(world.state.status).toBe(' M tracked.txt\n');
    }),
  );

  it.effect('redacts configured patterns from bounded evidence', () =>
    Effect.gen(function* () {
      const world = buildWorld([
        () => Effect.succeed({ exitCode: 0, stdout: 'token=secret-token', stderr: '' }),
      ]);
      const outcome = yield* runGuardedProjectCommand(
        command({ redactionPatterns: ['secret-token'] }),
      ).pipe(Effect.provide(world.layer));

      expect(outcome.log.redactionCount).toBe(1);
      const written = new TextDecoder().decode(world.writes[0]?.bytes ?? new Uint8Array());
      expect(written).not.toContain('secret-token');
      expect(written).toContain('[REDACTED]');
    }),
  );

  it.effect('truncates an oversized log while keeping the full byte count', () =>
    Effect.gen(function* () {
      const world = buildWorld([
        () => Effect.succeed({ exitCode: 0, stdout: 'x'.repeat(5000), stderr: '' }),
      ]);
      const outcome = yield* runGuardedProjectCommand(command({ maxLogBytes: 64 })).pipe(
        Effect.provide(world.layer),
      );

      expect(outcome.log.truncated).toBe(true);
      expect(outcome.log.retainedByteLength).toBeLessThanOrEqual(64);
      expect(outcome.log.byteLength).toBeGreaterThan(64);
    }),
  );
});
