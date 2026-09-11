# AGENTS.md

## Purpose

Foundry is an autonomous TypeScript orchestrator for an Architect → Coder →
Tester → Reviewer workflow. Preserve determinism, durable recovery, minimal
human interruption, strict validation, and Git safety over convenience.

## Product boundaries

- There is one autonomous operating model. Do not add manual, pilot, shadow, or
  adoption modes.
- Architect, Tester, and Reviewer are read-only. Only Coder may modify production
  target-project files.
- Tester has no authority to create, modify, or delete application data, and no
  mandatory visual-variant evidence system.
- Reviewer approval completes locally. A draft GitHub PR is created only when
  Reviewer returns a genuine `human_decision_required` outcome.
- Foundry never force-pushes, merges, deploys, rewrites history, or infers a
  human decision from free-form GitHub activity.

## Toolchain

- Node.js 24 and npm 11 (`.nvmrc`, `.node-version`, `package.json`).
- TypeScript ESM with `NodeNext`; relative source imports use `.js` suffixes.
- Effect is the default for asynchronous and failure-classified production code.
- Vitest 4.1.11 and `@effect/vitest` provide deterministic tests.
- ESLint enforces typed code and initial dependency directions.
- Oxlint runs the vendored generic and Effect anti-slop plugins.
- Prettier owns formatting.

## Effect guidance

Before writing Effect code, read
`.agents/skills/agent-friendly-codebase/references/effect.md`, then read
`node_modules/effect/AGENTS.md` completely. The installed guide is authoritative
for the pinned Effect version. Prefer `Effect.fn`, `Schema.TaggedError`, services,
Layers, and `TestClock`; do not invent Promise/throw alternatives beside an
Effect error channel.

## Repository map

- `src/domain/`: dependency-light workflow vocabulary and invariants.
- `src/application/`: autonomous use cases and state transitions; may depend on
  domain, never CLI.
- `src/cli/`: Effect composition root and presentation.
- `tests/`: behavior and architecture regression tests.
- `docs/features/`: intended product behavior.
- `tools/oxlint/anti-slop/`: vendored lint plugin; do not hand-edit casually.
- `.agents/skills/agent-friendly-codebase/`: maintainability workflow and
  references for agents.
- `.codex/agents/`: role-specific project guidance for Architect, Coder,
  Tester, and Reviewer. Reviewer uses the skill in AUDIT mode and treats
  medium-or-higher findings as a return to Coder.

Add deeper modules only when their ownership is clear. Keep public seams narrow
and keep infrastructure details behind application-owned contracts.

## Commands

```powershell
npm run format:check
npm run lint
npm run lint:anti-slop
npm run typecheck
npm run effect:diagnostics
npm test
npm run build
npm run verify
```

Run focused checks while iterating and `npm run verify` before handoff. Do not
run broad formatting across a dirty worktree; format only touched files.

## Change discipline

- Inspect `git status` first and preserve unrelated changes.
- Use the `agent-friendly-codebase` skill for features, audits, and refactors.
- Keep domain independent from application and CLI; keep application independent
  from CLI.
- Define untrusted inputs with explicit Effect Schema contracts at boundaries.
- Keep state transitions explicit and typed; never infer completion from file
  presence.
- Add deterministic tests for every behavior or contract change.
- Prefer mechanically enforced architecture over prose-only rules.
- Update `docs/features/` when supported behavior changes.
- Use two spaces, single quotes, trailing commas, and type-only imports.
