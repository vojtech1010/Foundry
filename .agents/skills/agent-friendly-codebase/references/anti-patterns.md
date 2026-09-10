# Anti-Patterns

## 1. The abstraction ladder

```text
Controller -> Service -> Manager -> Processor -> Executor -> Repository
```

If most layers only forward calls, they increase context without hiding complexity.

## 2. Global technical buckets

```text
controllers/
services/
repositories/
validators/
utils/
```

This can scatter a single feature across the repository. It is not always wrong, but audit whether it harms locality.

## 3. Public-by-default internals

Exporting every helper invites future agents to couple directly to implementation details.

## 4. Giant agent manual

Thousands of lines of always-loaded instructions consume context, decay quickly, and make priority unclear. Prefer a short map plus targeted references.

## 5. Unenforced architecture prose

"Never import X from Y" is likely to regress when the import remains technically possible. Enforce important invariants.

## 6. Big-bang cleanup

A repository-wide rewrite is difficult to verify and easy for an agent to overgeneralize. Create bounded migrations.

## 7. Utility gravity

A shared `utils` package gradually becomes a dependency hub for unrelated domain concepts. Keep domain concepts domain-owned.

## 8. Agent-generated synonym drift

Multiple agents create different names for the same domain idea, splitting invariants and making search harder. Maintain a domain glossary for important vocabulary.

## 9. E2E-only confidence

If every change requires a complex environment and long browser flow, agents get slow and ambiguous feedback. Add lower-level stable verification at module seams.

## 10. Refactor hidden inside feature work

"Add one field" should not silently become a rewrite of an entire subsystem. Separate feature scope from structural migration.

## 11. Copied Effect manuals

Do not paste `node_modules/effect/AGENTS.md` into skills or `AGENTS.md`. Point
at the installed file. Do not replace TypeBox with Effect Schema because both
are called schemas. Do not leak Effect into frozen slices (artifacts,
runtime/Herdr) or double every method as Effect and Promise.

See `references/effect.md`.
