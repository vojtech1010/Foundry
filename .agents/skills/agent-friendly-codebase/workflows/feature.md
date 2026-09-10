# FEATURE Workflow

Use when delivering new or changed behavior.

## Objective

Implement the requested behavior with the smallest sensible conceptual and architectural footprint.

## Procedure

1. **Read the repository map first**

   - Find top-level agent instructions, architecture docs, module docs, and relevant tests.
   - Do not read the entire repository documentation tree by default.

2. **Identify ownership**

   - Name the owning domain/module.
   - Find the intended public entry point.
   - Identify adjacent dependencies and existing contracts.

3. **Inspect existing behavior**

   - Read the narrowest relevant implementation and tests.
   - Prefer following a healthy existing pattern over introducing a new architecture.
   - Treat suspicious patterns as evidence to investigate, not automatically copy.

4. **Define the minimal design**

   - Keep the change local where possible.
   - Reuse/deepen an existing module seam before adding a new public abstraction.
   - Avoid new cross-domain dependencies.
   - If external data is added, define or reuse a typed/schema contract.
   - If the owning layer allows Effect and the work is async or failure-classified,
     prefer an Effect service + tagged errors over a new Promise/throw taxonomy.
     Read `references/effect.md` and `node_modules/effect/AGENTS.md` first.

5. **Plan verification before coding**

   - Identify the fastest relevant checks.
   - Determine whether acceptance, contract, integration, or E2E verification is actually required.

6. **Implement**

   - Preserve existing boundaries.
   - Keep internals private unless callers genuinely need a new capability.
   - Avoid unrelated cleanup.

7. **Verify**

   - Run affected type/lint/architecture checks.
   - Run the smallest relevant behavior tests.
   - Expand verification only as required by the risk and dependency surface.

8. **Architecture review**

   - Did the public API grow? Why?
   - Did dependency direction change?
   - Did a new implicit contract appear?
   - Did Effect types cross a seam that still needs a Promise adapter?
   - Did the change create duplicated domain logic?
   - Is a new rule worth enforcing mechanically?

9. **Report larger discovered debt separately**
   - Do not quietly turn feature work into a structural rewrite.

## Feature-mode stop conditions

Stop and propose/refocus if implementation requires:

- rewriting unrelated domains;
- replacing a major architecture pattern;
- changing many public contracts not required by the feature;
- large data migration not inherent to the requirement;
- removing behavior whose purpose is not understood.

## Architecture impact summary

For non-trivial work, report:

```text
Owning domain:
Affected module/public seam:
Public API change: yes/no + reason
New dependencies: none/list
Boundary changes: none/list
Behavior safety:
Verification:
Adjacent cleanup performed:
Larger debt discovered:
Guardrail added/proposed:
```
