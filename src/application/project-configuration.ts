import { Effect, Schema } from 'effect';
import { resolve } from 'node:path';

import {
  PROJECT_CONFIGURATION_SCHEMA_VERSION,
  PUBLICATION_DRAFT,
  PUBLICATION_MAINTAINERS_CAN_MODIFY,
  RESULT_PUBLICATION_DEFAULT_MERGE_METHOD,
  RESULT_PUBLICATION_DEFAULT_MODE,
  RESULT_PUBLICATION_MERGE_METHODS,
  RESULT_PUBLICATION_MODES,
  ROLE_HARNESS_PROTOCOL,
  RUNTIME_DATA_POLICY,
  RUNTIME_TESTER_ACCESS,
  TASK_ID_PLACEHOLDER,
  hasExactlyOneTaskIdPlaceholder,
  publicationRemoteMatchesSource,
} from '../domain/project-configuration.js';

import type { SchemaIssue } from 'effect';
import type { CommandVector, ProjectConfiguration } from '../domain/project-configuration.js';

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

const NonNegativeInteger = Schema.Natural;

const CommandVectorSchema = Schema.NonEmptyArray(Schema.NonEmptyString);

const StringListSchema = Schema.Array(Schema.NonEmptyString);

const RoleHarnessSchema = Schema.Struct({
  protocol: Schema.Literal(ROLE_HARNESS_PROTOCOL),
  command: CommandVectorSchema,
  environmentAllowlist: StringListSchema,
});

const TimeoutsSchema = Schema.Struct({
  roleMs: PositiveInteger,
  settleMs: PositiveInteger,
  pollMs: PositiveInteger,
  commandMs: PositiveInteger,
  runtimeReadinessMs: PositiveInteger,
  cleanupMs: PositiveInteger,
  leaseMs: PositiveInteger,
});

const RetryBudgetsSchema = Schema.Struct({
  architect: NonNegativeInteger,
  coder: NonNegativeInteger,
  tester: NonNegativeInteger,
  reviewer: NonNegativeInteger,
});

const OperationalRetryBudgetsSchema = Schema.Struct({
  git: NonNegativeInteger,
  runtime: NonNegativeInteger,
  publication: NonNegativeInteger,
  cleanup: NonNegativeInteger,
});

const LimitsSchema = Schema.Struct({
  maxParallelCoders: PositiveInteger,
  maxCorrectionRounds: NonNegativeInteger,
  maxControlRepairsPerAttempt: NonNegativeInteger,
});

const ProjectCommandsSchema = Schema.Struct({
  bootstrap: Schema.NullOr(CommandVectorSchema),
  formatCheck: CommandVectorSchema,
  lint: CommandVectorSchema,
  typecheck: CommandVectorSchema,
  test: CommandVectorSchema,
  build: CommandVectorSchema,
});

const ProjectProfileSchema = Schema.Struct({
  guidancePaths: StringListSchema,
  commands: ProjectCommandsSchema,
});

const RuntimeProfileSchema = Schema.Struct({
  reset: CommandVectorSchema,
  build: CommandVectorSchema,
  start: CommandVectorSchema,
  readiness: CommandVectorSchema,
  stop: CommandVectorSchema,
  baseUrl: Schema.NonEmptyString,
  environmentAllowlist: StringListSchema,
  dataPolicy: Schema.String,
  testerAccess: Schema.String,
});

const DecisionPublicationSchema = Schema.Struct({
  remote: Schema.NonEmptyString,
  draft: Schema.Boolean,
  maintainersCanModify: Schema.Boolean,
});

const ResultPublicationSchema = Schema.Struct({
  mode: Schema.Literals(RESULT_PUBLICATION_MODES),
  mergeMethod: Schema.optional(Schema.Literals(RESULT_PUBLICATION_MERGE_METHODS)),
});

const ArtifactsSchema = Schema.Struct({
  retentionDays: NonNegativeInteger,
  maxRequestBytes: PositiveInteger,
  maxGuidanceBytes: PositiveInteger,
  maxRoleHandoffBytes: PositiveInteger,
  maxEvidenceBytes: PositiveInteger,
  maxTerminalCaptureBytes: PositiveInteger,
  maxRunBytes: PositiveInteger,
  redactionPatterns: StringListSchema,
});

