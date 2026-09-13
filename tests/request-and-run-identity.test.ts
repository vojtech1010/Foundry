import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import { ProjectCommandProcess } from '../src/application/profile-check/index.js';
import { ReadinessGit, ReadinessHost } from '../src/application/readiness/index.js';
import {
  DuplicateRunId,
  InvalidRunRequest,
  RunIdentityStorageError,
  RunStateUnavailable,
  readRunWorkflowState,
  recordRunIdentity,
} from '../src/application/run-identity/index.js';
import {
  recordCleanupProgress,
  transitionWorkflow,
} from '../src/application/workflow-transitions/index.js';
import {
  RepositoryHostIdentity,
  acquireRepositoryLease,
} from '../src/application/repository-lease/index.js';
import {
  RunHistoryIntegrityError,
  RunHistoryStorage,
  RunHistoryStorageError,
  appendRunEvent,
} from '../src/application/run-history/index.js';
import {
  RUN_HISTORY_FILENAME,
  RUN_HISTORY_WITNESS_FILENAME,
  RunEventSchema,
  RunHistoryWitnessSchema,
  verifyRunHistoryEvents,
} from '../src/domain/run-history.js';
import type { RunEvent } from '../src/domain/run-history.js';
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
import { REPOSITORY_LEASE_FILENAME } from '../src/domain/repository-lease.js';
import {
  ACTIVE_WORKFLOW_STATES,
  CLEANUP_PROGRESS_FILENAME,
  CLEANUP_PROGRESS_SCHEMA_VERSION,
  CleanupProgressDocumentSchema,
  DECISION_OR_PUBLICATION_WORKFLOW_STATES,
  INITIAL_WORKFLOW_STATE,
  RECOVERABLE_WORKFLOW_STATES,
  SUCCESS_WORKFLOW_STATES,
  TERMINAL_WORKFLOW_STATES,
  WORKFLOW_STATES,
  WORKFLOW_STATE_FILENAME,
  WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
  WORKFLOW_STATE_SCHEMA_VERSION,
  WorkflowProgressDocumentSchema,
  WorkflowStateDocumentSchema,
  WorkflowStateSchema,
} from '../src/domain/workflow.js';
import { ReadinessFilesLive } from '../src/platform/readiness.js';
import { RunGitLive } from '../src/platform/git-provisioning.js';
import { GuidanceLive } from '../src/platform/guidance.js';
import { RepositoryLeaseLive } from '../src/platform/repository-lease.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import { capableRoleHostLauncher } from './fixtures/role-host/role-host-launcher.js';

import type { WorkflowState, WorkflowTransitionRequest } from '../src/domain/workflow.js';
import type { RunProgressReport } from '../src/application/run-identity/index.js';

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
  readonly remote: string;
  readonly configPath: string;
  readonly requestPath: string;
  readonly runDirectory: (runId: string) => string;
  readonly cleanup: () => void;
}

