import { Effect, Result, Schema } from 'effect';

import { executePublicCommand } from '../application/public-commands.js';
import {
  INVALID_INVOCATION_KIND,
  NOT_AVAILABLE,
  PUBLIC_COMMANDS,
  REPORT_FAILURE_KINDS,
  REPORT_SCHEMA_VERSION,
  exitCodeForOutcome,
  isNonProductCommand,
  isPublicCommand,
} from '../domain/public-commands.js';
import { Identifier } from '../domain/run-identity.js';
import { WorkflowStateSchema } from '../domain/workflow.js';

import type { PublicCommand, PublicCommandInvocation } from '../domain/public-commands.js';
import type { ReportFailureKind } from '../domain/public-commands.js';
import type { PublicCommandError, PublicCommandReport } from '../application/public-commands.js';
import type { ProjectCommandProcess } from '../application/profile-check/index.js';
import type {
  ReadinessFiles,
  ReadinessGit,
  ReadinessHost,
} from '../application/readiness/index.js';
import type { RunIdentityStore } from '../application/run-identity/index.js';

const UNKNOWN_COMMAND_LABEL = 'foundry';

const BOOLEAN_FLAGS = ['--json', '--dry-run', '--abandon', '--list'] as const;

type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];

const VALUE_FLAGS = [
  '--config',
  '--request',
  '--task-id',
  '--run-id',
  '--reason',
  '--output',
  '--confirm',
] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

type FlagName = BooleanFlag | ValueFlag;

function isFlagName(token: string): token is FlagName {
  return BOOLEAN_FLAGS.some((flag) => flag === token) || VALUE_FLAGS.some((flag) => flag === token);
}

function isBooleanFlag(token: FlagName): token is BooleanFlag {
  return BOOLEAN_FLAGS.some((flag) => flag === token);
}

interface RawArgv {
  readonly command: string | undefined;
  readonly booleans: ReadonlySet<BooleanFlag>;
  readonly values: ReadonlyMap<ValueFlag, string>;
  readonly error: string | undefined;
}

function tokenizeArgv(argv: ReadonlyArray<string>): RawArgv {
  let command: string | undefined;
  let error: string | undefined;
  const booleans = new Set<BooleanFlag>();
  const values = new Map<ValueFlag, string>();

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    index += 1;
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith('--')) {
      if (command === undefined) {
        command = token;
      } else {
        error ??= `Unexpected argument: ${token}`;
      }
      continue;
    }
    if (token.includes('=')) {
      error ??= `Flag values must be separate arguments: ${token}`;
      continue;
    }
    if (!isFlagName(token)) {
      error ??= `Unknown flag: ${token}`;
      continue;
    }
    if (isBooleanFlag(token)) {
      if (booleans.has(token)) {
        error ??= `Duplicate flag: ${token}`;
      } else {
        booleans.add(token);
      }
      continue;
    }
    const value = argv[index];
    index += value === undefined ? 0 : 1;
    if (value === undefined) {
      error ??= `Missing value for flag: ${token}`;
      continue;
    }
    if (values.has(token)) {
      error ??= `Duplicate flag: ${token}`;
      continue;
    }
    values.set(token, value);
  }

  return { command, booleans, values, error };
}

const PathValue = Schema.NonEmptyString;

const Invocation = Schema.Union([
  Schema.Struct({
    command: Schema.Literal('run'),
    config: PathValue,
    request: PathValue,
    taskId: Identifier,
    runId: Identifier,
  }),
  Schema.Struct({
    command: Schema.Literal('resume'),
    config: PathValue,
    runId: Identifier,
    abandon: Schema.Literal(true),
    reason: PathValue,
  }),
  Schema.Struct({
    command: Schema.Literal('resume'),
    config: PathValue,
    runId: Identifier,
  }),
  Schema.Struct({
    command: Schema.Literal('status'),
    config: PathValue,
    runId: Identifier,
  }),
  Schema.Struct({
    command: Schema.Literal('inspect'),
    config: PathValue,
    runId: Identifier,
  }),
  Schema.Struct({
    command: Schema.Literal('doctor'),
    config: PathValue,
  }),
  Schema.Struct({
    command: Schema.Literal('init'),
    config: PathValue,
    taskId: Identifier,
    dryRun: Schema.Literal(true),
  }),
  Schema.Struct({
    command: Schema.Literal('profile-check'),
    config: PathValue,
  }),
  Schema.Struct({
    command: Schema.Literal('diagnostic-bundle'),
    config: PathValue,
    output: PathValue,
  }),
  Schema.Struct({
    command: Schema.Literal('cleanup'),
    config: PathValue,
    list: Schema.Literal(true),
  }),
  Schema.Struct({
    command: Schema.Literal('cleanup'),
    config: PathValue,
    runId: Identifier,
    confirm: Identifier,
  }),
]);