export const ProjectConfigurationSchema = Schema.Struct({
  schemaVersion: Schema.Literal(PROJECT_CONFIGURATION_SCHEMA_VERSION),
  targetRepository: Schema.NonEmptyString,
  sourceRemote: Schema.NonEmptyString,
  sourceBranch: Schema.NonEmptyString,
  taskBranchPolicy: Schema.NonEmptyString,
  roleHarness: RoleHarnessSchema,
  timeouts: TimeoutsSchema,
  retryBudgets: RetryBudgetsSchema,
  operationalRetryBudgets: OperationalRetryBudgetsSchema,
  limits: LimitsSchema,
  projectProfile: ProjectProfileSchema,
  runtimeProfile: Schema.NullOr(RuntimeProfileSchema),
  decisionPublication: Schema.NullOr(DecisionPublicationSchema),
  resultPublication: Schema.optional(ResultPublicationSchema),
  artifacts: ArtifactsSchema,
});

export class InvalidProjectConfiguration extends Schema.TaggedError<InvalidProjectConfiguration>()(
  'InvalidProjectConfiguration',
  {
    message: Schema.String,
    expectedSchemaVersion: Schema.Literal(PROJECT_CONFIGURATION_SCHEMA_VERSION),
    field: Schema.optional(Schema.String),
  },
) {}

export type ResolvedProjectConfiguration = ProjectConfiguration;

function invalidProjectConfiguration(
  detail: string,
  field: string | undefined,
): InvalidProjectConfiguration {
  const message = `Invalid project configuration: ${detail}. Expected schemaVersion ${PROJECT_CONFIGURATION_SCHEMA_VERSION}.`;
  const expectedSchemaVersion = PROJECT_CONFIGURATION_SCHEMA_VERSION;
  return field === undefined
    ? new InvalidProjectConfiguration({ message, expectedSchemaVersion })
    : new InvalidProjectConfiguration({ message, expectedSchemaVersion, field });
}

function collectIssuePaths(
  issue: SchemaIssue.Issue,
  prefix: ReadonlyArray<PropertyKey>,
  paths: Array<Array<PropertyKey>>,
): void {
  switch (issue._tag) {
    case 'Pointer': {
      collectIssuePaths(issue.issue, [...prefix, ...issue.path], paths);
      return;
    }
    case 'Composite':
    case 'AnyOf': {
      if (issue.issues.length === 0) {
        paths.push([...prefix]);
        return;
      }
      for (const child of issue.issues) {
        collectIssuePaths(child, prefix, paths);
      }
      return;
    }
    case 'Filter':
    case 'Encoding': {
      collectIssuePaths(issue.issue, prefix, paths);
      return;
    }
    default: {
      paths.push([...prefix]);
    }
  }
}

function issueFieldPath(issue: SchemaIssue.Issue): string | undefined {
  const paths: Array<Array<PropertyKey>> = [];
  collectIssuePaths(issue, [], paths);
  let deepest: Array<PropertyKey> | undefined;
  for (const path of paths) {
    if (deepest === undefined || path.length > deepest.length) {
      deepest = path;
    }
  }
  return deepest === undefined || deepest.length === 0 ? undefined : deepest.join('.');
}

function fromSchemaError(error: Schema.SchemaError): InvalidProjectConfiguration {
  return invalidProjectConfiguration(
    error.message.replaceAll(/\s+/gu, ' ').trim(),
    issueFieldPath(error.issue),
  );
}

function containsPathSeparator(executable: string): boolean {
  return executable.includes('/') || executable.includes('\\');
}

function resolveHarnessCommand(configDirectory: string, command: CommandVector): CommandVector {
  const [executable, ...rest] = command;
  if (!containsPathSeparator(executable)) {
    return command;
  }
  return [resolve(configDirectory, executable), ...rest];
}

