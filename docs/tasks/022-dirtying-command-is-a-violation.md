# 022 — A check that rewrites tracked files is a violation

## Requirement

Foundry compares tracked Git state around every non-Coder project or runtime
command. If the command changes that state, Foundry keeps a bounded diff,
treats the command as a permission violation, and reconstructs the workspace
at the recorded commit. It never commits or cherry-picks those changes.

## Observable outcome

- The dirtying command fails even if its exit code was zero.
- The workspace is restored to the recorded commit before any safe retry.
- The captured diff is evidence, not a result to keep.
- Coder remains the only role whose tracked-file changes can become a commit.

## Not in this task

Running the happy-path verification report, or Tester observations.

## Depends on

[021](021-project-checks-on-commit.md)

## Spec

- [Project commands and runtime](../features/project-setup.md#project-commands-and-runtime)
- [Target runtime profile](../features/protocol-contracts.md#target-runtime-profile)

## Size guess

~8 files / ~400 lines
