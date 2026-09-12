import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

function removeTemporaryFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The temporary file may never have been created.
  }
}

function syncDirectory(directory: string): void {
  let handle: number | undefined;
  try {
    handle = openSync(directory, 'r');
    fsyncSync(handle);
  } catch {
    // A directory flush is not supported on every platform; the rename stays atomic.
  } finally {
    if (handle !== undefined) {
      closeSync(handle);
    }
  }
}

export function writeFileAtomically(path: string, bytes: Uint8Array): void {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = openSync(temporaryPath, 'wx');
    try {
      writeSync(handle, bytes);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporaryPath, path);
    syncDirectory(directory);
  } catch (cause) {
    removeTemporaryFile(temporaryPath);
    throw cause;
  }
}
