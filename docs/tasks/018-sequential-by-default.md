# 018 — Unsafe split metadata means one sequential implementation

## Requirement

Parallel implementation is optional. If the plan does not prove independent
bodies of work, Foundry runs one sequential implementation. It does not ask a
person how to split the work.

## Observable outcome

- Sequential execution is the default when split metadata is missing.
- Overlapping, incomplete, empty, or duplicate scopes fall back to sequential
  work.
- Foundry still assigns one objective covering every criterion.
- There is no operator flag to force parallelism.

## Not in this task

Creating worker workspaces or integrating parallel commits.

## Depends on

[017](017-bounded-plan.md)

## Spec

- [Use only for independent work](../features/parallel-objectives.md#use-only-for-independent-work)
- [Free-form handoffs](../features/protocol-contracts.md#free-form-handoffs-with-a-narrow-control-envelope)

## Size guess

~6 files / ~300 lines