function gitExec(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

function setupFixture(options?: { readonly maxRequestBytes?: number }): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-run-identity-'));
  const target = join(base, 'target');
  const remote = join(base, 'remote.git');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', target], { encoding: 'utf8' });
  gitExec(target, ['config', 'user.email', 'identity@example.com']);
  gitExec(target, ['config', 'user.name', 'Foundry Identity']);
  writeFileSync(join(target, '.gitignore'), '.agent\n');
  writeFileSync(join(target, 'README.md'), '# target\n');
  gitExec(target, ['add', '.gitignore', 'README.md']);
  gitExec(target, ['commit', '-m', 'initial']);
  gitExec(target, ['remote', 'add', 'origin', remote]);
  gitExec(target, ['push', '-u', 'origin', 'main']);
  const configPath = join(home, 'foundry.config.json');
  writeFileSync(
    configPath,
    JSON.stringify(goldenDocument(target, options?.maxRequestBytes ?? 262144)),
  );
  const requestPath = join(home, 'request.md');
  return {
    base,
    target,
    remote,
    configPath,
    requestPath,
    runDirectory: (runId: string) => join(target, '.agent', 'runs', runId),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const LiveFilesAndStore = Layer.mergeAll(
  ReadinessFilesLive,
  RunIdentityLive,
  RunHistoryLive,
  RepositoryLeaseLive,
  GuidanceLive,
  capableRoleHostLauncher(),
);

function unusedRunGit(name: string) {
  return Effect.die(new Error(`transition tests must not call RunGit.${name}`));
}

const SyntheticRunGit = Layer.succeed(
  RunGit,
  RunGit.of({
    inspectRepository: () => unusedRunGit('inspectRepository'),
    fetchSource: () => unusedRunGit('fetchSource'),
    commitExists: () => unusedRunGit('commitExists'),
    readBranch: () => unusedRunGit('readBranch'),
    createBranch: () => unusedRunGit('createBranch'),
    readWorktree: () => unusedRunGit('readWorktree'),
    createWorktree: () => unusedRunGit('createWorktree'),
    observeImplementation: (options) =>
      Effect.succeed({
        workspaceExists: true,
        currentBranch: options.taskBranch,
        headCommit: 'abc123',
        clean: true,
        baseIsAncestor: true,
        changedFiles: [],
      }),
  }),
);

const TransitionLayer = Layer.mergeAll(LiveFilesAndStore, SyntheticRunGit);

function appendAcceptedPlan(
  runDirectory: string,
  runId: string,
  outcome: 'plan_ready' | 'no_change_candidate' = 'plan_ready',
  runtimeValidationRequired = false,
) {
  return appendRunEvent({
    runDirectory,
    runId,
    createIfMissing: false,
    build: () =>
      Effect.succeed({
        type: 'plan-accepted',
        payload: {
          outcome,
          criteria: [{ id: 'AC-001', text: 'the seeded criterion' }],
          runtimeValidationRequired,
          execution: {
            mode: 'sequential' as const,
            objectives: [
              {
                id: 'OBJ-001',
                title: 'Implement the accepted plan',
                affectedPaths: ['.'],
                criterionIds: ['AC-001'],
              },
            ],
          },
        },
      } as const),
  }).pipe(Effect.provide(LiveFilesAndStore));
}

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
  RunHistoryLive,
  RepositoryLeaseLive,
  RunGitLive,
  GuidanceLive,
  capableRoleHostLauncher(),
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
  }).pipe(Effect.provide(Layer.mergeAll(LiveFilesAndStore, RunGitLive)));
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

const RunEventJson = Schema.fromJsonString(RunEventSchema);

function readHistoryEvents(runDirectory: string): ReadonlyArray<RunEvent> {
  const historyPath = join(runDirectory, RUN_HISTORY_FILENAME);
  const text = readFileSync(historyPath, 'utf8');
  const lines = text.split('\n');
  lines.pop();
  return lines.map((line) =>
    Schema.decodeUnknownSync(RunEventJson, { onExcessProperty: 'error' })(line),
  );
}

