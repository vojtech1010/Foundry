---
name: agent-friendly-codebase
description: Design, evolve, audit, and refactor codebases for long-term maintainability by coding agents. Use for feature implementation, maintainability audits, bounded refactoring, and when writing or migrating Effect code (services, Layers, tagged errors, TestClock, Promise adapters). Optimizes for locality, deep modules, explicit contracts, mechanically enforced boundaries, deterministic verification, repository legibility, and continuous architectural cleanup.
---

# Agent-Friendly Codebase

## Purpose

Use this skill to keep a codebase easy for future coding agents to understand and safely modify.

Optimize for:

- **locality** — a change should require understanding as little unrelated code as possible;
- **small conceptual surfaces** — expose narrow, stable APIs over substantial hidden implementation;
- **explicit contracts** — types, schemas, tests, and public APIs should encode assumptions;
- **mechanical architecture** — important boundaries should be enforced by tools, not prose alone;
- **deterministic verification** — agents should get fast, objective feedback after a change;
- **repository legibility** — important knowledge should be discoverable inside the repository;
- **controlled entropy** — recurring mistakes should become permanent guardrails.

This skill is intentionally conservative. Do not use maintainability as justification for unrelated rewrites.

## Select an operating mode

Choose exactly one mode before acting.

### FEATURE

Use when implementing or modifying product behavior.

Goal: deliver the requested behavior while preserving or incrementally improving maintainability.

Rules:

- Keep scope centered on the requested behavior.
- Prefer existing domain/module seams when they are sound.
- Do not introduce new architectural violations.
- When the repository depends on `effect` and the change is asynchronous or
  failure-classified in an allowed layer, prefer Effect over a new
  Promise/throw taxonomy. Read `references/effect.md` before writing Effect
  code.
- Perform only low-risk, directly adjacent cleanup unless broader refactoring is required for correctness.
- Record larger structural problems as findings rather than silently expanding scope.

Read `workflows/feature.md`.

### AUDIT

Use when asked to inspect maintainability, architecture, agent-friendliness, coupling, or technical debt without modifying code.

Goal: identify the highest-leverage problems and a sensible migration order.

Rules:

- Do not edit code.
- Prioritize structural issues over cosmetic style.
- Prefer evidence: imports, dependency edges, tests, public APIs, duplicated concepts, build/test behavior.
- Produce bounded remediation candidates rather than one giant rewrite proposal.

Read `workflows/audit.md` and `references/scoring.md`.

### REFACTOR

Use when explicitly asked to improve existing structure while preserving externally observable behavior.

Goal: move a bounded area toward the target principles in small, verifiable steps.

Rules:

- Never start with a whole-codebase rewrite.
- Define the target architecture before editing.
- Establish behavioral safety before moving structure.
- Migrate incrementally. A Promise-to-Effect conversion is one bounded slice
  at a time; read `references/effect.md`.
- Verify after each meaningful step.
- Where a repaired problem could recur, add a mechanical guardrail.

Read `workflows/refactor.md`.

## Core rules

### MUST

1. **Preserve behavior unless behavior change is explicitly requested.**
2. **Do not introduce forbidden dependency directions or new cross-domain leaks.**
3. **Validate external/untrusted data at a boundary or use a typed, trustworthy contract.**
4. **Run the narrowest relevant deterministic verification available after changes.**
5. **Keep refactors bounded and independently verifiable.**
6. **Do not bypass a public module seam merely because an internal symbol is convenient.**
7. **Do not invent architecture from scratch when a coherent existing architecture already exists.**
8. **Do not perform speculative abstraction.** Introduce a seam only when it hides meaningful complexity, protects a real boundary, centralizes an invariant, or supports demonstrated variation.
9. **Treat code, schemas, tests, and enforced rules as stronger sources of truth than prose documentation when they conflict.**
10. **Escalate recurring mistakes into repository guardrails where practical.** Prefer type/schema/lint/architecture-test/tooling fixes over repeated prompt instructions.

### SHOULD

1. Prefer **deep modules**: narrow public API, substantial hidden implementation.
2. Organize behavior by **owning domain**, then by feature/use case where useful.
3. Keep a feature change within one domain/module whenever reasonable.
4. Prefer explicit typed contracts over implicit object shapes and convention-only behavior.
   When `effect` is a dependency, prefer `Schema.TaggedError` and Effect
   services for new failure-classified async work in allowed layers (see
   `references/effect.md`).
5. Prefer tests at stable public seams over tests coupled to internals.
6. Make important architecture constraints mechanically enforceable.
7. Keep repository guidance concise and navigational; use progressive disclosure.
8. Record non-obvious architectural decisions and domain vocabulary in-repo.
9. Prefer generated repository facts over manually duplicated documentation.
10. Leave touched code no harder for the next agent to understand than before.

### MAY

1. Remove small adjacent duplication when risk is low.
2. Collapse shallow pass-through layers when this clearly reduces conceptual surface.
3. Deepen a public module seam while preserving callers.
4. Add an ADR for a non-obvious consequential decision.
5. Add a local verification command or targeted test runner.
6. Improve nearby documentation if it is stale and directly relevant.

## Decision procedure for every meaningful change

Before implementation or refactoring, answer:

