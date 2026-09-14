import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RoleHost } from '../../src/application/role-conversations/index.js';
import { evaluateStandInCreateRequest } from '../../src/application/stand-in-role-host/index.js';
import { ROLE_HOST_PROTOCOL_VERSION } from '../../src/domain/role-host.js';
import { roleHostProcessLayer } from '../../src/platform/role-host.js';

import type { RoleHostCreateRequest } from '../../src/domain/role-host.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/role-host/fake-role-host.mjs', import.meta.url),
);

const RecordedInvocationSchema = Schema.Struct({
  operation: Schema.String,
  argv: Schema.Array(Schema.String),
  env: Schema.Struct({
    FOUNDRY_FAKE_TOKEN: Schema.NullOr(Schema.String),
    FOUNDRY_FAKE_UNLISTED: Schema.NullOr(Schema.String),
  }),
  request: Schema.NullOr(Schema.Json),
});

const RecordedInvocationJson = Schema.fromJsonString(RecordedInvocationSchema);

type RecordedInvocation = Schema.Schema.Type<typeof RecordedInvocationJson>;

function readInvocations(logPath: string): ReadonlyArray<RecordedInvocation> {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => Schema.decodeUnknownSync(RecordedInvocationJson)(line));
}

describe('role-host parity', () => {
  it.effect('runs the closed role-host protocol on platform-native paths and argv', () => {
    const base = mkdtempSync(join(tmpdir(), 'foundry parity host '));
    const workingDirectory = join(base, 'working directory');
    mkdirSync(workingDirectory, { recursive: true });
    const logPath = join(base, 'invocations.jsonl');
    return Effect.gen(function* () {
      process.env.FOUNDRY_FAKE_TOKEN = 'parity-token';
      process.env.FOUNDRY_FAKE_UNLISTED = 'parity-unlisted';
      const host = yield* RoleHost;
      const capabilities = yield* host.capabilities({ schemaVersion: ROLE_HOST_PROTOCOL_VERSION });
      const created = yield* host.create({
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        runId: 'RUN-PARITY',
        role: 'coder',
        attempt: 1,
        generation: 1,
        workingDirectory,
        readRoots: [workingDirectory],
        writeRoots: [workingDirectory],
        networkAllowlist: [],
      });
      const submitted = yield* host.submit({
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        sessionId: created.sessionId,
        ownershipToken: created.ownershipToken,
        generation: created.generation,
        idempotencyKey: 'parity-key',
        prompt: 'Do the parity work.',
        deadline: '2026-09-13T00:00:00.000Z',
      });
      const observed = yield* host.observe({
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        sessionId: created.sessionId,
        ownershipToken: created.ownershipToken,
        generation: created.generation,
        afterSequence: 0,
      });
      const stopped = yield* host.stop({
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        sessionId: created.sessionId,
        ownershipToken: created.ownershipToken,
        generation: created.generation,
      });

      expect(capabilities.resumable).toBe(true);
      expect(created.runtimeIdentity.adapterVersion).toBe('fake-1');
      expect(submitted.submission).toBe('accepted');
      expect(observed.status).toBe('settled');
      expect(stopped.disposition).toBe('disposed');

      const invocations = readInvocations(logPath);
      expect(invocations.map((invocation) => invocation.operation)).toEqual([
        'capabilities',
        'create',
        'submit',
        'observe',
        'stop',
      ]);
      for (const invocation of invocations) {
        expect(invocation.argv.at(-1)).toBe(invocation.operation);
        expect(invocation.env.FOUNDRY_FAKE_TOKEN).toBe('parity-token');
        expect(invocation.env.FOUNDRY_FAKE_UNLISTED).toBeNull();
      }
      expect(invocations[1]?.request).toMatchObject({ workingDirectory });
    }).pipe(
      Effect.provide(
        roleHostProcessLayer({
          command: [process.execPath, FIXTURE_PATH, 'settled', logPath],
          cwd: base,
          environmentAllowlist: ['FOUNDRY_FAKE_TOKEN'],
          timeoutMs: 10_000,
          maxOutputBytes: 65_536,
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          delete process.env.FOUNDRY_FAKE_TOKEN;
          delete process.env.FOUNDRY_FAKE_UNLISTED;
          rmSync(base, { recursive: true, force: true });
        }),
      ),
    );
  });

  it('enforces the closed role model on platform-native absolute paths', () => {
    const base = mkdtempSync(join(tmpdir(), 'foundry parity host model '));
    try {
      const workspace = join(base, 'workspace');
      const projectRoot = join(base, 'project');
      const runDirectory = join(base, 'run');
      const scratch = join(runDirectory, 'scratch');
      for (const directory of [workspace, projectRoot, runDirectory, scratch]) {
        mkdirSync(directory, { recursive: true });
      }
      const coder: RoleHostCreateRequest = {
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        runId: 'RUN-PARITY',
        role: 'coder',
        attempt: 1,
        generation: 1,
        workingDirectory: workspace,
        readRoots: [workspace],
        writeRoots: [workspace],
        networkAllowlist: [],
      };

      expect(evaluateStandInCreateRequest(coder)).toBeNull();
      expect(
        evaluateStandInCreateRequest({ ...coder, workingDirectory: 'relative/path' }),
      ).toContain('absolute working directory');
      expect(
        evaluateStandInCreateRequest({
          ...coder,
          role: 'architect',
          workingDirectory: projectRoot,
          readRoots: [projectRoot],
          writeRoots: [scratch],
        }),
      ).toContain('outside every read root');
      expect(
        evaluateStandInCreateRequest({
          ...coder,
          role: 'architect',
          workingDirectory: projectRoot,
          readRoots: [projectRoot],
          writeRoots: [projectRoot],
        }),
      ).toContain('read-only root');
      expect(
        evaluateStandInCreateRequest({
          ...coder,
          role: 'tester',
          workingDirectory: projectRoot,
          readRoots: [projectRoot, runDirectory],
          writeRoots: [scratch],
          networkAllowlist: ['http://127.0.0.1:4200'],
        }),
      ).toBeNull();
      expect(
        evaluateStandInCreateRequest({
          ...coder,
          role: 'tester',
          workingDirectory: projectRoot,
          readRoots: [projectRoot, runDirectory],
          writeRoots: [scratch],
          networkAllowlist: [],
        }),
      ).toContain('exactly one prepared runtime origin');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
