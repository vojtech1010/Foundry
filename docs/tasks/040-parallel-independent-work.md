# 040 — Independent plan parts may run in parallel

## Requirement

When the accepted plan proves independent bodies of work, Foundry may run
those parts as parallel Coders. This is an execution choice inside the same
workflow, not a product mode. Each part starts from the same frozen source
and has its own workspace, branch, and conversation.

## Observable outcome

- There is no operator flag to turn parallelism on.
- Active Coders stay within the configured concurrency limit.
- Each objective and Lead Coder gets its own Coder retry budget.
- A successful part must produce a verifiable commit.
- A colliding worker branch that is not owned by this run blocks rather than
  being moved.

## Not in this task

Integrating those commits, or reviewing a partial aggregate.

## Depends on

[018](018-sequential-by-default.md), [019](019-coder-commits-the-change.md)

## Spec

- [Parallel objectives](../features/parallel-objectives.md)
- [Worker contract](../features/parallel-objectives.md#worker-contract)

## Size guess

~12 files / ~500 lines