const ReportError = Schema.Struct({
  kind: Schema.Literals(REPORT_FAILURE_KINDS),
  message: Schema.String,
  retryable: Schema.Boolean,
  runId: Schema.optional(Schema.String),
});

const StubReportData = Schema.Struct({
  availability: Schema.Literal(NOT_AVAILABLE),
  message: Schema.String,
  runId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
});

const DoctorReportData = Schema.Struct({
  readiness: Schema.Literal('ready'),
  host: Schema.Struct({
    platform: Schema.String,
    nodeVersion: Schema.String,
    npmVersion: Schema.String,
    gitVersion: Schema.String,
  }),
  config: Schema.Struct({
    path: Schema.String,
    schemaVersion: Schema.Number,
  }),
  storage: Schema.Struct({
    path: Schema.String,
    ignored: Schema.Literal(true),
  }),
  repository: Schema.Struct({
    path: Schema.String,
    remote: Schema.String,
    branch: Schema.String,
    commit: Schema.String,
  }),
});

const InitPreviewReportData = Schema.Struct({
  taskId: Schema.String,
  source: Schema.Struct({
    remote: Schema.String,
    branch: Schema.String,
    commit: Schema.String,
  }),
  branch: Schema.String,
  workspace: Schema.String,
  roleHarness: Schema.Struct({
    protocol: Schema.String,
    command: Schema.NonEmptyArray(Schema.String),
  }),
  artifacts: Schema.Struct({
    root: Schema.String,
  }),
});

const ProfileCheckReportData = Schema.Struct({
  profileCheck: Schema.Literal('passed'),
  repository: Schema.Struct({
    path: Schema.String,
  }),
  commands: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      command: Schema.Array(Schema.String),
      exitCode: Schema.Number,
    }),
  ),
});

const RunWorkflowStateReportData = Schema.Struct({
  runId: Schema.String,
  workflowState: WorkflowStateSchema,
});

const RecordedRunReportData = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  runDirectory: Schema.String,
  request: Schema.Struct({
    sourcePath: Schema.String,
    originalPath: Schema.String,
    normalizedPath: Schema.String,
    identityPath: Schema.String,
    originalByteLength: Schema.Number,
    originalContentHash: Schema.String,
    normalizedByteLength: Schema.Number,
    normalizedPromptHash: Schema.String,
  }),
});

const ReportData = Schema.Union([
  StubReportData,
  DoctorReportData,
  InitPreviewReportData,
  ProfileCheckReportData,
  RecordedRunReportData,
  RunWorkflowStateReportData,
]);

const SuccessEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(REPORT_SCHEMA_VERSION),
  command: Schema.String,
  ok: Schema.Literal(true),
  data: ReportData,
});

const FailureEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(REPORT_SCHEMA_VERSION),
  command: Schema.String,
  ok: Schema.Literal(false),
  error: ReportError,
});

export const ReportEnvelope = Schema.Union([SuccessEnvelope, FailureEnvelope]);

export type ReportEnvelopeValue = (typeof ReportEnvelope)['Type'];

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
}

class InvalidInvocation extends Schema.TaggedError<InvalidInvocation>()('InvalidInvocation', {
  command: Schema.String,
  message: Schema.String,
  json: Schema.Boolean,
  runId: Schema.optional(Schema.String),
}) {}

interface DecodedInvocation {
  readonly invocation: (typeof Invocation)['Type'];
  readonly json: boolean;
}

interface InvocationCandidate {
  command: string;
  config?: string | undefined;
  request?: string | undefined;
  taskId?: string | undefined;
  runId?: string | undefined;
  reason?: string | undefined;
  output?: string | undefined;
  confirm?: string | undefined;
  dryRun?: boolean | undefined;
  abandon?: boolean | undefined;
  list?: boolean | undefined;
}

