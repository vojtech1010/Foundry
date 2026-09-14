import { describe, expect, it } from '@effect/vitest';
import { Duration, Effect } from 'effect';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OwnedProjectProcess,
  ProjectCommandProcess,
} from '../../src/application/project-commands/index.js';
import { ProjectCommandProcessLive } from '../../src/platform/commands.js';
import { OwnedProjectProcessLive } from '../../src/platform/project-commands.js';

const ARGV_EXPRESSION = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';

const WRITE_ARGV_EXPRESSION =
  'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))';

const SHELL_HAZARDS = [
  'plain',
  'two words',
  '$(echo injected)',
  '`echo injected`',
  '; echo injected',
  'a"b',
  'a&b',
];

const PLATFORM_SOURCE_ROOT = fileURLToPath(new URL('../../src/platform/', import.meta.url));

function temporaryBase(): string {
  return mkdtempSync(join(tmpdir(), 'foundry-parity-argv-'));
}

function removeDirectory(path: string): Effect.Effect<void> {
  return Effect.sync(() => {
    rmSync(path, { recursive: true, force: true });
  });
}

function readWrittenFile(path: string): Effect.Effect<string> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const text = yield* Effect.sync(() => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return null;
        }
      });
      if (text !== null) {
        return text;
      }
      yield* Effect.sleep(Duration.millis(25));
    }
    return yield* Effect.die(new Error(`The owned process never wrote ${path}.`));
  });
}

describe('argument-vector process spawning parity', () => {
  it.live('passes each argument literally to a spawned command without a shell', () => {
    const base = temporaryBase();
    return Effect.gen(function* () {
      const runner = yield* ProjectCommandProcess;
      const result = yield* runner.run({
        command: [process.execPath, '-e', ARGV_EXPRESSION, ...SHELL_HAZARDS],
        cwd: base,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(SHELL_HAZARDS);
    }).pipe(Effect.provide(ProjectCommandProcessLive), Effect.ensuring(removeDirectory(base)));
  });

  it.live('starts an owned process from an argument vector and records its pid', () => {
    const base = temporaryBase();
    const argvPath = join(base, 'argv.json');
    const command = [process.execPath, '-e', WRITE_ARGV_EXPRESSION, argvPath, ...SHELL_HAZARDS];
    return Effect.gen(function* () {
      const owned = yield* OwnedProjectProcess;
      const handle = yield* owned.start({ command, cwd: base, maxLogBytes: 65_536 });

      expect(handle.command).toEqual(command);
      expect(handle.pid).not.toBeNull();
      expect(JSON.parse(yield* readWrittenFile(argvPath))).toEqual(SHELL_HAZARDS);

      const terminated = yield* owned.terminate({ handle, graceMs: 2_000 });
      expect(['disposed', 'forced']).toContain(terminated.disposition);
    }).pipe(Effect.provide(OwnedProjectProcessLive), Effect.ensuring(removeDirectory(base)));
  });

  it('never asks the platform adapter to launch through a shell', () => {
    for (const name of ['commands.ts', 'project-commands.ts', 'role-host.ts']) {
      const text = readFileSync(join(PLATFORM_SOURCE_ROOT, name), 'utf8');
      expect(text, name).toContain('shell: false');
      expect(text, name).not.toMatch(/shell:\s*true/u);
      expect(text, name).not.toContain('execSync');
    }
  });
});
