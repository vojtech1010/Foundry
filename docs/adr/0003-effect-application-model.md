# ADR-0003: Effect-Native Application and Error Model, One CLI Runtime

- Status: Accepted
- Date: 2026-09-08
- Relates to: `AGENTS.md` toolchain and Effect guidance

## Context

Orchestration is asynchronous and failure-classified: role timeouts,
command failures, Git errors, lock contention, and publication faults
each need distinct handling. Ad-hoc thrown errors and parallel Promise
taxonomies make recovery and testing nondeterministic.

## Decision

Effect is the default for asynchronous and failure-classified production
code:

- Build flows with `Effect.fn`, declare failures as `Schema.TaggedError`
  unions per capability, and expose dependencies as Context services
  composed with Layers.
- Exactly one Effect runtime lives at the CLI edge (`src/cli/`). Slices
  describe effects; they never run them.
- `src/domain/` stays Effect-light and pure (types, invariants,
  transition guards).
- Interop with Promise-based APIs (child processes, Git, network) goes
  through narrow adapters (`Effect.tryPromise`, `acquireRelease`,
  scoped resources). No new thrown-error taxonomy beside the Effect
  error channel.
- Time, randomness, and polling go through Effect (`Clock`, `TestClock`
  in tests), never `Date.now()`, `Math.random()`, or bare `setTimeout`
  in production paths.

## Consequences

- Failures are typed and exhaustive; recovery can match on causes
  instead of parsing strings.
- Tests can substitute Layers and control time deterministically.
- Contributors must read the installed Effect guide before writing
  Effect code; the pinned version's `node_modules/effect/AGENTS.md` is
  authoritative, not this ADR.

## Rejected alternatives

- Thrown strings / `unknown` catches: unmatchable and untestable.
- Parallel Promise + custom `Result` unions per slice: duplicates what
  Effect already provides.
- One runtime per slice or ad-hoc `Effect.runPromise` in libraries:
  breaks Layer substitution and resource scoping.

## Enforcement / verification

- `npm run effect:diagnostics` and the vendored oxlint Effect anti-slop
  rules run in `npm run verify`.
- Floating-Effect diagnostics come from the Effect language service
  (`npm run effect:diagnostics`), not from ESLint. No ESLint rule for
  unscoped resource acquisition exists; scoping is held by the
  `acquireRelease` / scoped-resource adapter convention and by review.
- New async behavior ships with Layer-injected tests; time-based logic
  uses `TestClock`.
