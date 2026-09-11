# 051 — Any new accepted result commit retires older checks and observations

## Requirement

Whenever Foundry accepts a new result-head commit — a correction, an
integration, or any other recorded advance — checks and live observations
bound to the previous commit cannot approve the new one. Foundry records why
the old evidence was retired and starts a new verification attempt against
the new commit.

## Observable outcome

- Mixing evidence from two result commits into one approval is refused.
- Reviewer is shown the correction or integration history, but judges only
  current evidence.
- The invalidation is not limited to work labeled “correction.”
- A later successful attempt keeps the retired attempts visible.

## Not in this task

Deciding when Coder must change the code, or integrating parallel workers.

## Depends on

[021](021-project-checks-on-commit.md), [027](027-bounded-corrections.md)

## Spec

- [Corrections](../features/running-work.md#corrections)
- [Plan routing and verification](../features/run-history-evidence.md#plan-routing-and-verification)

## Size guess

~8 files / ~400 lines
