# 056 — Run role sessions as Herdr agents

## Requirement

The bundled role host starts every Architect, Coder, Lead Coder, Tester, and
Reviewer session as a recognized agent in a Foundry-owned Herdr pane. Herdr is
the terminal transport and operator view; Foundry's recorded session identity,
ownership, result, and recovery state remain authoritative.

## Observable outcome

- `doctor` fails before work starts when the active Herdr session, supported
  Herdr version, selected harness, model, or required permission containment is
  unavailable.
- Each role attempt, including each parallel Coder, gets a distinct
  Foundry-owned pane and unique live agent name without taking UI focus.
- A resumed run reconnects to the recorded live agent or reports the session
  lost; it never creates a replacement pane or repeats an ambiguously submitted
  prompt merely because a pane cannot be found.
- Herdr `working`, `blocked`, and `unknown` states never imply success.
  `idle` or `done` settles a turn only after the bundled host has validated and
  durably retained its bounded Markdown narrative and control envelope.
- Pane IDs are retained as mutable execution metadata, not used as Foundry's
  durable session identity. Moving a pane therefore does not create a new role
  session.
- Abandonment, terminal cleanup, and retention cleanup stop only panes whose
  ownership matches the recorded role session and record uncertain or failed
  disposal instead of closing unrelated user panes.
- Herdr does not by itself count as filesystem or network enforcement. The
  bundled host advertises a role capability profile only when the selected
  harness containment actually enforces it.

## Not in this task

General-purpose Herdr workspace management, using terminal text as workflow
decision evidence, weakening role permissions, manual or shadow execution
modes, or treating a replacement pane as recovery of an owned session.

## Depends on

[035](035-resume-without-repeating-work.md),
[037](037-cleanup-keeps-the-result.md),
[040](040-parallel-independent-work.md),
[053](053-per-role-harness-models.md),
[054](054-bundled-role-host.md)

## Spec

- [Role-host protocol](../features/protocol-contracts.md#role-host-protocol)
- [Role recovery](../features/recovery.md#role-recovery)
- [Role boundaries](../features/quality-and-decisions.md#role-boundaries)
- [Validate before work](../features/project-setup.md#validate-before-work)

## Size guess

~12 files / ~500 lines; split harness containment or real-Herdr compatibility
certification into a follow-up if either cannot stay within this bound.
