# Protocol contracts

This page defines the small machine-readable surface that connects Foundry to
role harnesses and target projects. Agent handoffs remain ordinary Markdown.
Foundry requires structured data only for decisions that change workflow state.

## Free-form handoffs with a narrow control envelope

Every settled role turn consists of:

1. a bounded UTF-8 Markdown narrative; and
2. a small control envelope supplied through the harness protocol.

Agents do not create Foundry state files, verification reports, journals, or
handoff JSON. Foundry owns those records. A harness should use provider-native
structured output when available; otherwise it may collect the envelope in a
short same-session follow-up after the narrative is complete.

All envelopes have `schemaVersion: 1`, reject unknown fields, and contain an
`outcome`. Their complete version 1 shape is:

| Role/outcome                                                               | Additional fields                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architect `plan_ready`                                                     | `acceptanceCriteria: string[]`, `runtimeValidation: "required" \| "not_required"`, `execution: "sequential" \| "parallel"`, optional `affectedPaths: string[]`, and `objectives` only for parallel work |
| Architect `no_change_candidate`                                            | `acceptanceCriteria: string[]`, `runtimeValidation: "required" \| "not_required"`                                                                                                                       |
| Architect `blocked`                                                        | none                                                                                                                                                                                                    |
| Coder `implemented`, `no_change_candidate`, or `blocked`                   | none                                                                                                                                                                                                    |
| Tester `observed`, `retry_required`, or `blocked`                          | none                                                                                                                                                                                                    |
| Reviewer `approved`, `changes_requested`, `retest_requested`, or `blocked` | none                                                                                                                                                                                                    |
| Reviewer `human_decision_required`                                         | `decision: { question: string, options: { label: string, action: "accept" \| "correct" \| "abandon" }[], recommendation?: string }`                                                                     |

Criteria and decision options contain 1–100 trimmed entries; objectives contain
2–32 entries, and each path array contains 1–256 entries. Plain strings are
non-empty and at most 4,096 UTF-8 bytes. Paths are normalized repository-relative
prefixes with `/` separators; they cannot contain `..`, absolute roots, or
globs, and `.` means the entire repository. A parallel objective is exactly
`{ title: string, affectedPaths: string[], criteria: number[] }`, where criteria
are one-based indexes into `acceptanceCriteria`.

The role-specific meaning is:

- **Architect:** `plan_ready`, `no_change_candidate`, or `blocked`.
  `plan_ready` adds `acceptanceCriteria` as a non-empty array of plain strings,
  `runtimeValidation` as `required` or `not_required`, and `execution` as
  `sequential` or `parallel`; `affectedPaths` is optional. Foundry assigns
  stable `AC-001` identifiers by array order. `no_change_candidate` still
  supplies `acceptanceCriteria` and `runtimeValidation`, while its rationale
  remains in the narrative.
- **Coder:** `implemented`, `no_change_candidate`, or `blocked`. Commit IDs and
  changed files never appear in the envelope because Foundry derives them from
  Git.
- **Tester:** `observed`, `retry_required`, or `blocked`. Tester reports
  observations and limitations in Markdown; it does not declare the
  implementation passed or failed. `retry_required` consumes a Tester role
  retry against the same commit.
- **Reviewer:** `approved`, `changes_requested`,
  `retest_requested`, `human_decision_required`, or `blocked`.
  `retest_requested` is valid only while a Tester retry remains and does not
  permit a code change. Only `human_decision_required` adds a `decision` object
  containing a question, at least two labeled action options, and an optional
  recommendation. Foundry assigns stable `OPT-001` identifiers by array order.

For a sequential plan, Foundry creates one `OBJ-001` covering every criterion;
its affected scope is the optional Architect list or, when omitted, the whole
repository. Parallel execution is opt-in and adds one compact objective array
to the Architect envelope. Each objective contains a title, affected path
prefixes, and one-based criterion numbers. Foundry assigns `OBJ-001`,
`OBJ-002`, and so on, rejects empty or duplicate scopes, and requires complete
criterion coverage with every criterion assigned exactly once. If the array is
absent, invalid, overlapping, or not demonstrably independent, Foundry falls
back to sequential execution rather than asking a person.