export const decodeProjectConfiguration = Effect.fn('decodeProjectConfiguration')(function* (
  document: Schema.Json,
  configDirectory: string,
): Effect.fn.Return<ProjectConfiguration, InvalidProjectConfiguration> {
  const decoded = yield* Schema.decodeUnknownEffect(ProjectConfigurationSchema, {
    onExcessProperty: 'error',
  })(document).pipe(Effect.mapError(fromSchemaError));

  if (!hasExactlyOneTaskIdPlaceholder(decoded.taskBranchPolicy)) {
    return yield* invalidProjectConfiguration(
      `taskBranchPolicy must contain exactly one literal ${TASK_ID_PLACEHOLDER} placeholder`,
      'taskBranchPolicy',
    );
  }

  const runtimeProfile = decoded.runtimeProfile;
  if (runtimeProfile !== null) {
    if (runtimeProfile.dataPolicy !== RUNTIME_DATA_POLICY) {
      return yield* invalidProjectConfiguration(
        `runtimeProfile.dataPolicy must be ${RUNTIME_DATA_POLICY}`,
        'runtimeProfile.dataPolicy',
      );
    }
    if (runtimeProfile.testerAccess !== RUNTIME_TESTER_ACCESS) {
      return yield* invalidProjectConfiguration(
        `runtimeProfile.testerAccess must be ${RUNTIME_TESTER_ACCESS}`,
        'runtimeProfile.testerAccess',
      );
    }
  }

  const publication = decoded.decisionPublication;
  if (publication !== null) {
    if (!publicationRemoteMatchesSource(decoded.sourceRemote, publication.remote)) {
      return yield* invalidProjectConfiguration(
        'decisionPublication.remote must equal sourceRemote',
        'decisionPublication.remote',
      );
    }
    if (publication.draft !== PUBLICATION_DRAFT) {
      return yield* invalidProjectConfiguration(
        `decisionPublication.draft must be ${PUBLICATION_DRAFT}`,
        'decisionPublication.draft',
      );
    }
    if (publication.maintainersCanModify !== PUBLICATION_MAINTAINERS_CAN_MODIFY) {
      return yield* invalidProjectConfiguration(
        `decisionPublication.maintainersCanModify must be ${PUBLICATION_MAINTAINERS_CAN_MODIFY}`,
        'decisionPublication.maintainersCanModify',
      );
    }
  }

  const resultPublication = decoded.resultPublication;
  if (resultPublication !== undefined) {
    if (
      resultPublication.mergeMethod !== undefined &&
      resultPublication.mode !== 'non-draft-pr-auto-merge'
    ) {
      return yield* invalidProjectConfiguration(
        'resultPublication.mergeMethod is only legal with mode "non-draft-pr-auto-merge"',
        'resultPublication.mergeMethod',
      );
    }
    if (publication === null) {
      return yield* invalidProjectConfiguration(
        'resultPublication requires GitHub publication to be configured',
        'resultPublication',
      );
    }
  }

  yield* Effect.logDebug('Decoded Foundry project configuration');

  return {
    ...decoded,
    targetRepository: resolve(configDirectory, decoded.targetRepository),
    roleHarness: {
      ...decoded.roleHarness,
      command: resolveHarnessCommand(configDirectory, decoded.roleHarness.command),
    },
    projectProfile: {
      ...decoded.projectProfile,
      guidancePaths: decoded.projectProfile.guidancePaths.map((guidancePath) =>
        resolve(configDirectory, guidancePath),
      ),
    },
    runtimeProfile:
      runtimeProfile === null
        ? null
        : {
            ...runtimeProfile,
            dataPolicy: RUNTIME_DATA_POLICY,
            testerAccess: RUNTIME_TESTER_ACCESS,
          },
    decisionPublication:
      publication === null
        ? null
        : {
            ...publication,
            draft: PUBLICATION_DRAFT,
            maintainersCanModify: PUBLICATION_MAINTAINERS_CAN_MODIFY,
          },
    resultPublication: {
      mode: resultPublication?.mode ?? RESULT_PUBLICATION_DEFAULT_MODE,
      mergeMethod: resultPublication?.mergeMethod ?? RESULT_PUBLICATION_DEFAULT_MERGE_METHOD,
    },
  };
});
