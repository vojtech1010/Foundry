# ADR-0010: Mechanically Enforced Repo Constraints and Navigational Docs

- Status: Accepted
- Date: 2026-09-08
- Relates to: `AGENTS.md`,
  `.agents/skills/agent-friendly-codebase/references/documentation.md`,
  `.agents/skills/agent-friendly-codebase/references/enforcement.md`

## Context

Prose-only architecture rules decay: agents skim long instruction files,
duplicate guidance, and reintroduce violations that reviews catch too
late. At the same time, an oversized `AGENTS.md` becomes unnavigable.

## Decision

Constraints that matter are enforced by tools; documentation stays
concise and navigational:

- Mechanical gates, all part of `npm run verify`: Prettier owns
  formatting, ESLint enforces typed code and dependency directions,
  oxlint runs the vendored generic and Effect anti-slop plugins,
  `tsc` typechecks, `effect-language-service` diagnostics check Effect
  usage, Vitest (plus architecture tests) proves behavior and
  boundaries, and the build proves shippability.
- `AGENTS.md` stays short: purpose, product boundaries, toolchain,
  repository map, commands, change discipline. It points outward; it
  does not duplicate Effect APIs, test tactics, or feature behavior.
- `docs/features/` is the normative behavior reference;
  `docs/adr/` records why. Behavior changes update the owning feature
  page plus code and tests in the same change.
- Prefer generated or executable facts (schemas, contract tests,
  architecture tests, diagnostic bundles) over manually duplicated
  documentation. Document the map, not the territory.
- Recurring mistakes become permanent guardrails (lint rule, schema
  rejection, architecture test) instead of repeated prompt instructions.

## Consequences

- Agents get fast, objective feedback; reviewers check enforcement
  rather than re-reading prose.
- Adding a genuinely new invariant requires adding its enforcement, not
  just a paragraph.
- Vendored tooling (`tools/oxlint/anti-slop/`) is not hand-edited
  casually; changes there get their own review and tests.

## Rejected alternatives

- Long prose-only rule files: unenforceable and quickly stale.
- Duplicating Effect API guidance in-repo: drifts from the pinned
  version; the installed `node_modules/effect/AGENTS.md` stays
  authoritative.
- Whole-repository rewrites for maintainability: unbounded risk; change
  stays adjacent and verifiable per the skill's feature and refactor
  workflows.

## Enforcement / verification

- `npm run verify` gates handoff; CI runs the same sequence.
- Architecture tests cover dependency directions and facade/internal
  boundaries, including rejection of deep imports into another slice's
  internals.
- Review checklist: behavior change without a `docs/features/` update,
  or a new invariant without a mechanical guardrail, is incomplete.