Downstream roles receive the complete accepted Markdown narratives from the
roles before them, plus Foundry-owned Git, check, runtime, and retry facts. Those
narratives are passed intact rather than summarized into another agent-authored
schema; size pressure is handled by bounded referenced attachments, never silent
truncation.

The narrative is evidence, not a source of workflow transitions. Foundry never
infers an outcome from prose, filenames, sentiment, or role termination. A
missing or invalid envelope gets at most the configured same-session control
repair, then the normal role retry budget. The rejected narrative and validation
error remain retained.

## Role-host protocol

The first release supports one vendor-neutral command adapter,
`foundry-role-host-v1`. The configured executable is launched directly, never
through a shell, with one of these operations appended to its argument vector:

- `capabilities` reports protocol version, resumable-session support, and the
  enforceable filesystem/network capability profiles;
- `create` allocates a session without submitting a prompt;
- `submit` sends one turn using a Foundry-generated idempotency key;
- `observe` returns events newer than a recorded sequence and reports
  `active`, `settled`, or `lost`;
- `stop` disposes the exact owned session.

Each invocation reads one closed, versioned JSON document from standard input
and writes one closed, versioned JSON document to standard output. Standard
error is bounded diagnostic text. A non-zero exit, malformed response, session
identity mismatch, or sequence regression is a typed operational failure.

The operation payloads are deliberately small:

| Operation      | Request fields after `schemaVersion`                                                                                 | Success response fields after `schemaVersion`                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `capabilities` | none                                                                                                                 | `protocol`, `resumable`, `availableRoles`, `capabilityProfiles`, `adapterVersion` |
| `create`       | `runId`, `role`, `attempt`, `generation`, optional `workingDirectory`, `readRoots`, `writeRoots`, `networkAllowlist` | `sessionId`, `ownershipToken`, `generation`, `sequence`, `runtimeIdentity`        |
| `submit`       | `sessionId`, `ownershipToken`, `generation`, `idempotencyKey`, `prompt`, `deadline`                                  | `submission: "accepted" \| "already_accepted"`                                    |
| `observe`      | `sessionId`, `ownershipToken`, `generation`, `afterSequence`                                                         | `status`, `sequence`, `events`, and, only when settled, `narrative` and `control` |
| `stop`         | `sessionId`, `ownershipToken`, `generation`                                                                          | `disposition: "disposed" \| "already_disposed"`                                   |

Roles are `architect`, `coder`, `lead_coder`, `tester`, and `reviewer`;
attempts and generations are positive integers. `deadline` is an ISO-8601 UTC
instant. `events` is an ordered bounded array of `{ sequence, kind, text }`
diagnostics and may be empty. `status` is `active`, `settled`, or `lost`.
Every listed object is closed and every string/array is subject to the hardcoded
handoff and terminal-capture limits.

The `capabilities` response attests the host's executable surface. `protocol` is
the literal `foundry-role-host-v1`, `resumable` is a boolean, `availableRoles`
lists the runnable roles, `adapterVersion` is a non-empty build identifier, and
`capabilityProfiles` is a closed object with `filesystem` and `network` arrays.
The filesystem vocabulary is `read_only_snapshot`, `run_owned_worktree`,
`owned_scratch`, and `owned_capture_scratch`; the network vocabulary is
`network_denied` and `runtime_origin_only`. Foundry derives this required
role/profile matrix from the role permission table:

| Role               | Required filesystem profiles                  | Required network profile |
| ------------------ | --------------------------------------------- | ------------------------ |
| Architect          | `read_only_snapshot`, `owned_scratch`         | `network_denied`         |
| Coder / Lead Coder | `run_owned_worktree`, `owned_scratch`         | `network_denied`         |
| Tester             | `read_only_snapshot`, `owned_capture_scratch` | `runtime_origin_only`    |
| Reviewer           | `read_only_snapshot`, `owned_scratch`         | `network_denied`         |

An unknown, malformed, omitted, or negative attestation is never treated as
support. A single application-owned rule compares the decoded report with this
matrix, and both `doctor` and a live `run` fail clearly on an unsupported
protocol, non-resumable sessions, a missing role, or a missing profile.

