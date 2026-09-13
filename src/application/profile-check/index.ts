import { Effect, Schema } from 'effect';
import { dirname, relative, resolve, sep } from 'node:path';

import { VERIFICATION_COMMANDS } from '../../domain/project-configuration.js';
import { decodeProjectConfiguration } from '../project-configuration.js';
import { runGuardedProjectCommand } from '../project-commands/index.js';
import { ReadinessFiles, ReadinessGit } from '../readiness/index.js';

import type { CommandVector } from '../../domain/project-configuration.js';
import type { ProjectCommandProcess } from '../project-commands/index.js';
import type { ProjectEvidenceStore } from '../project-commands/index.js';

export { ProjectCommandProcess } from '../project-commands/index.js';
export type { ProjectCommandResult, RunProjectCommandOptions } from '../project-commands/index.js';

export class ProfileCheckError extends Schema.TaggedError<ProfileCheckError>()(
  'ProfileCheckError',
  {
    message: Schema.String,
  },
) {}

export interface ProfileCheckExecutedCommand {
  readonly name: string;
  readonly command: ReadonlyArray<string>;
  readonly exitCode: number;
}

export interface ProfileCheckRepositoryReport {
  readonly path: string;
}

export interface ProfileCheckReport {
  readonly profileCheck: 'passed';
  readonly repository: ProfileCheckRepositoryReport;
  readonly commands: ReadonlyArray<ProfileCheckExecutedCommand>;
}

export interface CheckProjectProfileOptions {
  readonly configArg: string;
  readonly cwd: string;
}

function excerpt(output: string): string {
  return output.trim().replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

function escapesRepository(repositoryPath: string, workingDirectory: string): boolean {
  const relativePath = relative(repositoryPath, workingDirectory);
  return relativePath === '..' || relativePath.startsWith(`..${sep}`);
}

export const checkProjectProfile = Effect.fn('checkProjectProfile')(function* (
  options: CheckProjectProfileOptions,
): Effect.fn.Return<
  ProfileCheckReport,
  ProfileCheckError,
  ReadinessFiles | ReadinessGit | ProjectCommandProcess | ProjectEvidenceStore
> {
  const files = yield* ReadinessFiles;
  const git = yield* ReadinessGit;

  const configPath = resolve(options.cwd, options.configArg);
  const configDirectory = dirname(configPath);
  const configText = yield* files
    .readFile(configPath)
    .pipe(Effect.mapError((error) => new ProfileCheckError({ message: error.message })));
  const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
    configText,
  ).pipe(
    Effect.mapError(
      (error) =>
        new ProfileCheckError({
          message: `Configuration document at ${configPath} is not valid JSON: ${excerpt(error.message)}.`,
        }),
    ),
  );
  const configuration = yield* decodeProjectConfiguration(document, configDirectory).pipe(
    Effect.mapError((error) => new ProfileCheckError({ message: error.message })),
  );

  const repositoryPath = configuration.targetRepository;
  const insideWorkTree = yield* git
    .run(['rev-parse', '--is-inside-work-tree'], repositoryPath)
    .pipe(Effect.mapError((error) => new ProfileCheckError({ message: error.message })));
  if (insideWorkTree.exitCode !== 0 || insideWorkTree.stdout.trim() !== 'true') {
    return yield* new ProfileCheckError({
      message: `Target repository at ${repositoryPath} is not a Git work tree.`,
    });
  }

  if (escapesRepository(repositoryPath, resolve(repositoryPath))) {
    return yield* new ProfileCheckError({
      message: `Project command working directory at ${repositoryPath} escapes target repository at ${repositoryPath}.`,
    });
  }

  const steps: Array<{ readonly name: string; readonly vector: CommandVector }> = [];
  if (configuration.projectProfile.commands.bootstrap !== null) {
    steps.push({ name: 'bootstrap', vector: configuration.projectProfile.commands.bootstrap });
  }
  for (const name of VERIFICATION_COMMANDS) {
    steps.push({ name, vector: configuration.projectProfile.commands[name] });
  }

  const commandMs = configuration.timeouts.commandMs;
  const evidenceDirectory = resolve(repositoryPath, '.agent', 'evidence');
  const executed: Array<ProfileCheckExecutedCommand> = [];

  for (const step of steps) {
    const argv = [
      ...(step.vector[0] === undefined
        ? step.vector
        : resolveCommandWithSeparator(configDirectory, step.vector)),
    ];
    const outcome = yield* runGuardedProjectCommand({
      kind: step.name === 'bootstrap' ? 'bootstrap' : 'gate',
      name: step.name,
      command: argv,
      cwd: repositoryPath,
      repositoryPath,
      timeoutMs: commandMs,
      maxLogBytes: 65536,
      maxDiffBytes: 65536,
      redactionPatterns: [],
      evidenceDirectory,
      reconstruct: false,
    }).pipe(Effect.mapError((error) => new ProfileCheckError({ message: error.message })));

    if (outcome.timedOut) {
      return yield* new ProfileCheckError({
        message: `Project command "${step.name}" timed out after ${commandMs}ms.`,
      });
    }
    if (outcome.mutation !== null) {
      const suffix = outcome.detail.length > 0 ? `: ${outcome.detail}` : '.';
      return yield* new ProfileCheckError({
        message: `Project command "${step.name}" changed tracked Git state${suffix}`,
      });
    }
    if (outcome.exitCode !== 0) {
      const suffix = outcome.detail.length > 0 ? `: ${outcome.detail}` : '.';
      return yield* new ProfileCheckError({
        message: `Project command "${step.name}" exited with code ${outcome.exitCode ?? 1}${suffix}`,
      });
    }
    executed.push({ name: step.name, command: argv, exitCode: 0 });
  }

  return {
    profileCheck: 'passed',
    repository: { path: repositoryPath },
    commands: executed,
  };
});

function resolveCommandWithSeparator(
  configDirectory: string,
  command: CommandVector,
): ReadonlyArray<string> {
  const [executable, ...rest] = command;
  if (!executable.includes('/') && !executable.includes('\\')) {
    return [...command];
  }
  return [resolve(configDirectory, executable), ...rest];
}
