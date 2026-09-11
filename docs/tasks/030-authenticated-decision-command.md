# 030 — A waiting decision is resolved only by the exact authenticated command

## Requirement

The draft pull request prints one exact command per option. On resume, Foundry
accepts a decision only when a later comment is exactly that command, the
author is a human with maintain or admin permission, the pull request is still
an open draft, and its head is the recorded result commit. Ordinary comments,
approvals, closure, merge, labels, and branch activity are ignored.

## Observable outcome

- Repeated comments selecting the same option are safe to see twice.
- Conflicting valid options, a changed pull request, or unverifiable
  permission stop for a person.
- `accept` completes locally and keeps the unresolved risk in the handoff; it
  is not rewritten as Reviewer approval.
- `correct` returns to Coder once without spending an automatic correction
  round, then reruns every later gate.
- `abandon` ends the run as abandoned.
- Foundry does not close, approve, or merge the pull request after applying
  an option.

## Not in this task

Creating the pull request, or recovering an uncertain publish.

## Depends on

[029](029-decision-only-draft-pr.md)

## Spec

- [Applying a human decision](../features/results-and-publication.md#applying-a-human-decision)

## Size guess

~10 files / ~500 lines
