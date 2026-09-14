import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';

import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { executePublicCommand } from '../src/application/public-commands.js';
import { ProjectCommandProcess } from '../src/application/profile-check/index.js';
import { ReadinessFiles, ReadinessGit, ReadinessHost } from '../src/application/readiness/index.js';
import {
  RepositoryHostIdentity,
  RepositoryLeaseStore,
} from '../src/application/repository-lease/index.js';
import { RunHistoryStorage } from '../src/application/run-history/index.js';
import { InvalidRunRequest, RunIdentityStore } from '../src/application/run-identity/index.js';
import { RoleHostLauncher } from '../src/application/role-conversations/index.js';
import {
  EXIT_CODES,
  INTERRUPT_EXIT_CODES,
  NON_PRODUCT_COMMANDS,
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

function expectFailureEnvelope(stdout: string) {
  const envelope = envelopeFrom(stdout);
  expect(envelope.ok).toBe(false);
  if (envelope.ok) {
    throw new Error(`Expected a failure envelope but received: ${stdout}`);
  }
  return envelope;
}

function serviceGuard(name: string) {
  return Effect.die(new Error(`Invalid invocations must not access readiness ${name}`));
}

const ServiceGuard = Layer.mergeAll(
  Layer.succeed(
    ReadinessHost,
    ReadinessHost.of({
      platform: serviceGuard('host.platform'),
      nodeVersion: serviceGuard('host.nodeVersion'),
      npmVersion: serviceGuard('host.npmVersion'),
      gitVersionOutput: serviceGuard('host.gitVersionOutput'),
    }),
  ),
  Layer.succeed(
    ReadinessFiles,
    ReadinessFiles.of({
      readFile: (_path: string) => serviceGuard('files.readFile'),
      statPath: (_path: string) => serviceGuard('files.statPath'),
      isWritable: (_path: string) => serviceGuard('files.isWritable'),
    }),
  ),
  Layer.succeed(
    ReadinessGit,
    ReadinessGit.of({
      run: (_args: ReadonlyArray<string>, _cwd: string) => serviceGuard('git.run'),
    }),
  ),
  Layer.succeed(
    ProjectCommandProcess,
    ProjectCommandProcess.of({
      run: (_options: { readonly command: ReadonlyArray<string>; readonly cwd: string }) =>
        serviceGuard('process.run'),
    }),
  ),
  Layer.succeed(
    RunIdentityStore,
    RunIdentityStore.of({
      statPath: (_path: string) => serviceGuard('runIdentity.statPath'),
      readFileBytes: (_path: string) => serviceGuard('runIdentity.readFileBytes'),
      ensureParentDirectory: (_path: string) => serviceGuard('runIdentity.ensureParentDirectory'),
      createRunDirectoryExclusive: (_path: string, _runId: string) =>
        serviceGuard('runIdentity.createRunDirectoryExclusive'),
      writeFileBytes: (_path: string, _bytes: Uint8Array) =>
        serviceGuard('runIdentity.writeFileBytes'),
      removeDirectory: (_path: string) => serviceGuard('runIdentity.removeDirectory'),
      listRuns: (_runsRoot: string) => serviceGuard('runIdentity.listRuns'),
      readDirectory: (_path: string) => serviceGuard('runIdentity.readDirectory'),
    }),
  ),
  Layer.succeed(
    RunHistoryStorage,
    RunHistoryStorage.of({
      readHistoryFiles: (_runDirectory: string) => serviceGuard('runHistory.readHistoryFiles'),
      commitHistory: (_options) => serviceGuard('runHistory.commitHistory'),
      replaceDerivedReports: (_options) => serviceGuard('runHistory.replaceDerivedReports'),
    }),
  ),
  Layer.succeed(
    RepositoryLeaseStore,
    RepositoryLeaseStore.of({
      ensureDirectory: (_path: string) => serviceGuard('repositoryLease.ensureDirectory'),
      statPath: (_path: string) => serviceGuard('repositoryLease.statPath'),
      createGuardFile: (_path: string, _bytes: Uint8Array) =>
        serviceGuard('repositoryLease.createGuardFile'),
      writeFileAtomically: (_path: string, _bytes: Uint8Array) =>
        serviceGuard('repositoryLease.writeFileAtomically'),
      removeFile: (_path: string) => serviceGuard('repositoryLease.removeFile'),
    }),
  ),
  Layer.succeed(
    RepositoryHostIdentity,
    RepositoryHostIdentity.of({
      hostIdentity: serviceGuard('repositoryLease.hostIdentity'),
      currentProcess: serviceGuard('repositoryLease.currentProcess'),
      probeProcess: (_processId: number) => serviceGuard('repositoryLease.probeProcess'),
    }),
  ),
  Layer.succeed(
    RoleHostLauncher,
    RoleHostLauncher.of({
      launch: () => {
        throw new Error('Invalid invocations must not launch the role host');
      },
    }),
  ),
);

function runGuardedCli(argv: ReadonlyArray<string>) {
  return runCli(argv).pipe(Effect.provide(ServiceGuard));
}

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

  it.effect('rejects forbidden, unknown, and malformed invocations with exit code 2', () =>
    Effect.gen(function* () {
      for (const scenario of invalidScenarios) {
        const result = yield* runGuardedCli(scenario.argv);
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
        const result = yield* runGuardedCli([command, '--json']);
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
        const result = yield* runGuardedCli([
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

  it.effect('rejects an incomplete application invocation with a typed error', () =>
    Effect.gen(function* () {
      const error = yield* executePublicCommand({ command: 'doctor' }).pipe(
        Effect.provide(ServiceGuard),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(InvalidRunRequest);
      expect(error.message).toContain('doctor command requires --config');
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
