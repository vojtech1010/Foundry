import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { ProjectCommandProcess } from '../src/application/profile-check/index.js';
import { ReadinessFiles, ReadinessGit, ReadinessHost } from '../src/application/readiness/index.js';
import {
  RepositoryHostIdentity,
  RepositoryLeaseStore,
} from '../src/application/repository-lease/index.js';
import { RunHistoryStorage } from '../src/application/run-history/index.js';
import { RunIdentityStore } from '../src/application/run-identity/index.js';
import { RoleHostLauncher } from '../src/application/role-conversations/index.js';
import {
  EXIT_CODES,
  INTERRUPT_EXIT_CODES,
  NON_PRODUCT_COMMANDS,
  NOT_AVAILABLE,
  PUBLIC_COMMANDS,
  REPORT_SCHEMA_VERSION,
  exitCodeForOutcome,
  interruptExitCodeFor,
  isPublicCommand,
} from '../src/domain/public-commands.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

function envelopeFrom(stdout: string) {
  return Schema.decodeUnknownSync(ReportEnvelopeJson)(stdout);
}

function expectSuccessEnvelope(stdout: string) {
  const envelope = envelopeFrom(stdout);
  expect(envelope.ok).toBe(true);
  if (!envelope.ok) {
    throw new Error(`Expected a success envelope but received: ${stdout}`);
  }
  return envelope;
}

function expectFailureEnvelope(stdout: string) {
  const envelope = envelopeFrom(stdout);
  expect(envelope.ok).toBe(false);
  if (envelope.ok) {
    throw new Error(`Expected a failure envelope but received: ${stdout}`);
  }
  return envelope;
}

function expectStubEnvelope(stdout: string) {
  const envelope = expectSuccessEnvelope(stdout);
  const data = envelope.data;
  if (!('availability' in data)) {
    throw new Error(`Expected a stub envelope but received: ${stdout}`);
  }
  return { envelope, data };
}

function untouchedReadiness(name: string) {
  return Effect.die(new Error(`Stub commands must not access readiness ${name}`));
}

const UntouchedReadiness = Layer.mergeAll(
  Layer.succeed(
    ReadinessHost,
    ReadinessHost.of({
      platform: untouchedReadiness('host.platform'),
      nodeVersion: untouchedReadiness('host.nodeVersion'),
      npmVersion: untouchedReadiness('host.npmVersion'),
      gitVersionOutput: untouchedReadiness('host.gitVersionOutput'),
    }),
  ),
  Layer.succeed(
    ReadinessFiles,
    ReadinessFiles.of({
      readFile: (_path: string) => untouchedReadiness('files.readFile'),
      statPath: (_path: string) => untouchedReadiness('files.statPath'),
      isWritable: (_path: string) => untouchedReadiness('files.isWritable'),
    }),
  ),
  Layer.succeed(
    ReadinessGit,
    ReadinessGit.of({
      run: (_args: ReadonlyArray<string>, _cwd: string) => untouchedReadiness('git.run'),
    }),
  ),
  Layer.succeed(
    ProjectCommandProcess,
    ProjectCommandProcess.of({
      run: (_options: { readonly command: ReadonlyArray<string>; readonly cwd: string }) =>
        untouchedReadiness('process.run'),
    }),
  ),
  Layer.succeed(
    RunIdentityStore,
    RunIdentityStore.of({
      statPath: (_path: string) => untouchedReadiness('runIdentity.statPath'),
      readFileBytes: (_path: string) => untouchedReadiness('runIdentity.readFileBytes'),
      ensureParentDirectory: (_path: string) =>
        untouchedReadiness('runIdentity.ensureParentDirectory'),
      createRunDirectoryExclusive: (_path: string, _runId: string) =>
        untouchedReadiness('runIdentity.createRunDirectoryExclusive'),
      writeFileBytes: (_path: string, _bytes: Uint8Array) =>
        untouchedReadiness('runIdentity.writeFileBytes'),
      removeDirectory: (_path: string) => untouchedReadiness('runIdentity.removeDirectory'),
    }),
  ),
  Layer.succeed(
    RunHistoryStorage,
    RunHistoryStorage.of({
      readHistoryFiles: (_runDirectory: string) =>
        untouchedReadiness('runHistory.readHistoryFiles'),
      commitHistory: (_options) => untouchedReadiness('runHistory.commitHistory'),
      replaceDerivedReports: (_options) => untouchedReadiness('runHistory.replaceDerivedReports'),
    }),
  ),
  Layer.succeed(
    RepositoryLeaseStore,
    RepositoryLeaseStore.of({
      ensureDirectory: (_path: string) => untouchedReadiness('repositoryLease.ensureDirectory'),
      statPath: (_path: string) => untouchedReadiness('repositoryLease.statPath'),
      createGuardFile: (_path: string, _bytes: Uint8Array) =>
        untouchedReadiness('repositoryLease.createGuardFile'),
      writeFileAtomically: (_path: string, _bytes: Uint8Array) =>
        untouchedReadiness('repositoryLease.writeFileAtomically'),
      removeFile: (_path: string) => untouchedReadiness('repositoryLease.removeFile'),
    }),
  ),
  Layer.succeed(
    RepositoryHostIdentity,
    RepositoryHostIdentity.of({
      hostIdentity: untouchedReadiness('repositoryLease.hostIdentity'),
      currentProcess: untouchedReadiness('repositoryLease.currentProcess'),
      probeProcess: (_processId: number) => untouchedReadiness('repositoryLease.probeProcess'),
    }),
  ),
  Layer.succeed(
    RoleHostLauncher,
    RoleHostLauncher.of({
      launch: () => {
        throw new Error('Stub commands must not launch the role host');
      },
    }),
  ),
);