Per-role harness and model selection belongs to Foundry configuration, which
names one harness and model per role; the exact command line used to launch
each harness stays hardcoded in the role-host adapter per harness and runtime
and is never carried in configuration. `doctor` and `init --dry-run` report
the resolved per-role routing without launching anything. A live adapter
rejects an unknown model against its own catalog and fails closed; Foundry
never invents a substitute model. The same document resolves the same routing
on Linux and Windows; only executable resolution follows existing platform
rules. `doctor` requires every role and capability profile, and `runtimeIdentity`
is exactly `{ adapterVersion, provider, model, toolProfile }`, recording the
non-empty strings actually assigned to the session. Foundry retains that value
as provenance without changing route semantics when different conforming hosts
are used.

`create` returns a session ID, ownership token, conversation generation, and
initial sequence. Foundry persists that identity before `submit`. `submit` is
idempotent for `(sessionId, generation, idempotencyKey)` and returns whether the
turn was newly accepted or already accepted. `observe` never submits work and a
settled observation includes the Markdown narrative and control envelope.
`stop` requires the ownership token and is also idempotent.

The adapter receives absolute roots and a fixed capability profile:

| Role               | Production repository access | Writable locations              | Runtime access                  |
| ------------------ | ---------------------------- | ------------------------------- | ------------------------------- |
| Architect          | read-only snapshot           | owned scratch only              | none                            |
| Coder / Lead Coder | run-owned worktree           | that worktree and owned scratch | none                            |
| Tester             | read-only evidence snapshot  | owned capture scratch only      | prepared read-only runtime only |
| Reviewer           | read-only evidence snapshot  | owned scratch only              | none                            |

The enforced role turn derives those roots from run-owned locations rather than
accepting caller-chosen permissions, so a caller cannot widen a role's access by
supplying its own roots. It refuses to start a turn when a required bound is
unavailable: a Coder without a run-owned worktree or a Tester without the
prepared application origin fails closed. An invalid environment-variable name
is rejected before the host is launched.

The role host must enforce these roots against absolute paths, `..`, symlinks,
junctions, case-folding, and alternate Windows path forms. `doctor` rejects a
live adapter that cannot attest support for resumable sessions and the required
capability profiles. Foundry compares Git and owned-resource state before and
after every read-only turn as an additional detection layer, but detection does
not replace host enforcement. A changed project or worktree records a
`project-mutation` violation; changed run-owned scratch or run-directory
resources record a `run-resource-mutation` violation. Either violation stops
that attempt and is never treated as a successful result.

Agent-exposed network access is denied for Architect, Coder, Lead Coder, and
Reviewer. Tester receives only the origin derived from `runtimeProfile.baseUrl`.
The adapter's own transport to its configured model provider is outside that
agent-visible allowlist but may not be exposed as a general network tool.

Only environment-variable names listed in `environmentAllowlist` are forwarded
to the role host; values are read from Foundry's environment and are never
written to configuration, prompts, events, or diagnostics. Role-host protocol
documents and reference conformance tests are part of Foundry, so vendor-specific
adapters do not change workflow semantics.

## Target runtime profile

`runtimeProfile` is optional. When present, it supplies direct argument vectors
for `reset`, `build`, `start`, `readiness`, and `stop`, plus a required base URL
and environment-variable allowlist. Relative executable paths and all working
directories resolve inside the run-owned worktree.

- `reset`, `build`, and `stop` must terminate with exit code zero.
- `start` is the one long-running process. Foundry records and owns its process
  tree before polling readiness.
- `readiness` is executed repeatedly until it returns zero or the readiness
  timeout expires.
- `stop` is a graceful request. Foundry subsequently verifies termination and
  kills only the recorded owned process tree after the cleanup grace period.
- The only supported `dataPolicy` is `preserve`, and the only supported
  `testerAccess` is `read_only`.

Runtime commands must not wipe or rewrite application data. A project that
cannot provide read-only scenarios should supply isolated automated tests and
omit `runtimeProfile`. If the accepted plan still requires runtime evidence,
Foundry records the limitation, gives Coder a correction opportunity to add
deterministic evidence, and ultimately lets Reviewer choose only
`human_decision_required` or `blocked`—never `approved` without the required
evidence.

