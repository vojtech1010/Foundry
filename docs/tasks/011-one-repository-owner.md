# 011 — Only one owner may drive the target repository

## Requirement

Before Foundry changes a target repository, it takes a time-limited lease that
names who owns it. The owner renews the lease while work continues. A
confirmed-dead local owner may be taken over. A live or unverifiable owner
stops the run for a person to investigate.

## Observable outcome

- A second Foundry process does not drive the same repository while the lease
  is healthy.
- A process ID alone is not enough to steal the lease.
- An unreachable machine is not treated as dead.
- Releasing and renewing the lease is safe against two owners at once.

## Not in this task

Creating worktrees, or recovering interrupted role sessions.

## Depends on

[009](009-trustworthy-run-history.md)

## Spec

- [Durable-record minimum](../features/protocol-contracts.md#durable-record-minimum)
- [Git and lock recovery](../features/recovery.md#git-and-lock-recovery)

## Size guess

~10 files / ~500 lines
