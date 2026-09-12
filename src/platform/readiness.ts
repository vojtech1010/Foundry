import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';

import { Effect, Layer } from 'effect';

import {
  ReadinessError,
  ReadinessFiles,
  ReadinessGit,
  ReadinessHost,
} from '../application/readiness/index.js';

function boundCause(cause: unknown): string {
  return String(cause).replaceAll(/\s+/gu, ' ').trim().slice(0, 200);
}

const runVersionTool = Effect.fn('runVersionTool')(function* (
  command: string,
  args: ReadonlyArray<string>,
  label: string,
  expected: string,
): Effect.fn.Return<string, ReadinessError> {
  const result = yield* Effect.sync(() => spawnSync(command, [...args], { encoding: 'utf8' }));
  if (result.error !== undefined) {
    return yield* new ReadinessError({
      message: `Missing required tool: ${label}. Expected ${expected}.`,
    });
  }
  if (result.status !== 0) {
    return yield* new ReadinessError({
      message: `Cannot determine ${label} version: ${boundCause(result.stdout)}. Expected ${expected}.`,
    });
  }
  return result.stdout;
});

const readConfigFile = Effect.fn('readConfigFile')(function* (
  path: string,
): Effect.fn.Return<string, ReadinessError> {
  return yield* Effect.try({
    try: () => readFileSync(path, 'utf8'),
    catch: (cause) =>
      new ReadinessError({
        message: `Cannot read configuration document at ${path}: ${boundCause(cause)}.`,
      }),
  });
});

const statConfiguredPath = Effect.fn('statConfiguredPath')(function* (
  path: string,
): Effect.fn.Return<{ readonly exists: boolean; readonly isDirectory: boolean }, ReadinessError> {
  const probed = yield* Effect.try({
    try: () => statSync(path),
    catch: (_cause) => 'unavailable' as const,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (probed === undefined) {
    return { exists: false, isDirectory: false };
  }
  return { exists: true, isDirectory: probed.isDirectory() };
});

const checkWritable = Effect.fn('checkWritable')(function* (
  path: string,
): Effect.fn.Return<boolean, ReadinessError> {
  const probed = yield* Effect.try({
    try: () => {
      accessSync(path, constants.W_OK);
      return true;
    },
    catch: (_cause) => 'unavailable' as const,
  }).pipe(Effect.orElseSucceed(() => false));
  return probed;
});

const runGitCommand = Effect.fn('runGitCommand')(function* (
  args: ReadonlyArray<string>,
  cwd: string,
): Effect.fn.Return<{ readonly stdout: string; readonly exitCode: number }, ReadinessError> {
  const result = yield* Effect.sync(() => spawnSync('git', [...args], { cwd, encoding: 'utf8' }));
  if (result.error !== undefined) {
    return yield* new ReadinessError({
      message: `Cannot run Git in ${cwd}: ${boundCause(result.error)}.`,
    });
  }
  return { stdout: result.stdout, exitCode: result.status ?? 1 };
});

export const ReadinessHostLive: Layer.Layer<ReadinessHost> = Layer.succeed(
  ReadinessHost,
  ReadinessHost.of({
    platform: Effect.sync(() => process.platform),
    nodeVersion: runVersionTool(process.execPath, ['--version'], 'Node.js', '24.14.0'),
    npmVersion: runVersionTool('npm', ['--version'], 'npm', '11.9.0'),
    gitVersionOutput: runVersionTool('git', ['version'], 'Git', '2.43 or newer'),
  }),
);

export const ReadinessFilesLive: Layer.Layer<ReadinessFiles> = Layer.succeed(
  ReadinessFiles,
  ReadinessFiles.of({
    readFile: (path: string) => readConfigFile(path),
    statPath: (path: string) => statConfiguredPath(path),
    isWritable: (path: string) => checkWritable(path),
  }),
);

export const ReadinessGitLive: Layer.Layer<ReadinessGit> = Layer.succeed(
  ReadinessGit,
  ReadinessGit.of({
    run: (args: ReadonlyArray<string>, cwd: string) => runGitCommand(args, cwd),
  }),
);

export const ReadinessLive = Layer.mergeAll(
  ReadinessHostLive,
  ReadinessFilesLive,
  ReadinessGitLive,
);