As with every Foundry-owned project command, Foundry snapshots tracked Git state
before and after each runtime command. A tracked change is a capability
violation: the command fails, the diff is captured as bounded diagnostic
evidence, and Foundry disposes and reconstructs the worktree at the recorded
commit before a bounded operational retry. It never accepts, commits, or
selectively restores those changes. Tester receives only the configured base URL
and credentials whose project-owned readiness check establishes read-only
access; the role host must deny other network destinations. If read-only access
cannot be established, the runtime is not prepared.

## Budgets and deterministic defaults

All retry budget values mean **additional attempts after the first attempt**.
They are consumed only for the named scope:

- role retries handle lost sessions or unacceptable settled output;
- control repairs are same-session control-envelope repairs;
- correction rounds are Reviewer- or verification-requested implementation
  changes and always create a new commit;
- operational retries cover Git, runtime, publication, and cleanup operations
  only when their journal proves retry is safe.

Each objective Coder and Lead Coder has its own Coder role-retry budget, while
`maxParallelCoders` limits all active Coder sessions for a run. Queued work does
not consume a retry. The defaults in the configuration example are normative.

Verification commands expect exit code zero, run in configured order, and each
uses `commandMs`. After a successful bootstrap, Foundry runs every configured
gate even if an earlier gate fails so Coder receives one complete correction
report. A bootstrap failure stops the attempt because later results would be
misleading. A timed-out gate is recorded and later gates continue only after
Foundry proves its process tree stopped. Commands are not blindly retried after
an ambiguous interruption. Verification reports are reused only within the same
orchestrator process for the exact commit and canonical command profile; resume
reruns verification rather than assuming the host environment is unchanged.

`roleMs` bounds one submitted role turn. `pollMs` is the minimum interval
between `observe` calls. `settleMs` is the final observation window after a role
deadline or orchestrator interruption before ownership is classified as lost or
uncertain. `runtimeReadinessMs` bounds readiness polling, `cleanupMs` is the
graceful process/session disposal window, and `leaseMs` is the repository lease
duration renewed before its midpoint.

## Paths, identifiers, and Git baseline

CLI path arguments resolve from the caller's current working directory. Paths
inside configuration resolve from the configuration file's directory. A bare
command name resolves through the host `PATH`; a command containing a path
separator resolves from the configuration directory for adapters and from the
run-owned worktree for project/runtime commands. Foundry canonicalizes paths
before containment checks. Configured project and guidance paths may not escape
the target repository; role-visible paths may not escape their declared roots.
Configured guidance paths identify files tracked at the frozen source commit,
never merely readable live files. A request may be any readable regular file,
while diagnostic output must satisfy the separate rule that it is outside live
`.agent` storage.

The request contract is deliberately free-form: a non-empty, bounded UTF-8
Markdown document with no front matter or required headings. Foundry validates
the byte limit and encoding, normalizes line endings to LF for prompting, and
retains both the original content hash and normalized prompt hash. Architect
turns that narrative into the small accepted-plan control data; unknown prose is
never rejected as though it were an unknown JSON field.

`run-id` and `task-id` are supplied by the caller in version 1. They must be
1–64 ASCII characters matching `[A-Za-z0-9][A-Za-z0-9._-]*`. A run ID must be
new. `taskBranchPolicy` contains exactly one literal `<task-id>` placeholder.
The rendered task branch must be a valid Git ref and may not equal the
configured source branch or any protected branch reported by GitHub.

At run creation, Foundry fetches the configured remote and freezes the resolved
fetched commit without updating remote-tracking refs or trusting or updating the
local source branch. The task branch and run-owned worktree start at that frozen
commit. An existing task or worker branch is reusable only when its ownership
record belongs to the same run and its recorded head matches Git; otherwise the
run blocks without moving or deleting it. Until verified `worktree-ready`
evidence exists, replay derives `blocked` rather than an active role state, and
a stale or forged `planning` report is replaced from verified history.

Normal forward movement of the remote source branch does not rewrite an active
run. Foundry records that drift, and publication is allowed only while the
recorded source commit remains an ancestor of the current remote source commit.
Rewritten or unrelated source history requires human recovery. Foundry never
rebases or merges source updates automatically.

