# 029 — A product decision creates a draft PR that asks a person to choose

## Requirement

When Reviewer needs a person to choose among labeled options for a reviewable
implementation, Foundry non-force-pushes the exact recorded commit and creates
or reuses one draft pull request. That pull request is a decision workspace:
it must not look approved or ready to merge. Foundry never force-pushes,
merges, closes, or rewrites history. Publishing a result pull request after
ordinary approval is a separate task.

## Observable outcome

- Before remote side effects, Foundry checks the clean task branch, source
  and result ancestry, and that the publication remote is the expected GitHub
  repository.
- An exact matching open draft is reused. A non-draft, a duplicate match, or
  a head mismatch stops for a person.
- The pull request explains that human judgment is requested, lists the
  question and options, and does not claim the work is approved or ready to
  merge.
- If publication is not configured, a human-decision outcome blocks rather
  than inventing another channel.
- Publication is allowed only while the frozen source commit is still an
  ancestor of the current remote source.

## Not in this task

Reading the person's command on the pull request, recovering a half-finished
publish, or opening a result pull request after ordinary approval.

## Depends on

[026](026-reviewer-outcomes.md), [043](043-publication-readiness.md)

## Spec

- [When Foundry creates a PR](../features/results-and-publication.md#when-foundry-creates-a-pr)
- [Human interruption policy](../features/product-and-modes.md#human-interruption-policy)

## Size guess

~12 files / ~500 lines
