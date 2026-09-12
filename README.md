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

The repository contains the toolchain, architectural boundaries, and the public
command surface: `run`, `resume`, `status`, `inspect`, `doctor`, `init`,
`profile-check`, `diagnostic-bundle`, and `cleanup` answer with one versioned
success or error envelope and stable exit-code meanings. `doctor` validates
host tooling, the configuration document, run storage, and target repository
identity without creating a live run; the remaining commands still report
`not_available` because workflow execution has not yet been implemented.
