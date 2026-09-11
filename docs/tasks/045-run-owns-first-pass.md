# 045 — `run` takes a request through first review without stage commands

## Requirement

The operator starts one `run`. Foundry owns the lifecycle from that point:
provision the source, plan, implement, run project checks, skip or perform
live testing as the plan requires, and reach a first Reviewer outcome. The
operator does not approve or invoke individual stages.

## Observable outcome

- `run` with a request, task ID, and run ID is enough to reach Reviewer or an
  earlier terminal/blocked stop.
- Status during the run shows the named stages in order.
- A healthy run is not paused for inspection or for a person to click Next.
- `resume` continues the same run after interruption; it does not start a
  sibling workflow.

## Not in this task

Routing after Reviewer answers, opening pull requests, or parallel workers.

## Depends on

[006](006-request-and-run-identity.md), [012](012-run-owned-workspace.md),
[017](017-bounded-plan.md), [019](019-coder-commits-the-change.md),
[021](021-project-checks-on-commit.md),
[023](023-live-testing-only-when-required.md),
[026](026-reviewer-outcomes.md), [047](047-role-packets.md)

## Spec

- [Start a run](../features/running-work.md#start-a-run)
- [Lifecycle](../features/running-work.md#lifecycle)

## Size guess

~12 files / ~500 lines
