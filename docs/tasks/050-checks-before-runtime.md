# 050 — Project checks finish before the application is started

## Requirement

When live testing is required, Foundry always finishes the project's
deterministic checks against the recorded commit before it resets, builds, or
starts the application. Live testing never runs as a substitute for those
checks, and checks never start from a runtime that was already brought up.

## Observable outcome

- The run history shows verifying, then preparing the application, then
  Tester — not the other way around.
- Tester and Reviewer reuse the check report already bound to that commit
  rather than launching the same project commands again.
- A failed required check does not proceed to application start in order to
  “see if it looks fine.”
- A Tester skip still happens only after checks, never instead of them.

## Not in this task

Owning start/stop of the application, or interpreting Tester observations.

## Depends on

[021](021-project-checks-on-commit.md), [023](023-live-testing-only-when-required.md),
[024](024-foundry-owns-the-application.md)

## Spec

- [Plan-controlled validation](../features/running-work.md#plan-controlled-validation)
- [Plan routing and verification](../features/run-history-evidence.md#plan-routing-and-verification)

## Size guess

~6 files / ~250 lines
