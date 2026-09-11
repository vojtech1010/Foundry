# 019 — Only Coder changes project files; the result is a commit

## Requirement

Coder implements the accepted plan in the run-owned workspace and commits on
the task branch. Foundry records that commit from Git. Coder does not get to
declare the commit ID or the changed-file list as authority.

## Observable outcome

- No other role can change production files.
- The accepted implementation is a commit on the assigned branch, not a pile
  of uncommitted files.
- A blocked Coder attempt preserves evidence and does not invent a result.
- Coder may say the request needs no change; that claim is not final until
  later verification and Reviewer say so.

## Not in this task

Running project checks, parallel workers, or the no-change completion path.

## Depends on

[017](017-bounded-plan.md), [012](012-run-owned-workspace.md)

## Spec

- [Lifecycle](../features/running-work.md#lifecycle)
- [What Foundry never does](../features/product-and-modes.md#what-foundry-never-does)

## Size guess

~10 files / ~500 lines
