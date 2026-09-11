# ADR-0011: Free-Form Handoffs and Minimal Protocol Contracts

- Status: Accepted
- Date: 2026-09-11
- Relates to: `docs/features/protocol-contracts.md`,
  `docs/features/project-setup.md`

## Context

Foundry needs machine-valid decisions for deterministic routing, but agents are
most useful when they can explain plans, implementation choices, observations,
and review findings naturally. Requiring every role to populate a large nested
artifact schema creates repair loops, loses nuance, and couples prompts to
Foundry's persistence layout.

The live role harness, application runtime, retry limits, path resolution, and
CLI result behavior also need one stable boundary so implementation does not
invent vendor- or platform-specific workflow semantics.

## Decision

- A role handoff is free-form bounded Markdown plus a narrow versioned control
  envelope containing only information required to choose the next state.
- Foundry, not the role, creates state files, journals, verification reports,
  evidence manifests, and the canonical handoff.
- Git supplies Coder commit identity and changed files. Tester supplies
  observations rather than a synthetic pass/fail verdict. Reviewer remains the
  sole role that decides approval, correction, or human escalation.
- Parallel plans add structured objective routing only when parallelism is
  requested; sequential plans use one Foundry-created objective by default.
- Live agent implementations connect through the resumable,
  idempotency-keyed `foundry-role-host-v1` command protocol. Vendor details stay
  behind that adapter.
- Runtime lifecycle commands, budgets, identifiers, paths, CLI envelopes, and
  artifact-limit behavior use the closed version 1 contracts in the owning
  feature specification.
- Explicit abandonment has the terminal `abandoned` state; pending resource
  disposal remains separate cleanup state.

## Consequences

- Agents write useful prose and only a few routing fields; invalid formatting
  cannot silently move the workflow.
- The role-host adapter is a real compatibility boundary and needs a conformance
  suite, but vendor churn does not leak into application slices.
- Some semantic completeness remains Reviewer judgment. Foundry validates
  objective/criterion coverage and Git facts mechanically without pretending to
  understand every claim in prose.
- Adding fields to a role envelope requires demonstrating that the field is
  necessary for a deterministic state transition.

## Rejected alternatives

- Large per-role JSON handoffs: too brittle and burdensome for no corresponding
  safety gain.
- Parsing prose to infer outcomes: nondeterministic and unsafe for recovery.
- Trusting role-reported commits or check results: conflicts with Git-derived
  provenance and Foundry-owned verification.
- Vendor-specific orchestration in workflow slices: makes recovery and role
  permissions depend on one CLI's current behavior.

## Enforcement / verification

- Contract tests accept free-form Markdown and reject unknown or invalid control
  fields.
- Role-host conformance tests cover create-before-submit persistence,
  idempotent submission, ordered observation, reattachment, capability
  enforcement, and idempotent disposal.
- Tests prove Coder envelopes cannot supply commit identity, Tester cannot claim
  workflow approval, and prose alone cannot cause a transition.
- Architecture tests keep vendor adapters behind the role-host capability
  facade.
