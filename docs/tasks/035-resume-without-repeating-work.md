# 035 — Resume without repeating prompts, commits, or publication

## Requirement

After an interruption, the operator inspects the existing run and resumes it.
Foundry continues from recorded checkpoints. It does not blindly resend a role
prompt, remake a commit, or republish. A new run is started only when the
request or source genuinely changed.

## Observable outcome

- Recovery either accepts a settled fact, keeps waiting, retries when that is
  proven safe, blocks for an operational fix, or stops for a person when
  identity, Git, lock, or submission evidence is ambiguous.
- After a send has started, Foundry watches the same owned session for a newer
  settled result.
- Interrupted Coder files are evidence, not an accepted implementation.
- Human recovery is an integrity stop, not a manual workflow mode.

## Not in this task

Abandonment, retention deletion, or the first happy-path run.

## Depends on

[014](014-role-conversations.md), [010](010-status-from-history.md),
[031](031-recover-publication-in-place.md)

## Spec

- [Recovery](../features/recovery.md)
- [Recovery dispositions](../features/recovery.md#recovery-dispositions)

## Size guess

~12 files / ~500 lines
