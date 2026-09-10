# REFACTOR Workflow

Use when explicitly asked to improve existing structure while preserving behavior.

## Objective

Move one bounded area toward a more agent-maintainable design in safe, reversible, independently verifiable steps.

## Hard constraints

- No whole-codebase rewrite in a single run.
- No behavior changes unless explicitly requested.
- No speculative target architecture detached from repository realities.
- No deletion of unusual behavior without evidence that it is obsolete.
- No moving code merely to make folders look cleaner.

## Procedure

### 1. Define the bounded target

Specify:

- directory/domain/module;
- callers;
- external dependencies;
- public surface;
- behavior that must remain unchanged.

If the target is too broad to verify independently, split it.

### 2. Describe the current state

Capture concrete issues:

- imports and dependency directions;
- public exports;
- duplicated concepts;
- shallow abstraction chains;
- boundary leaks;
- test/verification gaps;
- documentation gaps.

### 3. Define the desired end state

State architecture in observable terms, for example:

```text
- callers enter Payments only through payments/index.ts
- provider-specific code stays under payments/internal/providers
- Billing depends on Payments public operations, not provider SDK types
- refund behavior is covered by module-level tests
- direct imports from payments/internal are mechanically forbidden
```

Avoid vague goals such as "make clean" or "apply DDD".

### 4. Establish behavioral safety

Before structural changes, identify or create tests around stable behavior/public seams.

Prefer characterization tests when behavior exists but is poorly documented.

Do not lock obvious bugs in as intended behavior without noting them; separate behavior correction from structural migration when possible.

### 5. Sequence the migration

Prefer steps such as:

1. introduce/clarify intended public seam;
2. add behavior tests around it;
3. migrate a small set of callers;
4. verify;
5. move/hide implementation details;
6. verify;
7. migrate remaining callers;
8. remove obsolete path;
9. add architecture guardrail;
10. update relevant docs.

When the target is a Promise-to-Effect slice, keep the existing port working
(Promise adapter if callers still need it) until callers migrate. Do not
convert artifacts, runtime/Herdr, or TypeBox in the same unit. Read
`references/effect.md`.

Each step should leave the repository in a coherent state.

### 6. Refactor for depth, not ceremony

When collapsing shallow layers, keep only abstractions that:

- hide meaningful complexity;
- centralize invariants;
- protect an external boundary;
- provide demonstrated substitution/variation;
- materially simplify callers.

### 7. Enforce repaired boundaries

If the refactor removes a repeatable bad pattern, consider:

- import restrictions;
- architecture tests;
- lint rules;
- type restrictions;
- schema validation;
- generated APIs;
- CI checks.

Use error messages that explain remediation when custom checks are added.

### 8. Verify after meaningful steps

Use the narrowest relevant checks first. Expand to broader integration/E2E checks as the changed dependency surface requires.

### 9. Completion review

Confirm:

- observable behavior preserved;
- target end state achieved;
- callers use intended seam;
- obsolete bypass removed/deprecated;
- no unjustified public API growth;
- dependency rules hold;
- tests pass;
- guardrail added when appropriate;
- docs updated where necessary.

## Refactoring backlog rule

If an audit reveals many issues, create independent refactoring units rather than one master rewrite. Prioritize units that unlock future locality or allow important rules to become mechanically enforced.