function readHistoryWitness(runDirectory: string) {
  return Schema.decodeUnknownSync(Schema.fromJsonString(RunHistoryWitnessSchema), {
    onExcessProperty: 'error',
  })(readFileSync(join(runDirectory, RUN_HISTORY_WITNESS_FILENAME), 'utf8'));
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
          taskId: 'TASK-2',
          runId: 'RUN-DUP-2',
        });
        expect(sibling.runId).toBe('RUN-DUP-2');
        expect(sibling.taskId).toBe('TASK-2');
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
  it.effect('records exactly one canonical planning report with the run ID on initialization', () =>
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

        const record = yield* Schema.decodeUnknownEffect(WorkflowProgressDocumentSchema, {
          onExcessProperty: 'error',
        })(JSON.parse(readFileSync(statePath, 'utf8')));
        expect(record).toEqual({
          schemaVersion: WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
          runId: 'RUN-STATE',
          state: INITIAL_WORKFLOW_STATE,
          checkpoint: null,
          attempts: [],
        });

        const identityText = readFileSync(report.request.identityPath, 'utf8');
        expect(identityText).not.toContain('"state"');
        expect(identityText).toContain(`"schemaVersion": ${REQUEST_IDENTITY_SCHEMA_VERSION}`);

        const events = readHistoryEvents(report.runDirectory);
        expect(events).toHaveLength(5);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('rolls back the run directory when the canonical report cannot be written', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'rollback ask\n');
        const liveHistory = yield* RunHistoryStorage.pipe(Effect.provide(RunHistoryLive));
        const failingHistory = RunHistoryStorage.of({
          ...liveHistory,
          replaceDerivedReports: () =>
            Effect.fail(
              new RunHistoryStorageError({
                message: 'report write refused',
                runId: 'RUN-ROLLBACK',
              }),
            ),
        });
        const layer = Layer.mergeAll(
          ReadinessFilesLive,
          RunIdentityLive,
          Layer.succeed(RunHistoryStorage, failingHistory),
          RepositoryLeaseLive,
          capableRoleHostLauncher(),
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

  it.effect('rebuilds a hand-edited report from the verified history', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'state ask\n');
        const recorded = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-READ',
        });
        const planning = yield* readWithLive({
          configPath: fixture.configPath,
          runId: 'RUN-READ',
        });
        expect(planning).toMatchObject({
          runId: 'RUN-READ',
          runDirectory: recorded.runDirectory,
          historyPath: join(recorded.runDirectory, RUN_HISTORY_FILENAME),
          revision: 5,
          workflowState: 'planning',
          checkpoint: null,
          attempts: [],
          cleanupProgress: null,
        });
        expect(planning.provenance).not.toBeNull();

        const events = readHistoryEvents(recorded.runDirectory);
        expect(events).toHaveLength(5);
        const [genesis] = events;
        if (genesis === undefined) {
          throw new Error('Expected a genesis event.');
        }
        expect(genesis).toMatchObject({
          revision: 1,
          type: 'run-created',
          payload: { taskId: 'TASK-1' },
          previousEventHash: null,
        });
        expect(events[1]).toMatchObject({ revision: 2, type: 'source-frozen' });
        expect(events[2]).toMatchObject({ revision: 3, type: 'guidance-frozen' });
        expect(events[3]).toMatchObject({ revision: 4, type: 'worktree-ready' });
        const head = events[4];
        if (head === undefined) {
          throw new Error('Expected a workflow transition event.');
        }
        expect(head).toMatchObject({
          revision: 5,
          type: 'workflow-transition',
          payload: { route: 'run-created', from: null, to: 'planning' },
        });
        expect(planning.eventHash).toBe(head.eventHash);
        expect(readHistoryWitness(recorded.runDirectory)).toEqual({
          schemaVersion: 1,
          runId: 'RUN-READ',
          revision: 5,
          eventHash: head.eventHash,
        });
        expect(verifyRunHistoryEvents(events, 'RUN-READ').ok).toBe(true);

        yield* appendAcceptedPlan(recorded.runDirectory, 'RUN-READ');
        yield* transitionWorkflow({
          runDirectory: recorded.runDirectory,
          runId: 'RUN-READ',
          request: { route: 'plan-accepted' },
        }).pipe(Effect.provide(LiveFilesAndStore));
        const coding = yield* readWithLive({
          configPath: fixture.configPath,
          runId: 'RUN-READ',
        });
        expect(coding).toMatchObject({ runId: 'RUN-READ', workflowState: 'coding', revision: 7 });

        writeState(fixture, 'RUN-READ', 'completed');
        const rebuilt = yield* readWithLive({
          configPath: fixture.configPath,
          runId: 'RUN-READ',
        });
        expect(rebuilt.workflowState).toBe('coding');
        const rebuiltText = readFileSync(statePathOf(fixture, 'RUN-READ'), 'utf8');
        expect(
          Schema.decodeUnknownSync(WorkflowProgressDocumentSchema, { onExcessProperty: 'error' })(
            JSON.parse(rebuiltText),
          ),
        ).toEqual({
          schemaVersion: WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
          runId: 'RUN-READ',
          state: 'coding',
          checkpoint: null,
          attempts: [],
        });
        expect(readHistoryEvents(recorded.runDirectory)).toHaveLength(7);
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
        yield* appendAcceptedPlan(recorded.runDirectory, 'RUN-PROGRESS');
        const transitioned = yield* transitionWorkflow({
          runDirectory: recorded.runDirectory,
          runId: 'RUN-PROGRESS',
          request: { route: 'plan-accepted' },
        }).pipe(Effect.provide(LiveFilesAndStore));
        expect(transitioned.workflowState).toBe('coding');

        const report = yield* readWithLive({
          configPath: fixture.configPath,
          runId: 'RUN-PROGRESS',
        });
        expect(report).toMatchObject({
          runId: 'RUN-PROGRESS',
          workflowState: 'coding',
          checkpoint: null,
          attempts: [],
          cleanupProgress: null,
        });

        const stateText = readFileSync(statePathOf(fixture, 'RUN-PROGRESS'), 'utf8');
        expect(stateText).toContain(`"schemaVersion": ${WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION}`);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('rebuilds missing, malformed, unknown, and wrong-run reports from history', () =>
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
        const readState = () => readWithLive({ configPath: fixture.configPath, runId: 'RUN-BAD' });
        const expectRebuiltPlanning = (report: RunProgressReport): void => {
          expect(report.workflowState).toBe('planning');
          expect(report.revision).toBe(5);
          expect(existsSync(statePath)).toBe(true);
          expect(
            Schema.decodeUnknownSync(WorkflowProgressDocumentSchema, {
              onExcessProperty: 'error',
            })(JSON.parse(readFileSync(statePath, 'utf8'))),
          ).toEqual({
            schemaVersion: WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
            runId: 'RUN-BAD',
            state: 'planning',
            checkpoint: null,
            attempts: [],
          });
        };

        rmSync(statePath);
        expectRebuiltPlanning(yield* readState());

        writeFileSync(statePath, '{ not json');
        expectRebuiltPlanning(yield* readState());

        writeFileSync(statePath, '');
        expectRebuiltPlanning(yield* readState());

        writeState(fixture, 'RUN-BAD', 'queued');
        expectRebuiltPlanning(yield* readState());

        writeFileSync(
          statePath,
          `${JSON.stringify({ schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION, runId: 'RUN-OTHER', state: 'completed' }, null, 2)}\n`,
        );
        expectRebuiltPlanning(yield* readState());

        rmSync(statePath);
        mkdirSync(statePath);
        const directory = yield* readState().pipe(Effect.flip);
        expect(directory).toBeInstanceOf(RunHistoryStorageError);
        expect(directory.message).toContain('not a regular file');
        expect(existsSync(statePath)).toBe(true);

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

  it.effect('stops on incomplete history without repairing, truncating, or synthesizing', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'integrity ask\n');
        const recorded = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-BROKEN',
        });
        yield* appendAcceptedPlan(recorded.runDirectory, 'RUN-BROKEN');
        yield* transitionWorkflow({
          runDirectory: recorded.runDirectory,
          runId: 'RUN-BROKEN',
          request: { route: 'plan-accepted' },
        }).pipe(Effect.provide(LiveFilesAndStore));

        const streamPath = join(recorded.runDirectory, RUN_HISTORY_FILENAME);
        const witnessPath = join(recorded.runDirectory, RUN_HISTORY_WITNESS_FILENAME);
        const statePath = statePathOf(fixture, 'RUN-BROKEN');
        const lines = readFileSync(streamPath, 'utf8').split('\n');
        lines.pop();
        lines.pop();
        writeFileSync(streamPath, `${lines.join('\n')}\n`);
        const beforeStream = readFileSync(streamPath, 'utf8');
        const beforeWitness = readFileSync(witnessPath, 'utf8');
        const beforeState = readFileSync(statePath, 'utf8');

        const failure = yield* readWithLive({
          configPath: fixture.configPath,
          runId: 'RUN-BROKEN',
        }).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(RunHistoryIntegrityError);
        if (!(failure instanceof RunHistoryIntegrityError)) {
          throw new Error('Expected a run history integrity error.');
        }
        expect(failure.message).toContain(streamPath);
        expect(failure.message).toContain('investigate run integrity');

        expect(readFileSync(streamPath, 'utf8')).toBe(beforeStream);
        expect(readFileSync(witnessPath, 'utf8')).toBe(beforeWitness);
        expect(readFileSync(statePath, 'utf8')).toBe(beforeState);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('derived report reconciliation', () => {
  it.effect('reconstructs the cleanup report from verified cleanup events', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'cleanup ask\n');
        const recorded = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-CLEANUP',
        });
        const transition = (request: WorkflowTransitionRequest) =>
          transitionWorkflow({
            runDirectory: recorded.runDirectory,
            runId: 'RUN-CLEANUP',
            request,
          }).pipe(Effect.provide(TransitionLayer));
        yield* appendAcceptedPlan(recorded.runDirectory, 'RUN-CLEANUP');
        yield* transition({ route: 'plan-accepted' });
        yield* transition({
          route: 'implementation-ready',
          branchClean: true,
          candidateCommit: 'abc123',
          noChangeCandidateValidated: false,
        });
        yield* transition({
          route: 'checks-passed-reviewing',
          checksPassed: true,
          correctionBudgetExhausted: false,
          reviewableCommit: 'abc123',
        });
        yield* transition({
          route: 'review-approved',
          approvedCommit: 'abc123',
          evidenceCommitMatches: true,
          checksPassed: true,
          testerRequired: false,
          runtimeEvidencePresent: false,
        });
        yield* recordCleanupProgress({
          runDirectory: recorded.runDirectory,
          runId: 'RUN-CLEANUP',
          outcome: 'warning',
          detail: 'dispose warning',
        }).pipe(Effect.provide(LiveFilesAndStore));

        const cleanupPath = join(recorded.runDirectory, CLEANUP_PROGRESS_FILENAME);
        rmSync(cleanupPath);
        const rebuilt = yield* readWithLive({
          configPath: fixture.configPath,
          runId: 'RUN-CLEANUP',
        });
        expect(rebuilt.workflowState).toBe('completed');
        expect(rebuilt.cleanupProgress).toEqual({
          outcome: 'warning',
          detail: 'dispose warning',
        });
        expect(
          Schema.decodeUnknownSync(CleanupProgressDocumentSchema, { onExcessProperty: 'error' })(
            JSON.parse(readFileSync(cleanupPath, 'utf8')),
          ),
        ).toEqual({
          schemaVersion: CLEANUP_PROGRESS_SCHEMA_VERSION,
          runId: 'RUN-CLEANUP',
          outcome: 'warning',
          detail: 'dispose warning',
        });

        writeFileSync(
          cleanupPath,
          `${JSON.stringify(
            {
              schemaVersion: CLEANUP_PROGRESS_SCHEMA_VERSION,
              runId: 'RUN-CLEANUP',
              outcome: 'failed',
              detail: 'hand edited',
            },
            null,
            2,
          )}\n`,
        );
        const replaced = yield* readWithLive({
          configPath: fixture.configPath,
          runId: 'RUN-CLEANUP',
        });
        expect(replaced.cleanupProgress).toEqual({
          outcome: 'warning',
          detail: 'dispose warning',
        });
        expect(replaced.workflowState).toBe('completed');
        expect(readFileSync(cleanupPath, 'utf8')).toContain('dispose warning');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('discards a leftover cleanup report with no backing history', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'cleanup ask\n');
        const recorded = yield* recordWithLive({
          configPath: fixture.configPath,
          requestPath: fixture.requestPath,
          taskId: 'TASK-1',
          runId: 'RUN-NOCLEAN',
        });
        const cleanupPath = join(recorded.runDirectory, CLEANUP_PROGRESS_FILENAME);
        writeFileSync(
          cleanupPath,
          `${JSON.stringify(
            {
              schemaVersion: CLEANUP_PROGRESS_SCHEMA_VERSION,
              runId: 'RUN-NOCLEAN',
              outcome: 'failed',
              detail: 'not canonical',
            },
            null,
            2,
          )}\n`,
        );

        const report = yield* readWithLive({
          configPath: fixture.configPath,
          runId: 'RUN-NOCLEAN',
        });
        expect(report.workflowState).toBe('planning');
        expect(report.cleanupProgress).toBeNull();
        expect(existsSync(cleanupPath)).toBe(false);
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
          ['provenance', 'request', 'runDirectory', 'runId', 'taskId'].sort(),
        );
        expect(Object.keys(data.provenance).sort()).toEqual(
          [
            'repositoryRoot',
            'gitDirectory',
            'remoteUrl',
            'sourceRemote',
            'sourceBranch',
            'sourceCommit',
            'taskBranch',
            'workspace',
            'headCommit',
          ].sort(),
        );
        expect(data.provenance.sourceRemote).toBe('origin');
        expect(data.provenance.sourceBranch).toBe('main');
        expect(data.provenance.taskBranch).toBe('foundry/TASK-CLI');
        expect(data.provenance.workspace).toBe(
          join(fixture.target, '.agent', 'worktrees', 'TASK-CLI'),
        );
        expect(data.provenance.sourceCommit).toBe(
          execFileSync('git', ['-C', fixture.remote, 'rev-parse', 'main'], {
            encoding: 'utf8',
          }).trim(),
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
          'TASK-CLI-2',
          '--run-id',
          'RUN-CLI-HUMAN-2',
        ]);
        expect(humanResult.exitCode).toBe(EXIT_CODES.reported);
        expect(humanResult.stdout).toContain(`data.runId: RUN-CLI-HUMAN-2`);
        expect(humanResult.stdout).toContain(`data.taskId: TASK-CLI-2`);
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

        const transition = (request: WorkflowTransitionRequest) =>
          transitionWorkflow({
            runDirectory: fixture.runDirectory('RUN-STATUS'),
            runId: 'RUN-STATUS',
            request,
          }).pipe(Effect.provide(TransitionLayer));

        const expectStatus = (state: WorkflowState) =>
          Effect.gen(function* () {
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
            expect(envelope.data.runId).toBe('RUN-STATUS');
            expect(envelope.data.workflowState).toBe(state);
            expect(envelope.data.provenance).toMatchObject({
              sourceRemote: 'origin',
              sourceBranch: 'main',
              taskBranch: 'foundry/TASK-CLI',
              workspace: join(fixture.target, '.agent', 'worktrees', 'TASK-CLI'),
            });

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
            expect(humanResult.stdout).toContain('data.provenance.taskBranch: foundry/TASK-CLI');
            expect(humanResult.stdout.endsWith('\n')).toBe(true);
          });

        yield* expectStatus('planning');
        yield* appendAcceptedPlan(fixture.runDirectory('RUN-STATUS'), 'RUN-STATUS');
        yield* transition({ route: 'plan-accepted' });
        yield* expectStatus('coding');
        yield* transition({
          route: 'implementation-ready',
          branchClean: true,
          candidateCommit: 'abc123',
          noChangeCandidateValidated: false,
        });
        yield* transition({
          route: 'checks-passed-reviewing',
          checksPassed: true,
          correctionBudgetExhausted: false,
          reviewableCommit: 'abc123',
        });
        yield* expectStatus('reviewing');
        yield* transition({
          route: 'review-approved',
          approvedCommit: 'abc123',
          evidenceCommitMatches: true,
          checksPassed: true,
          testerRequired: false,
          runtimeEvidencePresent: false,
        });
        yield* expectStatus('completed');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('fails status for a run whose canonical history is missing or tampered with', () =>
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
          'RUN-INTEGRITY',
          '--json',
        ]);
        expect(recorded.exitCode).toBe(EXIT_CODES.reported);

        rmSync(join(fixture.runDirectory('RUN-INTEGRITY'), RUN_HISTORY_FILENAME));
        const missing = yield* run([
          'status',
          '--config',
          fixture.configPath,
          '--run-id',
          'RUN-INTEGRITY',
          '--json',
        ]);
        expect(missing.exitCode).toBe(EXIT_CODES.operationFailed);
        const missingFailure = expectRecordedFailure(missing.stdout);
        expect(missingFailure.error.kind).toBe('failed');
        expect(missingFailure.error.runId).toBe('RUN-INTEGRITY');
        expect(missingFailure.error.message).toContain('witness remains');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('rebuilds status from history when the record is missing or invalid', () =>
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
        expect(missing.exitCode).toBe(EXIT_CODES.reported);
        const missingEnvelope = envelopeFrom(missing.stdout);
        expect(missingEnvelope.ok).toBe(true);
        if (!missingEnvelope.ok) {
          throw new Error(`Expected a success envelope but received: ${missing.stdout}`);
        }
        expect(missingEnvelope.command).toBe('status');
        expect(missingEnvelope.data).toMatchObject({
          runId: 'RUN-NOSTATE',
          workflowState: 'planning',
          provenance: { taskBranch: 'foundry/TASK-CLI' },
        });
        expect(existsSync(statePath)).toBe(true);

        writeState(fixture, 'RUN-NOSTATE', 'queued');
        const invalid = yield* run([
          'status',
          '--config',
          fixture.configPath,
          '--run-id',
          'RUN-NOSTATE',
          '--json',
        ]);
        expect(invalid.exitCode).toBe(EXIT_CODES.reported);
        const invalidEnvelope = envelopeFrom(invalid.stdout);
        expect(invalidEnvelope.ok).toBe(true);
        if (!invalidEnvelope.ok) {
          throw new Error(`Expected a success envelope but received: ${invalid.stdout}`);
        }
        expect(invalidEnvelope.data).toMatchObject({
          runId: 'RUN-NOSTATE',
          workflowState: 'planning',
          provenance: { taskBranch: 'foundry/TASK-CLI' },
        });

        writeState(fixture, 'RUN-NOSTATE', 'completed');
        const stale = yield* run([
          'status',
          '--config',
          fixture.configPath,
          '--run-id',
          'RUN-NOSTATE',
          '--json',
        ]);
        expect(stale.exitCode).toBe(EXIT_CODES.reported);
        const staleEnvelope = envelopeFrom(stale.stdout);
        expect(staleEnvelope.ok).toBe(true);
        if (!staleEnvelope.ok) {
          throw new Error(`Expected a success envelope but received: ${stale.stdout}`);
        }
        expect(staleEnvelope.data).toMatchObject({
          runId: 'RUN-NOSTATE',
          workflowState: 'planning',
          provenance: { taskBranch: 'foundry/TASK-CLI' },
        });
        expect(readFileSync(statePath, 'utf8')).toContain('"state": "planning"');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

function leasePathOf(fixture: Fixture): string {
  return join(fixture.target, '.agent', REPOSITORY_LEASE_FILENAME);
}

interface SeedRepositoryLeaseOverrides {
  readonly hostIdentity?: string;
  readonly processId?: number;
  readonly processStartIdentity?: string | null;
}

function seedRepositoryLease(fixture: Fixture, overrides?: SeedRepositoryLeaseOverrides): void {
  mkdirSync(join(fixture.target, '.agent'), { recursive: true });
  writeFileSync(
    leasePathOf(fixture),
    `${JSON.stringify({
      schemaVersion: 1,
      ownerId: '33333333-3333-4333-8333-333333333333',
      hostIdentity: hostname(),
      processId: 2147483000,
      processStartIdentity: 'linux:seed:1',
      acquiredAt: '1969-12-31T23:58:00.000Z',
      heartbeatAt: '1969-12-31T23:58:00.000Z',
      expiresAt: '1969-12-31T23:59:59.000Z',
      ...overrides,
    })}\n`,
  );
}

function runCommand(fixture: Fixture, runId: string): ReadonlyArray<string> {
  return [
    'run',
    '--config',
    fixture.configPath,
    '--request',
    fixture.requestPath,
    '--task-id',
    'TASK-LEASE',
    '--run-id',
    runId,
    '--json',
  ];
}

describe('repository lease through the run command', () => {
  it.effect('releases the repository lease after a successful run', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'lease ask\n');
        const result = yield* runCli(runCommand(fixture, 'RUN-LEASE-OK')).pipe(
          Effect.provide(CliLayer),
        );

        expect(result.exitCode).toBe(EXIT_CODES.reported);
        expect(existsSync(fixture.runDirectory('RUN-LEASE-OK'))).toBe(true);
        expect(existsSync(leasePathOf(fixture))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('denies a competing run while a healthy live lease is held', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'competing ask\n');
        const lease = yield* acquireRepositoryLease({
          repositoryRoot: fixture.target,
          runId: 'RUN-LEASE-HOLDER',
          leaseMs: 60000,
        }).pipe(Effect.provide(RepositoryLeaseLive));

        yield* Effect.ensuring(
          Effect.gen(function* () {
            const result = yield* runCli(runCommand(fixture, 'RUN-LEASE-DENIED')).pipe(
              Effect.provide(CliLayer),
            );

            expect(result.exitCode).toBe(EXIT_CODES.operationFailed);
            const failure = expectRecordedFailure(result.stdout);
            expect(failure.command).toBe('run');
            expect(failure.error.kind).toBe('blocked');
            expect(failure.error.retryable).toBe(false);
            expect(failure.error.runId).toBe('RUN-LEASE-DENIED');
            expect(existsSync(fixture.runDirectory('RUN-LEASE-DENIED'))).toBe(false);
            expect(existsSync(leasePathOf(fixture))).toBe(true);
          }),
          lease.release.pipe(Effect.ignore),
        );
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('takes over an expired lease whose recorded process is dead', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'takeover ask\n');
        const deadProcessId = Number(
          execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
            encoding: 'utf8',
          }).trim(),
        );
        seedRepositoryLease(fixture, { processId: deadProcessId });
        const seeded = readFileSync(leasePathOf(fixture), 'utf8');
        expect(seeded).toContain(String(deadProcessId));

        const result = yield* runCli(runCommand(fixture, 'RUN-LEASE-TAKEOVER')).pipe(
          Effect.provide(CliLayer),
        );

        expect(result.exitCode).toBe(EXIT_CODES.reported);
        expect(existsSync(fixture.runDirectory('RUN-LEASE-TAKEOVER'))).toBe(true);
        expect(existsSync(leasePathOf(fixture))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('fails closed when an expired lease owner is still live', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'live ask\n');
        const identity = yield* RepositoryHostIdentity.pipe(Effect.provide(RepositoryLeaseLive));
        const hostIdentity = yield* identity.hostIdentity;
        const current = yield* identity.currentProcess;
        seedRepositoryLease(fixture, {
          hostIdentity,
          processId: current.processId,
          processStartIdentity: current.processStartIdentity,
        });
        const before = readFileSync(leasePathOf(fixture), 'utf8');

        const result = yield* runCli(runCommand(fixture, 'RUN-LEASE-LIVE')).pipe(
          Effect.provide(CliLayer),
        );

        expect(result.exitCode).toBe(EXIT_CODES.operationFailed);
        const failure = expectRecordedFailure(result.stdout);
        expect(failure.error.kind).toBe('blocked');
        expect(failure.error.runId).toBe('RUN-LEASE-LIVE');
        expect(existsSync(fixture.runDirectory('RUN-LEASE-LIVE'))).toBe(false);
        expect(readFileSync(leasePathOf(fixture), 'utf8')).toBe(before);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('fails closed on a corrupt lease record and preserves it', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, 'corrupt ask\n');
        mkdirSync(join(fixture.target, '.agent'), { recursive: true });
        writeFileSync(leasePathOf(fixture), '{"schemaVersion": 1');

        const result = yield* runCli(runCommand(fixture, 'RUN-LEASE-CORRUPT')).pipe(
          Effect.provide(CliLayer),
        );

        expect(result.exitCode).toBe(EXIT_CODES.operationFailed);
        const failure = expectRecordedFailure(result.stdout);
        expect(failure.error.kind).toBe('blocked');
        expect(failure.error.message).toContain('not a valid closed record');
        expect(existsSync(fixture.runDirectory('RUN-LEASE-CORRUPT'))).toBe(false);
        expect(readFileSync(leasePathOf(fixture), 'utf8')).toBe('{"schemaVersion": 1');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('does not take a lease when request validation fails', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeFileSync(fixture.requestPath, '');
        const result = yield* runCli(runCommand(fixture, 'RUN-LEASE-INVALID')).pipe(
          Effect.provide(CliLayer),
        );

        expect(result.exitCode).toBe(EXIT_CODES.invalidInvocation);
        const failure = expectRecordedFailure(result.stdout);
        expect(failure.error.kind).toBe('invalid_invocation');
        expect(existsSync(leasePathOf(fixture))).toBe(false);
        expect(existsSync(join(fixture.target, '.agent', 'runs'))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
