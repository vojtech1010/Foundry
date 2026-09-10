# Successful-run evidence for the rewrite

This appendix records the retained `project-c` history used to enrich Foundry's
feature specifications. It is reverse-engineering evidence, not another runtime
contract or a compatibility requirement. Artifact filenames, schema fields,
event names, and legacy state names below describe the source orchestrator;
Foundry may use different representations while preserving the specified
behavior and its accepted ADRs.

## Selection and coverage

Requested scope: the last ten successful runs in `G:/Git/project-c`.

The inspected `.agent/runs` contains 34 immediate run directories: 32 have a
`run-state.json`, and two have no durable state. Only **seven** have a successful
terminal `workflowState` (`completed`; none is `completed_no_change`). The other
25 state-bearing runs are failed, blocked, or nonterminal. All seven selected
runs also have a passed `verification-report.json` and an approved Reviewer
result. Output-file presence alone was not used to infer success.

Order below is durable `createdAt` descending, not the date embedded in the run
ID or a file's modification time. Ordering by terminal `updatedAt` yields the
same seven in the same order. The shortfall of three is explicit: failed or
incomplete runs were not substituted. Four successes are harness-only probes;
only three are application changes.

| Ref | Run ID                                           | Created at (UTC)        | Kind                          | Result commit (short) |
| --- | ------------------------------------------------ | ----------------------- | ----------------------------- | --------------------- |
| P4  | `RUN-PARALLEL-PROBE-20260903-R1`                 | 2026-09-03 17:29:55.046 | Parallel harness probe        | `77106fc`             |
| P3  | `RUN-PARALLEL-PROBE-20260902-R2`                 | 2026-09-01 22:18:14.967 | Parallel harness probe        | `53afedc`             |
| P2  | `RUN-PARALLEL-PROBE-20260901-R8`                 | 2026-09-01 19:56:50.978 | Parallel harness probe        | `4d520bd`             |
| P1  | `RUN-PARALLEL-PROBE-20260830-R5`                 | 2026-08-30 19:03:00.120 | Legacy parallel harness probe | `303888d`             |
| G   | `RUN-GUEST-DATA-MIGRATE-ON-LOGIN-20260827-2031`  | 2026-08-27 18:33:45.762 | Guest migration               | `31509b0`             |
| C   | `RUN-CALENDAR-TODAY-OUTLINE-GREEN-20260827-0001` | 2026-08-26 22:08:43.556 | Calendar outline              | `93df642`             |
| H   | `RUN-HEATMAP-TODAY-GREEN-20260826`               | 2026-08-26 10:33:16.741 | Heatmap outline               | `7b9af93`             |

Every artifact reference below is relative to
`G:/Git/project-c/.agent/runs/<Run ID>/`. Full commit identities remain in each
run's durable state and verification report. Source artifacts were read only;
they are not copied into Foundry or required for its tests.

## Behavior incorporated into the specs

### Plan routing and verification

**H, C, G:** `plan.md` has a `PLAN_ANNEX` with
`runtimeValidationRequired: true`, a rationale, affected path prefixes, and
acceptance-criterion IDs. `run-log.jsonl` records verification before runtime
preparation and Tester. **P2–P4:** `run-state.json.attempts.tester` is zero and
`run-log.jsonl` records `testing -> reviewing` with
`details.reason: "tester-not-required"` (sequence 74). No Tester artifact is
needed for this skip. Their `tester-001-*` terminal filenames identify
orchestrator verification captures, not an actual Tester attempt.

All seven `verification-report.json` files bind ordered command executions to
`acceptedCommit` and `projectCommandProfileHash`. Command records include
`argv`, exit codes, timeout outcome, duration, log hash/size, truncation, and
redaction counts. C and H Tester reports consume those checks without rerunning
them. P1–P4 map both `formatCheck` and `lint` to `npm run check:monorepo`; their
configured typecheck covers the app project. Thus labels alone do not prove
formatting, lint, or every workspace's test/typecheck coverage.

In **P1**, `run-log.jsonl` sequence 98 records `artifact_invalidated` with
reason `accepted-head-advanced`, followed by verification attempt 2 against
`303888d`, replacing verification of `f816552`. This supports evidence
invalidation whenever the accepted head changes; the legacy Quality Engineer
that caused this particular change is not carried over.

