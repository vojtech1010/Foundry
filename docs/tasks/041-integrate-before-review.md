# 041 — Parallel work is integrated before checks and review

## Requirement

Lead Coder waits until every objective has a valid commit, then integrates
those commits, resolves overlap, finishes remaining plan work, and commits
the combined result. Foundry never checks or reviews a partial combination.
The combined commit is the only candidate result.

## Observable outcome

- Integration records the accepted parts and the intended order before Lead
  Coder starts. Arrival order does not silently rewrite the plan.
- Actual Git combination order is recorded, with a reason when it differs
  from the intended order.
- Worker-reported commits are inputs to validation, not authority.
- If a part fails, queued work stops, active workers drain, owned resources
  are cleaned, and retries stay within budget.
- A cleanup failure after a successful combination keeps the result and
  reports the cleanup problem.

## Not in this task

Opening extra approval gates for parallel work, or creating worker
workspaces.

## Depends on

[040](040-parallel-independent-work.md), [021](021-project-checks-on-commit.md)

## Spec

- [Worker lifecycle and integration provenance](../features/parallel-objectives.md#worker-lifecycle-and-integration-provenance)
- [Failure behavior](../features/parallel-objectives.md#failure-behavior)

## Size guess

~10 files / ~500 lines
