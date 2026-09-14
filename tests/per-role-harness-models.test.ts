import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  InvalidProjectConfiguration,
  decodeProjectConfiguration,
} from '../src/application/project-configuration.js';
import {
  BUNDLED_CREDENTIAL_ENVIRONMENT_NAMES,
  ROLE_HARNESS_NAMES,
  type RoleHarnessSelections,
} from '../src/domain/project-configuration.js';
import {
  ROLE_HOST_PROTOCOL_VERSION,
  resolveAllRoleHostRoutes,
  resolveRoleHostRoute,
} from '../src/domain/role-host.js';
import {
  RoleHost,
  RoleHostLauncher,
  RoleHostOperationalError,
  launchOptionsForRole,
} from '../src/application/role-conversations/index.js';
import {
  ROLE_HARNESS_CATALOG,
  RoleHostLauncherLive,
  isSupportedRoleHostModel,
} from '../src/platform/role-host.js';
import { standInRoleHost } from '../src/application/stand-in-role-host/index.js';

import type { Schema } from 'effect';
import type { RoleHostLaunchOptions } from '../src/application/role-conversations/index.js';
import type { RoleHostRole } from '../src/domain/role-host.js';

const FAKE_ROLE_HOST = fileURLToPath(
  new URL('./fixtures/role-host/fake-role-host.mjs', import.meta.url),
);

const configDirectory = join(tmpdir(), 'foundry-per-role-harness-tests', '.agent');

function validRoles() {
  return {
    architect: { harness: 'codex', model: 'gpt-5-codex' },
    coder: { harness: 'codex', model: 'gpt-5-codex' },
    lead_coder: { harness: 'opencode', model: 'openai/gpt-5' },
    tester: { harness: 'opencode', model: 'openai/gpt-5' },
    reviewer: { harness: 'codex', model: 'gpt-5-codex' },
  };
}

function withoutRole(role: string): Schema.Json {
  return Object.fromEntries(Object.entries(validRoles()).filter(([name]) => name !== role));
}

function withoutDocumentKey(key: string): Schema.Json {
  return Object.fromEntries(Object.entries(validDocument()).filter(([name]) => name !== key));
}

function expectedSelections(): RoleHarnessSelections {
  return {
    architect: { harness: 'codex', model: 'gpt-5-codex' },
    coder: { harness: 'codex', model: 'gpt-5-codex' },
    lead_coder: { harness: 'opencode', model: 'openai/gpt-5' },
    tester: { harness: 'opencode', model: 'openai/gpt-5' },
    reviewer: { harness: 'codex', model: 'gpt-5-codex' },
  };
}

function validDocument() {
  return {
    schemaVersion: 1,
    targetRepository: '..',
    sourceRemote: 'origin',
    sourceBranch: 'main',
    taskBranchPolicy: 'foundry/<task-id>',
    roles: validRoles(),
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
  };
}