## CLI result contract

With `--json`, every command emits exactly one closed envelope:

```json
{
  "schemaVersion": 1,
  "command": "status",
  "ok": true,
  "data": {}
}
```

A failure replaces `data` with a tagged `error` containing `kind`, `message`,
`retryable`, and an optional `runId`. Human-readable mode presents the same
facts without becoming authoritative state.

Exit code `0` means the command completed and durably reported its outcome,
including a successfully published `human_decision_required` result. Exit code
`1` means a valid operation ended `blocked`, `failed`, or `publish_failed`.
Exit code `2` means CLI/configuration validation failed before a durable run was
created. An operator interruption uses the platform's conventional interrupt
exit code after checkpointing; it never converts an active role into failure or
resubmits it.

The complete public command surface is:

- `run`, `resume`, `status`, and `inspect`;
- `doctor`, `init --dry-run`, and `profile-check`;
- `diagnostic-bundle`;
- `cleanup --list` and `cleanup --run-id <id> --confirm <id>`; and
- `resume --run-id <id> --abandon --reason <text>` for explicit abandonment.

End-of-run disposal of owned processes, sessions, and worktrees is automatic.
Retention cleanup is never automatic. The hardcoded `retentionDays` determines eligibility
from the terminal `completed`, `completed_no_change`, `failed`, or `abandoned`
transition time shown by `cleanup --list`; nonterminal runs are never eligible.
`cleanup --run-id <id> --confirm <id>` refuses a nonterminal run, a run still
inside its retention window, or a run whose pre-deletion state, history,
workers, workspaces, branches, or ownership check fails, naming the failed
check and writing nothing. Retention cleanup may remove verified disposable
resources and bounded artifacts, but preserves the task branch and canonical
handoff unless a future explicit policy says otherwise.

## Linux and Windows parity

Foundry uses Node argument-vector process spawning with no shell. On Windows,
bare executables follow `PATH`/`PATHEXT`; paths are compared with Windows case
and separator rules, and junctions are resolved alongside symlinks. Owned
process cleanup must terminate the recorded process tree rather than matching
by executable name. Linux and Windows CI both run the role-host conformance,
path-escape, atomic-persistence, lock-recovery, temporary-Git-repository, and
interrupt/resume suites. A feature is not supported until the same observable
workflow and safety tests pass on both platforms.

**Implemented:** `tests/parity/` holds the platform-conditional argument-vector,
owned-process-tree, path-escape, role-host, durable-history, lock-recovery,
temporary-repository, and interrupt/resume suites, and the CI `parity` job runs
them on `ubuntu-latest` and `windows-latest`.

## Artifact limits

Artifact bounds are hardcoded, not configured: `retentionDays` 30,
`maxRequestBytes` 262144, `maxGuidanceBytes` 1048576, `maxRoleHandoffBytes`
262144, `maxEvidenceBytes` 26214400, `maxTerminalCaptureBytes` 10485760, and
`maxRunBytes` 104857600, plus the hardcoded `redactionPatterns`. The hardcoded
bounds apply to every run on every project; requests, guidance, handoffs,
evidence, and terminal captures keep today's limit behavior, only the source of
the numbers changes. `doctor` and `init --dry-run` report the effective bounds
from the hardcoded set.

Mandatory state, events, journals, control envelopes, and the canonical handoff
are never silently truncated. Terminal output and optional captures are kept up
to the hardcoded limits; Foundry records the original observed byte count,
retained byte count, content hash when fully observed, truncation, and redaction
count. Once `maxRunBytes` is reached, optional evidence is rejected and the run
continues using mandatory evidence when possible. If mandatory durable state
cannot be written, the run stops safely as `blocked`.

The hardcoded `redactionPatterns` are ECMAScript regular-expression strings.
Redaction occurs before persistent logs and bundles are written. Projects can
no longer extend the patterns with their own secret shapes; the hardcoded set
plus never persisting credentials is the whole accidental-disclosure defense.
Secrets remain outside the evidence contract; redaction is only a final
accidental-disclosure defense.

