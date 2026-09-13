# Quality gates and decisions

Foundry advances ordinary work without human stage approvals. Confidence comes
from independent, commit-bound gates rather than repeated operator confirmation.

## Gates

| Gate                       | Examines                                                           | Pass                                             | Failure route                                  |
| -------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------- |
| Plan validation            | Architect plan, criteria, exclusions, execution mode, runtime need | Durable accepted plan                            | Bounded Architect retry, then block            |
| Deterministic verification | Recorded implementation commit and project commands                | Commit-bound report                              | Bounded Coder correction, then review or block |
| Tester validation          | Prepared runtime at the recorded commit                            | Accepted read-only observations tied to criteria | Retry environment/Tester or route finding      |
| Reviewer validation        | Plan, Git diff, checks, observations, findings, corrections        | `approved`                                       | Correction, decision escalation, or block      |

Deterministic verification normally runs format checking, linting, typechecking,
tests, and build in configured order. A cached report is reusable only for the
same verified commit and command profile.

## Verification evidence

A verification report identifies its attempt, accepted commit, command-profile
hash, overall result, and ordered command executions. Each execution records
its executable/arguments, expected and actual exit codes, timeout outcome,
duration, and bounded log reference with hash, size, truncation, and redaction
metadata. The commit/profile binding belongs to the report; command labels alone
do not establish coverage.

Tester and Reviewer may consume this Foundry-owned report without rerunning
identical commands. Distinguish those executions from Coder's local checks and
Reviewer spot checks. A check mentioned only in role prose is not automatically
part of the durable deterministic gate. In monorepos, verify which workspaces,
TypeScript projects, and test roots the configured commands actually cover.

A plan-authorized Tester skip does not skip deterministic verification or
Reviewer. Record it as not required, not as a passed runtime test.

## Tester boundary

Tester supplies independent observations only. Its machine outcome is
`observed`, `retry_required`, or `blocked`, not passed or failed; Reviewer
evaluates whether the observations, deterministic checks, and other evidence
satisfy each criterion.

- Tester cannot create, modify, or delete application data.
- Plans cannot declare `testerScenarioAuthority` or equivalent mutation grants.
- Visual captures are optional evidence, not required named variants.
- Foundry does not reject an otherwise adequate result merely because a
  screenshot matrix is absent.
- Runtime lifecycle, readiness, and cleanup remain Foundry-owned.

When safe runtime validation requires mutation, prefer project-owned isolated
automated tests. If that is unavailable, record the limitation instead of
expanding Tester permissions.

## Control repair versus retest

A settled role can produce schema-invalid or internally inconsistent output even
when useful work was done. Keep these routes separate:

- **Control repair:** a bounded continuation of the same attempt/session that
  corrects only its narrow control envelope against the unchanged narrative and
  existing evidence; see
  [recovery](recovery.md#role-recovery).
- **Retest or role retry:** another recorded attempt when output remains
  unacceptable or observations must be repeated within the role budget.
- **Implementation correction:** Coder changes the implementation and creates a
  new commit, invalidating downstream evidence.

A settled Tester result cannot claim workflow approval. Schema repair does not
waive semantic validation; a repair or retest must not relabel missing or failed
evidence. Preserve validation errors and rejected attempts even if a later
attempt succeeds.
Environment failures use operational retry/recovery, while implementation
failures become findings for Coder.

Tester `retry_required` and Reviewer `retest_requested` repeat Tester against
the same prepared commit without involving Coder. When no Tester retry remains,
the limitation returns to Reviewer, which must choose correction, a genuine
human decision, or block; it cannot approve missing required evidence.

## Findings and automatic correction

Finding records are Foundry-owned. A `changes_requested` turn creates one
blocking correction brief with an assigned ID, category `review`, owner `coder`,
the full Reviewer Markdown as its required outcome, and automatic references to
the current commit and evidence set. Coder must close every medium-or-higher
finding in that Markdown. A low-severity finding is fixed only when Coder
agrees it should be; disagreement is recorded and does not fail the
correction. Reviewer may organize multiple issues freely inside that
narrative instead of populating one schema object per issue.
Failed deterministic commands get separate Foundry-generated findings.
Environment and workflow failures use retry/recovery rather than being
misclassified as product decisions.

Keep informational observations distinct from blocking findings. Unrelated,
pre-existing UX issues or non-blocking command warnings may be retained as notes
or limitations without forcing a correction. That distinction must be justified
against the accepted scope: an unmet required criterion cannot be hidden as a
non-blocking note. Reviewer explains criterion coverage and observations in its
free-form narrative; Foundry links that narrative to every accepted criterion
in the handoff without attempting to parse prose into synthetic evidence.

Every correction creates a new commit. Checks and runtime observations from an
older commit cannot approve the corrected result. Reviewer sees the complete
correction history but evaluates only current evidence.

## Reviewer outcomes

| Outcome                   | Meaning                                                            | Next action                                                          |
| ------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `approved`                | Current implementation and required evidence satisfy the plan      | Complete locally without human approval                              |
| `changes_requested`       | Coder can address evidence-backed findings                         | Route a bounded correction automatically                             |
| `retest_requested`        | Current commit needs another independent observation               | Retry Tester against the same commit when budget remains             |
| `human_decision_required` | A reviewable result needs a product/risk choice beyond the request | Push exact commit and create/reuse a draft GitHub PR                 |
| `blocked`                 | Reviewer cannot safely review or formulate a decision              | Preserve evidence and enter recovery; do not create a speculative PR |

Foundry routes every outcome above automatically; no separate `approve`,
`reject`, `code`, `test`, or `review` command exists. A `changes_requested`
outcome is accepted only while a correction round remains; `retest_requested`
returns to Tester only while a same-commit retry remains; and
`human_decision_required` enters `publishing` only for an eligible, reviewable
changed commit, otherwise it blocks for recovery.

Reviewer cannot approve failed deterministic checks or missing/blocked evidence
from a required Tester stage. It also cannot turn an operational failure into a
human product choice merely to escape retry limits.

## Decision escalation contract

A `human_decision_required` result must include:

1. the precise question a person must answer;
2. the available options and consequences;
3. the Reviewer recommendation, if any;
4. open findings and limitations;
5. the exact source and result commits;
6. current check and runtime evidence; and
7. why another automatic correction cannot settle the issue.

Foundry then creates or reuses one draft PR for the exact task-head/source-base
pair. The PR is a decision workspace, not evidence that a person has decided.
Foundry applies only the authenticated option command defined in
[results and publication](results-and-publication.md#applying-a-human-decision).
Ordinary comments, approvals, closure, or merge never resolve the decision.

The Reviewer narrative remains free-form. Only its outcome is always structured;
a human-decision outcome also carries the exact question and options needed for
publication. Findings and reasoning stay in Markdown and are passed intact to
Coder or the draft PR rather than being forced into a large nested schema.

## Completion rule

Ordinary Reviewer approval is sufficient for Foundry to complete the run. No
manual `approve` or `reject` CLI command exists. A decision-escalated run remains
nonterminal until an authenticated PR option accepts, corrects, or abandons it.
