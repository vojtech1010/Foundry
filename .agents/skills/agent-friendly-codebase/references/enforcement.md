# Mechanical Enforcement Patterns

Use the repository's ecosystem. Do not introduce a heavy architecture framework solely to satisfy this skill.

## TypeScript / JavaScript

Possible mechanisms:

- ESLint import restrictions;
- Nx module-boundary rules;
- dependency-cruiser;
- package `exports` to hide internals;
- TypeScript project references/package boundaries;
- Zod/Valibot/JSON Schema or generated API contracts where appropriate;
- Effect `Schema.TaggedError` and Layer boundaries when `effect` is a
  dependency (`references/effect.md`).

## Java / JVM

Possible mechanisms:

- ArchUnit architecture tests;
- module/package visibility;
- build-module dependency constraints;
- generated schema/client contracts.

## .NET

Possible mechanisms:

- project/reference boundaries;
- architecture tests (for example NetArchTest or equivalent repository tooling);
- analyzers;
- internal/public visibility;
- schema/contract generation.

## Python

Possible mechanisms:

- package/public API conventions backed by import linting;
- import-linter or equivalent;
- type checking;
- Pydantic/schema validation;
- focused package tests.

## General

Prefer mechanisms already present in the repository. Introduce new tooling only when it protects a meaningful invariant and its maintenance cost is justified.

## Promotion ladder

When a rule repeatedly matters, promote it from weaker to stronger representation:

```text
review comment
  -> repository guidance
  -> test/lint/type/schema
  -> generated/enforced boundary
```

Not every rule needs to reach the final stage; use judgment based on recurrence and impact.
