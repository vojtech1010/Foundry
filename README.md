# Foundry

Foundry is an autonomous, deterministic Architect → Coder → Tester → Reviewer
workflow orchestrator. This repository is a new project skeleton based on the
product behavior documented in [`docs/features`](docs/features).

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

The repository currently contains the toolchain, architectural boundaries, a
minimal Effect entry point, one test, and the feature specification. Production
orchestration behavior has not yet been implemented.
