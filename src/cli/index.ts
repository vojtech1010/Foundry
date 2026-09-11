#!/usr/bin/env node
import { Cause, Effect, Exit } from 'effect';

import { interruptExitCodeFor } from '../domain/public-commands.js';

import { runCli } from './program.js';

process.on('SIGINT', () => {
  process.exit(interruptExitCodeFor(process.platform));
});

const exit = await Effect.runPromiseExit(runCli(process.argv.slice(2)));

if (Exit.isSuccess(exit)) {
  process.stdout.write(exit.value.stdout);
  process.exitCode = exit.value.exitCode;
} else if (Cause.hasInterruptsOnly(exit.cause)) {
  process.exitCode = interruptExitCodeFor(process.platform);
} else {
  process.stderr.write(`${Cause.pretty(exit.cause)}\n`);
  process.exitCode = 1;
}
