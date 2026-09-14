import { spawn } from 'node:child_process';

import { Duration, Effect, Layer, Schema } from 'effect';

import {
  RoleHost,
  RoleHostLauncher,
  RoleHostOperationalError,
} from '../application/role-conversations/index.js';
import {
  RoleHostCapabilitiesResponseSchema,
  RoleHostCreateResponseSchema,
  RoleHostObserveResponseSchema,
  RoleHostStopResponseSchema,
  RoleHostSubmitResponseSchema,
} from '../domain/role-host.js';

import type {
  RoleHostCapabilitiesRequest,
  RoleHostCapabilitiesResponse,
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
import { ROLE_HARNESS_NAMES } from '../domain/project-configuration.js';
import type { CommandVector, RoleHarnessName } from '../domain/project-configuration.js';

const STDERR_CAPTURE_LIMIT = 2_048;

type ProcessOutputChunk = Buffer | string;

export interface RoleHostProcessOptions {
  /**
   * Explicit launch argv for the legacy externally configured adapter.
   * Required when `harness` is absent; ignored when `harness` is present so
   * launch details are never carried in configuration.
   */
  readonly command?: CommandVector;
  /** Per-role routing: resolve the hardcoded catalog argv for this harness. */
  readonly harness?: RoleHarnessName;
  /** The model the harness must serve; required with `harness`. */
  readonly model?: string;
  readonly cwd: string;
  readonly environmentAllowlist: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface RoleHarnessCatalogEntry {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly models: ReadonlyArray<string>;
}

/**
 * Adapter-owned launch details per harness: the exact argv to spawn and the
 * model catalog the harness may serve. Configuration only names a harness
 * and model; this table is the only place argv and catalog membership live.
 * The entries below are the initial seed for the closed-model rule
 * mechanism; vendor-accurate launch details and catalog updates belong to
 * the bundling work in task 054.
 */
export const ROLE_HARNESS_CATALOG: Readonly<Record<RoleHarnessName, RoleHarnessCatalogEntry>> = {
  codex: { executable: 'codex', args: [], models: ['gpt-5-codex'] },
  opencode: { executable: 'opencode', args: [], models: ['openai/gpt-5'] },
};

/**
 * Reports whether the harness catalog contains the model. The comparison
 * trims surrounding whitespace, matching configuration decoding, and fails
 * closed on unknown harnesses and unknown models.
 */
export function isSupportedRoleHostModel(harness: RoleHarnessName, model: string): boolean {
  const entry = ROLE_HARNESS_CATALOG[harness];
  if (entry === undefined) {
    return false;
  }
  return entry.models.includes(model.trim());
}

const resolveEffectiveCommand = Effect.fn('roleHost.resolveEffectiveCommand')(function* (
  options: RoleHostProcessOptions,
  operation: RoleHostOperation,
): Effect.fn.Return<CommandVector, RoleHostOperationalError> {
  if (options.harness !== undefined) {
    const entry = ROLE_HARNESS_CATALOG[options.harness];
    if (entry === undefined) {
      return yield* new RoleHostOperationalError({
        message: `Unknown role harness "${options.harness}": Foundry supports ${ROLE_HARNESS_NAMES.join(', ')}.`,
        operation,
      });
    }
    const model = options.model?.trim() ?? '';
    if (model.length === 0) {
      return yield* new RoleHostOperationalError({
        message: `Role harness "${options.harness}" requires a non-empty model; Foundry never invents a substitute model.`,
        operation,
      });
    }
    if (!entry.models.includes(model)) {
      return yield* new RoleHostOperationalError({
        message: `Unknown model "${model}" for role harness "${options.harness}": supported models are ${entry.models.join(', ')}.`,
        operation,
      });
    }
    const command: CommandVector = [entry.executable, ...entry.args];
    return command;
  }
  if (options.model !== undefined) {
    return yield* new RoleHostOperationalError({
      message:
        'A role host model without a harness cannot be resolved; configure both harness and model per role.',
      operation,
    });
  }
  const [executable, ...rest] = options.command ?? [];
  if (executable === undefined) {
    return yield* new RoleHostOperationalError({
      message: 'The configured role host command is empty.',
      operation,
    });
  }
  return [executable, ...rest];
});

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
  const command = yield* resolveEffectiveCommand(options, operation);
  const [executable, ...args] = command;
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
      capabilities: (
        request: RoleHostCapabilitiesRequest,
      ): Effect.Effect<RoleHostCapabilitiesResponse, RoleHostOperationalError> =>
        runOperation(
          options,
          'capabilities',
          JSON.stringify(request),
          RoleHostCapabilitiesResponseSchema,
        ),
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

export const RoleHostLauncherLive: Layer.Layer<RoleHostLauncher> = Layer.succeed(
  RoleHostLauncher,
  RoleHostLauncher.of({
    launch: (options) => roleHostProcessLayer(options),
  }),
);