function runStubCli(argv: ReadonlyArray<string>) {
  return runCli(argv).pipe(Effect.provide(UntouchedReadiness));
}

interface ValidScenario {
  readonly command: string;
  readonly argv: ReadonlyArray<string>;
  readonly runId: string | undefined;
  readonly taskId: string | undefined;
}

const validScenarios: ReadonlyArray<ValidScenario> = [
  {
    command: 'resume',
    argv: [
      'resume',
      '--config',
      'foundry.config.json',
      '--run-id',
      'RUN-1',
      '--abandon',
      '--reason',
      'superseded by a new request',
    ],
    runId: 'RUN-1',
    taskId: undefined,
  },
  {
    command: 'diagnostic-bundle',
    argv: ['diagnostic-bundle', '--config', 'foundry.config.json', '--output', 'bundle'],
    runId: undefined,
    taskId: undefined,
  },
  {
    command: 'cleanup',
    argv: ['cleanup', '--list', '--config', 'foundry.config.json'],
    runId: undefined,
    taskId: undefined,
  },
  {
    command: 'cleanup',
    argv: ['cleanup', '--config', 'foundry.config.json', '--run-id', 'RUN-1', '--confirm', 'RUN-1'],
    runId: 'RUN-1',
    taskId: undefined,
  },
];

interface InvalidScenario {
  readonly label: string;
  readonly argv: ReadonlyArray<string>;
  readonly runId: string | undefined;
}

