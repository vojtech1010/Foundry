# REVIEW Workflow

Use when judging whether a current change meets this skill's maintainability
and Effect standard. Read-only. The skill is the reference; the diff is the
scope.

## Objective

Verify the touched slice against this skill's MUST/SHOULD rules and
`references/effect.md`. Do not map the whole repository, do not assign 1–5
dimension scores, and do not produce a refactor backlog.

## Procedure

1. **Bound the slice** to the current-commit Git diff and the public seams it
   touches. Out-of-scope pre-existing issues are notes, not findings.
2. **Read the standard**, not the audit procedure: this `SKILL.md` core rules,
   then `references/effect.md`. When Effect is in the diff, also read
   `node_modules/effect/AGENTS.md`.
3. **Check the touched code** against that standard:
   - locality and public-seam depth;
   - dependency direction and internal-import leaks;
   - explicit contracts at untrusted boundaries;
   - Effect usage in allowed layers (`Effect.fn`, tagged errors, Schema,
     `TestClock`);
   - tests at the public seam;
   - `docs/features/` update when behavior changed;
   - a mechanical guardrail when a new invariant was introduced.
4. **File findings** with severity and evidence. Use the caller's severity
   legend when one is supplied; otherwise HIGH/MEDIUM/LOW from
   `references/scoring.md` without numeric dimension scores.
5. **Stop.** Do not expand into AUDIT (repo map, scoring, remediation
   candidates). Do not edit code.

## Nitpicks

Taste and debatable alternatives are low severity, or notes. They are not
medium or high.
