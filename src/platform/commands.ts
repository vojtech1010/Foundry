import { spawn } from 'node:child_process';

import { Effect, Layer } from 'effect';

import { ProfileCheckError, ProjectCommandProcess } from '../application/profile-check/index.js';

import type {
  ProjectCommandResult,
  RunProjectCommandOptions,
} from '../application/profile-check/index.js';

function boundCause(cause: unknown): string {
  return String(cause).replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

type ProcessOutputChunk = Buffer | string;

function waitForClose(
  child: ReturnType<typeof spawn>,
  executable: string,
  stdoutRef: { readonly append: (chunk: ProcessOutputChunk) => void },
  stderrRef: { readonly append: (chunk: ProcessOutputChunk) => void },
  readStdout: () => string,
  readStderr: () => string,
): Effect.Effect<ProjectCommandResult, ProfileCheckError> {
  return Effect.callback<ProjectCommandResult, ProfileCheckError>((resume) => {
    child.stdout?.on('data', (chunk: ProcessOutputChunk) => {
      stdoutRef.append(chunk);
    });
    child.stderr?.on('data', (chunk: ProcessOutputChunk) => {
      stderrRef.append(chunk);
    });
    child.on('error', (cause: unknown) => {
      resume(
        Effect.fail(
          new ProfileCheckError({
            message: `Cannot start project command "${executable}": ${boundCause(cause)}.`,
          }),
        ),
      );
    });
    child.on('close', (code: number | null, signal: string | null) => {
      if (signal !== null) {
        resume(
          Effect.fail(
            new ProfileCheckError({
              message: `Project command "${executable}" terminated with signal ${signal}.`,
            }),
          ),
        );
        return;
      }
      resume(Effect.succeed({ exitCode: code ?? 1, stdout: readStdout(), stderr: readStderr() }));
    });
  });
}

const runCommand = (
  options: RunProjectCommandOptions,
): Effect.Effect<ProjectCommandResult, ProfileCheckError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const [executable, ...args] = options.command;
      if (executable === undefined) {
        return yield* new ProfileCheckError({
          message: 'Project command is empty.',
        });
      }
      const target = executable;
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () => spawn(target, [...args], { cwd: options.cwd, shell: false }),
          catch: (cause) =>
            new ProfileCheckError({
              message: `Cannot start project command "${target}": ${boundCause(cause)}.`,
            }),
        }),
        (spawned) =>
          Effect.sync(() => {
            if (spawned.exitCode === null && spawned.signalCode === null) {
              spawned.kill();
            }
          }),
      );
      let stdout = '';
      let stderr = '';
      const appendStdout = (chunk: ProcessOutputChunk) => {
        stdout += String(chunk);
      };
      const appendStderr = (chunk: ProcessOutputChunk) => {
        stderr += String(chunk);
      };
      return yield* waitForClose(
        child,
        target,
        { append: appendStdout },
        { append: appendStderr },
        () => stdout,
        () => stderr,
      );
    }),
  );

export const ProjectCommandProcessLive: Layer.Layer<ProjectCommandProcess> = Layer.succeed(
  ProjectCommandProcess,
  ProjectCommandProcess.of({
    run: runCommand,
  }),
);