function buildCandidate(command: PublicCommand, raw: RawArgv): InvocationCandidate {
  const candidate: InvocationCandidate = { command };

  const config = raw.values.get('--config');
  if (config !== undefined) {
    candidate.config = config;
  }
  const request = raw.values.get('--request');
  if (request !== undefined) {
    candidate.request = request;
  }
  const taskId = raw.values.get('--task-id');
  if (taskId !== undefined) {
    candidate.taskId = taskId;
  }
  const runId = raw.values.get('--run-id');
  if (runId !== undefined) {
    candidate.runId = runId;
  }
  const reason = raw.values.get('--reason');
  if (reason !== undefined) {
    candidate.reason = reason;
  }
  const output = raw.values.get('--output');
  if (output !== undefined) {
    candidate.output = output;
  }
  const confirm = raw.values.get('--confirm');
  if (confirm !== undefined) {
    candidate.confirm = confirm;
  }

  if (raw.booleans.has('--dry-run')) {
    candidate.dryRun = true;
  }
  if (raw.booleans.has('--abandon')) {
    candidate.abandon = true;
  }
  if (raw.booleans.has('--list')) {
    candidate.list = true;
  }

  return candidate;
}

function validRunId(value: string | undefined): string | undefined {
  return value !== undefined && Schema.is(Identifier)(value) ? value : undefined;
}

const decodeInvocation = Effect.fn('decodeInvocation')(function* (
  argv: ReadonlyArray<string>,
): Effect.fn.Return<DecodedInvocation, InvalidInvocation> {
  const raw = tokenizeArgv(argv);
  const json = raw.booleans.has('--json');
  const runId = validRunId(raw.values.get('--run-id'));
  const attempted = raw.command;
  const command = attempted ?? UNKNOWN_COMMAND_LABEL;

  if (raw.error !== undefined) {
    return yield* new InvalidInvocation({ command, message: raw.error, json, runId });
  }
  if (attempted === undefined) {
    return yield* new InvalidInvocation({
      command: UNKNOWN_COMMAND_LABEL,
      message: `Missing command. Expected one of: ${PUBLIC_COMMANDS.join(', ')}.`,
      json,
      runId,
    });
  }
  if (isNonProductCommand(attempted)) {
    return yield* new InvalidInvocation({
      command: attempted,
      message: `Command "${attempted}" is not part of the Foundry product.`,
      json,
      runId,
    });
  }
  if (!isPublicCommand(attempted)) {
    return yield* new InvalidInvocation({
      command: attempted,
      message: `Unknown command: ${attempted}.`,
      json,
      runId,
    });
  }

  const decoded = yield* Schema.decodeUnknownEffect(Invocation, {
    onExcessProperty: 'error',
  })(buildCandidate(attempted, raw)).pipe(
    Effect.mapError(
      (error) =>
        new InvalidInvocation({
          command: attempted,
          message: `Invalid invocation: ${error.message.replaceAll(/\s+/gu, ' ').trim()}`,
          json,
          runId,
        }),
    ),
  );

  if ('confirm' in decoded && decoded.confirm !== decoded.runId) {
    return yield* new InvalidInvocation({
      command: attempted,
      message: 'Value for --confirm must match --run-id.',
      json,
      runId: decoded.runId,
    });
  }

  return { invocation: decoded, json };
});

