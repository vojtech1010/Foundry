import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RoleHost,
  RoleHostCapabilityError,
  RoleHostLauncher,
  RoleHostOperationalError,
  preflightRoleHostCapabilities,
} from '../src/application/role-conversations/index.js';
import { decodeProjectConfiguration } from '../src/application/project-configuration.js';
import {
  ROLE_HOST_FILESYSTEM_PROFILES,
  ROLE_HOST_NETWORK_PROFILES,
  ROLE_HOST_PROTOCOL_NAME,
  ROLE_HOST_PROTOCOL_VERSION,
  RoleHostCapabilitiesRequestSchema,
  RoleHostCapabilitiesResponseSchema,
  evaluateRoleHostCapabilities,
} from '../src/domain/role-host.js';
import { roleHostProcessLayer } from '../src/platform/role-host.js';
import {
  CAPABLE_ROLE_HOST_CAPABILITIES,
  capableRoleHostLauncher,
  roleHostLauncherWith,
} from './fixtures/role-host/role-host-launcher.js';

import type { RoleHostCapabilityFailureReason } from '../src/application/role-conversations/index.js';
import type {
  RoleHostCapabilityProblemKind,
  RoleHostCapabilitiesResponse,
} from '../src/domain/role-host.js';

const PARSE_OPTIONS = { onExcessProperty: 'error' } as const;

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/role-host/fake-role-host.mjs', import.meta.url),
);

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

function goldenDocument(targetRepository: string) {
  return {
    schemaVersion: 1,
    targetRepository,
    sourceRemote: 'origin',
    sourceBranch: 'main',
    taskBranchPolicy: 'foundry/<task-id>',
    roleHarness: {
      protocol: 'foundry-role-host-v1',
      command: ['foundry-role-host'],
      environmentAllowlist: [],
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
      maxRequestBytes: 262144,
      maxGuidanceBytes: 1048576,
      maxRoleHandoffBytes: 262144,
      maxEvidenceBytes: 26214400,
      maxTerminalCaptureBytes: 10485760,
      maxRunBytes: 104857600,
      redactionPatterns: [],
    },
  };
}

type RoleHostFilesystemProfileList =
  RoleHostCapabilitiesResponse['capabilityProfiles']['filesystem'];

type RoleHostNetworkProfileList = RoleHostCapabilitiesResponse['capabilityProfiles']['network'];

function withProfiles(
  filesystem: RoleHostFilesystemProfileList,
  network: RoleHostNetworkProfileList,
): RoleHostCapabilitiesResponse['capabilityProfiles'] {
  return { filesystem, network };
}

const RecordedInvocationSchema = Schema.Struct({
  operation: Schema.String,
  argv: Schema.Array(Schema.String),
  env: Schema.Json,
  request: Schema.NullOr(Schema.Json),
});

const RecordedInvocationJson = Schema.fromJsonString(RecordedInvocationSchema);

function readInvocations(logPath: string) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => Schema.decodeUnknownSync(RecordedInvocationJson, PARSE_OPTIONS)(line));
}

