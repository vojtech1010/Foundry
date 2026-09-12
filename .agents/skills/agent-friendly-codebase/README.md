# Agent-Friendly Codebase Skill

A single reusable skill for keeping codebases maintainable when coding agents perform a large share of implementation and refactoring.

## Modes

- **FEATURE** — implement behavior without architectural drift or scope creep.
- **AUDIT** — inspect agent-maintainability and produce prioritized bounded remediation.
- **REVIEW** — judge a current diff against this skill as a reference; no scores, no backlog.
- **REFACTOR** — incrementally improve a bounded area while preserving behavior and adding guardrails.

## Installation

Place the `agent-friendly-codebase` directory in the skills location used by your coding agent/tool, preserving `SKILL.md` and its relative `references/`, `workflows/`, and `templates/` directories.

The package intentionally avoids tool-specific commands so it can be used across different agent runtimes and programming stacks.

## Suggested invocations

### New feature

```text
Use the agent-friendly-codebase skill in FEATURE mode.
Implement <feature>.
Keep the change local and do not perform unrelated architectural refactoring.
```

### Audit messy code

```text
Use the agent-friendly-codebase skill in AUDIT mode on <area>.
Do not modify code. Produce a prioritized bounded refactoring backlog.
```

### Review a change

```text
Use the agent-friendly-codebase skill in REVIEW mode on the current-commit diff.
Do not modify code. Do not score the repository. File findings with severity.
```

### Refactor

```text
Use the agent-friendly-codebase skill in REFACTOR mode on <area>.
Preserve externally observable behavior. Define the target architecture first, then migrate in independently verifiable steps and add guardrails where practical.
```

## Design intent

The skill emphasizes:

- deep modules / information hiding;
- domain locality and bounded vertical slices;
- mechanically enforced dependency rules;
- explicit typed/schema contracts;
- fast deterministic verification;
- concise progressive repository documentation;
- architectural decision memory;
- continuous small cleanup instead of large rewrites.

When the host repository depends on `effect`, FEATURE/REFACTOR/AUDIT/REVIEW also
follow `references/effect.md`: prefer Effect services, Layers, and tagged
errors for new async/error-channel work in allowed layers; keep the installed
`node_modules/effect/AGENTS.md` as the API guide.