function renderHuman(envelope: ReportEnvelopeValue): string {
  const lines = [
    `schemaVersion: ${envelope.schemaVersion}`,
    `command: ${envelope.command}`,
    `ok: ${envelope.ok}`,
  ];
  if (envelope.ok) {
    const data = envelope.data;
    if ('availability' in data) {
      lines.push(`data.availability: ${data.availability}`, `data.message: ${data.message}`);
      if (data.runId !== undefined) {
        lines.push(`data.runId: ${data.runId}`);
      }
      if (data.taskId !== undefined) {
        lines.push(`data.taskId: ${data.taskId}`);
      }
    } else if ('readiness' in data) {
      lines.push(
        `data.readiness: ${data.readiness}`,
        `data.host.platform: ${data.host.platform}`,
        `data.host.nodeVersion: ${data.host.nodeVersion}`,
        `data.host.npmVersion: ${data.host.npmVersion}`,
        `data.host.gitVersion: ${data.host.gitVersion}`,
        `data.config.path: ${data.config.path}`,
        `data.config.schemaVersion: ${data.config.schemaVersion}`,
        `data.storage.path: ${data.storage.path}`,
        `data.storage.ignored: ${data.storage.ignored}`,
        `data.repository.path: ${data.repository.path}`,
        `data.repository.remote: ${data.repository.remote}`,
        `data.repository.branch: ${data.repository.branch}`,
        `data.repository.commit: ${data.repository.commit}`,
      );
    } else if ('profileCheck' in data) {
      lines.push(
        `data.profileCheck: ${data.profileCheck}`,
        `data.repository.path: ${data.repository.path}`,
      );
      for (const command of data.commands) {
        lines.push(
          `data.commands: ${command.name} ${command.command.join(' ')} ${command.exitCode}`,
        );
      }
    } else if ('request' in data) {
      lines.push(
        `data.runId: ${data.runId}`,
        `data.taskId: ${data.taskId}`,
        `data.runDirectory: ${data.runDirectory}`,
        `data.request.sourcePath: ${data.request.sourcePath}`,
        `data.request.originalPath: ${data.request.originalPath}`,
        `data.request.normalizedPath: ${data.request.normalizedPath}`,
        `data.request.identityPath: ${data.request.identityPath}`,
        `data.request.originalByteLength: ${data.request.originalByteLength}`,
        `data.request.originalContentHash: ${data.request.originalContentHash}`,
        `data.request.normalizedByteLength: ${data.request.normalizedByteLength}`,
        `data.request.normalizedPromptHash: ${data.request.normalizedPromptHash}`,
      );
    } else if ('workflowState' in data) {
      lines.push(`data.runId: ${data.runId}`, `data.workflowState: ${data.workflowState}`);
    } else {
      lines.push(
        `data.taskId: ${data.taskId}`,
        `data.source.remote: ${data.source.remote}`,
        `data.source.branch: ${data.source.branch}`,
        `data.source.commit: ${data.source.commit}`,
        `data.branch: ${data.branch}`,
        `data.workspace: ${data.workspace}`,
        `data.roleHarness.protocol: ${data.roleHarness.protocol}`,
        `data.roleHarness.command: ${data.roleHarness.command.join(' ')}`,
        `data.artifacts.root: ${data.artifacts.root}`,
      );
    }
  } else {
    lines.push(
      `error.kind: ${envelope.error.kind}`,
      `error.message: ${envelope.error.message}`,
      `error.retryable: ${envelope.error.retryable}`,
    );
    if (envelope.error.runId !== undefined) {
      lines.push(`error.runId: ${envelope.error.runId}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function failureKindFor(error: PublicCommandError): ReportFailureKind {
  return error._tag === 'RunStateUnavailable' ? 'failed' : INVALID_INVOCATION_KIND;
}

function renderEnvelope(envelope: ReportEnvelopeValue, json: boolean): string {
  if (!json) {
    return renderHuman(envelope);
  }
  return `${JSON.stringify(Schema.encodeSync(ReportEnvelope)(envelope))}\n`;
}

function toDomainInvocation(
  invocation: (typeof Invocation)['Type'],
  cwd: string,
): PublicCommandInvocation {
  switch (invocation.command) {
    case 'run': {
      return {
        command: 'run',
        runId: invocation.runId,
        taskId: invocation.taskId,
        config: invocation.config,
        request: invocation.request,
        cwd,
      };
    }
    case 'resume':
    case 'status':
    case 'inspect': {
      return {
        command: invocation.command,
        runId: invocation.runId,
        config: invocation.config,
        cwd,
      };
    }
    case 'doctor': {
      return { command: 'doctor', config: invocation.config, cwd };
    }
    case 'init': {
      return {
        command: 'init',
        taskId: invocation.taskId,
        config: invocation.config,
        cwd,
      };
    }
    case 'profile-check': {
      return { command: 'profile-check', config: invocation.config, cwd };
    }
    case 'diagnostic-bundle': {
      return { command: 'diagnostic-bundle', config: invocation.config, cwd };
    }
    case 'cleanup': {
      if ('runId' in invocation) {
        return {
          command: 'cleanup',
          runId: invocation.runId,
          config: invocation.config,
          cwd,
        };
      }
      return { command: 'cleanup', config: invocation.config, cwd };
    }
    default: {
      const exhaustive: never = invocation;
      return exhaustive;
    }
  }
}

function toEnvelopeData(report: PublicCommandReport): (typeof ReportData)['Type'] {
  if ('availability' in report) {
    if (report.runId !== undefined && report.taskId !== undefined) {
      return {
        availability: report.availability,
        message: report.message,
        runId: report.runId,
        taskId: report.taskId,
      };
    }
    if (report.runId !== undefined) {
      return {
        availability: report.availability,
        message: report.message,
        runId: report.runId,
      };
    }
    if (report.taskId !== undefined) {
      return {
        availability: report.availability,
        message: report.message,
        taskId: report.taskId,
      };
    }
    return {
      availability: report.availability,
      message: report.message,
    };
  }
  if ('host' in report) {
    return {
      readiness: 'ready',
      host: {
        platform: report.host.platform,
        nodeVersion: report.host.nodeVersion,
        npmVersion: report.host.npmVersion,
        gitVersion: report.host.gitVersion,
      },
      config: {
        path: report.config.path,
        schemaVersion: report.config.schemaVersion,
      },
      storage: {
        path: report.storage.path,
        ignored: report.storage.ignored,
      },
      repository: {
        path: report.repository.path,
        remote: report.repository.remote,
        branch: report.repository.branch,
        commit: report.repository.commit,
      },
    };
  }
  if ('profileCheck' in report) {
    return {
      profileCheck: report.profileCheck,
      repository: {
        path: report.repository.path,
      },
      commands: report.commands.map((command) => ({
        name: command.name,
        command: [...command.command],
        exitCode: command.exitCode,
      })),
    };
  }
  if ('request' in report) {
    return {
      runId: report.runId,
      taskId: report.taskId,
      runDirectory: report.runDirectory,
      request: {
        sourcePath: report.request.sourcePath,
        originalPath: report.request.originalPath,
        normalizedPath: report.request.normalizedPath,
        identityPath: report.request.identityPath,
        originalByteLength: report.request.originalByteLength,
        originalContentHash: report.request.originalContentHash,
        normalizedByteLength: report.request.normalizedByteLength,
        normalizedPromptHash: report.request.normalizedPromptHash,
      },
    };
  }
  if ('workflowState' in report) {
    return {
      runId: report.runId,
      workflowState: report.workflowState,
    };
  }
  return {
    taskId: report.taskId,
    source: {
      remote: report.source.remote,
      branch: report.source.branch,
      commit: report.source.commit,
    },
    branch: report.branch,
    workspace: report.workspace,
    roleHarness: {
      protocol: report.roleHarness.protocol,
      command: [...report.roleHarness.command],
    },
    artifacts: {
      root: report.artifacts.root,
    },
  };
}

export const runCli = Effect.fn('runCli')(function* (
  argv: ReadonlyArray<string>,
): Effect.fn.Return<
  CliResult,
  never,
  ReadinessHost | ReadinessFiles | ReadinessGit | ProjectCommandProcess | RunIdentityStore
> {
  const decoded = yield* decodeInvocation(argv).pipe(Effect.result);

  if (Result.isFailure(decoded)) {
    const error = decoded.failure;
    const envelope: ReportEnvelopeValue = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: error.command,
      ok: false,
      error: {
        kind: INVALID_INVOCATION_KIND,
        message: error.message,
        retryable: false,
        runId: error.runId,
      },
    };
    return {
      exitCode: exitCodeForOutcome({ ok: false, kind: INVALID_INVOCATION_KIND }),
      stdout: renderEnvelope(envelope, error.json),
    };
  }

  const { invocation, json } = decoded.success;
  const cwd = yield* Effect.sync(() => process.cwd());
  const outcome = yield* executePublicCommand(toDomainInvocation(invocation, cwd)).pipe(
    Effect.result,
  );

  if (Result.isFailure(outcome)) {
    const failureValue = outcome.failure;
    const errorRunId = 'runId' in failureValue ? failureValue.runId : undefined;
    const invocationRunId = 'runId' in invocation ? invocation.runId : undefined;
    const failureKind = failureKindFor(failureValue);
    const failure: ReportEnvelopeValue = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: invocation.command,
      ok: false,
      error: {
        kind: failureKind,
        message: failureValue.message,
        retryable: false,
        runId: errorRunId ?? invocationRunId,
      },
    };
    return {
      exitCode: exitCodeForOutcome({ ok: false, kind: failureKind }),
      stdout: renderEnvelope(failure, json),
    };
  }

  const envelope: ReportEnvelopeValue = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    command: invocation.command,
    ok: true,
    data: toEnvelopeData(outcome.success),
  };
  return {
    exitCode: exitCodeForOutcome({ ok: true }),
    stdout: renderEnvelope(envelope, json),
  };
});
