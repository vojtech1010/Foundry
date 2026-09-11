# 021 — Run the project's own checks against the recorded commit

## Requirement

After an accepted implementation commit, Foundry runs the configured format,
lint, typecheck, test, and build commands against that exact commit. After a
successful bootstrap it runs every gate even if an earlier gate fails, so Coder
sees the complete failure set. Command names are labels; what actually ran is
the executable and arguments.

## Observable outcome

- Each execution records arguments, exit codes, timeout, duration, and a
  bounded log.
- A cached report is reused only inside the same Foundry process for the same
  commit and command profile. Resume reruns checks.
- A bootstrap failure stops the attempt.
- Failed required checks cannot be approved.
- Role prose that mentions a check does not make that check part of the gate.

## Not in this task

Reconstructing a worktree after a command rewrites Git, or live application
testing.

## Depends on

[019](019-coder-commits-the-change.md), [005](005-commands-must-not-dirty-git.md)

## Spec

- [Gates](../features/quality-and-decisions.md#gates)
- [Verification evidence](../features/quality-and-decisions.md#verification-evidence)
- [Budgets and deterministic defaults](../features/protocol-contracts.md#budgets-and-deterministic-defaults)

## Size guess

~12 files / ~500 lines
