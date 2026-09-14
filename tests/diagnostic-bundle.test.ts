import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReportEnvelope, runCli } from '../src/cli/program.js';
import {
  DIAGNOSTIC_BUNDLE_MANIFEST_FILENAME,
  DiagnosticBundleManifestSchema,
} from '../src/domain/diagnostic-bundle.js';
import { EXIT_CODES } from '../src/domain/public-commands.js';
import {
  RUN_HISTORY_FILENAME,
  RUN_HISTORY_WITNESS_FILENAME,
  encodeRunEventLine,
  encodeRunHistoryWitness,
  sealRunEvent,
  verifyRunHistoryEvents,
} from '../src/domain/run-history.js';
import { ReadinessFilesLive } from '../src/platform/readiness.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import { goldenConfigurationDocument } from './fixtures/checks-runtime-run.js';

import type { RunEvent, RunEventDraft, RunEventEnvelope } from '../src/domain/run-history.js';

const RUN_ID = 'RUN-DIAGNOSTIC';

const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const COMMIT_ONE = '1111111111111111111111111111111111111111';

const TASK_BRANCH = 'foundry/RUN-DIAGNOSTIC';

const WORKSPACE = '/target/.agent/worktrees/RUN-DIAGNOSTIC';

const OCCURRED_AT = '2026-09-13T00:00:00.000Z';

const RUNTIME_IDENTITY = {
  adapterVersion: 'test',
  provider: 'test',
  model: 'test',
  toolProfile: 'test',
};

const SECRET_PATTERN = 'SECRET-[0-9]+';

function eventId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function sealChain(runId: string, drafts: ReadonlyArray<RunEventDraft>): ReadonlyArray<RunEvent> {
  const events: Array<RunEvent> = [];
  let previousHash: string | null = null;
  drafts.forEach((draft, index) => {
    const envelope: RunEventEnvelope = {
      schemaVersion: 1,
      runId,
      revision: index + 1,
      eventId: eventId(index + 1),
      occurredAt: OCCURRED_AT,
      previousEventHash: previousHash,
    };
    const sealed = sealRunEvent(envelope, draft);
    events.push(sealed);
    previousHash = sealed.eventHash;
  });
  return events;
}

function draftsFor(logPath: string): ReadonlyArray<RunEventDraft> {
  return [
    { type: 'run-created', payload: { taskId: 'TASK-DIAGNOSTIC' } },
    {
      type: 'source-frozen',
      payload: {
        repository: {
          repositoryRoot: '/target',
          gitDirectory: '/target/.git',
          remoteUrl: 'https://example.invalid/target.git',
        },
        sourceRemote: 'origin',
        sourceBranch: 'main',
        sourceCommit: FROZEN_COMMIT,
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        expectedHead: FROZEN_COMMIT,
      },
    },
    {
      type: 'guidance-frozen',
      payload: {
        sourceCommit: FROZEN_COMMIT,
        manifestPath: 'guidance-manifest.json',
        aggregateHash: 'f'.repeat(64),
        files: [],
      },
    },
    {
      type: 'worktree-ready',
      payload: {
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        headCommit: FROZEN_COMMIT,
        baseCommit: FROZEN_COMMIT,
      },
    },
    {
      type: 'workflow-transition',
      payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
    },
    {
      type: 'plan-accepted',
      payload: {
        outcome: 'plan_ready',
        criteria: [{ id: 'AC-001', text: 'the seeded criterion' }],
        runtimeValidationRequired: false,
        execution: {
          mode: 'sequential',
          objectives: [
            {
              id: 'OBJ-001',
              title: 'Implement the accepted plan',
              affectedPaths: ['src/implementation.ts'],
              criterionIds: ['AC-001'],
            },
          ],
        },
      },
    },
    {
      type: 'workflow-transition',
      payload: { route: 'plan-accepted', from: 'planning', to: 'coding', checkpoint: null },
    },
    {
      type: 'implementation-accepted',
      payload: {
        taskBranch: TASK_BRANCH,
        baseCommit: FROZEN_COMMIT,
        commit: COMMIT_ONE,
        changedFiles: ['src/implementation.ts'],
        noChangeCandidate: false,
      },
    },
    {
      type: 'workflow-transition',
      payload: {
        route: 'implementation-ready',
        from: 'coding',
        to: 'verifying',
        checkpoint: null,
      },
    },
    {
      type: 'verification-completed',
      payload: {
        attempt: 1,
        repository: '/target',
        commit: COMMIT_ONE,
        profileHash: 'a'.repeat(64),
        commandMs: 10,
        executions: [
          {
            kind: 'gate',
            name: 'formatCheck',
            executable: 'fmt',
            arguments: ['--check'],
            expectedExitCode: 0,
            actualExitCode: 0,
            timedOut: false,
            durationMs: 1,
            log: {
              path: logPath,
              sha256: 'c'.repeat(64),
              byteLength: 10,
              retainedByteLength: 10,
              truncated: false,
              redactionCount: 0,
            },
            trackedMutation: null,
            reconstructed: false,
            reconstructionError: null,
          },
        ],
        result: 'passed',
      },
    },
    {
      type: 'workflow-transition',
      payload: {
        route: 'checks-passed-reviewing',
        from: 'verifying',
        to: 'reviewing',
        checkpoint: null,
      },
    },
    {
      type: 'role-session-created',
      payload: {
        role: 'reviewer',
        attempt: 1,
        generation: 1,
        sessionId: 'session-reviewer-1',
        ownershipToken: 'owner-reviewer-1',
        sequence: 0,
        runtimeIdentity: RUNTIME_IDENTITY,
        workingDirectory: null,
      },
    },
    {
      type: 'role-session-observed',
      payload: {
        sessionId: 'session-reviewer-1',
        generation: 1,
        status: 'settled',
        sequence: 1,
        eventCount: 1,
        narrative: '# Review\n\nThe change is approved.',
        control: { schemaVersion: 1, outcome: 'approved' },
      },
    },
    {
      type: 'workflow-transition',
      payload: {
        route: 'review-approved',
        from: 'reviewing',
        to: 'completed',
        checkpoint: null,
      },
    },
  ];
}

