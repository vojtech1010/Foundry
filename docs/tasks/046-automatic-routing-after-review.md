# 046 — After Reviewer answers, Foundry routes the rest of the run

## Requirement

Once Reviewer has an outcome, Foundry continues on its own. Approval finishes
the change. Requested changes return to Coder within budget. Another live
observation is retried when that budget remains. A genuine product decision
waits on a person. A blocked or failed outcome stops with evidence preserved.
Cleanup of owned resources follows a terminal result.

## Observable outcome

- The operator never runs a separate approve, reject, code, test, or review
  command to finish the work.
- Correction, retest, completion, human decision, and block follow the
  allowed routes already defined.
- A no-change approval finishes as completed with no change, with no result
  commit.

## Not in this task

The first pass into Reviewer, the contents of either kind of pull request, or
parallel integration.

## Depends on

[045](045-run-owns-first-pass.md), [027](027-bounded-corrections.md),
[020](020-already-satisfied-request.md), [037](037-cleanup-keeps-the-result.md)

## Spec

- [Lifecycle](../features/running-work.md#lifecycle)
- [Reviewer outcomes](../features/quality-and-decisions.md#reviewer-outcomes)

## Size guess

~10 files / ~450 lines
