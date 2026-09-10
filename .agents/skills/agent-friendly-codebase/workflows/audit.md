# AUDIT Workflow

Use for maintainability/architecture assessment without modifying code.

## Objective

Find the few structural problems that most increase future agent context, ambiguity, blast radius, or verification cost.

## Procedure

1. **Map the repository**

   - top-level packages/domains;
   - build/test units;
   - public entry points;
   - dependency directions;
   - major external boundaries;
   - architecture/docs locations.

2. **Sample real change paths**
   Pick representative behaviors and trace how many modules/files/layers an agent must understand to change them safely.

3. **Inspect public surfaces**
   Look for:

   - excessive exports;
   - callers importing internals;
   - leaky infrastructure details;
   - unstable low-level types crossing domains.

4. **Inspect dependency topology**
   Look for:

   - cycles;
   - reverse dependencies;
   - cross-domain shortcuts;
   - global utility hubs;
   - shared packages that contain domain behavior;
   - dependency rules existing only in prose.

5. **Inspect module depth and indirection**
   Look for:

   - shallow pass-through abstractions;
   - wrapper chains;
   - many interfaces that do not hide complexity;
   - giant modules with no meaningful seam;
   - implementation details exposed to callers.

6. **Inspect domain locality**
   Measure whether one behavior is spread across global layer folders or is reasonably colocated around an owning domain/use case.

7. **Inspect contracts**
   Look for:

   - guessed JSON/object shapes;
   - unvalidated external inputs;
   - duplicated schemas;
   - stringly typed states/identifiers;
   - incompatible domain vocabulary.
   - dual Promise/throw and Effect error taxonomies for the same failures in
     one slice (see `references/effect.md`). Remaining Promises elsewhere are
     not defects by default.

8. **Inspect verification**
   Look for:

   - lack of module-level tests;
   - only-E2E validation;
   - slow or flaky setup;
   - tests strongly coupled to implementation internals;
   - no deterministic command for a bounded area.

9. **Inspect repository legibility**
   Look for:

   - giant instruction files;
   - stale docs;
   - missing architecture map;
   - key decisions existing only in history/chat;
   - manually duplicated generated facts.

10. **Inspect entropy patterns**
    Search for repeated one-off helpers, duplicate validators, alternate names for the same concept, repeated boundary bypasses, and multiple competing patterns for the same task.

11. **Score and prioritize**
    Use `references/scoring.md`.

12. **Create bounded remediation candidates**
    Each candidate should have:
    - target area;
    - concrete problem;
    - evidence;
    - desired end state;
    - migration steps;
    - behavior safety strategy;
    - verification;
    - guardrail opportunity.

## Audit principle

Do not reward elegance for its own sake. Prioritize changes that reduce:

- agent context required per task;
- number of boundaries crossed;
- ambiguous ownership;
- blast radius;
- probability of architectural drift;
- verification time;
- repeated rediscovery of repository facts.