The optional-evidence ledger is derived from verified history: retained
terminal-capture and tracked-mutation bytes recorded for each verification
execution. A write is admitted only while the ledger plus the incoming retained
bytes stays within `maxRunBytes`; otherwise the write is refused with a typed
`run-evidence-limit-reached` reason and no evidence file is created. Every entry
of the hardcoded `redactionPatterns` compiles as an ECMAScript regular
expression.

## Durable-record minimum

The canonical run stream is `.agent/runs/<run-id>/events.jsonl`. Each closed
event document contains `schemaVersion`, `runId`, monotonic `revision`, unique
`eventId`, UTC `occurredAt`, `type`, typed `payload`, `previousEventHash`, and
`eventHash`. The first event has no previous hash. Event types cover run
creation, provisioning checkpoints, state transitions, attempts, control
validation and repair, accepted commits, evidence invalidation, verification,
runtime ownership, review, publication checkpoints, recovery, abandonment, and
cleanup. Each event type has its own closed payload Schema in the owning slice.
Hashes use lowercase hexadecimal SHA-256. `eventHash` covers
`previousEventHash`, a newline byte, and the UTF-8 JSON encoding of the event
without `eventHash`; object keys are lexicographically sorted recursively,
arrays retain order, and schemas permit only integers for numeric event fields.

`run-state.json`, statistics, inspection output, and `handoff.json` are derived
views. On open or resume, Foundry validates the complete event hash chain and
rebuilds state; a disagreeing derived view is regenerated atomically and never
used to advance the run. An invalid or truncated canonical event stream enters
`human_recovery` without attempting to guess or repair history.

An append acquires the run lease, checks the expected revision and previous
hash, writes a same-directory temporary file, flushes it, and atomically replaces
the canonical stream. The platform storage adapter must pass crash-injection
tests for Linux and Windows. A stale writer receives a revision conflict and
replays; it never overwrites newer events.

The implemented slice records run creation, the `source-frozen` and
`worktree-ready` provisioning checkpoints, workflow transitions, retry or
repair attempts, cleanup progress, the role-session lifecycle: created
identity and runtime provenance, the pre-submit baseline with prompt hash,
generation and idempotency key, the submission-started checkpoint, observed
progress with any settled narrative and control envelope, and the stop
disposition, the accepted plan with its labelled acceptance criteria and
compiled execution objectives, every recorded role permission violation, each
Git-derived accepted implementation commit with its changed files, each
commit-bound `verification-completed` report with its ordered command
executions, an explicit `tester-skipped` record or a `validation-limitation`
for a required-but-unusable runtime stage, and each `runtime-lifecycle`
record for prepared, stopped, and cleaned-up owned application processes. A
same-directory
`events.witness.json` records the last accepted revision and hash as an
independently durable append-integrity floor: a missing witness, a stream
without its terminal newline, or a revision, link, or payload discontinuity
stops the run for human integrity investigation instead of repairing or
truncating history, and the stream, witness, and reports stay untouched.

Whenever an existing run is opened or read, Foundry replays and verifies the
complete stream and witness before reading any report, then rebuilds workflow
state, checkpoint, attempts, and the latest cleanup progress from that history.
`workflow-state.json` and `cleanup-progress.json` are derived reports that never
advance a run: a missing, malformed, wrong-run, or disagreeing report is
disposable and is replaced atomically from verified history, a report with no
backing event is removed, and no report is used to choose a transition, retry,
completion, or resume. Repository ownership is enforced by the repository lease
described below before `run` creates any run storage.

The repository lease records a random owner ID, host identity, process ID and
process start identity, acquisition time, heartbeat, and expiry. The owner
renews before half the lease duration. Automatic takeover requires both an
expired lease and proof that the recorded local process identity is dead; an
unreachable foreign host or unverifiable identity remains `human_recovery`.
Release and renewal use compare-and-swap on the owner ID. `run` acquires the
lease after request and configuration validation and before preparing
`.agent/runs`, renews while the mutating operation continues, and releases it on
success, failure, or interruption. A competing healthy owner, or an owner that
cannot be verified as dead, stops the run as `blocked` with exit code `1` and
the run ID; an invalid request or configuration still fails validation with exit
code `2` and takes no lease.
