# Inspection and reporting

Inspection is read-only. Use `status` for current progress, `inspect` for
accepted artifacts and failures, and the handoff or diagnostic bundle for
retained evidence.

```powershell
node dist/cli/index.js status --config .\.agent\foundry.config.json --run-id RUN-EXAMPLE-001
node dist/cli/index.js inspect --config .\.agent\foundry.config.json --run-id RUN-EXAMPLE-001 --json
```

There is no manual stage-control or approval surface. Inspection does not pause
an active run.

## Status

Status reports the run ID, workflow state, active role and attempt, elapsed time,
last event, branch/commit when available, retry/correction counts, and bounded
statistics.

| State                                                                   | Interpretation                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `planning`, `coding`, `verifying`, `testing`, `reviewing`, `correcting` | Automatic work is active or queued                                             |
| `human_decision_required`                                               | Reviewer produced a decision question and an exact draft PR should be recorded |
| `publishing`                                                            | Foundry is creating or reconciling that decision PR                            |
| `blocked`                                                               | Progress can resume after its recorded prerequisite is corrected               |
| `failed`                                                                | The run is terminal; inspect the cause before starting a new run               |
| `publish_failed`                                                        | Decision publication is uncertain or failed; recover the same run              |
| `completed`, `completed_no_change`                                      | Read the final handoff and result                                              |
| `abandoned`                                                             | The run was explicitly ended; inspect its reason and cleanup                   |

Status is not proof that an artifact is valid or a PR exists. Durable validation
and publication journals remain authoritative.

The current implementation keeps the canonical append-only history at
`.agent/runs/<run-id>/events.jsonl` with its `events.witness.json` integrity
floor. `run` retains the request files and appends the run-creation event as one
initialization; if any write fails, initialization removes the run directory and
reports failure, so request files or a directory alone never establish success.
`status` verifies the complete history first, rebuilds current progress from it,
and returns the verified state, checkpoint, attempts, cleanup progress, and the
canonical history path with the accepted revision so a later inspection surface
can point at the source of truth. It is read-only: it never appends events,
approves, advances, pauses, or repairs a run. Its presentation reports the run ID
and verified state, the active role and attempt when role work is active, elapsed
time since run creation, the last recorded event with a bounded detail, the known
task branch and result commit, Foundry role retries, same-session control
repairs, correction rounds, findings, and bounded statistics. Token and cost
figures are not recorded in the current history, so they are presented as
unavailable with a null total rather than as zero consumption or zero spend.
`workflow-state.json` is a disposable derived report: missing, malformed,
wrong-run, or disagreeing records are replaced atomically from verified history
and are never read to infer status, while a report that disagrees with a verified
history is never reported. Cleanup progress is rebuilt the same way from cleanup
events without changing the accepted result. An incomplete or invalid stream or
witness fails the command with a typed integrity report naming the canonical
history and never repairs, truncates, appends, or synthesizes state.
Resume/recovery is not delivered yet.

## Inspect artifacts and findings

`inspect` identifies accepted plan, implementation, verification, Tester, and
Reviewer artifacts; failed attempts; validation errors; findings; correction
history; decision escalation; publication state; and incomplete journal
diagnostics.

The canonical handoff is:

```text
.agent/runs/<run-id>/handoff.json
```

A change handoff records commits, Git-derived files, checks, criterion evidence,
findings, limitations, corrections, Reviewer outcome, and any decision PR. A
no-change handoff records why implementation was unnecessary. The handoff is a
report, not workflow state, and must never be edited to repair a run.

## Evidence integrity and completeness

The handoff summarizes evidence; it does not replace accepted artifacts,
verification reports, commit/integration journals, prompt metadata, or worker
ownership records. Inspection links those records so a reader can trace a
criterion from the accepted plan through the exact result commit to its checks
and Reviewer assessment.

An empty handoff array does not prove that no checks, criteria, or observations
exist. Surface missing or inconsistent summary data and consult the authoritative
records. Foundry must populate the promised handoff coverage or explicitly
identify unavailable information, not reproduce sparse legacy summaries as
apparently complete reports.

