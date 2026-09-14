import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

import { Duration, Effect, Layer, Schema } from 'effect';

import {
  RoleHost,
  RoleHostBinaryResolver,
  RoleHostCapabilityError,
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
import {
  BUNDLED_CREDENTIAL_ENVIRONMENT_NAMES,
  ROLE_HARNESS_NAMES,
} from '../domain/role-harness.js';
import type { RoleHarnessName } from '../domain/role-harness.js';
import type { CommandVector } from '../domain/project-configuration.js';

export { BUNDLED_CREDENTIAL_ENVIRONMENT_NAMES } from '../domain/role-harness.js';

const STDERR_CAPTURE_LIMIT = 2_048;

type ProcessOutputChunk = Buffer | string;

export interface RoleHostProcessOptions {
  /** Per-role routing: resolve the hardcoded catalog argv for this harness. */
  readonly harness: RoleHarnessName;
  /** The model the harness must serve. */
  readonly model: string;
  readonly cwd: string;
  readonly environmentAllowlist: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface RoleHarnessCatalogEntry {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly models: ReadonlyArray<string>;
  /**
   * Provider credential names the Foundry process forwards to this harness.
   * Values are read from Foundry's own environment at launch and never reach
   * configuration, prompts, or logs; see the role-host protocol contracts.
   */
  readonly environmentAllowlist: ReadonlyArray<string>;
}

/**
 * Candidate executable names per harness and platform. Only executable
 * resolution varies by platform; argv, catalogs, and routing are identical
 * on Linux and Windows. Windows probes PATHEXT-style names because vendor
 * CLIs may install as `.exe`, `.cmd`, or `.bat` shims.
 */
export function bundledExecutableCandidates(
  harness: RoleHarnessName,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  const entry = ROLE_HARNESS_CATALOG[harness];
  if (platform === 'win32') {
    return [
      entry.executable,
      `${entry.executable}.exe`,
      `${entry.executable}.cmd`,
      `${entry.executable}.bat`,
    ];
  }
  return [entry.executable];
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
  codex: {
    executable: 'codex',
    args: [],
    models: ['gpt-5-codex'],
    environmentAllowlist: BUNDLED_CREDENTIAL_ENVIRONMENT_NAMES,
  },
  opencode: {
    executable: 'opencode',
    args: [],
    models: ['openai/gpt-5'],
    environmentAllowlist: BUNDLED_CREDENTIAL_ENVIRONMENT_NAMES,
  },
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
  const entry = ROLE_HARNESS_CATALOG[options.harness];
  if (entry === undefined) {
    return yield* new RoleHostOperationalError({
      message: `Unknown role harness "${options.harness}": Foundry supports ${ROLE_HARNESS_NAMES.join(', ')}.`,
      operation,
    });
  }
  const model = options.model.trim();
  if (model.length === 0) {
    return yield* new RoleHostOperationalError({
      message: `Role harness "${options.harness}" requires a non-empty model; Foundry never invents a substitute model.`,
      operation,
    });
  }
  if (!isSupportedRoleHostModel(options.harness, model)) {
    return yield* new RoleHostOperationalError({
      message: `Unknown model "${model}" for role harness "${options.harness}": supported models are ${entry.models.join(', ')}.`,
      operation,
    });
  }
  const command: CommandVector = [entry.executable, ...entry.args];
  return command;
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
  // Bundled harness CLIs resolve through the process PATH, so PATH is always
  // forwarded alongside the credential names. This keeps spawned launches
  // coherent with doctor's PATH-based binary verification; PATH itself
  // carries directory names, never credential values.
  const path = process.env.PATH;
  if (path !== undefined) {
    environment.PATH = path;
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

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure PATH search behind live executable resolution. Tests cover this
 * directly with a fake `exists` predicate, so Windows ordering (bare,
 * `.exe`, `.cmd`, `.bat` across every directory) is verified
 * deterministically without platform-skipping; the live resolver supplies
 * the process PATH and `accessSync` underneath.
 */
export function findBundledExecutable(
  candidates: ReadonlyArray<string>,
  directories: ReadonlyArray<string>,
  joinPath: (directory: string, name: string) => string,
  exists: (path: string) => boolean,
): string | null {
  for (const directory of directories) {
    if (directory.length === 0) {
      continue;
    }
    for (const name of candidates) {
      const candidate = joinPath(directory, name);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Live bundled-harness resolution: searches the Foundry process PATH for the
 * hardcoded per-harness, per-platform executable candidates and checks model
 * catalog membership. Used by doctor verification; live runs resolve through
 * the spawning adapter instead.
 */
export const RoleHostBinaryResolverLive: Layer.Layer<RoleHostBinaryResolver> = Layer.succeed(
  RoleHostBinaryResolver,
  RoleHostBinaryResolver.of({
    resolveExecutable: (harness) =>
      Effect.gen(function* () {
        const candidates = bundledExecutableCandidates(harness, process.platform);
        const directories = (process.env.PATH ?? '').split(delimiter);
        const found = yield* Effect.sync(() =>
          findBundledExecutable(candidates, directories, join, isExecutableFile),
        );
        if (found !== null) {
          return found;
        }
        return yield* new RoleHostCapabilityError({
          message: `Bundled role harness "${harness}" executable (${candidates.join(', ')}) was not found on the process PATH.`,
          reason: 'unavailable',
        });
      }),
    resolveModel: (harness, model) =>
      Effect.gen(function* () {
        const entry = ROLE_HARNESS_CATALOG[harness];
        const trimmed = model.trim();
        if (!isSupportedRoleHostModel(harness, model)) {
          const supported =
            entry === undefined ? ROLE_HARNESS_NAMES.join(', ') : entry.models.join(', ');
          return yield* new RoleHostCapabilityError({
            message: `Unknown model "${model}" for bundled role harness "${harness}": supported models are ${supported}.`,
            reason: 'unavailable',
          });
        }
        return trimmed;
      }),
  }),
);
