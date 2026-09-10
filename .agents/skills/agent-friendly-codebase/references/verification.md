# Deterministic Verification

## Goal

A coding agent should be able to prove or falsify its change quickly without relying on human interpretation.

## Verification pyramid for agent work

Prefer the narrowest useful signal first:

1. static/type checks for affected area;
2. lint and architecture checks;
3. unit/module tests around the owning seam;
4. contract tests;
5. focused integration tests;
6. E2E/UI flows when behavior crosses those boundaries;
7. broader regression suite as risk requires.

## Characteristics of good agent verification

- deterministic;
- fast enough to run repeatedly;
- easy to invoke from the repository;
- failure points close to the cause;
- minimal manual environment preparation;
- diagnostic output that tells the agent what failed.

When testing Effect timing, use `TestClock` and do not mix it with
`vi.useFakeTimers` in the same test. See `references/effect.md`.

## Prefer repository commands

Good:

```text
./check billing/refund
pnpm test:affected billing
make verify-payments
```

The exact command is repository-specific. The important property is that agents do not need to rediscover a fragile setup sequence on every run.

## Characterization tests

Before structural refactoring in poorly documented legacy code, add tests around current observable behavior. Use them to separate structural migration from intentional product changes.

## E2E caution

E2E tests are valuable for real boundaries and user flows, but a slow/flaky environment is a poor first feedback signal. Pair E2E with cheaper module-level checks where possible.
