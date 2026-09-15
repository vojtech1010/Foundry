# 058 — No human decision, ever; caveats travel with the result

## Requirement

Reviewer never routes a run to a human decision. The
`human_decision_required` outcome leaves the Reviewer vocabulary entirely:
the closed outcome set becomes `approved`, `changes_requested`,
`retest_requested`, and `blocked`. Everything that previously depended on a
human decision is removed or repurposed:

- The decision-publication machinery (decision-only draft PR, authenticated
  decision comments, publication recovery for decisions, the
  `decisionPublication` configuration key, and its publication-readiness
  capabilities) is deleted from the product. Result publication is the only
  publication surface and follows the configured `resultPublication` mode.
- Reviewer `approved` may carry an explicit, bounded list of **caveats**:
  reviewer-authored observations it consciously accepts (retained runtime
  limitations, unproven-but-plausible areas, accepted simplifications).
  Caveats are durable run evidence. They are rendered into the result
  publication: a trailer block in the result commit message and, when a
  result pull request is published, the pull request body. Caveats never
  change routing, exit codes, or approval semantics.
- A `changes_requested` with no remaining automatic correction round stops
  the run as a recoverable prerequisite (`blocked`), never a decision. The
  recorded findings stay the recoverable evidence. Raising
  `limits.maxCorrectionRounds` in the configuration and resuming continues
  the same run: Coder receives the recorded findings, produces a new commit,
  earlier evidence is invalidated, and Reviewer reviews again — a fresh
  review round with no human gate.

A genuine product/risk question is still a reviewer concern: Reviewer states
it as a finding or a caveat in its narrative. Foundry never invents a
decision, never guesses from free-form activity, and never blocks on an
operator reply.

## Observable outcome

- The Reviewer control envelope schema rejects `human_decision_required`;
  documents from earlier runs remain readable but the outcome is refused as
  an invalid envelope going forward.
- With actionable findings and an exhausted correction budget, the run
  blocks with a reason naming the budget; raising
  `limits.maxCorrectionRounds` in the configuration and resuming continues
  the same run without repeating prompts, commits, or publication.
- An approved result with caveats records the caveats durably; the result
  commit message and the published result PR body carry a bounded caveat
  section; a result without caveats renders without the section.
- `decisionPublication` leaves the configuration document; documents
  containing it are rejected as unknown fields under the closed-document
  rule. Publication readiness reports only the capabilities result
  publication needs.
- `inspect` replaces the decision section with caveats and retained
  limitations; abandoned and completed decision-parking states
  (`human_decision_required`, `publishing`) leave the workflow state
  vocabulary, and existing run histories with those states remain readable
  as history.
- The handoff matches the recorded result without a decision section.

## Not in this task

Changing the Reviewer evidence rules, the correction-round accounting
itself, Tester authority, or the result-publication modes beyond removing
the decision branch.

## Depends on

[026](026-reviewer-outcomes.md), [027](027-bounded-corrections.md),
[049](049-result-pr-on-approval.md)

## Supersedes

[029](029-decision-only-draft-pr.md), [030](030-authenticated-decision-command.md),
[031](031-recover-publication-in-place.md)

## Spec

- [Quality and decisions](../features/quality-and-decisions.md)
- [Results and publication](../features/results-and-publication.md)
- [Running work](../features/running-work.md)
- [Protocol contracts](../features/protocol-contracts.md)

## Size guess

~25 files / ~700 lines: reviewer envelope vocabulary, workflow routes and
transition gate, publication simplification, inspection and handoff
rendering, configuration schema, plus feature-doc rewrites and test updates.
Split the feature-doc rewrites off if the change grows past that.

## Product-doc consequences to land with the change

- `AGENTS.md` product boundaries: no human-decision branch; caveats listed in
  the result commit/PR; draft PR only through the configured result
  publication mode.
- `docs/features/quality-and-decisions.md`,
  `docs/features/results-and-publication.md`,
  `docs/features/running-work.md`, and
  `docs/features/protocol-contracts.md` lose the decision vocabulary and gain
  the caveat contract.