interface Fixture {
  readonly base: string;
  readonly target: string;
  readonly configPath: string;
  readonly runDirectory: string;
  readonly logPath: string;
  readonly cleanup: () => void;
}

const REQUEST_TEXT = `${'SECRET-12345 '.repeat(6)}trailing payload`;

// 055: artifact bounds are hardcoded, so the per-document limit overrides are
// accepted here only to preserve call sites until the hardcoded set lands.
function setupFixture(_options?: {
  readonly maxRequestBytes?: number;
  readonly redactionPatterns?: ReadonlyArray<string>;
}): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-diagnostic-'));
  const target = join(base, 'target');
  const runDirectory = join(target, '.agent', 'runs', RUN_ID);
  const evidenceDirectory = join(runDirectory, 'evidence');
  mkdirSync(evidenceDirectory, { recursive: true });
  const logPath = join(evidenceDirectory, 'formatCheck.log');
  writeFileSync(logPath, 'checked OK');

  writeFileSync(join(runDirectory, 'request.md'), REQUEST_TEXT);
  writeFileSync(join(runDirectory, 'request.normalized.md'), `${REQUEST_TEXT}\n`);

  const document = goldenConfigurationDocument(target);
  const configPath = join(base, 'foundry.config.json');
  writeFileSync(configPath, JSON.stringify(document));

  const events = sealChain(RUN_ID, draftsFor(logPath));
  const verification = verifyRunHistoryEvents(events, RUN_ID);
  if (!verification.ok) {
    throw new Error(`Expected valid seeded history but received: ${verification.problem}`);
  }
  const stream = Buffer.concat(events.map((event) => Buffer.from(encodeRunEventLine(event))));
  writeFileSync(join(runDirectory, RUN_HISTORY_FILENAME), stream);
  const last = events[events.length - 1];
  writeFileSync(
    join(runDirectory, RUN_HISTORY_WITNESS_FILENAME),
    Buffer.from(
      encodeRunHistoryWitness({
        schemaVersion: 1,
        runId: RUN_ID,
        revision: events.length,
        eventHash: last?.eventHash ?? '',
      }),
    ),
  );

  return {
    base,
    target,
    configPath,
    runDirectory,
    logPath,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const DiagnosticCliLayer = Layer.mergeAll(ReadinessFilesLive, RunHistoryLive, RunIdentityLive);

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

const DiagnosticBundleManifestJson = Schema.fromJsonString(DiagnosticBundleManifestSchema);

function outputPath(fixture: Fixture): string {
  return join(fixture.base, 'diagnostic-bundle');
}

function manifestOf(fixture: Fixture) {
  const manifestPath = join(outputPath(fixture), DIAGNOSTIC_BUNDLE_MANIFEST_FILENAME);
  return Schema.decodeUnknownSync(DiagnosticBundleManifestJson)(readFileSync(manifestPath, 'utf8'));
}

describe('diagnostic bundle', () => {
  it.effect('writes a bounded, redacted manifest of verified history and retained artifacts', () =>
    Effect.gen(function* () {
      const fixture = setupFixture({
        maxRequestBytes: 40,
        redactionPatterns: [SECRET_PATTERN],
      });
      try {
        const historyBefore = readFileSync(
          join(fixture.runDirectory, RUN_HISTORY_FILENAME),
          'utf8',
        );
        const result = yield* runCli([
          'diagnostic-bundle',
          '--config',
          fixture.configPath,
          '--run-id',
          RUN_ID,
          '--output',
          outputPath(fixture),
          '--json',
        ]).pipe(Effect.provide(DiagnosticCliLayer));

        expect(result.exitCode).toBe(EXIT_CODES.reported);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(true);
        if (!envelope.ok || !('manifest' in envelope.data)) {
          throw new Error(`Expected a diagnostic bundle but received: ${result.stdout}`);
        }
        expect(envelope.command).toBe('diagnostic-bundle');
        expect(envelope.data.runId).toBe(RUN_ID);
        expect(envelope.data.manifest.entryCount).toBeGreaterThanOrEqual(5);

        const manifest = manifestOf(fixture);
        expect(manifest.schemaVersion).toBe(1);
        expect(manifest.runId).toBe(RUN_ID);
        expect(manifest.destination).toBe(outputPath(fixture));
        expect(manifest.totalByteLength).toBe(
          manifest.entries.reduce((total, entry) => total + entry.byteLength, 0),
        );

        const paths = manifest.entries.map((entry) => entry.path);
        expect(paths).toContain('run-history/events.jsonl');
        expect(paths).toContain('request.md');
        expect(paths).toContain('request.normalized.md');
        expect(paths).toContain('inspect.json');
        expect(paths).toContain('evidence/formatCheck.log');

        const request = manifest.entries.find((entry) => entry.path === 'request.md');
        expect(request).toMatchObject({ source: 'request', byteLength: 40, truncated: true });
        expect(request?.redactionCount).toBeGreaterThanOrEqual(1);
        expect(readFileSync(join(outputPath(fixture), 'request.md'), 'utf8')).toContain(
          '[REDACTED]',
        );

        const evidence = manifest.entries.find(
          (entry) => entry.path === 'evidence/formatCheck.log',
        );
        expect(evidence).toMatchObject({
          source: 'verification-log',
          byteLength: 10,
          truncated: false,
          redactionCount: 0,
        });

        const history = manifest.entries.find((entry) => entry.path === 'run-history/events.jsonl');
        expect(history?.sha256).toMatch(/^[0-9a-f]{64}$/u);

        expect(readFileSync(join(fixture.runDirectory, RUN_HISTORY_FILENAME), 'utf8')).toBe(
          historyBefore,
        );
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses a destination inside live .agent storage without writing', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const destination = join(fixture.target, '.agent', 'bundle');
        const result = yield* runCli([
          'diagnostic-bundle',
          '--config',
          fixture.configPath,
          '--run-id',
          RUN_ID,
          '--output',
          destination,
          '--json',
        ]).pipe(Effect.provide(DiagnosticCliLayer));

        expect(result.exitCode).toBe(EXIT_CODES.operationFailed);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(false);
        if (envelope.ok) {
          throw new Error('Expected a refusal envelope.');
        }
        expect(envelope.error.kind).toBe('failed');
        expect(envelope.error.message).toContain('inside live run storage');
        expect(existsSync(destination)).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses a non-empty destination without changing it', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const destination = outputPath(fixture);
        mkdirSync(destination);
        writeFileSync(join(destination, 'leftover.txt'), 'do not touch');

        const result = yield* runCli([
          'diagnostic-bundle',
          '--config',
          fixture.configPath,
          '--run-id',
          RUN_ID,
          '--output',
          destination,
          '--json',
        ]).pipe(Effect.provide(DiagnosticCliLayer));

        expect(result.exitCode).toBe(EXIT_CODES.operationFailed);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(false);
        if (envelope.ok) {
          throw new Error('Expected a refusal envelope.');
        }
        expect(envelope.error.message).toContain('is not empty');
        expect(readdirSync(destination)).toEqual(['leftover.txt']);
        expect(readFileSync(join(destination, 'leftover.txt'), 'utf8')).toBe('do not touch');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('allows a new or existing empty destination', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        mkdirSync(outputPath(fixture));
        const result = yield* runCli([
          'diagnostic-bundle',
          '--config',
          fixture.configPath,
          '--run-id',
          RUN_ID,
          '--output',
          outputPath(fixture),
          '--json',
        ]).pipe(Effect.provide(DiagnosticCliLayer));

        expect(result.exitCode).toBe(EXIT_CODES.reported);
        expect(existsSync(join(outputPath(fixture), DIAGNOSTIC_BUNDLE_MANIFEST_FILENAME))).toBe(
          true,
        );
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('requires a run id and reports invalid invocation before any write', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const result = yield* runCli([
          'diagnostic-bundle',
          '--config',
          fixture.configPath,
          '--output',
          outputPath(fixture),
          '--json',
        ]).pipe(Effect.provide(DiagnosticCliLayer));

        expect(result.exitCode).toBe(EXIT_CODES.invalidInvocation);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(false);
        if (envelope.ok) {
          throw new Error('Expected an invalid invocation envelope.');
        }
        expect(envelope.error.kind).toBe('invalid_invocation');
        expect(existsSync(outputPath(fixture))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
