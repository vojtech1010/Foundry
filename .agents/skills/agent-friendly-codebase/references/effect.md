# Effect in Foundry

Use this reference whenever Foundry production code depends on Effect.

## Source of truth

Before writing or auditing Effect code, read `node_modules/effect/AGENTS.md` completely. It
is version-locked to this repository and is authoritative for API style. Search
`node_modules/effect/src` when that guide omits an API. Do not copy external or
memory-based Effect APIs into the project.

## Default architecture

- Use `Effect.fn("Name")` for functions that return an Effect.
- Use `Schema.TaggedError` for expected failure modes.
- Use `Context.Service` and `Layer` when a boundary needs dependency injection or
  hides meaningful infrastructure complexity.
- Keep failures in the Effect error channel until the outermost integration
  boundary.
- Add a Promise adapter only when a real external caller requires one; do not
  expose both Effect and Promise APIs for convenience.
- Use Effect Schema to decode untrusted data rather than predicates or manual
  parsing.
- Use Effect `Clock`, `DateTime`, schedules, scopes, and process services instead
  of untestable ambient time, ad hoc retries, or unmanaged resources.

## Layer ownership

- `src/domain/` stays dependency-light and must not depend on application or CLI.
- `src/application/` owns workflow services, state transitions, and typed errors.
- `src/cli/` is the composition root and may run the fully provided Effect.
- Infrastructure modules should implement application-owned services rather than
  leaking provider APIs into workflow code.

## Testing

- Prefer `it.effect` from `@effect/vitest`.
- Use test Layers for service substitution.
- Use `TestClock` for time-sensitive behavior; do not use wall-clock sleeps or
  fake global timers.
- Assert typed success and failure outcomes at stable public seams.

## Verification

Run:

```powershell
npm run typecheck
npm run effect:diagnostics
npm run lint
npm run lint:anti-slop
npm test
```

Effect-language-service diagnostics are a gate, not optional advice. Fix the
model rather than suppressing diagnostics or converting typed failures into
throws.

## Anti-patterns

- plain functions wrapping `Effect.gen` instead of `Effect.fn`;
- floating Effects;
- thrown strings or generic `Error` for expected failures;
- `async`/`Promise` implementations beside an existing Effect service;
- raw timers and retry loops instead of Effect time and schedules;
- service-constructor imports across module boundaries;
- manual runtime type guards where Schema or `Predicate` already applies; and
- speculative services that hide no meaningful complexity.
