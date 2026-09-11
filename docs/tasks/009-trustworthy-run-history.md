# 009 — A trustworthy history of what happened

## Requirement

A run keeps an append-only history of accepted facts. Each entry is chained to
the one before it. History is never silently truncated. If the chain is broken
or truncated, Foundry stops and asks a person to investigate integrity rather
than guessing what happened.

## Observable outcome

- Creating a run, changing state, recording attempts, and similar facts append
  to the history.
- Two writers cannot quietly overwrite each other; the later writer retries
  against the real latest history.
- A person must not edit run storage by hand to make a run advance.
- Derived files such as a status snapshot are reports, not the source of
  truth.

## Not in this task

Rebuilding status on open, repository locking, or role conversations.

## Depends on

[008](008-legal-progress-only.md)

## Spec

- [Durable-record minimum](../features/protocol-contracts.md#durable-record-minimum)

## Size guess

~10 files / ~500 lines
