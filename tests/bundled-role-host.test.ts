import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RoleHostBinaryResolver,
  RoleHostCapabilityError,
} from '../src/application/role-conversations/index.js';
import {
  BUNDLED_ROLE_HOST_ADAPTER_VERSION,
  BUNDLED_ROLE_HOST_CAPABILITIES,
  evaluateRoleHostCapabilities,
} from '../src/domain/role-host.js';
import {
  RoleHostBinaryResolverLive,
  bundledExecutableCandidates,
} from '../src/platform/role-host.js';

describe('bundled role-host executable candidates', () => {
  it('resolves the bare executable name on POSIX platforms', () => {
    expect(bundledExecutableCandidates('codex', 'linux')).toEqual(['codex']);
    expect(bundledExecutableCandidates('opencode', 'darwin')).toEqual(['opencode']);
  });

  it('probes PATHEXT-style names on Windows', () => {
    expect(bundledExecutableCandidates('codex', 'win32')).toEqual([
      'codex',
      'codex.exe',
      'codex.cmd',
    ]);
    expect(bundledExecutableCandidates('opencode', 'win32')).toEqual([
      'opencode',
      'opencode.exe',
      'opencode.cmd',
    ]);
  });
});

describe('bundled role-host static attestation', () => {
  it('identifies the bundled adapter build', () => {
    expect(BUNDLED_ROLE_HOST_ADAPTER_VERSION).toBe('bundled-1');
    expect(BUNDLED_ROLE_HOST_CAPABILITIES.adapterVersion).toBe('bundled-1');
  });

  it('covers every role plus the required capability profiles', () => {
    const evaluation = evaluateRoleHostCapabilities(BUNDLED_ROLE_HOST_CAPABILITIES);

    expect(evaluation).toEqual({ ok: true });
  });
});

describe('live bundled binary resolution', () => {
  function stubBinaries() {
    const directory = mkdtempSync(join(tmpdir(), 'foundry-bundled-binaries-'));
    const stub = join(directory, 'codex');
    writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    chmodSync(stub, 0o755);
    const previousPath = process.env.PATH;
    // PATH contains only the stub directory so resolution cannot observe
    // developer-machine binaries; the temp dir is hermetic by construction.
    process.env.PATH = directory;
    return {
      directory,
      previousPath,
      restore: () => {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        rmSync(directory, { recursive: true, force: true });
      },
    };
  }

  it.effect('resolves a stubbed harness executable from the process PATH', () =>
    Effect.gen(function* () {
      if (process.platform === 'win32') {
        return;
      }
      const stubbed = stubBinaries();
      try {
        const resolver = yield* RoleHostBinaryResolver;
        const executable = yield* resolver.resolveExecutable('codex');

        expect(executable).toBe(join(stubbed.directory, 'codex'));
      } finally {
        stubbed.restore();
      }
    }).pipe(Effect.provide(RoleHostBinaryResolverLive)),
  );

  it.effect('fails closed with the harness name when no executable resolves', () =>
    Effect.gen(function* () {
      if (process.platform === 'win32') {
        return;
      }
      const stubbed = stubBinaries();
      try {
        const resolver = yield* RoleHostBinaryResolver;
        const error = yield* resolver.resolveExecutable('opencode').pipe(Effect.flip);

        expect(error).toBeInstanceOf(RoleHostCapabilityError);
        expect(error.reason).toBe('unavailable');
        expect(error.message).toContain('"opencode"');
      } finally {
        stubbed.restore();
      }
    }).pipe(Effect.provide(RoleHostBinaryResolverLive)),
  );

  it.effect('resolves catalog models and rejects unknown models without spawning', () =>
    Effect.gen(function* () {
      const resolver = yield* RoleHostBinaryResolver;

      expect(yield* resolver.resolveModel('codex', 'gpt-5-codex')).toBe('gpt-5-codex');
      expect(yield* resolver.resolveModel('codex', '  gpt-5-codex  ')).toBe('gpt-5-codex');

      const error = yield* resolver.resolveModel('opencode', 'no-such-model').pipe(Effect.flip);
      expect(error).toBeInstanceOf(RoleHostCapabilityError);
      expect(error.reason).toBe('unavailable');
      expect(error.message).toContain('no-such-model');
      expect(error.message).toContain('"opencode"');
    }).pipe(Effect.provide(RoleHostBinaryResolverLive)),
  );

  it.effect('resolves the catalog model for the remaining harness', () =>
    Effect.gen(function* () {
      const resolver = yield* RoleHostBinaryResolver;

      expect(yield* resolver.resolveModel('opencode', 'openai/gpt-5')).toBe('openai/gpt-5');
    }).pipe(Effect.provide(RoleHostBinaryResolverLive)),
  );
});
