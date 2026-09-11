# 031 — Interrupted publication is recovered in the same run

## Requirement

Creating a decision pull request has remote side effects, so Foundry records
checkpoints as it goes. If push or pull-request creation may already have
happened, the operator resumes the same run. Foundry never opens a second run,
branch, or pull request to get unstuck.

## Observable outcome

- Uncertain remote work stays `publish_failed` or waits for a person until
  GitHub and the recorded checkpoints agree.
- A later decision on the same run updates the existing owned draft rather
  than opening a second pull request.
- A resume with no valid command reports that the run is still waiting.
- Success is recorded only after the exact draft URL is durably known.

## Not in this task

The happy-path first publish, or interpreting free-form GitHub activity as a
decision.

## Depends on

[029](029-decision-only-draft-pr.md)

## Spec

- [Decision-publication recovery](../features/recovery.md#decision-publication-recovery)
- [Publication outcomes](../features/results-and-publication.md#publication-outcomes)

## Size guess

~8 files / ~400 lines
