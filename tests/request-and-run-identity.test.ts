import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { ProjectCommandProcess } from '../src/application/profile-check/index.js';
import { ReadinessGit, ReadinessHost } from '../src/application/readiness/index.js';
import {
  DuplicateRunId,
  InvalidRunRequest,
  RunIdentityStorageError,
  RunIdentityStore,
  RunStateUnavailable,
  readRunWorkflowState,
  recordRunIdentity,
} from '../src/application/run-identity/index.js';
import { transitionWorkflow } from '../src/application/workflow-transitions/index.js';
import {
  Identifier,
  REQUEST_IDENTITY_FILENAME,
  REQUEST_IDENTITY_SCHEMA_VERSION,
  REQUEST_NORMALIZED_FILENAME,
  REQUEST_ORIGINAL_FILENAME,
  RequestIdentityDocumentSchema,
  normalizeRequestPromptText,
} from '../src/domain/run-identity.js';
import { EXIT_CODES } from '../src/domain/public-commands.js';
import {
  ACTIVE_WORKFLOW_STATES,
  DECISION_OR_PUBLICATION_WORKFLOW_STATES,
  INITIAL_WORKFLOW_STATE,
  RECOVERABLE_WORKFLOW_STATES,
  SUCCESS_WORKFLOW_STATES,
  TERMINAL_WORKFLOW_STATES,
  WORKFLOW_STATES,
  WORKFLOW_STATE_FILENAME,
  WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
  WORKFLOW_STATE_SCHEMA_VERSION,
  WorkflowStateDocumentSchema,
  WorkflowStateSchema,
} from '../src/domain/workflow.js';
import { ReadinessFilesLive } from '../src/platform/readiness.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

function envelopeFrom(stdout: string) {
  return Schema.decodeUnknownSync(ReportEnvelopeJson)(stdout);
}

function expectRecordedEnvelope(stdout: string) {
  const envelope = envelopeFrom(stdout);
  expect(envelope.ok).toBe(true);
  if (!envelope.ok) {
    throw new Error(`Expected a success envelope but received: ${stdout}`);
  }
  const data = envelope.data;
  if (!('request' in data)) {
    throw new Error(`Expected a recorded-run envelope but received: ${stdout}`);
  }
  return { envelope, data };
}

