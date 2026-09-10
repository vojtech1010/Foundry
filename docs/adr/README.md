# Architecture Decision Records

Accepted architectural direction for Foundry. New consequential,
non-obvious choices get a new ADR; do not edit an accepted ADR in place
— supersede it.

Behavioral intent lives in `docs/features/`; these records capture why
the structure is the way it is and how it is enforced.

| ADR                                             | Title                                                                      | Status   |
| ----------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| [0001](0001-single-autonomous-workflow.md)      | Single autonomous workflow and explicit state machine                      | Accepted |
| [0002](0002-vertical-slice-topology.md)         | Capability-oriented vertical slices with narrow facades                    | Accepted |
| [0003](0003-effect-application-model.md)        | Effect-native application and error model, one CLI runtime                 | Accepted |
| [0004](0004-schema-boundaries-no-legacy.md)     | Strict Schema boundaries and pre-1.0 no-legacy policy                      | Accepted |
| [0005](0005-durable-events-and-replay.md)       | Durable events, CAS revisions, atomic persistence, replay safety           | Accepted |
| [0006](0006-role-capabilities.md)               | Role capabilities: Coder-only writes, read-only Tester                     | Accepted |
| [0007](0007-git-provenance.md)                  | Git provenance and run-owned worktrees and branches                        | Accepted |
| [0008](0008-reviewer-completion-and-pr.md)      | Local Reviewer completion, decision-only draft PR, deferred reconciliation | Accepted |
| [0009](0009-deterministic-test-architecture.md) | Deterministic test architecture with Effect Layers and TestClock           | Accepted |
| [0010](0010-mechanical-repo-constraints.md)     | Mechanically enforced repo constraints and navigational docs               | Accepted |

## Conventions

- One decision per file: context, decision, consequences, rejected
  alternatives, enforcement/verification.
- Status is `Accepted` for the ten records above. Later changes add a new
  ADR that supersedes, with a link in both directions.
- Keep each ADR concrete and short; link the owning `docs/features/` page
  and the enforcing check or test seam.
