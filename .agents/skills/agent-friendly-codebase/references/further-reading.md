# Further Reading

These sources informed the skill's rationale. They are references, not mandatory implementation prescriptions.

## OpenAI — Harness engineering: leveraging Codex in an agent-first world

https://openai.com/index/harness-engineering/

Relevant themes:

- repository knowledge as system of record;
- progressive disclosure instead of a giant AGENTS.md;
- agent legibility;
- mechanically enforced architecture;
- boundary validation and typed contracts;
- feedback loops and self-verification;
- recurring cleanup / architectural "garbage collection";
- converting repeated feedback into repository tooling.

## Matt Pocock — Codebase Design / Deep Modules

https://skillsdocs.com/mattpocock/skills/codebase-design

Relevant themes:

- deep modules;
- small interfaces over substantial implementation;
- locality;
- testing at useful seams;
- avoiding unnecessary/shallow abstractions.

## Nx — Enforce Module Boundaries

https://nx.dev/docs/features/enforce-module-boundaries

Example of mechanically constraining project/module dependencies in JS/TS monorepos.

## John Ousterhout — A Philosophy of Software Design

Background for the deep-vs-shallow module concept and information hiding.

## Architecture fitness functions / architecture tests

Use ecosystem-appropriate tools (for example ArchUnit on the JVM or import/dependency rules in JS/TS) to turn important dependency constraints into executable checks.

## Effect (when the repository depends on it)

Installed package guide: `node_modules/effect/AGENTS.md`. Repo adoption:
`references/effect.md`. Do not treat web copies of Effect docs as
authoritative over the installed version.
