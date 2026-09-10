#!/usr/bin/env node
import { Console, Effect } from 'effect';

import { summarizeFoundry } from '../application/foundry.js';

const program = Effect.gen(function* () {
  const summary = yield* summarizeFoundry();
  yield* Console.log(summary);
});

await Effect.runPromise(program);
