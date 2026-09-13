import { spawn, spawnSync } from 'node:child_process';

import { Effect, Layer } from 'effect';

import {
  ProjectCommandError,
  ProjectCommandProcess,
} from '../application/project-commands/index.js';

import type {
  ProjectCommandResult,
  RunProjectCommandOptions,
} from '../application/project-commands/index.js';

function boundCause(cause: unknown): string {
  return String(cause).replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function waitForTreeStopped(child: ReturnType<typeof spawn>): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void);
      return;
    }
    child.once('exit', () => {
      resume(Effect.void);
    });
    terminateProcessTree(child);
  });
}

type ProcessOutputChunk = Buffer | string;

function waitForClose(
  child: ReturnType<typeof spawn>,
  executable: string,
  stdoutRef: { readonly append: (chunk: ProcessOutputChunk) => void },
  stderrRef: { readonly append: (chunk: ProcessOutputChunk) => void },
  readStdout: () => string,
  readStderr: () => string,
): Effect.Effect<ProjectCommandResult, ProjectCommandError> {
  return Effect.callback<ProjectCommandResult, ProjectCommandError>((resume) => {
    child.stdout?.on('data', (chunk: ProcessOutputChunk) => {
      stdoutRef.append(chunk);
    });
    child.stderr?.on('data', (chunk: ProcessOutputChunk) => {
      stderrRef.append(chunk);
    });
    child.on('error', (cause: unknown) => {
      resume(
        Effect.fail(
          new ProjectCommandError({
            message: `Cannot start project command "${executable}": ${boundCause(cause)}.`,
          }),
        ),
      );
    });
    child.on('close', (code: number | null, signal: string | null) => {
      if (signal !== null) {
        resume(
          Effect.fail(
            new ProjectCommandError({
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
): Effect.Effect<ProjectCommandResult, ProjectCommandError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const [executable, ...args] = options.command;
      if (executable === undefined) {
        return yield* new ProjectCommandError({
          message: 'Project command is empty.',
        });
      }
      const target = executable;
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawn(target, [...args], {
              cwd: options.cwd,
              shell: false,
              detached: process.platform !== 'win32',
            }),
          catch: (cause) =>
            new ProjectCommandError({
              message: `Cannot start project command "${target}": ${boundCause(cause)}.`,
            }),
        }),
        (spawned) => waitForTreeStopped(spawned),
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
