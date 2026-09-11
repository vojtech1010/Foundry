# 012 — A run uses its own workspace and leaves the checkout alone

## Requirement

Before role work, Foundry fetches the configured source, freezes the remote
commit it will use, and opens a run-owned workspace and task branch. It never
switches or updates the operator's checked-out source branch. An existing
task branch is reused only when this run already owns it and the recorded
head still matches Git.

## Observable outcome

- The run records repository identity, source branch, frozen source commit,
  task branch, and workspace.
- Forward movement of the remote source later does not rewrite this run.
- A colliding branch that belongs to someone else blocks the run instead of
  being moved or deleted.
- Uncommitted Coder files are never the accepted result; only a commit on the
  assigned branch is.

## Not in this task

Publishing to GitHub, parallel worker branches, or running project checks.

## Depends on

[011](011-one-repository-owner.md)

## Spec

- [Provisioning identity](../features/project-setup.md#provisioning-identity)
- [Paths, identifiers, and Git baseline](../features/protocol-contracts.md#paths-identifiers-and-git-baseline)

## Size guess

~12 files / ~500 lines
