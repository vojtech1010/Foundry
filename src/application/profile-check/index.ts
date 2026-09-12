import { Context, Duration, Effect, Schema } from 'effect';
import { dirname, relative, resolve, sep } from 'node:path';

import { VERIFICATION_COMMANDS } from '../../domain/project-configuration.js';
import { decodeProjectConfiguration } from '../project-configuration.js';
import { ReadinessFiles, ReadinessGit } from '../readiness/index.js';

import type { CommandVector } from '../../domain/project-configuration.js';

export class ProfileCheckError extends Schema.TaggedError<ProfileCheckError>()(
  'ProfileCheckError',
  {
    message: Schema.String,
  },
) {}

export interface ProjectCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunProjectCommandOptions {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
}

export class ProjectCommandProcess extends Context.Service<
  ProjectCommandProcess,
  {
    readonly run: (
      options: RunProjectCommandOptions,
    ) => Effect.Effect<ProjectCommandResult, ProfileCheckError>;
  }
>()('foundry/application/profile-check/Process') {}

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

function containsPathSeparator(executable: string): boolean {
  return executable.includes('/') || executable.includes('\\');
}

function resolveCommandVector(
  configDirectory: string,
  command: CommandVector,
): ReadonlyArray<string> {
  const [executable, ...rest] = command;
  if (!containsPathSeparator(executable)) {
    return [...command];
  }
  return [resolve(configDirectory, executable), ...rest];
}

function escapesRepository(repositoryPath: string, workingDirectory: string): boolean {
  const relativePath = relative(repositoryPath, workingDirectory);
  return relativePath === '..' || relativePath.startsWith(`..${sep}`);
}

interface TrackedSnapshot {
  readonly head: string;
  readonly status: string;
}

const readSnapshot = Effect.fn('profileCheck.readSnapshot')(function* (
  git: ReadinessGit['Service'],
  repositoryPath: string,
  commandName: string,
): Effect.fn.Return<TrackedSnapshot, ProfileCheckError> {
  const head = yield* git
    .run(['rev-parse', 'HEAD'], repositoryPath)
    .pipe(Effect.mapError((error) => new ProfileCheckError({ message: error.message })));
  if (head.exitCode !== 0) {
    return yield* new ProfileCheckError({
      message: `Cannot snapshot tracked Git state before project command "${commandName}": ${excerpt(head.stdout)}.`,
    });
  }
  const status = yield* git
    .run(['status', '--porcelain=v1', '--untracked-files=no'], repositoryPath)
    .pipe(Effect.mapError((error) => new ProfileCheckError({ message: error.message })));
  if (status.exitCode !== 0) {
    return yield* new ProfileCheckError({
      message: `Cannot snapshot tracked Git state before project command "${commandName}": ${excerpt(status.stdout)}.`,
    });
  }
  return { head: head.stdout.trim(), status: status.stdout };
});

export const checkProjectProfile = Effect.fn('checkProjectProfile')(function* (
  options: CheckProjectProfileOptions,
): Effect.fn.Return<
  ProfileCheckReport,
  ProfileCheckError,
  ReadinessFiles | ReadinessGit | ProjectCommandProcess
> {
  const files = yield* ReadinessFiles;
  const git = yield* ReadinessGit;
  const process = yield* ProjectCommandProcess;

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
  const executed: Array<ProfileCheckExecutedCommand> = [];

  for (const step of steps) {
    const argv = resolveCommandVector(configDirectory, step.vector);
    const before = yield* readSnapshot(git, repositoryPath, step.name);
    const result = yield* process.run({ command: argv, cwd: repositoryPath }).pipe(
      Effect.timeout(Duration.millis(commandMs)),
      Effect.catchTag(
        'TimeoutError',
        () =>
          new ProfileCheckError({
            message: `Project command "${step.name}" timed out after ${commandMs}ms.`,
          }),
      ),
    );
    if (result.exitCode !== 0) {
      const detail = excerpt(`${result.stdout}\n${result.stderr}`);
      const suffix = detail.length > 0 ? `: ${detail}` : '.';
      return yield* new ProfileCheckError({
        message: `Project command "${step.name}" exited with code ${result.exitCode}${suffix}`,
      });
    }
    const after = yield* readSnapshot(git, repositoryPath, step.name);
    if (after.head !== before.head || after.status !== before.status) {
      const detail = excerpt(after.status.length > 0 ? after.status : after.head);
      const suffix = detail.length > 0 ? `: ${detail}` : '.';
      return yield* new ProfileCheckError({
        message: `Project command "${step.name}" changed tracked Git state${suffix}`,
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