const invalidScenarios: ReadonlyArray<InvalidScenario> = [
  { label: 'missing command', argv: ['--json'], runId: undefined },
  { label: 'unknown command', argv: ['frobnicate', '--json'], runId: undefined },
  {
    label: 'mode flag',
    argv: ['--manual', 'status', '--config', 'cfg.json', '--run-id', 'RUN-1', '--json'],
    runId: 'RUN-1',
  },
  {
    label: 'missing run id',
    argv: ['status', '--config', 'cfg.json', '--json'],
    runId: undefined,
  },
  {
    label: 'missing config',
    argv: ['status', '--run-id', 'RUN-1', '--json'],
    runId: 'RUN-1',
  },
  {
    label: 'missing request',
    argv: ['run', '--config', 'cfg.json', '--task-id', 'TASK-1', '--run-id', 'RUN-1', '--json'],
    runId: 'RUN-1',
  },
  {
    label: 'unknown flag',
    argv: ['status', '--config', 'cfg.json', '--run-id', 'RUN-1', '--bogus', '--json'],
    runId: 'RUN-1',
  },
  {
    label: 'flag with equals value',
    argv: ['status', '--config=cfg.json', '--run-id', 'RUN-1', '--json'],
    runId: 'RUN-1',
  },
  {
    label: 'duplicate flag',
    argv: [
      'status',
      '--config',
      'cfg.json',
      '--config',
      'other.json',
      '--run-id',
      'RUN-1',
      '--json',
    ],
    runId: 'RUN-1',
  },
  {
    label: 'missing flag value',
    argv: ['--json', 'status', '--run-id'],
    runId: undefined,
  },
  {
    label: 'unexpected argument',
    argv: ['status', '--config', 'cfg.json', '--run-id', 'RUN-1', 'surplus', '--json'],
    runId: 'RUN-1',
  },
  {
    label: 'init without dry-run',
    argv: ['init', '--config', 'cfg.json', '--task-id', 'TASK-1', '--json'],
    runId: undefined,
  },
  {
    label: 'init without task id',
    argv: ['init', '--dry-run', '--config', 'cfg.json', '--json'],
    runId: undefined,
  },
  {
    label: 'cleanup without a form',
    argv: ['cleanup', '--config', 'cfg.json', '--json'],
    runId: undefined,
  },
  {
    label: 'cleanup delete form without confirm',
    argv: ['cleanup', '--config', 'cfg.json', '--run-id', 'RUN-1', '--json'],
    runId: 'RUN-1',
  },
  {
    label: 'cleanup confirm mismatch',
    argv: ['cleanup', '--config', 'cfg.json', '--run-id', 'RUN-1', '--confirm', 'OTHER', '--json'],
    runId: 'RUN-1',
  },
  {
    label: 'cleanup list mixed with delete flags',
    argv: [
      'cleanup',
      '--config',
      'cfg.json',
      '--list',
      '--run-id',
      'RUN-1',
      '--confirm',
      'RUN-1',
      '--json',
    ],
    runId: 'RUN-1',
  },
  {
    label: 'resume abandon without reason',
    argv: ['resume', '--config', 'cfg.json', '--run-id', 'RUN-1', '--abandon', '--json'],
    runId: 'RUN-1',
  },
  {
    label: 'resume reason without abandon',
    argv: ['resume', '--config', 'cfg.json', '--run-id', 'RUN-1', '--reason', 'why', '--json'],
    runId: 'RUN-1',
  },
  {
    label: 'malformed run id',
    argv: ['status', '--config', 'cfg.json', '--run-id', 'bad id', '--json'],
    runId: undefined,
  },
  {
    label: 'empty config value',
    argv: ['status', '--config', '', '--run-id', 'RUN-1', '--json'],
    runId: 'RUN-1',
  },
  {
    label: 'flag not valid for command',
    argv: ['status', '--config', 'cfg.json', '--run-id', 'RUN-1', '--abandon', '--json'],
    runId: 'RUN-1',
  },
];

