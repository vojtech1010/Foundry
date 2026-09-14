import { describe, expect, it } from '@effect/vitest';
import { Duration, Effect, Predicate, Schema } from 'effect';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OwnedProjectProcess } from '../../src/application/project-commands/index.js';
import { OwnedProjectProcessLive } from '../../src/platform/project-commands.js';

const TREE_EXPRESSION = [
  'const { spawn } = require("node:child_process");',
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const marker = process.argv[1];',
  'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
  'fs.mkdirSync(path.dirname(marker), { recursive: true });',
  'fs.writeFileSync(marker, JSON.stringify({ root: process.pid, child: child.pid }));',
  'setInterval(() => {}, 1000);',
].join('\n');

const TreeMarkerJson = Schema.fromJsonString(
  Schema.Struct({ root: Schema.Int, child: Schema.Int }),
);

function isAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (cause) {
    return Predicate.isObject(cause) && 'code' in cause && cause.code === 'EPERM';
  }
}

function waitForMarker(path: string): Effect.Effect<Schema.Schema.Type<typeof TreeMarkerJson>> {
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
        return Schema.decodeUnknownSync(TreeMarkerJson)(text);
      }
      yield* Effect.sleep(Duration.millis(25));
    }
    return yield* Effect.die(new Error(`The owned process tree never wrote ${path}.`));
  });
}

function waitUntil(predicate: () => boolean, deadlineMs: number): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const deadline = Date.now() + deadlineMs;
    while (!predicate()) {
      if (Date.now() >= deadline) {
        return yield* Effect.fail(new Error('The condition was not met before the deadline.'));
      }
      yield* Effect.sleep(Duration.millis(25));
    }
  });
}

describe('owned process tree cleanup parity', () => {
  it.live('terminates the recorded tree by pid while a same-name process survives', () => {
    const base = mkdtempSync(join(tmpdir(), 'foundry-parity-tree-'));
    const markerPath = join(base, 'tree.json');
    let sentinelPid: number | null = null;
    return Effect.gen(function* () {
      const owned = yield* OwnedProjectProcess;
      const handle = yield* owned.start({
        command: [process.execPath, '-e', TREE_EXPRESSION, markerPath],
        cwd: base,
        maxLogBytes: 65_536,
      });

      const marker = yield* waitForMarker(markerPath);
      expect(marker.root).toBe(handle.pid);
      expect(isAlive(marker.child)).toBe(true);

      const sentinel = yield* Effect.sync(() =>
        spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }),
      );
      sentinelPid = sentinel.pid ?? null;
      expect(sentinelPid).not.toBeNull();
      expect(isAlive(sentinelPid ?? -1)).toBe(true);

      const terminated = yield* owned.terminate({ handle, graceMs: 2_000 });
      expect(terminated.disposition).not.toBe('failed');

      yield* waitUntil(() => !isAlive(marker.child), 5_000);
      expect(isAlive(marker.child)).toBe(false);
      expect(isAlive(sentinelPid ?? -1)).toBe(true);
    }).pipe(
      Effect.provide(OwnedProjectProcessLive),
      Effect.ensuring(
        Effect.sync(() => {
          if (sentinelPid !== null) {
            try {
              process.kill(sentinelPid, 'SIGKILL');
            } catch {
              // The sentinel already exited.
            }
          }
          rmSync(base, { recursive: true, force: true });
        }),
      ),
    );
  });
});
