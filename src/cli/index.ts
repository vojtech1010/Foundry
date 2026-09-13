#!/usr/bin/env node
import { Cause, Effect, Exit, Layer } from 'effect';

import { interruptExitCodeFor } from '../domain/public-commands.js';
import { ProjectCommandProcessLive } from '../platform/commands.js';
import { RunGitLive } from '../platform/git-provisioning.js';
import { GuidanceLive } from '../platform/guidance.js';
import { ReadinessLive } from '../platform/readiness.js';
import { RepositoryLeaseLive } from '../platform/repository-lease.js';
import { RunHistoryLive } from '../platform/run-history.js';
import { RunIdentityLive } from '../platform/run-identity.js';

import { runCli } from './program.js';

process.on('SIGINT', () => {
  process.exit(interruptExitCodeFor(process.platform));
});

const program = runCli(process.argv.slice(2)).pipe(
  Effect.provide(
    Layer.mergeAll(
      ReadinessLive,
      ProjectCommandProcessLive,
      RunIdentityLive,
      RunHistoryLive,
      RepositoryLeaseLive,
      RunGitLive,
      GuidanceLive,
    ),
  ),
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
