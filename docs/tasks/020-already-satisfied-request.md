# 020 — An already-satisfied request can finish with no code change

## Requirement

If Architect or Coder believes the frozen source already satisfies the
request, Foundry checks that the task branch is clean and has no difference
from source, runs the project's checks on that frozen commit, and asks
Reviewer. Reviewer approval completes the run with no implementation commit
and no pull request.

## Observable outcome

- A no-change finish has no result commit and cannot publish a decision PR.
- If Reviewer wants implementation, Coder proceeds without spending a
  correction round.
- Unresolved ambiguity becomes Coder work or a blocked run, not a
  human-decision PR.
- Success is `completed_no_change`, not an empty fake implementation.

## Not in this task

Ordinary implementation review, or GitHub publication.

## Depends on

[019](019-coder-commits-the-change.md), [021](021-project-checks-on-commit.md),
[026](026-reviewer-outcomes.md)

## Spec

- [Lifecycle](../features/running-work.md#lifecycle)
- [Normal result](../features/results-and-publication.md#normal-result)

## Size guess

~8 files / ~400 lines
