# 034 — The final handoff matches the recorded result

## Requirement

A successful run produces a human-readable handoff that agrees with the
accepted commit and current check report. The handoff is a report. Editing it
must never be a way to repair a run.

## Observable outcome

- A change handoff records source and result commits, task branch,
  Git-derived files, plan and criterion coverage, checks, optional Tester
  observations, findings, corrections, limitations, Reviewer outcome, and any
  authenticated human decision.
- A no-change handoff explains why implementation was unnecessary.
- A required Tester result is reported separately from an explicit skip.
- Rejected attempts, discounted evidence, non-blocking limitations, and
  cleanup warnings stay discoverable after success.
- Missing promised coverage is called out rather than looking complete.

## Not in this task

Operator `inspect` presentation, or diagnostic bundles.

## Depends on

[026](026-reviewer-outcomes.md), [020](020-already-satisfied-request.md)

## Spec

- [Normal result](../features/results-and-publication.md#normal-result)
- [Evidence integrity and completeness](../features/inspection-and-reporting.md#evidence-integrity-and-completeness)

## Size guess

~8 files / ~400 lines
