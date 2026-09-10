# Bounded Refactor Plan

## Target

- Area/module:
- In scope:
- Explicitly out of scope:

## Current problem

- Structural issue:
- Evidence:
- Agent-maintainability impact:

## Behavior to preserve

- Public behavior:
- Existing tests/characterization:
- Unknowns requiring investigation:

## Target architecture

Describe observable structural invariants, not pattern names alone.

- Public seam:
- Allowed dependency directions:
- Internal implementation boundary:
- Contract ownership:
- Test boundary:
- Effect at the public seam (adapter / Effect-native / not applicable):

## Migration steps

1.
2.
3.

Each step must leave the repository coherent and independently verifiable.

## Verification

For each step, specify the narrowest deterministic checks.

## Guardrail

What prevents the old problem from returning?

- lint/import rule:
- architecture test:
- type/schema contract:
- CI check:
- repository documentation:

## Completion criteria

- [ ] Observable behavior preserved
- [ ] Intended public seam used by callers
- [ ] Obsolete bypass removed or deliberately deprecated
- [ ] Relevant tests pass
- [ ] Architecture/dependency checks pass
- [ ] Public surface did not grow without justification
- [ ] Guardrail added where practical
- [ ] Relevant repository docs updated
