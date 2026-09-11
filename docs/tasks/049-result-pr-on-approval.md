# 049 — Ordinary approval publishes a result pull request

## Requirement

When Reviewer approves a changed implementation, Foundry publishes a pull
request for that exact result commit so the team can take it through their
normal GitHub process. This is a result pull request, not a question waiting
for a Foundry command. A no-change completion still has no pull request.
Foundry still never force-pushes, merges, closes, or rewrites history.

## Observable outcome

- An approved change with publication enabled ends with a recorded pull
  request URL for the task branch and accepted commit.
- The pull request presents the approved result. It is distinct from a
  decision pull request that asks a person to choose among options.
- If publication is not configured, ordinary approval still completes
  locally and reports that no result pull request was opened.
- If push or pull-request creation is uncertain, the same run is resumed;
  Foundry does not open a second run or a duplicate result pull request.
- `completed_no_change` never publishes.

## Not in this task

Waiting on an authenticated option command, or treating GitHub merge/approval
as a Foundry decision.

## Depends on

[046](046-automatic-routing-after-review.md),
[029](029-decision-only-draft-pr.md), [043](043-publication-readiness.md)

## Spec

Current feature pages say ordinary approval stays local. This task adds result
publication after approval, as operators used in successful legacy runs, while
keeping decision pull requests as a separate waiting state.

- [Normal result](../features/results-and-publication.md#normal-result)
- [Approved-result PRs in evidence](../features/run-history-evidence.md#deliberate-exclusions-and-limits-of-the-evidence)

## Size guess

~10 files / ~450 lines
