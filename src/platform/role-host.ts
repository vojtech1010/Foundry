import { spawn } from 'node:child_process';

import { Duration, Effect, Layer, Schema } from 'effect';

import { RoleHost, RoleHostOperationalError } from '../application/role-conversations/index.js';
import {
  RoleHostCreateResponseSchema,
  RoleHostObserveResponseSchema,
  RoleHostStopResponseSchema,
  RoleHostSubmitResponseSchema,
} from '../domain/role-host.js';

import type {
  RoleHostCreateRequest,
  RoleHostCreateResponse,
  RoleHostObserveRequest,
  RoleHostObserveResponse,
  RoleHostOperation,
  RoleHostStopRequest,
  RoleHostStopResponse,
  RoleHostSubmitRequest,
  RoleHostSubmitResponse,
} from '../domain/role-host.js';
import type { CommandVector } from '../domain/project-configuration.js';

const STDERR_CAPTURE_LIMIT = 2_048;

type ProcessOutputChunk = Buffer | string;

export interface RoleHostProcessOptions {
  readonly command: CommandVector;
  readonly cwd: string;
  readonly environmentAllowlist: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

interface ResponseDocumentSchema extends Schema.Constraint {
  readonly DecodingServices: never;
}

function boundCause(cause: unknown): string {
  return String(cause).replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

function forwardedEnvironment(names: ReadonlyArray<string>) {
  const environment: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function waitForClose(
  child: ReturnType<typeof spawn>,
  executable: string,
  operation: RoleHostOperation,
  maxOutputBytes: number,
): Effect.Effect<string, RoleHostOperationalError> {
  return Effect.callback<string, RoleHostOperationalError>((resume) => {
    const stdoutChunks: Array<Buffer> = [];
    const stderrChunks: Array<Buffer> = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    let settled = false;
    const fail = (message: string) => {
      if (!settled) {
        settled = true;
        resume(Effect.fail(new RoleHostOperationalError({ message, operation })));
      }
    };
    const succeed = (text: string) => {
      if (!settled) {
        settled = true;
        resume(Effect.succeed(text));
      }
    };
    child.stdout?.on('data', (chunk: ProcessOutputChunk) => {
      const buffer = Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > maxOutputBytes) {
        overflowed = true;
        child.kill();
        return;
      }
      stdoutChunks.push(buffer);
    });
    child.stderr?.on('data', (chunk: ProcessOutputChunk) => {
      if (stderrBytes >= STDERR_CAPTURE_LIMIT) {
        return;
      }
      const buffer = Buffer.from(chunk);
      stderrChunks.push(buffer);
      stderrBytes += buffer.byteLength;
    });
    child.on('error', (cause: unknown) => {
      fail(`Cannot start role host "${executable}": ${boundCause(cause)}.`);
    });
    child.on('close', (code: number | null, signal: string | null) => {
      if (overflowed) {
        fail(`Role host "${executable}" ${operation} output exceeded ${maxOutputBytes} bytes.`);
        return;
      }
      if (signal !== null) {
        fail(`Role host "${executable}" ${operation} terminated with signal ${signal}.`);
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderrChunks)
          .toString('utf8')
          .replaceAll(/\s+/gu, ' ')
          .trim()
          .slice(0, 500);
        const suffix = detail.length > 0 ? `: ${detail}` : '.';
        fail(`Role host "${executable}" ${operation} exited with code ${code ?? 1}${suffix}`);
        return;
      }
      succeed(Buffer.concat(stdoutChunks).toString('utf8'));
    });
  });
}

const runOperation = Effect.fn('roleHost.runOperation')(function* <
  ResponseSchema extends ResponseDocumentSchema,
>(
  options: RoleHostProcessOptions,
  operation: RoleHostOperation,
  requestText: string,
  responseSchema: ResponseSchema,
): Effect.fn.Return<ResponseSchema['Type'], RoleHostOperationalError> {
  const [executable, ...args] = options.command;
  if (executable === undefined) {
    return yield* new RoleHostOperationalError({
      message: 'The configured role host command is empty.',
      operation,
    });
  }
  const environment = forwardedEnvironment(options.environmentAllowlist);
  const stdout = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawn(executable, [...args, operation], {
              cwd: options.cwd,
              env: environment,
              shell: false,
              stdio: ['pipe', 'pipe', 'pipe'],
            }),
          catch: (cause) =>
            new RoleHostOperationalError({
              message: `Cannot start role host "${executable}": ${boundCause(cause)}.`,
              operation,
            }),
        }),
        (spawned) =>
          Effect.sync(() => {
            if (spawned.exitCode === null && spawned.signalCode === null) {
              spawned.kill();
            }
          }),
      );
      yield* Effect.try({
        try: () => {
          child.stdin?.end(`${requestText}\n`);
        },
        catch: (cause) =>
          new RoleHostOperationalError({
            message: `Cannot send the ${operation} request to role host "${executable}": ${boundCause(cause)}.`,
            operation,
          }),
      });
      return yield* waitForClose(child, executable, operation, options.maxOutputBytes);
    }),
  ).pipe(
    Effect.timeout(Duration.millis(options.timeoutMs)),
    Effect.catchTag(
      'TimeoutError',
      () =>
        new RoleHostOperationalError({
          message: `Role host "${executable}" ${operation} exceeded ${options.timeoutMs}ms.`,
          operation,
        }),
    ),
  );

  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(responseSchema), {
    onExcessProperty: 'error',
  })(stdout).pipe(
    Effect.mapError(
      () =>
        new RoleHostOperationalError({
          message: `Role host "${executable}" ${operation} did not return exactly one closed response document.`,
          operation,
        }),
    ),
  );
});

export const roleHostProcessLayer = (options: RoleHostProcessOptions): Layer.Layer<RoleHost> =>
  Layer.succeed(
    RoleHost,
    RoleHost.of({
      create: (
        request: RoleHostCreateRequest,
      ): Effect.Effect<RoleHostCreateResponse, RoleHostOperationalError> =>
        runOperation(options, 'create', JSON.stringify(request), RoleHostCreateResponseSchema),
      submit: (
        request: RoleHostSubmitRequest,
      ): Effect.Effect<RoleHostSubmitResponse, RoleHostOperationalError> =>
        runOperation(options, 'submit', JSON.stringify(request), RoleHostSubmitResponseSchema),
      observe: (
        request: RoleHostObserveRequest,
      ): Effect.Effect<RoleHostObserveResponse, RoleHostOperationalError> =>
        runOperation(options, 'observe', JSON.stringify(request), RoleHostObserveResponseSchema),
      stop: (
        request: RoleHostStopRequest,
      ): Effect.Effect<RoleHostStopResponse, RoleHostOperationalError> =>
        runOperation(options, 'stop', JSON.stringify(request), RoleHostStopResponseSchema),
    }),
  );
