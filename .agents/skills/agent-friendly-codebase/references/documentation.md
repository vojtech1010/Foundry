# Repository Legibility and Documentation

## Progressive disclosure

Keep the always-loaded instruction surface small. Use it as a map to deeper repository-local sources of truth.

Example:

```text
AGENTS.md / equivalent
ARCHITECTURE.md
docs/
  domain/
  decisions/
  product/
  plans/
  generated/
```

## Good top-level guidance

Top-level agent guidance should answer:

- how the repository is organized;
- where architecture rules live;
- how to run common verification;
- where domain/product docs live;
- how to find deeper instructions.

It should not duplicate every framework or domain detail. If the repository
depends on `effect`, API style lives in `node_modules/effect/AGENTS.md`; repo
adoption policy lives in `references/effect.md` and the relevant ADR.

## Repository as system of record

Important knowledge needed by a future agent should be discoverable from versioned repository artifacts rather than only chat, tickets, or human memory.

## Prefer generated facts

Generate facts such as:

- schema documentation;
- dependency graphs;
- package inventories;
- API references;
- generated clients/types;

when possible, rather than maintaining two manual copies.

## ADRs

Use short architecture decision records for consequential, non-obvious choices.

Suggested structure:

```text
Context
Decision
Alternatives considered
Consequences
```

Do not create ADRs for trivial implementation details.

## Stale documentation

When docs conflict with executable behavior, investigate and update the docs. Stale documentation is often worse for an agent than missing documentation because it creates confident wrong context.
