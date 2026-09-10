# ADR-0009: Deterministic Test Architecture with Effect Layers and TestClock

- Status: Accepted
- Date: 2026-09-08
- Relates to: `AGENTS.md` toolchain,
  `.agents/skills/agent-friendly-codebase/references/verification.md`

## Context

Agents need fast, objective feedback after each change. Real timers,
live GitHub, shared runtimes, and screenshot matrices make tests
slow, flaky, and order-dependent, which pushes agents toward skipping
verification.

## Decision

Tests are deterministic and layered:

- Runner: Vitest 4.1.11 with `@effect/vitest`; async failure-classified
  tests use Effect test Layers with fakes for clock, filesystem,
  processes, Git, and the role/GitHub harnesses.
- Time-based logic (timeouts, settle/poll intervals, lease expiry,
  retry budgets) uses `TestClock`; production code takes `Clock`, never
  wall time directly.
- Lanes, cheapest first: unit and contract tests at slice facades;
  module tests with fake Layers; a narrow integration lane with real
  temporary Git repositories and stubbed project commands. No slow or
  flaky end-to-end suite is the first correctness signal.
- Verification reports are cached only by (result commit, command
  profile). A new commit or profile reruns the configured format, lint,
  typecheck, test, and build order.
- Evidence bounds (artifact bytes, capture sizes) are asserted so tests
  cannot balloon the repository.

## Consequences

- Most development iterates on the fast lanes; the integration lane
  runs before handoff and in CI.
- Fakes must be faithful enough to catch contract drift, which requires
  maintaining them alongside the real adapters.
- Live runtimes are used only where the plan requires runtime
  validation, with Foundry-owned lifecycle and cleanup.

## Rejected alternatives

- Real `sleep` and wall-clock timeouts in tests: slow and flaky under
  load.
- Live GitHub or shared environments in unit tests: couples every test
  to credentials and network.
- Mandatory browser-screenshot E2E gate: expensive, nondeterministic,
  and redundant with criterion-tied observations.

## Enforcement / verification

- `npm test` runs the full deterministic suite; focused lane commands
  run subsets while iterating.
- New time-dependent production code ships with a `TestClock` test.
- Flaky tests are quarantined and fixed or removed; retries inside the
  test runner do not substitute for determinism.