Optional captures and logs need bounded, hashed references and criterion links
where relevant. A filename or label is not proof of content: identical files
with different descriptions do not establish two independent observations.
Reviewer must identify misleading evidence and explain what was excluded.
Approval can still be justified by independent evidence permitted by the plan;
otherwise the affected criterion remains unproven. This is evidence-integrity
review, not a mandatory screenshot or named-variant gate.

## Human-decision report

When state is `human_decision_required`, inspection must expose:

- the exact question and options;
- Reviewer recommendation;
- unresolved findings and limitations;
- source/result commits;
- draft PR URL and publication checkpoint; and
- the exact authenticated option commands and whether a decision comment has
  been accepted.

Normal approved runs have no human decision and no Foundry-created PR.

## Statistics and retained information

Statistics may include duration, attempts, retries, corrections, token/tool
usage, worker activity, and availability flags. Missing usage is unknown, not
zero. Report availability and incompleteness alongside totals: unavailable token
usage cannot be presented as zero consumption or zero cost, and an unavailable
cost estimate remains unknown. Missing verification/publication telemetry does
not mean those operations did not happen; consult their reports and journals.
Statistics never determine acceptance. `status` reports each bounded measure with
an explicit availability flag and a null total when it is unavailable, so a
missing figure is never rendered as zero.

Distinguish a Foundry role retry, control repair, or correction from a command
failure handled inside one Coder/worker session. Zero workflow retries can
coexist with failed local test invocations followed by same-session fixes.
`status` counts role retries only from durable workflow-attempt records and
reports same-session control repairs and correction rounds as separate counts.
Bounded terminal logs retain that diagnostic context; do not promote every
local command failure into a workflow failure or silently count it as a new
role attempt.

A run can retain request text, guidance, role notes, command output, evidence,
captures, findings, and publication diagnostics. Configure bounds and redaction,
keep unnecessary secrets out of requests and logs, and restrict `.agent` access.
Redaction reduces accidental disclosure but is not a security boundary.

## Diagnostic bundles

A diagnostic bundle is a bounded, redacted support snapshot:

```powershell
node dist/cli/index.js diagnostic-bundle `
  --config .\.agent\foundry.config.json `
  --output .\diagnostic-bundle `
  --json
```

The output must be new or empty and outside live `.agent` storage. The manifest
records included entries, byte counts, hashes, redaction counts, and truncation.
A bundle is not a complete archive and is not automatically safe to publish.

All JSON CLI output uses the single versioned success/error envelope in
[protocol contracts](protocol-contracts.md#cli-result-contract). Human-readable
output is a presentation of the same durable facts.

## Retention cleanup

Status and inspection distinguish result completion from cleanup completion.
End-of-run disposal is automatic and records a cleanup-progress outcome naming
each owned resource and its disposition, so a terminal result does not by itself
prove that resource disposal succeeded. Expose per-role and per-worker disposal
status, pending/failed cleanup, retained resources, and uncertain ownership.
Successful checks may contain non-blocking process-shutdown warnings; preserve
them without claiming either failed acceptance or successful resource disposal
solely from the command exit code.

List eligible terminal runs before deleting them, then confirm through the
supported cleanup command. Cleanup validates state, event logs, workers,
worktrees, branches, and ownership before each deletion. It may partially
succeed, so list again after any failure. Never delete `.agent/runs` manually.

Use `cleanup --list` to report eligibility and
`cleanup --run-id <id> --confirm <id>` to act. Cleanup is explicit, never
background retention work; normal end-of-run resource disposal remains
automatic. It preserves the task branch and canonical handoff while disposing
verified owned sessions, worktrees, worker branches, and eligible bounded
evidence.

## When to intervene

Intervene only for operational recovery, integrity ambiguity, or a Reviewer
product decision. Do not interrupt healthy automatic work merely to inspect an
intermediate artifact, and do not turn a technical failure into an approval
question. See [recovery](recovery.md).
