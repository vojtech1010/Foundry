import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Duration, Effect, Layer } from 'effect';

import {
  OwnedProjectProcess,
  ProjectCommandError,
  ProjectEvidenceError,
  ProjectEvidenceStore,
} from '../application/project-commands/index.js';

import type {
  OwnedProcessHandle,
  StartOwnedProcessOptions,
  TerminateOwnedProcessOptions,
  TerminateOwnedProcessResult,
  WriteEvidenceOptions,
} from '../application/project-commands/index.js';

function boundCause(cause: unknown): string {
  return String(cause).replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

const writeEvidence = Effect.fn('projectEvidence.write')(function* (
  options: WriteEvidenceOptions,
): Effect.fn.Return<void, ProjectEvidenceError> {
  yield* Effect.try({
    try: () => {
      mkdirSync(dirname(options.path), { recursive: true });
      writeFileSync(options.path, options.bytes);
    },
    catch: (cause) =>
      new ProjectEvidenceError({
        message: `Cannot write project evidence at ${options.path}: ${boundCause(cause)}.`,
      }),
  });
});

export const ProjectEvidenceStoreLive: Layer.Layer<ProjectEvidenceStore> = Layer.succeed(
  ProjectEvidenceStore,
  ProjectEvidenceStore.of({ write: writeEvidence }),
);

interface OwnedChild {
  readonly child: ReturnType<typeof spawn>;
}

const ownedChildren = new Map<string, OwnedChild>();

function signalOwned(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

function forceOwned(child: ReturnType<typeof spawn>): void {
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

function waitForExit(child: ReturnType<typeof spawn>): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void);
      return;
    }
    child.once('exit', () => {
      resume(Effect.void);
    });
  });
}

const startOwned = Effect.fn('ownedProjectProcess.start')(function* (
  options: StartOwnedProcessOptions,
): Effect.fn.Return<OwnedProcessHandle, ProjectCommandError> {
  const [executable, ...args] = options.command;
  if (executable === undefined) {
    return yield* new ProjectCommandError({ message: 'Owned application command is empty.' });
  }
  const child = yield* Effect.try({
    try: () =>
      spawn(executable, [...args], {
        cwd: options.cwd,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: 'ignore',
      }),
    catch: (cause) =>
      new ProjectCommandError({
        message: `Cannot start owned application command "${executable}": ${boundCause(cause)}.`,
      }),
  });
  child.on('error', () => {
    // A start failure surfaces through readiness and cleanup rather than an
    // unhandled process error event.
  });
  const id = randomUUID();
  ownedChildren.set(id, { child });
  return { id, pid: child.pid ?? null, command: [...options.command] };
});

const terminateOwned = Effect.fn('ownedProjectProcess.terminate')(function* (
  options: TerminateOwnedProcessOptions,
): Effect.fn.Return<TerminateOwnedProcessResult, ProjectCommandError> {
  const owned = ownedChildren.get(options.handle.id);
  if (owned === undefined) {
    return { disposition: 'not_owned', detail: 'No recorded owned process for this handle.' };
  }
  ownedChildren.delete(options.handle.id);
  const { child } = owned;

  if (child.exitCode !== null || child.signalCode !== null) {
    return { disposition: 'disposed', detail: 'The owned process had already exited.' };
  }

  signalOwned(child, 'SIGTERM');
  const stopped = yield* waitForExit(child).pipe(
    Effect.timeout(Duration.millis(options.graceMs)),
    Effect.result,
  );
  if (stopped._tag === 'Success') {
    return { disposition: 'disposed', detail: 'The owned process exited during the grace period.' };
  }

  forceOwned(child);
  const forced = yield* waitForExit(child).pipe(
    Effect.timeout(Duration.millis(options.graceMs)),
    Effect.result,
  );
  if (forced._tag === 'Success') {
    return {
      disposition: 'forced',
      detail: 'The owned process tree was force-terminated after the grace period.',
    };
  }
  return {
    disposition: 'failed',
    detail: 'The owned process tree did not terminate within the cleanup budget.',
  };
});

export const OwnedProjectProcessLive: Layer.Layer<OwnedProjectProcess> = Layer.succeed(
  OwnedProjectProcess,
  OwnedProjectProcess.of({ start: startOwned, terminate: terminateOwned }),
);

export const ProjectCommandsPlatformLive = Layer.mergeAll(
  ProjectEvidenceStoreLive,
  OwnedProjectProcessLive,
);