describe('public command surface', () => {
  it('publishes exactly the documented command set', () => {
    expect(PUBLIC_COMMANDS).toEqual([
      'run',
      'resume',
      'status',
      'inspect',
      'doctor',
      'init',
      'profile-check',
      'diagnostic-bundle',
      'cleanup',
    ]);
    expect(NON_PRODUCT_COMMANDS).toEqual(['approve', 'reject', 'code', 'test', 'review']);
    for (const command of PUBLIC_COMMANDS) {
      expect(isPublicCommand(command)).toBe(true);
    }
    for (const command of NON_PRODUCT_COMMANDS) {
      expect(isPublicCommand(command)).toBe(false);
    }
    expect(isPublicCommand('frobnicate')).toBe(false);
  });

  it.effect('accepts every stub command with well-formed flags', () =>
    Effect.gen(function* () {
      for (const scenario of validScenarios) {
        const result = yield* runStubCli([...scenario.argv, '--json']);
        expect(result.exitCode, scenario.command).toBe(EXIT_CODES.reported);
        expect(result.stdout.endsWith('\n'), scenario.command).toBe(true);
        const { envelope, data } = expectStubEnvelope(result.stdout);
        expect(envelope.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
        expect(envelope.command).toBe(scenario.command);
        expect(data.availability).toBe(NOT_AVAILABLE);
        expect(data.message.length).toBeGreaterThan(0);

        const expectedEnvelopeKeys = ['schemaVersion', 'command', 'ok', 'data'];
        expect(Object.keys(envelope)).toEqual(expectedEnvelopeKeys);

        const expectedDataKeys = ['availability', 'message'];
        if (scenario.runId === undefined) {
          expect('runId' in data).toBe(false);
        } else {
          expectedDataKeys.push('runId');
          expect(data.runId).toBe(scenario.runId);
        }
        if (scenario.taskId === undefined) {
          expect('taskId' in data).toBe(false);
        } else {
          expectedDataKeys.push('taskId');
          expect(data.taskId).toBe(scenario.taskId);
        }
        expect(Object.keys(data)).toEqual(expectedDataKeys);
      }
    }),
  );

  it.effect('rejects forbidden, unknown, and malformed invocations with exit code 2', () =>
    Effect.gen(function* () {
      for (const scenario of invalidScenarios) {
        const result = yield* runStubCli(scenario.argv);
        expect(result.exitCode, scenario.label).toBe(EXIT_CODES.invalidInvocation);
        const envelope = expectFailureEnvelope(result.stdout);
        expect(envelope.schemaVersion, scenario.label).toBe(REPORT_SCHEMA_VERSION);
        expect(envelope.error.kind, scenario.label).toBe('invalid_invocation');
        expect(envelope.error.retryable, scenario.label).toBe(false);
        expect(envelope.error.message.length, scenario.label).toBeGreaterThan(0);
        expect(Object.keys(envelope), scenario.label).toEqual([
          'schemaVersion',
          'command',
          'ok',
          'error',
        ]);

        const expectedErrorKeys = ['kind', 'message', 'retryable'];
        if (scenario.runId === undefined) {
          expect('runId' in envelope.error, scenario.label).toBe(false);
        } else {
          expectedErrorKeys.push('runId');
          expect(envelope.error.runId, scenario.label).toBe(scenario.runId);
        }
        expect(Object.keys(envelope.error), scenario.label).toEqual(expectedErrorKeys);
      }
    }),
  );

  it.effect('names forbidden commands without treating them as product commands', () =>
    Effect.gen(function* () {
      for (const command of NON_PRODUCT_COMMANDS) {
        const result = yield* runStubCli([command, '--json']);
        expect(result.exitCode, command).toBe(EXIT_CODES.invalidInvocation);
        const envelope = expectFailureEnvelope(result.stdout);
        expect(envelope.command).toBe(command);
        expect(envelope.error.kind).toBe('invalid_invocation');
      }
    }),
  );

  it.effect('rejects every mode flag', () =>
    Effect.gen(function* () {
      for (const flag of ['--manual', '--pilot', '--shadow', '--adoption']) {
        const result = yield* runStubCli([
          flag,
          'status',
          '--config',
          'cfg.json',
          '--run-id',
          'RUN-1',
          '--json',
        ]);
        expect(result.exitCode, flag).toBe(EXIT_CODES.invalidInvocation);
        expectFailureEnvelope(result.stdout);
      }
    }),
  );

  it.effect('accepts --json before the command name', () =>
    Effect.gen(function* () {
      const result = yield* runStubCli([
        '--json',
        'diagnostic-bundle',
        '--config',
        'cfg.json',
        '--output',
        'bundle',
      ]);
      expect(result.exitCode).toBe(EXIT_CODES.reported);
      const { envelope, data } = expectStubEnvelope(result.stdout);
      expect(envelope.command).toBe('diagnostic-bundle');
      expect(data.availability).toBe(NOT_AVAILABLE);
    }),
  );

  it.effect('presents the same facts in human output as in JSON output', () =>
    Effect.gen(function* () {
      const argv = ['diagnostic-bundle', '--config', 'cfg.json', '--output', 'bundle'];
      const jsonResult = yield* runStubCli([...argv, '--json']);
      const humanResult = yield* runStubCli(argv);
      expect(jsonResult.exitCode).toBe(EXIT_CODES.reported);
      expect(humanResult.exitCode).toBe(EXIT_CODES.reported);

      const { envelope, data } = expectStubEnvelope(jsonResult.stdout);
      expect(humanResult.stdout).toContain(`schemaVersion: ${envelope.schemaVersion}`);
      expect(humanResult.stdout).toContain(`command: ${envelope.command}`);
      expect(humanResult.stdout).toContain(`ok: ${envelope.ok}`);
      expect(humanResult.stdout).toContain(`data.availability: ${data.availability}`);
      expect(humanResult.stdout).toContain(`data.message: ${data.message}`);
      if (data.runId !== undefined) {
        expect(humanResult.stdout).toContain(`data.runId: ${data.runId}`);
      }
      expect(humanResult.stdout.endsWith('\n')).toBe(true);
    }),
  );

  it.effect('renders human success and failure reports without a JSON prefix', () =>
    Effect.gen(function* () {
      const success = yield* runStubCli([
        'diagnostic-bundle',
        '--config',
        'cfg.json',
        '--output',
        'bundle',
      ]);
      expect(success.stdout).toBe(
        [
          'schemaVersion: 1',
          'command: diagnostic-bundle',
          'ok: true',
          `data.availability: ${NOT_AVAILABLE}`,
          'data.message: Foundry diagnostic-bundle is not available yet.',
          '',
        ].join('\n'),
      );

      const failure = yield* runStubCli(['run', '--config', 'cfg.json']);
      expect(failure.exitCode).toBe(EXIT_CODES.invalidInvocation);
      expect(failure.stdout).toContain('schemaVersion: 1');
      expect(failure.stdout).toContain('command: run');
      expect(failure.stdout).toContain('ok: false');
      expect(failure.stdout).toContain('error.kind: invalid_invocation');
      expect(failure.stdout).toContain('error.retryable: false');
      expect(failure.stdout.startsWith('{')).toBe(false);
    }),
  );

  it.effect('writes exactly one JSON envelope per invocation', () =>
    Effect.gen(function* () {
      const result = yield* runStubCli([
        'diagnostic-bundle',
        '--config',
        'cfg.json',
        '--output',
        'bundle',
        '--json',
      ]);
      expect(result.stdout.startsWith('{')).toBe(true);
      expect(result.stdout.trimEnd().includes('\n')).toBe(false);
      expect(result.stdout.endsWith('\n')).toBe(true);
    }),
  );

  it.effect('reports not-available without reading configuration or writing outputs', () =>
    Effect.gen(function* () {
      const missingConfig = join(tmpdir(), 'foundry-public-surface-missing-config.json');
      const output = join(tmpdir(), `foundry-public-surface-output-${process.pid}`);
      expect(existsSync(output)).toBe(false);

      const result = yield* runStubCli([
        'diagnostic-bundle',
        '--config',
        missingConfig,
        '--output',
        output,
        '--json',
      ]);
      expect(result.exitCode).toBe(EXIT_CODES.reported);
      const { envelope, data } = expectStubEnvelope(result.stdout);
      expect(envelope.command).toBe('diagnostic-bundle');
      expect(data.availability).toBe(NOT_AVAILABLE);
      expect(existsSync(output)).toBe(false);
    }),
  );

  it('maps report outcomes to stable exit codes', () => {
    expect(exitCodeForOutcome({ ok: true })).toBe(EXIT_CODES.reported);
    expect(exitCodeForOutcome({ ok: false, kind: 'blocked' })).toBe(EXIT_CODES.operationFailed);
    expect(exitCodeForOutcome({ ok: false, kind: 'failed' })).toBe(EXIT_CODES.operationFailed);
    expect(exitCodeForOutcome({ ok: false, kind: 'publish_failed' })).toBe(
      EXIT_CODES.operationFailed,
    );
    expect(exitCodeForOutcome({ ok: false, kind: 'invalid_invocation' })).toBe(
      EXIT_CODES.invalidInvocation,
    );
  });

  it('uses the platform conventional interrupt exit code', () => {
    expect(interruptExitCodeFor('linux')).toBe(INTERRUPT_EXIT_CODES.signalled);
    expect(interruptExitCodeFor('darwin')).toBe(INTERRUPT_EXIT_CODES.signalled);
    expect(interruptExitCodeFor('win32')).toBe(INTERRUPT_EXIT_CODES.windowsControlC);
  });
});
