#!/usr/bin/env node
import { Cause, Effect, Exit, Layer } from 'effect';

import { interruptExitCodeFor } from '../domain/public-commands.js';
import { ProjectCommandProcessLive } from '../platform/commands.js';
import { ReadinessLive } from '../platform/readiness.js';
import { RunIdentityLive } from '../platform/run-identity.js';

import { runCli } from './program.js';

process.on('SIGINT', () => {
  process.exit(interruptExitCodeFor(process.platform));
});

const program = runCli(process.argv.slice(2)).pipe(
  Effect.provide(Layer.mergeAll(ReadinessLive, ProjectCommandProcessLive, RunIdentityLive)),
);

const exit = await Effect.runPromiseExit(program);

if (Exit.isSuccess(exit)) {
  process.stdout.write(exit.value.stdout);
  process.exitCode = exit.value.exitCode;
} else if (Cause.hasInterruptsOnly(exit.cause)) {
  process.exitCode = interruptExitCodeFor(process.platform);
} else {
  process.stderr.write(`${Cause.pretty(exit.cause)}\n`);
  process.exitCode = 1;
}
