# ADR-0002: Capability-Oriented Vertical Slices with Narrow Facades

- Status: Accepted
- Date: 2026-09-08
- Relates to: `AGENTS.md` repository map,
  `.agents/skills/agent-friendly-codebase/references/vertical-slices.md`

## Context

The orchestrator spans run lifecycle, planning, implementation,
verification, runtime testing, review, publication, recovery, and
inspection. Global technical buckets (`services/`, `managers/`,
`utils/`) would force every agent to traverse the whole tree for one
capability change.

## Decision

Organize by owning capability as vertical slices with narrow facades:

- `src/domain/`: dependency-light workflow vocabulary and invariants
  only. No I/O, no CLI, no infrastructure imports.
- `src/application/<capability>/`: one directory per capability (run
  lifecycle, planning, coding, verification, runtime testing, review,
  publication, recovery, inspection). Each capability directory exposes
  a small `index.ts` facade; everything else under it is private
  internals. Application may depend on domain, never on CLI.
- `src/cli/`: composition root and presentation only. No domain logic or
  state-transition rules.
- Cross-capability access goes through the owning capability's
  `index.ts` facade (`src/application/<capability>/index.ts`), never
  through deep internal imports. Shared helpers live in the capability
  that owns the invariant, not in a global `utils` hub.
- Add a deeper module only when its ownership is clear; prefer deepening
  an existing slice over adding a pass-through layer.

## Consequences

- A change to one capability stays local to one slice plus its tests.
- Public seams stay small and reviewable; internals remain free to
  evolve.
- Slice count must stay justified: each slice needs a distinct invariant
  or variation it hides.

## Rejected alternatives

- Horizontal technical layers (`controllers/`, `repositories/`):
  scatters one capability across many directories.
- Single flat `src/` module: no locality once capabilities grow.
- God orchestrator calling internals directly: couples every caller to
  every implementation detail.

## Enforcement / verification

- ESLint import restrictions enforce `domain <- application <- cli`,
  top-level internal ownership, and per-capability ownership under
  `src/application/`.
- Architecture tests require cross-capability imports to target
  `src/application/<capability>/index.ts` and reject deep or `internal/`
  imports from other capabilities.
- Review checklist: new public exports need an owning slice and a reason
  the facade must grow.
