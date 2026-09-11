# 036 — Abandon a run with a recorded reason

## Requirement

An operator can explicitly end a nonterminal run. The reason is required and
recorded. Abandonment does not approve, commit, publish, or erase history. It
stops owned resources where that is safe and preserves evidence.

## Observable outcome

- The supported action is resume with an abandon flag and a reason.
- The run becomes terminal `abandoned` even if some disposal is still pending
  or uncertain.
- Repeating the same reason is safe. A different later reason is noted without
  rerunning cleanup.
- Result acceptance and resource disposal remain separate facts.

## Not in this task

Retention deletion of old finished runs, or ordinary successful completion.

## Depends on

[035](035-resume-without-repeating-work.md)

## Spec

- [Abandonment and cleanup](../features/recovery.md#abandonment-and-cleanup)

## Size guess

~6 files / ~300 lines