Applied to [running work](running-work.md#plan-controlled-validation),
[project setup](project-setup.md#project-commands-and-runtime), and
[quality gates](quality-and-decisions.md#verification-evidence).

### Artifact repair and semantic retesting

**C:** `run-log.jsonl` sequences 18–22 record Coder attempt 1 repairing an
unknown `verification` property; sequences 42–46 record Tester attempt 1
repairing an unknown `identity` property. The `attempt_prepared` repair events
retain the artifact path, validation errors, `preRepairHash`, prompt hash, and
`promptKind: "artifact_repair"`. Repair prompts under `prompts/` restrict changes
to the artifact, not code, tests, or Git state.

**G:** sequences 37–41 record Tester artifact repair, but sequence 42 still
reports `passed Tester result contains a non-passed acceptance criterion`.
Sequence 45 prepares Tester attempt 2 with `promptKind: "retest"`; sequences
51–55 record another artifact repair before acceptance. The distinction between
schema repair, semantic validation, and another attempt is observable even in a
terminally successful run. It is not permission to rewrite failures as passes.

Applied to [role recovery](recovery.md#role-recovery) and
[repair versus retest](quality-and-decisions.md#validation-repair-versus-retest).

### Runtime identity, criterion evidence, and observations

**H, C, G:** accepted Tester artifacts under `attempts/tester/` retain
`runtimeEvidence.environmentIdentity`, including the commit, repository,
application, runtime kind, start/stop times, data-preservation flag, and
lifecycle operations. H explicitly reports preserved guest data and no test-data
mutation. These records motivate prepared-runtime identity and lifecycle
reporting, not broader Tester permissions.

**G:** `attempts/tester/002/evidence-manifest.json` gives the same hash and size
for captures labeled authenticated settings and no-duplicate relogin overview.
`attempts/reviewer/001/reviewer-result.json`, in `summary` and
`validationCompleteness.assessment`, explicitly discounts the mislabeled
capture and uses independent overview and deterministic idempotency evidence
allowed by the plan. A filename is not proof of content.

The product runs retain pre-existing copy/UX observations in Tester and Reviewer
notes while their findings arrays remain empty. Informational limitations are
not automatically acceptance failures, but required criteria still need proof.

Applied to [runtime setup](project-setup.md#project-commands-and-runtime),
[findings](quality-and-decisions.md#findings-and-automatic-correction), and
[evidence integrity](inspection-and-reporting.md#evidence-integrity-and-completeness).

### Parallel ownership and aggregate provenance

**P2–P4:** `workers/*/worker-state.json` records four objective workers and a
separate Lead Coder, source commit, isolated branch/worktree, runtime ownership
and working directory, result commit, and eventual `lifecycle: "disposed"`.
`run-state.json.concurrency` is four. `run-log.jsonl` records the objective
completion barrier before Lead Coder starts; in P2 the final objective settles
at sequence 42 and integration preparation begins at sequence 43.

`integration-journal.json` records accepted worker commits, evidence hashes,
scopes/diff fingerprints, declared order, and aggregate result. The accepted
head/commit ledger and `verification-report.json.acceptedCommit` identify the
single result. P3/P4 top-level `attempts/coder/001/coder-result.json` has null
`commit` and `resultingCommit` fields; the authoritative aggregate is still
recorded in the integration journal and durable state.

In **P2**, `integration-journal.json.order` lists OBJ-001 through OBJ-004, but
`terminal-logs/WORKER-LEAD-CODER-C68DEDA842F7B31D.txt` records merges in the order
OBJ-002, OBJ-004, OBJ-001, OBJ-003 and ancestry checks for all four. Do not treat
a declared order as proof of actual Git operation order or generalize this
observation into permission for nondeterministic integration policy. Foundry's
enriched contract therefore requires durable actual-order evidence and an
explicit explanation for deviations, rather than leaving the discrepancy only
in a terminal capture.

Applied to [parallel provenance](parallel-objectives.md#worker-lifecycle-and-integration-provenance)
and [results](results-and-publication.md#normal-result).

### Reporting, telemetry, and cleanup limitations

**P1:** `handoff.json.checks` is empty. **P2:** handoff checks, criteria, and
evidence are empty despite populated verification, integration, and Reviewer
records. **P3/P4** retain populated handoff checks and criteria. Sparse legacy
handoffs motivate completeness diagnostics and links to underlying evidence;
they are not Foundry's intended reporting contract.

**P1–P4:** `stats.json.availability` marks usage/tools/MCP/context unavailable;
zero token counters coexist with nonzero `totals.tokensUnknownAttempts`, null
`costUsdEstimated`, and `costIncomplete: true`. P3/P4 also have empty
verification/publication statistics despite dedicated successful reports and
journals. Worker logs contain local failed test/check commands followed by
same-session fixes while workflow retry/repair/correction counters remain zero.
These are different accounting scopes, not proof that no local failure occurred.

**H/G:** `provisioning-journal.json.roles.architect.cleanup` is failed and
`run-state.json.runOwnedHarnessesUncertain` is true despite `completed`.
**C:** provisioning cleanup remains pending. **H/C:** publication journals
retain worktree-removal `Directory not empty` warnings. In contrast, **P1–P4**
provisioning journals are closed and run state reports no owned harnesses or
ownership uncertainty; P2–P4 worker records show disposal. None of those fields
alone proves task-branch deletion.

Applied to [inspection](inspection-and-reporting.md),
[cleanup recovery](recovery.md#abandonment-and-cleanup), and
[provisioning identity](project-setup.md#provisioning-identity).

## Deliberate exclusions and limits of the evidence

- **Approved-result PRs:** all seven legacy runs published after approval.
  Their `publish-transaction.json` and state/events describe the old policy,
  not Foundry's [decision-only publication](results-and-publication.md) or
  [ADR-0008](../adr/0008-reviewer-completion-and-pr.md). Ordinary Foundry
  approval remains local. No selected run demonstrates a genuine Reviewer
  `human_decision_required` escalation.
- **Quality Engineer:** P1 has a legacy Quality Engineer worker and an extra
  accepted commit. P2–P4 do not establish that role merely because a plan or
  review note mentions it. Foundry does not acquire a new role from this history.
- **Tester mutation:** G describes creating application data during testing.
  That historical behavior conflicts with [ADR-0006](../adr/0006-role-capabilities.md)
  and is excluded. Data-mutating scenarios belong in project-owned isolated
  automated tests; Tester retains no mutation grant.
- **Visual variants:** H/C captures illustrate useful optional criterion
  evidence, not a mandatory screenshot matrix or attestation system.
- **No-change, corrections, and crash recovery:** these seven runs do not
  demonstrate `completed_no_change`, a Foundry-style Coder correction loop, or
  successful interrupted-role reattachment. Same-session artifact repairs and
  local worker fixes are not evidence for those different paths.
- **Probes and safety:** tiny disjoint-constant probes do not prove general
  feature runtime behavior. Local commands seen in worker logs, including
  ad hoc Git-lock handling, are observations rather than approved recovery
  procedures. No manual/shadow/adoption modes, legacy schema compatibility,
  free-form human decisions, or Git safety exceptions are imported.
