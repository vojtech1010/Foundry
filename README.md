# Foundry

Foundry is an autonomous, deterministic Architect → Coder → Tester → Reviewer
workflow orchestrator. It implements the product behavior documented in
[`docs/features`](docs/features).

## Toolchain

- Node.js 24 and npm 11
- TypeScript ESM with `NodeNext`
- Effect and `@effect/language-service`
- Vitest with `@effect/vitest`
- ESLint, Oxlint anti-slop rules, and Prettier

## Commands

```powershell
npm ci
npm run typecheck
npm run effect:diagnostics
npm run lint
npm run lint:anti-slop
npm test
npm run build
npm start
```

Run all checks with `npm run verify`.

## Current scope

The public command surface is implemented: `run`, `resume`, `status`, `inspect`,
`doctor`, `init`, `profile-check`, `diagnostic-bundle`, and `cleanup` answer with
one versioned success or error envelope and stable exit-code meanings.

`run` retains the request, drives the autonomous Architect → Coder → checks →
optional Tester → Reviewer workflow, and then publishes the configured result
publication (see
[results and publication](docs/features/results-and-publication.md)). `resume`
continues an interrupted or waiting run in place from its recorded checkpoint,
applies an authenticated human decision, or abandons a run with a recorded
reason. `status` reads the durable state record and reports its exact state,
failing rather than guessing when the record is missing or invalid. `inspect`
summarizes accepted evidence, failures, and open decisions. `doctor` validates
host tooling, the configuration document, run storage, and target repository
identity without creating a live run; `init --dry-run` previews the resolved
source, task branch, workspace, role harness, and artifact locations for a task
ID without changing anything; `profile-check` runs the configured bootstrap
(when present) and verification commands directly without a shell and fails when
a command rewrites tracked Git state, without recording a live run.
`diagnostic-bundle` exports a bounded, redacted snapshot, and `cleanup` lists
retention candidates and deletes a finished run only behind explicit
confirmation.
