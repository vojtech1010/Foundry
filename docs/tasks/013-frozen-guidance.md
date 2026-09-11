# 013 — Project guidance is frozen for the run

## Requirement

At run creation Foundry copies the project's tracked guidance as it existed
on the frozen source commit. Later recovery does not reread live files.
Guidance cannot override Foundry's safety rules.

## Observable outcome

- Tracked `AGENTS.md` files and any extra listed guidance files are snapshotted.
- A missing, untracked, escaping, or oversized listed path fails before work.
- Nested guidance still applies to its subtree, using the snapshot, not the
  live tree.
- The snapshot is hashed, size-bounded, and shown to roles at conversation
  start.

## Not in this task

Planning or coding against that guidance.

## Depends on

[012](012-run-owned-workspace.md)

## Spec

- [Project guidance](../features/project-setup.md#project-guidance)

## Size guess

~8 files / ~400 lines