function expectRecordedFailure(stdout: string) {
  const envelope = envelopeFrom(stdout);
  expect(envelope.ok).toBe(false);
  if (envelope.ok) {
    throw new Error(`Expected a failure envelope but received: ${stdout}`);
  }
  return envelope;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function goldenDocument(targetRepository: string, maxRequestBytes = 262144) {
  return {
    schemaVersion: 1,
    targetRepository,
    sourceRemote: 'origin',
    sourceBranch: 'main',
    taskBranchPolicy: 'foundry/<task-id>',
    roleHarness: {
      protocol: 'foundry-role-host-v1',
      command: ['foundry-role-host'],
      environmentAllowlist: ['OPENAI_API_KEY'],
    },
    timeouts: {
      roleMs: 1800000,
      settleMs: 30000,
      pollMs: 100,
      commandMs: 900000,
      runtimeReadinessMs: 120000,
      cleanupMs: 30000,
      leaseMs: 60000,
    },
    retryBudgets: { architect: 1, coder: 2, tester: 1, reviewer: 1 },
    operationalRetryBudgets: { git: 2, runtime: 1, publication: 2, cleanup: 1 },
    limits: { maxParallelCoders: 4, maxCorrectionRounds: 2, maxControlRepairsPerAttempt: 1 },
    projectProfile: {
      guidancePaths: [],
      commands: {
        bootstrap: ['npm', 'ci'],
        formatCheck: ['npm', 'run', 'format:check'],
        lint: ['npm', 'run', 'lint'],
        typecheck: ['npm', 'run', 'typecheck'],
        test: ['npm', 'test'],
        build: ['npm', 'run', 'build'],
      },
    },
    runtimeProfile: null,
    decisionPublication: null,
    artifacts: {
      retentionDays: 30,
      maxRequestBytes,
      maxGuidanceBytes: 1048576,
      maxRoleHandoffBytes: 262144,
      maxEvidenceBytes: 26214400,
      maxTerminalCaptureBytes: 10485760,
      maxRunBytes: 104857600,
      redactionPatterns: [],
    },
  };
}

interface Fixture {
  readonly base: string;
  readonly target: string;
  readonly configPath: string;
  readonly requestPath: string;
  readonly runDirectory: (runId: string) => string;
  readonly cleanup: () => void;
}

function setupFixture(options?: { readonly maxRequestBytes?: number }): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-run-identity-'));
  const target = join(base, 'target');
  const home = join(base, 'home');
  mkdirSync(target, { recursive: true });
  mkdirSync(home, { recursive: true });
  const configPath = join(home, 'foundry.config.json');
  writeFileSync(
    configPath,
    JSON.stringify(goldenDocument(target, options?.maxRequestBytes ?? 262144)),
  );
  const requestPath = join(home, 'request.md');
  return {
    base,
    target,
    configPath,
    requestPath,
    runDirectory: (runId: string) => join(target, '.agent', 'runs', runId),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const LiveFilesAndStore = Layer.mergeAll(ReadinessFilesLive, RunIdentityLive);

function dieService(message: string) {
  return Effect.die(new Error(message));
}

const CliLayer = Layer.mergeAll(
  Layer.succeed(
    ReadinessHost,
    ReadinessHost.of({
      platform: dieService('run must not read the host platform'),
      nodeVersion: dieService('run must not read tool versions'),
      npmVersion: dieService('run must not read tool versions'),
      gitVersionOutput: dieService('run must not read tool versions'),
    }),
  ),
  ReadinessFilesLive,
  Layer.succeed(
    ReadinessGit,
    ReadinessGit.of({
      run: (_args: ReadonlyArray<string>, _cwd: string) => dieService('run must not run git'),
    }),
  ),
  Layer.succeed(
    ProjectCommandProcess,
    ProjectCommandProcess.of({
      run: (_options: { readonly command: ReadonlyArray<string>; readonly cwd: string }) =>
        dieService('run must not run project commands'),
    }),
  ),
  RunIdentityLive,
);

function recordWithLive(options: {
  readonly configPath: string;
  readonly requestPath: string;
  readonly taskId: string;
  readonly runId: string;
}) {
  return recordRunIdentity({
    configArg: options.configPath,
    cwd: '/',
    requestArg: options.requestPath,
    taskId: options.taskId,
    runId: options.runId,
  }).pipe(Effect.provide(LiveFilesAndStore));
}

function readWithLive(options: { readonly configPath: string; readonly runId: string }) {
  return readRunWorkflowState({
    configArg: options.configPath,
    cwd: '/',
    runId: options.runId,
  }).pipe(Effect.provide(LiveFilesAndStore));
}

function statePathOf(fixture: Fixture, runId: string): string {
  return join(fixture.runDirectory(runId), WORKFLOW_STATE_FILENAME);
}

function writeState(fixture: Fixture, runId: string, state: string): string {
  const statePath = statePathOf(fixture, runId);
  writeFileSync(
    statePath,
    `${JSON.stringify({ schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION, runId, state }, null, 2)}\n`,
  );
  return statePath;
}

describe('workflow state vocabulary', () => {
  it('names exactly the documented workflow states', () => {
    expect(WORKFLOW_STATES).toEqual([
      'planning',
      'coding',
      'verifying',
      'testing',
      'reviewing',
      'correcting',
      'human_decision_required',
      'publishing',
      'completed',
      'completed_no_change',
      'abandoned',
      'blocked',
      'failed',
      'publish_failed',
    ]);
    for (const state of WORKFLOW_STATES) {
      expect(Schema.is(WorkflowStateSchema)(state), state).toBe(true);
    }
    for (const value of ['queued', 'running', 'approved', 'changes_requested', '']) {
      expect(Schema.is(WorkflowStateSchema)(value), value).toBe(false);
    }
  });

  it('classifies every state through the documented groups', () => {
    const groups: ReadonlyArray<ReadonlyArray<string>> = [
      ACTIVE_WORKFLOW_STATES,
      DECISION_OR_PUBLICATION_WORKFLOW_STATES,
      SUCCESS_WORKFLOW_STATES,
      RECOVERABLE_WORKFLOW_STATES,
      TERMINAL_WORKFLOW_STATES,
    ];
    const covered = new Set(groups.flat());
    for (const state of WORKFLOW_STATES) {
      expect(covered.has(state), state).toBe(true);
    }
    for (const state of covered) {
      expect(
        WORKFLOW_STATES.some((candidate) => candidate === state),
        state,
      ).toBe(true);
    }
    expect(INITIAL_WORKFLOW_STATE).toBe('planning');
    expect(ACTIVE_WORKFLOW_STATES).toEqual([
      'planning',
      'coding',
      'verifying',
      'testing',
      'reviewing',
      'correcting',
    ]);
    expect(DECISION_OR_PUBLICATION_WORKFLOW_STATES).toEqual([
      'human_decision_required',
      'publishing',
    ]);
    expect(SUCCESS_WORKFLOW_STATES).toEqual(['completed', 'completed_no_change']);
    expect(TERMINAL_WORKFLOW_STATES).toEqual([
      'completed',
      'completed_no_change',
      'abandoned',
      'failed',
    ]);
    expect(RECOVERABLE_WORKFLOW_STATES).toEqual(['blocked', 'publish_failed']);
  });

  it('decodes versioned state records and rejects unknown or malformed records', () => {
    const decode = (value: Schema.Json) =>
      Schema.decodeUnknownSync(WorkflowStateDocumentSchema, { onExcessProperty: 'error' })(value);
    for (const state of WORKFLOW_STATES) {
      expect(
        decode({ schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION, runId: 'RUN-1', state }),
      ).toEqual({ schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION, runId: 'RUN-1', state });
    }
    expect(() =>
      decode({ schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION, runId: 'RUN-1', state: 'queued' }),
    ).toThrow();
    expect(() => decode({ schemaVersion: 2, runId: 'RUN-1', state: 'planning' })).toThrow();
    expect(() => decode({ runId: 'RUN-1', state: 'planning' })).toThrow();
    expect(() =>
      decode({
        schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
        runId: 'RUN-1',
        state: 'planning',
        extra: true,
      }),
    ).toThrow();
  });
});

describe('run identity vocabulary', () => {
  it('normalizes line endings to LF only', () => {
    expect(normalizeRequestPromptText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    expect(normalizeRequestPromptText('plain')).toBe('plain');
  });

  it('accepts operator IDs and rejects malformed values', () => {
    for (const valid of ['RUN-1', 'TASK-1', 'a', 'A0._-x']) {
      expect(Schema.is(Identifier)(valid), valid).toBe(true);
    }
    for (const invalid of ['', 'bad id', '-leading', '.leading', 'a'.repeat(65)]) {
      expect(Schema.is(Identifier)(invalid), invalid).toBe(false);
    }
  });
});

describe('recordRunIdentity with live storage', () => {
  it.effect('records operator IDs with retained original, normalized, and identity files', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const text = '# Outcome\n\nShip it.\n';
        writeFileSync(fixture.requestPath, text);
        const report = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-1',
        });

        expect(report.runId).toBe('RUN-1');
        expect(report.taskId).toBe('TASK-1');
        expect(report.runDirectory).toBe(fixture.runDirectory('RUN-1'));

        const originalBytes = new Uint8Array(readFileSync(report.request.originalPath));
        const normalizedText = readFileSync(report.request.normalizedPath, 'utf8');
        expect(Buffer.from(originalBytes).toString('utf8')).toBe(text);
        expect(normalizedText).toBe('# Outcome\n\nShip it.\n');
        expect(report.request.originalByteLength).toBe(originalBytes.byteLength);
        expect(report.request.originalContentHash).toBe(sha256Hex(originalBytes));
        expect(report.request.normalizedPromptHash).toBe(
          sha256Hex(new TextEncoder().encode(normalizedText)),
        );
        expect(report.request.originalPath).toBe(
          join(fixture.runDirectory('RUN-1'), REQUEST_ORIGINAL_FILENAME),
        );
        expect(report.request.normalizedPath).toBe(
          join(fixture.runDirectory('RUN-1'), REQUEST_NORMALIZED_FILENAME),
        );
        expect(report.request.identityPath).toBe(
          join(fixture.runDirectory('RUN-1'), REQUEST_IDENTITY_FILENAME),
        );

        const identityText = readFileSync(report.request.identityPath, 'utf8');
        const identity = yield* Schema.decodeUnknownEffect(RequestIdentityDocumentSchema, {
          onExcessProperty: 'error',
        })(JSON.parse(identityText));
        expect(identity).toEqual({
          schemaVersion: REQUEST_IDENTITY_SCHEMA_VERSION,
          runId: 'RUN-1',
          taskId: 'TASK-1',
          sourceRequestPath: fixture.requestPath,
          originalByteLength: originalBytes.byteLength,
          originalContentHash: sha256Hex(originalBytes),
          normalizedByteLength: new TextEncoder().encode(normalizedText).byteLength,
          normalizedPromptHash: sha256Hex(new TextEncoder().encode(normalizedText)),
        });

        const extraDecode = ((): 'decoded' | 'rejected' => {
          try {
            Schema.decodeUnknownSync(RequestIdentityDocumentSchema, {
              onExcessProperty: 'error',
            })({ ...JSON.parse(identityText), extra: true });
            return 'decoded';
          } catch {
            return 'rejected';
          }
        })();
        expect(extraDecode).toBe('rejected');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('keeps retained evidence after the live request file changes', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'original ask\n');
        const report = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-KEEP',
        });

        writeFileSync(fixture.requestPath, 'rewritten ask\n');
        expect(readFileSync(report.request.originalPath, 'utf8')).toBe('original ask\n');
        expect(readFileSync(report.request.normalizedPath, 'utf8')).toBe('original ask\n');
        expect(report.request.originalContentHash).toBe(
          sha256Hex(new TextEncoder().encode('original ask\n')),
        );
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses an empty request without creating a run directory', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, '');
        const error = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-EMPTY',
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(InvalidRunRequest);
        expect(error.message).toContain('empty');
        expect(existsSync(fixture.runDirectory('RUN-EMPTY'))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses an oversized request without creating a run directory', () =>
    Effect.gen(function* () {
      const fixture = setupFixture({ maxRequestBytes: 16 });
      try {
        writeFileSync(fixture.requestPath, 'x'.repeat(17));
        const error = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-BIG',
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(InvalidRunRequest);
        expect(error.message).toContain('exceeds the limit');
        expect(existsSync(fixture.runDirectory('RUN-BIG'))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses a non-UTF-8 request without creating a run directory', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, Buffer.from([0xff, 0xfe, 0x41]));
        const error = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-BINARY',
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(InvalidRunRequest);
        expect(error.message).toContain('UTF-8');
        expect(existsSync(fixture.runDirectory('RUN-BINARY'))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses missing and non-regular requests without creating a run directory', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const missing = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-MISSING',
        }).pipe(Effect.flip);
        expect(missing).toBeInstanceOf(InvalidRunRequest);
        expect(existsSync(fixture.runDirectory('RUN-MISSING'))).toBe(false);

        mkdirSync(fixture.requestPath, { recursive: true });
        const directory = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-DIRECTORY',
        }).pipe(Effect.flip);
        expect(directory).toBeInstanceOf(InvalidRunRequest);
        expect(directory.message).toContain('regular file');
        expect(existsSync(fixture.runDirectory('RUN-DIRECTORY'))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses a duplicate run ID without overwriting retained files', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'first ask\n');
        const first = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-DUP',
        });
        const beforeOriginal = readFileSync(first.request.originalPath, 'utf8');
        const beforeIdentity = readFileSync(first.request.identityPath, 'utf8');

        writeFileSync(fixture.requestPath, 'second ask\n');
        const duplicate = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-DUP',
        }).pipe(Effect.flip);
        expect(duplicate).toBeInstanceOf(DuplicateRunId);
        expect(duplicate.runId).toBe('RUN-DUP');
        expect(readFileSync(first.request.originalPath, 'utf8')).toBe(beforeOriginal);
        expect(readFileSync(first.request.identityPath, 'utf8')).toBe(beforeIdentity);

        const sibling = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-DUP-2',
        });
        expect(sibling.runId).toBe('RUN-DUP-2');
        expect(sibling.taskId).toBe('TASK-1');
        expect(readFileSync(sibling.request.originalPath, 'utf8')).toBe('second ask\n');
        expect(readFileSync(first.request.originalPath, 'utf8')).toBe('first ask\n');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('accepts free-form prose and keeps original bytes exact for CRLF input', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const input = 'do the thing\r\n---\r\nno headings here\r\n';
        writeFileSync(fixture.requestPath, input);
        const report = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-FREE',
        });

        expect(Buffer.from(new Uint8Array(readFileSync(report.request.originalPath)))).toEqual(
          Buffer.from(input, 'utf8'),
        );
        expect(readFileSync(report.request.normalizedPath, 'utf8')).toBe(
          'do the thing\n---\nno headings here\n',
        );
        expect(report.request.originalContentHash).not.toBe(report.request.normalizedPromptHash);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('workflow state through run storage', () => {
  it.effect('records exactly one planning state with the run ID on initialization', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'state ask\n');
        const report = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-STATE',
        });
        const statePath = statePathOf(fixture, 'RUN-STATE');
        expect(statePath).toBe(join(report.runDirectory, WORKFLOW_STATE_FILENAME));
        expect(existsSync(statePath)).toBe(true);

        const record = yield* Schema.decodeUnknownEffect(WorkflowStateDocumentSchema, {
          onExcessProperty: 'error',
        })(JSON.parse(readFileSync(statePath, 'utf8')));
        expect(record).toEqual({
          schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
          runId: 'RUN-STATE',
          state: INITIAL_WORKFLOW_STATE,
        });

        const identityText = readFileSync(report.request.identityPath, 'utf8');
        expect(identityText).not.toContain('"state"');
        expect(identityText).toContain(`"schemaVersion": ${REQUEST_IDENTITY_SCHEMA_VERSION}`);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('rolls back the run directory when the state record cannot be written', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'rollback ask\n');
        const liveStore = yield* RunIdentityStore.pipe(Effect.provide(RunIdentityLive));
        const failingStore = RunIdentityStore.of({
          ...liveStore,
          writeFileBytes: (path: string, bytes: Uint8Array) =>
            path.endsWith(WORKFLOW_STATE_FILENAME)
              ? Effect.fail(
                  new RunIdentityStorageError({
                    message: 'state write refused',
                    runId: 'RUN-ROLLBACK',
                  }),
                )
              : liveStore.writeFileBytes(path, bytes),
        });
        const layer = Layer.mergeAll(
          ReadinessFilesLive,
          Layer.succeed(RunIdentityStore, failingStore),
        );
        const error = yield* recordRunIdentity({
          configArg: fixture.configPath,
          cwd: '/',
          requestArg: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-ROLLBACK',
        }).pipe(Effect.provide(layer), Effect.flip);

        expect(error).toBeInstanceOf(RunIdentityStorageError);
        expect(error.message).toContain('Cannot retain request');
        expect(existsSync(fixture.runDirectory('RUN-ROLLBACK'))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('reads every named state from the durable record for the matching run', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'state ask\n');
        yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-READ',
        });
        for (const state of WORKFLOW_STATES) {
          writeState(fixture, 'RUN-READ', state);
          const report = yield* readWithLive({
            configPath: fixture.configPath,
            runId: 'RUN-READ',
          });
          expect(report).toEqual({ runId: 'RUN-READ', workflowState: state });
        }
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('reads progress records written by the transition gate', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'progress ask\n');
        const recorded = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-PROGRESS',
        });
        const transitioned = yield* transitionWorkflow({
          runDirectory: recorded.runDirectory,
          runId: 'RUN-PROGRESS',
          request: { route: 'plan-accepted', planRequiresImplementation: true },
        }).pipe(Effect.provide(LiveFilesAndStore));
        expect(transitioned.workflowState).toBe('coding');

        const report = yield* readWithLive({
          configPath: fixture.configPath,
          runId: 'RUN-PROGRESS',
        });
        expect(report).toEqual({ runId: 'RUN-PROGRESS', workflowState: 'coding' });

        const stateText = readFileSync(statePathOf(fixture, 'RUN-PROGRESS'), 'utf8');
        expect(stateText).toContain(`"schemaVersion": ${WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION}`);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('reports missing, malformed, unknown, and wrong-run state without guessing', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'state ask\n');
        yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-BAD',
        });
        const statePath = statePathOf(fixture, 'RUN-BAD');
        const readState = () =>
          readWithLive({ configPath: fixture.configPath, runId: 'RUN-BAD' }).pipe(Effect.flip);

        rmSync(statePath);
        const missing = yield* readState();
        expect(missing).toBeInstanceOf(RunStateUnavailable);
        expect(missing.runId).toBe('RUN-BAD');
        expect(missing.message).toContain('no recorded workflow state');

        writeFileSync(statePath, '{ not json');
        const malformed = yield* readState();
        expect(malformed).toBeInstanceOf(RunStateUnavailable);
        expect(malformed.message).toContain('not valid JSON');

        writeState(fixture, 'RUN-BAD', 'queued');
        const unknown = yield* readState();
        expect(unknown).toBeInstanceOf(RunStateUnavailable);
        expect(unknown.message).toContain('not a valid state record');

        writeFileSync(
          statePath,
          `${JSON.stringify({ schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION, runId: 'RUN-OTHER', state: 'completed' }, null, 2)}\n`,
        );
        const wrongRun = yield* readState();
        expect(wrongRun).toBeInstanceOf(RunStateUnavailable);
        expect(wrongRun.message).toContain('RUN-OTHER');

        rmSync(statePath);
        mkdirSync(statePath);
        const directory = yield* readState();
        expect(directory).toBeInstanceOf(RunStateUnavailable);
        expect(directory.message).toContain('not a regular file');

        const invalidId = yield* readRunWorkflowState({
          configArg: fixture.configPath,
          cwd: '/',
          runId: '../escape',
        }).pipe(Effect.provide(LiveFilesAndStore), Effect.flip);
        expect(invalidId).toBeInstanceOf(RunStateUnavailable);
        expect(invalidId.message).toContain('not a valid run identifier');
        expect(existsSync(join(fixture.target, '.agent', 'escape'))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('run command through the cli envelope', () => {
  it.effect('reports recorded IDs, hashes, and retained paths with exit code 0', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, '# Outcome\n\nShip it.\n');
        const result = yield* runCli([
          'run',
          '--config',
          fixture.configPath,
          '--request',
          fixture.requestPath,
          '--task-id',
          'TASK-CLI',
          '--run-id',
          'RUN-CLI-1',
          '--json',
        ]).pipe(Effect.provide(CliLayer));

        expect(result.exitCode).toBe(EXIT_CODES.reported);
        const { envelope, data } = expectRecordedEnvelope(result.stdout);
        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.command).toBe('run');
        expect(data.runId).toBe('RUN-CLI-1');
        expect(data.taskId).toBe('TASK-CLI');
        expect(data.runDirectory).toBe(fixture.runDirectory('RUN-CLI-1'));
        expect(Object.keys(data).sort()).toEqual(
          ['request', 'runDirectory', 'runId', 'taskId'].sort(),
        );
        expect(Object.keys(data.request).sort()).toEqual(
          [
            'sourcePath',
            'originalPath',
            'normalizedPath',
            'identityPath',
            'originalByteLength',
            'originalContentHash',
            'normalizedByteLength',
            'normalizedPromptHash',
          ].sort(),
        );

        const originalBytes = new Uint8Array(readFileSync(data.request.originalPath));
        expect(data.request.originalContentHash).toBe(sha256Hex(originalBytes));
        const normalizedBytes = new Uint8Array(readFileSync(data.request.normalizedPath));
        expect(data.request.normalizedPromptHash).toBe(sha256Hex(normalizedBytes));
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('presents the same recorded facts in human output as in json output', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'human readable ask\n');
        const run = (argv: ReadonlyArray<string>) => runCli(argv).pipe(Effect.provide(CliLayer));
        const jsonResult = yield* run([
          'run',
          '--config',
          fixture.configPath,
          '--request',
          fixture.requestPath,
          '--task-id',
          'TASK-CLI',
          '--run-id',
          'RUN-CLI-HUMAN',
          '--json',
        ]);
        expect(jsonResult.exitCode).toBe(EXIT_CODES.reported);
        const { data } = expectRecordedEnvelope(jsonResult.stdout);

        const humanResult = yield* run([
          'run',
          '--config',
          fixture.configPath,
          '--request',
          fixture.requestPath,
          '--task-id',
          'TASK-CLI',
          '--run-id',
          'RUN-CLI-HUMAN-2',
        ]);
        expect(humanResult.exitCode).toBe(EXIT_CODES.reported);
        expect(humanResult.stdout).toContain(`data.runId: RUN-CLI-HUMAN-2`);
        expect(humanResult.stdout).toContain(`data.taskId: TASK-CLI`);
        expect(humanResult.stdout).toContain(
          `data.request.originalContentHash: ${data.request.originalContentHash}`,
        );
        expect(humanResult.stdout).toContain(
          `data.request.normalizedPromptHash: ${data.request.normalizedPromptHash}`,
        );
        expect(humanResult.stdout.endsWith('\n')).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses a duplicate run ID with exit code 2 and keeps the first run intact', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'first ask\n');
        const run = (argv: ReadonlyArray<string>) => runCli(argv).pipe(Effect.provide(CliLayer));
        const first = yield* run([
          'run',
          '--config',
          fixture.configPath,
          '--request',
          fixture.requestPath,
          '--task-id',
          'TASK-CLI',
          '--run-id',
          'RUN-CLI-DUP',
          '--json',
        ]);
        expect(first.exitCode).toBe(EXIT_CODES.reported);
        const { data } = expectRecordedEnvelope(first.stdout);
        const before = readFileSync(data.request.originalPath, 'utf8');

        writeFileSync(fixture.requestPath, 'second ask\n');
        const second = yield* run([
          'run',
          '--config',
          fixture.configPath,
          '--request',
          fixture.requestPath,
          '--task-id',
          'TASK-CLI',
          '--run-id',
          'RUN-CLI-DUP',
          '--json',
        ]);
        expect(second.exitCode).toBe(EXIT_CODES.invalidInvocation);
        const failure = expectRecordedFailure(second.stdout);
        expect(failure.command).toBe('run');
        expect(failure.error.kind).toBe('invalid_invocation');
        expect(failure.error.retryable).toBe(false);
        expect(failure.error.runId).toBe('RUN-CLI-DUP');
        expect(readFileSync(data.request.originalPath, 'utf8')).toBe(before);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('maps request validation failures to exit code 2 with the run ID', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, '');
        const result = yield* runCli([
          'run',
          '--config',
          fixture.configPath,
          '--request',
          fixture.requestPath,
          '--task-id',
          'TASK-CLI',
          '--run-id',
          'RUN-CLI-EMPTY',
          '--json',
        ]).pipe(Effect.provide(CliLayer));

        expect(result.exitCode).toBe(EXIT_CODES.invalidInvocation);
        const failure = expectRecordedFailure(result.stdout);
        expect(failure.error.kind).toBe('invalid_invocation');
        expect(failure.error.retryable).toBe(false);
        expect(failure.error.runId).toBe('RUN-CLI-EMPTY');
        expect(existsSync(fixture.runDirectory('RUN-CLI-EMPTY'))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('status command through the cli envelope', () => {
  it.effect('reports the recorded state in json and human output with exit code 0', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'status ask\n');
        const run = (argv: ReadonlyArray<string>) => runCli(argv).pipe(Effect.provide(CliLayer));
        const recorded = yield* run([
          'run',
          '--config',
          fixture.configPath,
          '--request',
          fixture.requestPath,
          '--task-id',
          'TASK-CLI',
          '--run-id',
          'RUN-STATUS',
          '--json',
        ]);
        expect(recorded.exitCode).toBe(EXIT_CODES.reported);

        for (const state of [
          'planning',
          'human_decision_required',
          'publishing',
          'completed',
          'completed_no_change',
          'publish_failed',
        ] as const) {
          writeState(fixture, 'RUN-STATUS', state);

          const jsonResult = yield* run([
            'status',
            '--config',
            fixture.configPath,
            '--run-id',
            'RUN-STATUS',
            '--json',
          ]);
          expect(jsonResult.exitCode, state).toBe(EXIT_CODES.reported);
          const envelope = envelopeFrom(jsonResult.stdout);
          expect(envelope.ok, state).toBe(true);
          if (!envelope.ok) {
            throw new Error(`Expected a success envelope but received: ${jsonResult.stdout}`);
          }
          expect(envelope.command).toBe('status');
          expect(envelope.data).toEqual({ runId: 'RUN-STATUS', workflowState: state });

          const humanResult = yield* run([
            'status',
            '--config',
            fixture.configPath,
            '--run-id',
            'RUN-STATUS',
          ]);
          expect(humanResult.exitCode, state).toBe(EXIT_CODES.reported);
          expect(humanResult.stdout).toContain('command: status');
          expect(humanResult.stdout).toContain('data.runId: RUN-STATUS');
          expect(humanResult.stdout).toContain(`data.workflowState: ${state}`);
          expect(humanResult.stdout.endsWith('\n')).toBe(true);
        }
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('fails status without synthesizing a state when the record is missing or invalid', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'status ask\n');
        const run = (argv: ReadonlyArray<string>) => runCli(argv).pipe(Effect.provide(CliLayer));
        yield* run([
          'run',
          '--config',
          fixture.configPath,
          '--request',
          fixture.requestPath,
          '--task-id',
          'TASK-CLI',
          '--run-id',
          'RUN-NOSTATE',
          '--json',
        ]);

        const statePath = statePathOf(fixture, 'RUN-NOSTATE');
        rmSync(statePath);
        const missing = yield* run([
          'status',
          '--config',
          fixture.configPath,
          '--run-id',
          'RUN-NOSTATE',
          '--json',
        ]);
        expect(missing.exitCode).toBe(EXIT_CODES.operationFailed);
        const missingFailure = expectRecordedFailure(missing.stdout);
        expect(missingFailure.command).toBe('status');
        expect(missingFailure.error.kind).toBe('failed');
        expect(missingFailure.error.retryable).toBe(false);
        expect(missingFailure.error.runId).toBe('RUN-NOSTATE');
        expect(missingFailure.error.message).toContain('no recorded workflow state');

        writeState(fixture, 'RUN-NOSTATE', 'queued');
        const invalid = yield* run([
          'status',
          '--config',
          fixture.configPath,
          '--run-id',
          'RUN-NOSTATE',
          '--json',
        ]);
        expect(invalid.exitCode).toBe(EXIT_CODES.operationFailed);
        const invalidFailure = expectRecordedFailure(invalid.stdout);
        expect(invalidFailure.error.kind).toBe('failed');
        expect(invalidFailure.error.runId).toBe('RUN-NOSTATE');
        expect(invalidFailure.error.message).toContain('not a valid state record');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