describe('per-role harness and model contract', () => {
  it('publishes the supported harness vocabulary', () => {
    expect([...ROLE_HARNESS_NAMES]).toEqual(['codex', 'opencode']);
  });

  it.effect('accepts one harness and model per role', () =>
    Effect.gen(function* () {
      const decoded = yield* decodeProjectConfiguration(validDocument(), configDirectory);
      expect(decoded.roles).toEqual(expectedSelections());
    }),
  );

  it.effect('trims surrounding whitespace from models', () =>
    Effect.gen(function* () {
      const decoded = yield* decodeProjectConfiguration(
        {
          ...validDocument(),
          roles: {
            ...validRoles(),
            coder: { harness: 'codex', model: '  gpt-5-codex\t\n' },
          },
        },
        configDirectory,
      );
      expect(decoded.roles.coder).toEqual({ harness: 'codex', model: 'gpt-5-codex' });
    }),
  );

  it.effect('rejects unknown harnesses', () =>
    Effect.gen(function* () {
      const document = validDocument();
      const error = yield* decodeProjectConfiguration(
        {
          ...document,
          roles: {
            ...validRoles(),
            architect: { harness: 'vendor-x', model: 'some-model' },
          },
        },
        configDirectory,
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(InvalidProjectConfiguration);
      expect(error.field).toBe('roles.architect.harness');
    }),
  );

  it.effect('rejects missing roles', () =>
    Effect.gen(function* () {
      const error = yield* decodeProjectConfiguration(
        { ...validDocument(), roles: withoutRole('tester') },
        configDirectory,
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(InvalidProjectConfiguration);
      expect(error.field).toBe('roles.tester');
    }),
  );

  it.effect('rejects a missing roles block', () =>
    Effect.gen(function* () {
      const error = yield* decodeProjectConfiguration(
        withoutDocumentKey('roles'),
        configDirectory,
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(InvalidProjectConfiguration);
      expect(error.field).toBe('roles');
    }),
  );

  it.effect('rejects extra roles and extra selection fields', () =>
    Effect.gen(function* () {
      const document = validDocument();
      const extraRole = yield* decodeProjectConfiguration(
        {
          ...document,
          roles: {
            ...validRoles(),
            planner: { harness: 'codex', model: 'gpt-5-codex' },
          },
        },
        configDirectory,
      ).pipe(Effect.flip);
      expect(extraRole).toBeInstanceOf(InvalidProjectConfiguration);
      expect(extraRole.field).toBe('roles.planner');

      const extraField = yield* decodeProjectConfiguration(
        {
          ...document,
          roles: {
            ...validRoles(),
            coder: { harness: 'codex', model: 'gpt-5-codex', temperature: 0.2 },
          },
        },
        configDirectory,
      ).pipe(Effect.flip);
      expect(extraField).toBeInstanceOf(InvalidProjectConfiguration);
      expect(extraField.field).toBe('roles.coder.temperature');
    }),
  );

  it.effect('rejects empty and whitespace-only models', () =>
    Effect.gen(function* () {
      for (const model of ['', '   ', '\t\n ']) {
        const document = validDocument();
        const error = yield* decodeProjectConfiguration(
          {
            ...document,
            roles: {
              ...validRoles(),
              reviewer: { harness: 'codex', model },
            },
          },
          configDirectory,
        ).pipe(Effect.flip);
        expect(error, JSON.stringify(model)).toBeInstanceOf(InvalidProjectConfiguration);
        expect(error.field, JSON.stringify(model)).toBe('roles.reviewer.model');
      }
    }),
  );

  it.effect('rejects non-string models', () =>
    Effect.gen(function* () {
      const document = validDocument();
      const error = yield* decodeProjectConfiguration(
        {
          ...document,
          roles: {
            ...validRoles(),
            tester: { harness: 'opencode', model: 7 },
          },
        },
        configDirectory,
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(InvalidProjectConfiguration);
      expect(error.field).toBe('roles.tester.model');
    }),
  );

  it.effect('rejects the removed roleHarness block as an unknown field', () =>
    Effect.gen(function* () {
      const error = yield* decodeProjectConfiguration(
        {
          ...validDocument(),
          roleHarness: {
            protocol: 'foundry-role-host-v1',
            command: ['foundry-role-host'],
            environmentAllowlist: ['OPENAI_API_KEY'],
          },
        },
        configDirectory,
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(InvalidProjectConfiguration);
      expect(error.field).toBe('roleHarness');
    }),
  );
});

describe('per-role routing', () => {
  it('resolves the harness and model for each role', () => {
    const selections = expectedSelections();
    expect(resolveRoleHostRoute(selections, 'architect')).toEqual({
      role: 'architect',
      harness: 'codex',
      model: 'gpt-5-codex',
    });
    expect(resolveRoleHostRoute(selections, 'lead_coder')).toEqual({
      role: 'lead_coder',
      harness: 'opencode',
      model: 'openai/gpt-5',
    });
  });

  it('resolves every role deterministically from the same document', () => {
    const selections = expectedSelections();
    const first = resolveAllRoleHostRoutes(selections);
    const second = resolveAllRoleHostRoutes(selections);
    expect(second).toEqual(first);
    const roles = Object.keys(first).sort();
    expect(roles).toEqual(['architect', 'coder', 'lead_coder', 'reviewer', 'tester']);
    const expectedRoles: ReadonlyArray<RoleHostRole> = [
      'architect',
      'coder',
      'lead_coder',
      'tester',
      'reviewer',
    ];
    for (const role of expectedRoles) {
      expect(roles).toContain(role);
      expect(first[role].role).toBe(role);
      expect(first[role].harness).toBe(selections[role].harness);
      expect(first[role].model).toBe(selections[role].model);
    }
  });

  it.effect('builds launch options carrying harness and model without argv', () =>
    Effect.gen(function* () {
      const configuration = yield* decodeProjectConfiguration(validDocument(), configDirectory);
      const options = launchOptionsForRole({
        configuration,
        role: 'tester',
        cwd: configuration.targetRepository,
      });
      expect(options.harness).toBe('opencode');
      expect(options.model).toBe('openai/gpt-5');
      expect(options.cwd).toBe(configuration.targetRepository);
      expect(options.environmentAllowlist).toEqual([...BUNDLED_CREDENTIAL_ENVIRONMENT_NAMES]);
      expect(options.timeoutMs).toBe(configuration.timeouts.commandMs);
      expect(options.maxOutputBytes).toBe(configuration.artifacts.maxRoleHandoffBytes);

      const overridden = launchOptionsForRole({
        configuration,
        role: 'coder',
        cwd: '/work',
        timeoutMs: 1_000,
        maxOutputBytes: 2_000,
      });
      expect(overridden.harness).toBe('codex');
      expect(overridden.model).toBe('gpt-5-codex');
      expect(overridden.timeoutMs).toBe(1_000);
      expect(overridden.maxOutputBytes).toBe(2_000);
    }),
  );
});

describe('role-host adapter catalog', () => {
  it('hardcodes one argv and model catalog per harness', () => {
    expect(ROLE_HARNESS_CATALOG.codex.executable).toBe('codex');
    expect(ROLE_HARNESS_CATALOG.opencode.executable).toBe('opencode');
    expect(ROLE_HARNESS_CATALOG.codex.models.length).toBeGreaterThan(0);
    expect(ROLE_HARNESS_CATALOG.opencode.models.length).toBeGreaterThan(0);
  });

  it('recognizes catalog models and rejects unknown models', () => {
    expect(isSupportedRoleHostModel('codex', 'gpt-5-codex')).toBe(true);
    expect(isSupportedRoleHostModel('codex', '  gpt-5-codex  ')).toBe(true);
    expect(isSupportedRoleHostModel('codex', 'no-such-model')).toBe(false);
    expect(isSupportedRoleHostModel('opencode', 'gpt-5-codex')).toBe(false);
    expect(isSupportedRoleHostModel('opencode', '')).toBe(false);
  });

  it.effect('fails closed on an unknown model before spawning', () =>
    Effect.gen(function* () {
      const launcher = yield* RoleHostLauncher;
      const hostLayer = launcher.launch({
        harness: 'codex',
        model: 'no-such-model',
        cwd: configDirectory,
        environmentAllowlist: [],
        timeoutMs: 5_000,
        maxOutputBytes: 65_536,
      });
      const error = yield* Effect.gen(function* () {
        const host = yield* RoleHost;
        return yield* host.capabilities({ schemaVersion: ROLE_HOST_PROTOCOL_VERSION });
      }).pipe(Effect.provide(hostLayer), Effect.flip);
      expect(error).toBeInstanceOf(RoleHostOperationalError);
      expect(error.operation).toBe('capabilities');
      expect(error.message).toContain('Unknown model "no-such-model"');
      expect(error.message).toContain('codex');
    }).pipe(Effect.provide(RoleHostLauncherLive)),
  );

  it.effect('fails closed on an empty model beside a harness', () =>
    Effect.gen(function* () {
      const launcher = yield* RoleHostLauncher;
      // A missing model is a type error at the launch seam; only empty or
      // whitespace strings can still reach the adapter, which rejects them.
      const incomplete: Array<Pick<RoleHostLaunchOptions, 'harness' | 'model'>> = [
        { harness: 'codex', model: '' },
        { harness: 'codex', model: '   ' },
      ];
      for (const options of incomplete) {
        const hostLayer = launcher.launch({
          ...options,
          cwd: configDirectory,
          environmentAllowlist: [],
          timeoutMs: 5_000,
          maxOutputBytes: 65_536,
        });
        const error = yield* Effect.gen(function* () {
          const host = yield* RoleHost;
          return yield* host.capabilities({ schemaVersion: ROLE_HOST_PROTOCOL_VERSION });
        }).pipe(Effect.provide(hostLayer), Effect.flip);
        expect(error).toBeInstanceOf(RoleHostOperationalError);
        expect(error.message).toContain('requires a non-empty model');
      }
    }).pipe(Effect.provide(RoleHostLauncherLive)),
  );

  it.effect('launches the catalog argv and keeps the actual runtimeIdentity', () =>
    Effect.gen(function* () {
      if (process.platform === 'win32') {
        // The PATH shim below relies on POSIX executable resolution; Windows
        // executable resolution (PATHEXT) is covered by the parity suites.
        return;
      }
      const directory = mkdtempSync(join(tmpdir(), 'foundry-harness-shim-'));
      const shimLog = join(directory, 'shim.log');
      const fakeLog = join(directory, 'fake.log');
      writeFileSync(shimLog, '');
      writeFileSync(fakeLog, '');
      const shimPath = join(directory, 'codex');
      writeFileSync(
        shimPath,
        `#!/bin/sh\n echo "shim-invoked $1" >> "${shimLog}"\n exec "${process.execPath}" "${FAKE_ROLE_HOST}" settled "${fakeLog}" "$1"\n`,
      );
      chmodSync(shimPath, 0o755);
      const previousPath = process.env.PATH;
      const previousShimLog = process.env.FOUNDRY_SHIM_LOG;
      const previousFakeLog = process.env.FOUNDRY_FAKE_LOG;
      process.env.PATH = `${directory}${delimiter}${previousPath ?? ''}`;
      process.env.FOUNDRY_SHIM_LOG = shimLog;
      process.env.FOUNDRY_FAKE_LOG = fakeLog;
      try {
        const launcher = yield* RoleHostLauncher;
        const hostLayer = launcher.launch({
          harness: 'codex',
          model: 'gpt-5-codex',
          cwd: directory,
          environmentAllowlist: ['PATH', 'FOUNDRY_SHIM_LOG', 'FOUNDRY_FAKE_LOG'],
          timeoutMs: 30_000,
          maxOutputBytes: 1_048_576,
        });
        const created = yield* Effect.gen(function* () {
          const host = yield* RoleHost;
          const capabilities = yield* host.capabilities({
            schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
          });
          expect(capabilities.protocol).toBe('foundry-role-host-v1');
          return yield* host.create({
            schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
            runId: 'test-run-1',
            role: 'coder',
            attempt: 1,
            generation: 1,
          });
        }).pipe(Effect.provide(hostLayer));
        expect(created.runtimeIdentity).toEqual({
          adapterVersion: 'fake-1',
          provider: 'fake-provider',
          model: 'fake-model',
          toolProfile: 'fake-profile',
        });
        const shimInvocations = readFileSync(shimLog, 'utf8');
        expect(shimInvocations).toContain('shim-invoked capabilities');
        expect(shimInvocations).toContain('shim-invoked create');
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        if (previousShimLog === undefined) {
          delete process.env.FOUNDRY_SHIM_LOG;
        } else {
          process.env.FOUNDRY_SHIM_LOG = previousShimLog;
        }
        if (previousFakeLog === undefined) {
          delete process.env.FOUNDRY_FAKE_LOG;
        } else {
          process.env.FOUNDRY_FAKE_LOG = previousFakeLog;
        }
        rmSync(directory, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(RoleHostLauncherLive)),
  );
});

describe('stand-in host with per-role routing', () => {
  it.effect('serves harness-routed launches with stand-in provenance', () =>
    Effect.gen(function* () {
      const configuration = yield* decodeProjectConfiguration(validDocument(), configDirectory);
      const launcher = yield* RoleHostLauncher;
      const options = launchOptionsForRole({
        configuration,
        role: 'coder',
        cwd: configDirectory,
      });
      const hostLayer = launcher.launch(options);
      const created = yield* Effect.gen(function* () {
        const host = yield* RoleHost;
        return yield* host.create({
          schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
          runId: 'test-run-1',
          role: 'coder',
          attempt: 1,
          generation: 1,
          workingDirectory: configDirectory,
          readRoots: [configDirectory],
          writeRoots: [configDirectory],
          networkAllowlist: [],
        });
      }).pipe(Effect.provide(hostLayer));
      expect(created.runtimeIdentity).toEqual({
        adapterVersion: 'stand-in-1',
        provider: 'stand-in',
        model: 'stand-in',
        toolProfile: 'stand-in',
      });
    }).pipe(Effect.provide(standInRoleHost())),
  );
});
