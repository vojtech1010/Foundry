import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface BundledHarnessShim {
  readonly directory: string;
  readonly restore: () => void;
}

/**
 * Installs a `codex` executable shim forwarding to the fake role-host
 * fixture, so bundled catalog launches resolve without an explicit command.
 * The shim forwards the scenario, log path, and the appended operation to
 * the fixture. POSIX writes an sh shim; Windows writes a `.cmd` shim for
 * PATHEXT resolution. `restore` returns the previous PATH and removes the
 * shim directory.
 */
export function installBundledHarnessShim(
  fakePath: string,
  scenario: string,
  logPath: string,
): BundledHarnessShim {
  const directory = mkdtempSync(join(tmpdir(), 'foundry-bundled-harness-'));
  if (process.platform === 'win32') {
    writeFileSync(
      join(directory, 'codex.cmd'),
      `@echo off\r\n"${process.execPath}" "${fakePath}" ${scenario} "${logPath}" "%~1"\r\n`,
    );
  } else {
    const shim = join(directory, 'codex');
    writeFileSync(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "${fakePath}" ${scenario} "${logPath}" "$1"\n`,
    );
    chmodSync(shim, 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}${delimiter}${previousPath ?? ''}`;
  return {
    directory,
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