1. **Ownership** — Which domain/module owns this behavior?
2. **Public seam** — What is the intended entry point for callers?
3. **Locality** — What is the smallest code area that should need to change?
4. **Dependencies** — Which dependency edges are affected or introduced?
5. **Contract** — What inputs/outputs/invariants cross a boundary? If Effect is
   in play, are failures a tagged error union rather than thrown strings?
6. **Abstraction** — Is a new abstraction actually necessary? If yes, what complexity does it hide?
7. **Behavior safety** — What existing behavior must remain unchanged?
8. **Verification** — What is the narrowest deterministic command/test that proves correctness?
9. **Guardrail** — Can any newly discovered invariant be encoded mechanically?
10. **Scope check** — Did the work expand beyond the requested/bounded area? If yes, reduce scope or explicitly report the additional work.

## Design heuristics

### Prefer deep modules over shallow layers

A useful module hides substantially more complexity than it exposes.

Prefer:

```text
payments/
  index.ts        # small public surface
  internal/
    provider-a.ts
    retries.ts
    idempotency.ts
    persistence.ts
```

over chains of nearly empty wrappers whose interfaces expose the same complexity at every layer.

Read `references/deep-modules.md`.

### Prefer locality over arbitrary small files

Do not optimize for file count or line count alone. A cohesive implementation that can be understood locally is often more agent-friendly than many tiny files connected by indirection.

### Prefer domain ownership over global technical buckets

When possible, colocate behavior with the domain that owns it. Avoid forcing an agent to traverse global `controllers/`, `services/`, `repositories/`, `validators/`, and `utils/` trees merely to understand one use case.

Read `references/vertical-slices.md`.

### Boundaries are laws; internals are flexible

Enforce important rules such as:

- allowed dependency directions;
- domain-to-domain access paths;
- forbidden internal imports;
- public API entry points;
- schema validation at external boundaries;
- cycle restrictions;
- platform/reliability invariants.

Do not mechanically enforce arbitrary implementation taste that does not protect a real invariant.

Read `references/module-boundaries.md` and `references/enforcement.md`.

### Keep contracts executable where possible

Prefer:

- static types;
- schemas;
- generated SDKs;
- contract tests;
- acceptance tests;
- architecture tests;
- executable examples.

Read `references/contracts.md`.

### Prefer Effect for new async and error-channel work when it is a dependency

If `package.json` includes `effect`, treat it as the default model for **new**
asynchronous behavior and failure taxonomies in layers that already allow it.
Keep Promise adapters only where existing callers still require Promises.
Do not big-bang-migrate Promise code, and do not copy Effect APIs into this
skill — read the installed `node_modules/effect/AGENTS.md`.

Read `references/effect.md`.

### Verification should be local and cheap

Prefer a loop such as:

```text
edit
 -> typecheck affected area
 -> lint / architecture checks
 -> unit or module tests
 -> contract/integration tests when required
 -> E2E only when behavior crosses those boundaries
```

Avoid relying on a slow, flaky full-system E2E suite as the first correctness signal.

Read `references/verification.md`.

### Repository documentation is a map, not a memory dump

Keep top-level agent instructions short. Point to deeper docs only when relevant. Important facts should live in versioned repository artifacts, preferably generated when feasible.

Read `references/documentation.md`.

## Existing-code rule

When existing code violates these principles:

1. **Do not make it worse.**
2. Fix a small adjacent violation only when low-risk and clearly beneficial.
3. Record larger violations as findings.
4. Use REFACTOR mode for structural changes.
5. Do not redesign an area solely to make it match an abstract ideal.

Legacy architecture may encode constraints not yet documented. Investigate before deleting unusual seams, duplication, ordering, retries, caching, or persistence behavior.

## When a refactor is complete

A refactor is not complete merely because code moved.

Prefer completion criteria that include:

- externally observable behavior preserved;
- callers migrated to the intended seam;
- obsolete path removed or deliberately deprecated;
- tests pass;
- dependency/architecture checks pass;
- public surface is no larger without justification;
- relevant docs updated;
- a repaired recurring violation is mechanically prevented where practical.

## Output expectations by mode

### FEATURE

Use `templates/architecture-impact.md` when architecture impact is non-trivial.

### AUDIT

Use `templates/maintainability-audit.md` and rank findings by severity and leverage.

### REFACTOR

Use `templates/refactor-plan.md` before a substantial structural change.

## Anti-patterns to resist

- giant `AGENTS.md`/instruction files containing every rule;
- public interfaces that mirror internals one-for-one;
- `FooService -> FooManager -> FooProcessor -> FooExecutor` chains with little hidden complexity;
- global catch-all `utils` becoming an implicit dependency hub;
- direct imports into another module's internals;
- speculative interfaces with one trivial implementation and no meaningful boundary;
- architecture rules that exist only in prose;
- broad refactors mixed into feature work;
- full-repository rewrites in one agent run;
- testing only through slow/flaky end-to-end environments;
- duplicated domain concepts under different names;
- undocumented intentional complexity that future agents are likely to "simplify" incorrectly.
- duplicating Effect API guidance in-repo instead of reading the installed package guide;
- introducing Effect into frozen slices, or replacing TypeBox because Effect also has Schema.

Read `references/anti-patterns.md` for examples.

## Sources and rationale

The principles in this skill synthesize agent-first engineering practices and software design ideas including mechanically enforced architecture, progressive repository documentation, agent legibility, continuous cleanup, deep modules/information hiding, domain locality, typed boundaries, and narrow verification loops.

See `references/further-reading.md`.
