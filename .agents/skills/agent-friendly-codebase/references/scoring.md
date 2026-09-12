# Agent-Maintainability Scoring

Use this scoring model in AUDIT mode. Scores are directional, not mathematical truth. Do not use this scoring model in REVIEW mode; REVIEW files findings with severity only.

Score each dimension from 1 (poor) to 5 (strong).

| Dimension             | 1                                          | 3                                           | 5                                                     |
| --------------------- | ------------------------------------------ | ------------------------------------------- | ----------------------------------------------------- |
| Locality              | Typical feature spans many unrelated areas | Some locality, common cross-layer traversal | Most behavior changes stay in one owning module/slice |
| Public-surface depth  | APIs expose internals; many shallow layers | Mixed                                       | Narrow stable APIs hide substantial complexity        |
| Boundary integrity    | Frequent arbitrary imports/cycles          | Conventions exist but leaks occur           | Important directions mechanically enforced            |
| Domain ownership      | Ownership unclear                          | Mostly identifiable                         | Clear domain/module ownership and entry points        |
| Contract explicitness | Guessed/stringly data shapes               | Types exist but boundary gaps remain        | Typed/schema contracts at important boundaries        |
| Verification locality | Only slow/manual/E2E checks                | Some targeted tests                         | Fast deterministic checks per bounded area            |
| Repository legibility | Key knowledge external/stale               | Some useful docs                            | Concise map + discoverable versioned sources of truth |
| Concept consistency   | Duplicate concepts and naming drift        | Occasional duplication                      | Shared vocabulary/invariants are centralized          |
| Change blast radius   | Small changes commonly affect many modules | Moderate                                    | Public seams isolate most implementation changes      |
| Entropy resistance    | Repeated mistakes recur                    | Some lint/tests                             | Recurring mistakes promoted into guardrails           |

## Overall interpretation

- **4.5–5.0:** highly agent-friendly; focus on preserving discipline.
- **3.5–4.4:** solid; target specific weak dimensions.
- **2.5–3.4:** workable but agents will spend significant context rediscovering structure.
- **1.5–2.4:** structural friction likely causes repeated agent mistakes and broad changes.
- **1.0–1.4:** prioritize architecture/verification foundation before increasing agent autonomy.

## Finding severity

### CRITICAL

Likely to cause correctness/security/data-integrity failures or makes safe bounded changes impractical.

### HIGH

Strongly increases blast radius, repeated agent errors, architectural drift, or verification ambiguity.

### MEDIUM

Creates recurring context/maintenance cost but does not immediately threaten correctness.

### LOW

Localized improvement with limited system-wide leverage.

Prioritize high-leverage systemic fixes over large counts of low-severity style findings.