function setupLog() {
  const base = mkdtempSync(join(tmpdir(), 'foundry-capabilities-log-'));
  return {
    logPath: join(base, 'invocations.jsonl'),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function adapterLayer(scenario: string, logPath: string): Layer.Layer<RoleHost> {
  return roleHostProcessLayer({
    command: [process.execPath, FIXTURE_PATH, scenario, logPath],
    cwd: REPOSITORY_ROOT,
    environmentAllowlist: [],
    timeoutMs: 10_000,
    maxOutputBytes: 65_536,
  });
}

describe('role-host capabilities contract', () => {
  it('accepts a complete report and rejects open, malformed, or unknown payloads', () => {
    expect(
      Schema.decodeUnknownSync(
        RoleHostCapabilitiesResponseSchema,
        PARSE_OPTIONS,
      )(CAPABLE_ROLE_HOST_CAPABILITIES),
    ).toMatchObject({ protocol: ROLE_HOST_PROTOCOL_NAME, resumable: true });

    const incompatible = [
      { ...CAPABLE_ROLE_HOST_CAPABILITIES, extra: true },
      { ...CAPABLE_ROLE_HOST_CAPABILITIES, resumable: 'yes' },
      { ...CAPABLE_ROLE_HOST_CAPABILITIES, availableRoles: ['architect', 'operator'] },
      {
        ...CAPABLE_ROLE_HOST_CAPABILITIES,
        capabilityProfiles: { filesystem: ['read_only_snapshot'], network: ['global_internet'] },
      },
      { ...CAPABLE_ROLE_HOST_CAPABILITIES, adapterVersion: '' },
      { schemaVersion: ROLE_HOST_PROTOCOL_VERSION, protocol: ROLE_HOST_PROTOCOL_NAME },
    ];
    for (const candidate of incompatible) {
      expect(() =>
        Schema.decodeUnknownSync(RoleHostCapabilitiesResponseSchema, PARSE_OPTIONS)(candidate),
      ).toThrow();
    }
  });

  it('closes the capabilities request to exactly the schema version', () => {
    expect(
      Schema.decodeUnknownSync(
        RoleHostCapabilitiesRequestSchema,
        PARSE_OPTIONS,
      )({
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
      }),
    ).toEqual({ schemaVersion: ROLE_HOST_PROTOCOL_VERSION });
    expect(() =>
      Schema.decodeUnknownSync(
        RoleHostCapabilitiesRequestSchema,
        PARSE_OPTIONS,
      )({
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        role: 'coder',
      }),
    ).toThrow();
  });

  it('derives each role requirement from the documented permission matrix', () => {
    expect(evaluateRoleHostCapabilities(CAPABLE_ROLE_HOST_CAPABILITIES)).toEqual({ ok: true });

    const gaps: ReadonlyArray<{
      readonly label: string;
      readonly report: RoleHostCapabilitiesResponse;
      readonly kind: RoleHostCapabilityProblemKind;
    }> = [
      {
        label: 'protocol',
        report: { ...CAPABLE_ROLE_HOST_CAPABILITIES, protocol: 'foundry-role-host-v0' },
        kind: 'protocol',
      },
      {
        label: 'non-resumable',
        report: { ...CAPABLE_ROLE_HOST_CAPABILITIES, resumable: false },
        kind: 'resumable',
      },
      {
        label: 'missing role',
        report: { ...CAPABLE_ROLE_HOST_CAPABILITIES, availableRoles: ['architect', 'coder'] },
        kind: 'role',
      },
      {
        label: 'missing filesystem profile',
        report: {
          ...CAPABLE_ROLE_HOST_CAPABILITIES,
          capabilityProfiles: withProfiles(['read_only_snapshot'], [...ROLE_HOST_NETWORK_PROFILES]),
        },
        kind: 'filesystem-profile',
      },
      {
        label: 'missing network profile',
        report: {
          ...CAPABLE_ROLE_HOST_CAPABILITIES,
          capabilityProfiles: withProfiles([...ROLE_HOST_FILESYSTEM_PROFILES], ['network_denied']),
        },
        kind: 'network-profile',
      },
    ];

    for (const gap of gaps) {
      const evaluation = evaluateRoleHostCapabilities(gap.report);
      expect(evaluation.ok, gap.label).toBe(false);
      if (!evaluation.ok) {
        expect(evaluation.problem.kind, gap.label).toBe(gap.kind);
        expect(evaluation.problem.detail.length, gap.label).toBeGreaterThan(0);
      }
    }
  });
});

describe('role-host capabilities adapter', () => {
  it.effect('executes the capabilities operation and strictly decodes the report', () =>
    Effect.gen(function* () {
      const log = setupLog();
      try {
        const report = yield* Effect.gen(function* () {
          const host = yield* RoleHost;
          return yield* host.capabilities({ schemaVersion: ROLE_HOST_PROTOCOL_VERSION });
        }).pipe(Effect.provide(adapterLayer('settled', log.logPath)));

        expect(report.protocol).toBe(ROLE_HOST_PROTOCOL_NAME);
        expect(report.resumable).toBe(true);
        expect(report.availableRoles).toEqual([
          'architect',
          'coder',
          'lead_coder',
          'tester',
          'reviewer',
        ]);

        const invocations = readInvocations(log.logPath);
        expect(invocations.map((invocation) => invocation.operation)).toEqual(['capabilities']);
        expect(invocations.at(0)?.argv.at(-1)).toBe('capabilities');
      } finally {
        log.cleanup();
      }
    }),
  );

  it.effect('fails operationally on nonzero, malformed, or open capabilities responses', () =>
    Effect.gen(function* () {
      for (const scenario of ['nonzero', 'malformed', 'extra-capabilities', 'unknown-role']) {
        const log = setupLog();
        try {
          const error = yield* Effect.gen(function* () {
            const host = yield* RoleHost;
            yield* host.capabilities({ schemaVersion: ROLE_HOST_PROTOCOL_VERSION });
          }).pipe(Effect.provide(adapterLayer(scenario, log.logPath)), Effect.flip);
          expect(error, scenario).toBeInstanceOf(RoleHostOperationalError);
        } finally {
          log.cleanup();
        }
      }
    }),
  );
});

describe('role-host capability preflight', () => {
  it.effect('accepts a capable host and rejects every incapable attestation', () =>
    Effect.gen(function* () {
      const configuration = yield* decodeProjectConfiguration(goldenDocument('/target'), '/work');

      const accepted = yield* preflightRoleHostCapabilities({ configuration }).pipe(
        Effect.provide(capableRoleHostLauncher()),
      );
      expect(accepted.adapterVersion).toBe(CAPABLE_ROLE_HOST_CAPABILITIES.adapterVersion);

      const cases: ReadonlyArray<{
        readonly label: string;
        readonly report: RoleHostCapabilitiesResponse;
        readonly reason: RoleHostCapabilityFailureReason;
      }> = [
        {
          label: 'unsupported protocol',
          report: { ...CAPABLE_ROLE_HOST_CAPABILITIES, protocol: 'foundry-role-host-v0' },
          reason: 'unsupported-protocol',
        },
        {
          label: 'non-resumable',
          report: { ...CAPABLE_ROLE_HOST_CAPABILITIES, resumable: false },
          reason: 'not-resumable',
        },
        {
          label: 'missing role',
          report: {
            ...CAPABLE_ROLE_HOST_CAPABILITIES,
            availableRoles: ['architect', 'coder', 'lead_coder', 'reviewer'],
          },
          reason: 'missing-role',
        },
        {
          label: 'missing profile',
          report: {
            ...CAPABLE_ROLE_HOST_CAPABILITIES,
            capabilityProfiles: withProfiles(
              [...ROLE_HOST_FILESYSTEM_PROFILES],
              ['network_denied'],
            ),
          },
          reason: 'missing-profile',
        },
      ];

      for (const testCase of cases) {
        const error = yield* preflightRoleHostCapabilities({
          configuration,
          runId: 'RUN-CAPABILITY',
        }).pipe(Effect.provide(roleHostLauncherWith(testCase.report)), Effect.flip);
        expect(error, testCase.label).toBeInstanceOf(RoleHostCapabilityError);
        if (!(error instanceof RoleHostCapabilityError)) {
          throw new Error(`Expected a RoleHostCapabilityError for ${testCase.label}.`);
        }
        expect(error.reason, testCase.label).toBe(testCase.reason);
        expect(error.runId, testCase.label).toBe('RUN-CAPABILITY');
      }
    }),
  );

  it.effect('wraps an operational host failure as an unavailable capability error', () =>
    Effect.gen(function* () {
      const configuration = yield* decodeProjectConfiguration(goldenDocument('/target'), '/work');
      const log = setupLog();
      try {
        const failingLauncher = Layer.succeed(
          RoleHostLauncher,
          RoleHostLauncher.of({
            launch: () =>
              roleHostProcessLayer({
                command: [process.execPath, FIXTURE_PATH, 'nonzero', log.logPath],
                cwd: REPOSITORY_ROOT,
                environmentAllowlist: [],
                timeoutMs: 10_000,
                maxOutputBytes: 65_536,
              }),
          }),
        );
        const error = yield* preflightRoleHostCapabilities({ configuration }).pipe(
          Effect.provide(failingLauncher),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(RoleHostCapabilityError);
        if (error instanceof RoleHostCapabilityError) {
          expect(error.reason).toBe('unavailable');
        }
      } finally {
        log.cleanup();
      }
    }),
  );
});
