# Project setup

The Foundry checkout runs the compiled CLI. The target Git repository owns task
branches, execution worktrees, and ignored `.agent` run data.

## Prerequisites

- a supported host operating system: Linux or Windows;
- Node.js 24.14.0, npm 11.9.0, and Git 2.43 or newer;
- a clean target Git repository;
- a reachable authoritative source remote and branch;
- project-owned deterministic verification commands;
- one harness and model per role for real runs, served by the bundled role
  host (required harness binaries installed: `codex`, `opencode`); and
- a `GITHUB_TOKEN` environment credential only if Reviewer decision escalation
  may publish a draft PR.

Use a disposable repository first. Keep `.agent` ignored and restrict credentials
to the target repository. `GITHUB_TOKEN` is read from the process environment
only; it is never written to configuration, run storage, or logs.

“Clean” means no staged or unstaged tracked changes, no untracked files outside
ignored paths, and no merge, rebase, cherry-pick, revert, or bisect in progress.
Foundry may fetch remote refs and create ignored `.agent` data, but it never
switches or updates the user's checked-out source branch.

## Configuration shape

Foundry has no adoption, pilot, shadow, or manual-mode configuration. One run
command always drives the autonomous workflow.

```json
{
  "schemaVersion": 1,
  "targetRepository": "..",
  "sourceRemote": "origin",
  "sourceBranch": "main",
  "taskBranchPolicy": "foundry/<task-id>",
  "roles": {
    "architect": { "harness": "codex", "model": "gpt-5.6-luna" },
    "coder": { "harness": "codex", "model": "gpt-5.6-luna" },
    "lead_coder": { "harness": "opencode", "model": "opencode-go/glm-5.3-flash" },
    "tester": { "harness": "opencode", "model": "opencode-go/glm-5.3-flash" },
    "reviewer": { "harness": "codex", "model": "gpt-5.6-luna" }
  },
  "timeouts": {
    "roleMs": 1800000,
    "settleMs": 30000,
    "pollMs": 100,
    "commandMs": 900000,
    "runtimeReadinessMs": 120000,
    "cleanupMs": 30000,
    "leaseMs": 60000
  },
  "retryBudgets": {
    "architect": 1,
    "coder": 2,
    "tester": 1,
    "reviewer": 1
  },
  "operationalRetryBudgets": {
    "git": 2,
    "runtime": 1,
    "publication": 2,
    "cleanup": 1
  },
  "limits": {
    "maxParallelCoders": 4,
    "maxCorrectionRounds": 2,
    "maxControlRepairsPerAttempt": 1
  },
  "projectProfile": {
    "guidancePaths": [],
    "commands": {
      "bootstrap": ["npm", "ci"],
      "formatCheck": ["npm", "run", "format:check"],
      "lint": ["npm", "run", "lint"],
      "typecheck": ["npm", "run", "typecheck"],
      "test": ["npm", "test"],
      "build": ["npm", "run", "build"]
    }
  },
  "runtimeProfile": {
    "reset": ["npm", "run", "runtime:reset"],
    "build": ["npm", "run", "build"],
    "start": ["npm", "run", "runtime:start"],
    "readiness": ["npm", "run", "runtime:ready"],
    "stop": ["npm", "run", "runtime:stop"],
    "baseUrl": "http://127.0.0.1:3000",
    "environmentAllowlist": [],
    "dataPolicy": "preserve",
    "testerAccess": "read_only"
  },
  "decisionPublication": {
    "remote": "origin",
    "draft": true,
    "maintainersCanModify": false
  },
  "resultPublication": {
    "mode": "non-draft-pr"
  }
}
```

This is the intended Foundry contract, not a compatibility promise to the
source project's configuration schema. Documents are closed and unknown fields
must be rejected. Projects without a safely prepared application runtime set
`runtimeProfile` to `null`. Projects that cannot publish a decision PR set
`decisionPublication` to `null`. Both keys are always present; JSON `null` is
the omission form.

`roles` names one harness and model per role (`architect`, `coder`,
`lead_coder`, `tester`, `reviewer`). Each harness is a supported harness name
(`codex`, `opencode`) and each model is a non-empty model string resolved
against that harness's own catalog. A valid document is accepted only when
every role names a supported harness and model; unknown harnesses, missing
roles, or extra fields fail before work starts. Per-role selection is the
only harness-related configuration: a document containing the removed
`roleHarness` block (`protocol`, `command`, `environmentAllowlist`) is
rejected as an unknown field under the closed-document rule. Foundry ships
its role host instead of spawning an externally configured one: the exact
command line used to launch each harness is hardcoded in Foundry per harness
and platform (only executable resolution varies between Linux and Windows),
never carried in configuration. There is still one operating model and one
role-host protocol.

Provider credentials are read by the Foundry process itself from its own
environment and forwarded to launched harnesses. Exactly one credential name
is read: `OPENAI_API_KEY`. Credential values never reach configuration,
prompts, or logs; only the hardcoded name list plus `PATH` (forwarded so
launched CLIs resolve their own runtime) reach a harness process. The
accepted costs are explicit: Foundry releases now track vendor CLI changes,
and the credential and workflow trust domains share one process.

Artifact bounds are hardcoded, not configured. A document containing an
`artifacts` block is rejected as an unknown field under the closed-document
rule. One hardcoded set applies to every run on every project: `retentionDays`
30, `maxRequestBytes` 262144, `maxGuidanceBytes` 1048576, `maxRoleHandoffBytes`
262144, `maxEvidenceBytes` 26214400, `maxTerminalCaptureBytes` 10485760, and
`maxRunBytes` 104857600, plus the hardcoded `redactionPatterns`. The accepted
cost is explicit: projects can no longer extend `redactionPatterns` with their
own secret shapes; the hardcoded set plus never persisting credentials is the
whole accidental-disclosure defense.

`decisionPublication.draft` is always `true` and `maintainersCanModify` is
always `false`; non-draft or mutable-head automated publication is unsupported.
The publication remote must equal `sourceRemote`.
Relative paths inside the document resolve from the configuration file's
directory. Retry counts are additional attempts after the first; the limits and
timeout meanings are defined in [protocol contracts](protocol-contracts.md).
Every command is a non-empty argument vector of non-empty strings. The five
verification commands are required; `bootstrap` may be `null`. A non-null
`runtimeProfile` contains every displayed field.

`resultPublication` is an optional additive key. Omitting it preserves the
legacy behavior with effective mode `non-draft-pr`, so existing version-1
documents decode unchanged. When the object is present, `mode` is required and
must be one of `draft-pr`, `non-draft-pr`, `non-draft-pr-auto-merge`, or
`direct-merge`. `mergeMethod` (`merge`, `squash`, or `rebase`, default `merge`)
is only legal with `non-draft-pr-auto-merge`; supplying it with any other mode is
rejected. Because every mode reuses `decisionPublication.remote` for repository
identity and credentials, `resultPublication` requires `decisionPublication` to
be configured; declaring the mode while decision publication is `null` is
rejected. The resolved `resultPublication` is always present for consumers, with
mode `non-draft-pr` and merge method `merge` when the key is absent.

## Validate before work

```powershell
node dist/cli/index.js doctor --config .\target\.agent\foundry.config.json
node dist/cli/index.js init --dry-run --config .\target\.agent\foundry.config.json --task-id example-change
node dist/cli/index.js profile-check --config .\target\.agent\foundry.config.json
```

- `doctor` validates tooling, configuration, storage, target identity, runtime,
  and optional GitHub decision-publication readiness.
- `init --dry-run` displays resolved source, branch, worktree, per-role routing,
  and artifact paths without mutation. It first reuses the `doctor` readiness check,
  so every configuration and identity problem `doctor` would catch also fails
  the preview. It then reports:
  - `source`: the configured `sourceRemote` and `sourceBranch` plus the reachable
    `commit` from `ls-remote`;
  - `branch`: `taskBranchPolicy` with its single `<task-id>` placeholder replaced
    by the invocation task ID, which must be a legal Git branch ref and must not
    equal the source branch;
  - `workspace`: `<target>/.agent/worktrees/<task-id>`;
  - `roleRouting`: the resolved per-role routing (harness and model) from the
    bundled host without launching anything; and
  - `artifacts.root`: `<target>/.agent/runs`, under which later run directories
    appear, plus the effective hardcoded artifact bounds. The preview creates
    nothing and leaves Git status, HEAD, and the current branch unchanged.
- `profile-check` runs configured project commands in order and fails if they
  mutate tracked Git state.

`doctor` verifies the bundled role host directly, without spawning anything:
required harness binaries are present on the process `PATH`, every listed
model resolves against its harness catalog, and every role plus the required
capability profiles are covered. A live run is additionally gated before
source provisioning on the bundled host attesting resumable sessions and the
role capability profiles. Both `doctor` and `init --dry-run` report
the resolved per-role routing (harness and model) and the effective hardcoded
artifact bounds without launching anything.

## Provisioning identity

Before role work begins, retain the target repository identity, source branch
and confirmed source commit, assigned task branch, and execution worktree. Role
and worker resource records additionally identify their owned runtime sessions
and working directories. A workspace or pane identifier alone does not prove
which repository, branch, or role conversation is active.

Run creation fetches the configured source branch without switching or updating
the operator's checked-out branch, resolves the fetched commit, and appends a
closed `source-frozen` event carrying the repository identity (root, Git
directory, remote URL), source remote/branch/commit, task branch, workspace, and
expected head. Foundry creates the task branch and run-owned worktree at that
frozen commit and appends `worktree-ready` only after Git confirms the branch,
HEAD, workspace, and base. The creation-to-`planning` transition follows that
checkpoint, so verified history that stops at `run-created` or `source-frozen`
derives `blocked` instead of an active role. Later forward movement of the
remote source never rewrites the run's frozen base or its worktree.

An existing task branch or workspace without this run's durable ownership
evidence blocks the run without moving or deleting it. A retried run reuses an
owned branch or worktree only when the recorded head still matches Git, and an
ambiguous interruption before ownership was recorded blocks rather than
adopting a coincidentally matching branch.

Keep source/Git provenance and resource-provisioning evidence linked but
distinct: a ready runtime is not proof of source ancestry, and a valid source
commit is not proof that runtime provisioning or cleanup succeeded.

## Project commands and runtime

Project commands execute directly, without a shell, in the run-owned worktree.
Working and log paths stay inside the target repository. Bootstrap may install
or generate dependencies but cannot rewrite tracked source or create a commit.
Commands expect exit code zero and use the configured command timeout. Foundry
runs every verification gate after a successful bootstrap so one correction
receives the complete failure set.

Foundry compares tracked Git state around every non-Coder project command. If a
command changes it, Foundry captures the bounded diff, marks the command as a
capability violation, and reconstructs the worktree at its recorded commit
before any safe retry. It never commits or selectively restores those changes.

When runtime validation is required, Foundry owns application reset, build,
start, readiness, stop, and process cleanup. Tester receives a prepared runtime
but no data-mutation authority. Projects requiring mutable scenarios should
encode them as isolated automated tests rather than granting Tester access to
shared records or services.

Runtime observations identify the repository, accepted implementation commit,
application/session, runtime kind, and lifecycle timestamps. Retain the reset,
build, start, readiness, stop, and owned-process cleanup outcomes, including
whether application data was preserved. Preparing a runtime does not imply a
fresh data store or authorize wiping existing data. Tester uses prepared,
read-only scenarios; data-mutating scenarios belong in project-owned isolated
automated tests, not shared-service setup performed by Tester.

The concrete process, readiness, ownership, and data-preservation rules are in
[protocol contracts](protocol-contracts.md#target-runtime-profile). A required
runtime stage without a usable profile cannot be silently skipped or approved.

Command names are labels, not coverage guarantees. Inspect the executable and
arguments behind each profile entry: two labels may invoke the same command,
and a root test or typecheck command may omit a workspace package. Make required
coverage explicit rather than inferring it from names such as `lint` or `test`.

## Project guidance

At run creation Foundry snapshots every tracked `AGENTS.md` from the frozen
source commit, excluding `.git` and `.agent`, plus the tracked files explicitly
listed in `projectProfile.guidancePaths`. A missing, untracked, escaping, or
oversized configured path fails preflight. Committed bytes are authoritative:
a live file that differs, or an untracked live file at a listed path, never
changes the snapshot. Each file and the aggregate are bounded by the hardcoded
`maxGuidanceBytes`, and invalid UTF-8 text is rejected. Saved guidance
is immutable for the run, hashed, size-bounded, and injected through the prompt
contract. More deeply nested `AGENTS.md` files apply to their subtree using the
same precedence as normal repository instructions.

Foundry verifies these paths before it creates the task branch or worktree and
retains byte-exact copies with a closed, versioned manifest inside the run
directory. It records one `guidance-frozen` checkpoint tied to the recorded
`source-frozen` commit, and a run cannot enter planning without it. On recovery
Foundry verifies the retained manifest and bytes against that checkpoint;
missing, changed, or corrupt retained guidance blocks safely instead of being
reacquired from the live tree.

Recovery never rereads live guidance files. Guidance cannot override schemas,
Git safety, role permissions, or output requirements. Retain the guidance role,
snapshot path/hash, verification status, and prompt hash as provenance. Inject
verified guidance at conversation bootstrap; retries and control repairs
continue against that recorded context rather than rereading live guidance or
asking the role to reopen the snapshot.

## GitHub escalation readiness

Normal approved runs do not publish. If decision escalation is enabled, verify
that:

- the source remote is GitHub and matches the publication remote;
- authentication permits non-force push, draft PR creation/update, issue-comment
  reads, and collaborator-permission lookup;
- task branch names cannot collide with protected branches; and
- the credential is limited to the configured repository and has no Actions,
  deployment, administration, or unrelated-repository access.

When `decisionPublication` is configured, `doctor` reports a closed
`publication` object alongside the other readiness facts:

- `configured` and `eligible` describe whether publication can proceed;
- `repository` is the resolved `owner/name` from the publication remote, or
  `null` when the remote is not a GitHub repository;
- `repositoryScope` is `repository` for a repository-limited credential,
  `broad` when advertised token scopes reach unrelated repositories or
  administration, and `unknown` when the probe could not establish it;
- `capabilities` reports each required capability—`push`, `pull_request`,
  `issue_comment_read`, `collaborator_permission`—as `granted`, `denied`, or
  `unknown`; and
- `reason` is a specific, bounded explanation whenever publication is not
  eligible, or `null` when it is eligible.

When a result-publication mode is configured (or defaulted), `doctor` also
reports `publication.resultPublication` with the effective `mode`, its
`mergeMethod` (`null` unless the mode is `non-draft-pr-auto-merge`), `eligible`,
a specific `reason` whenever it is ineligible, and the probed
`autoMergeAllowed` and `sourceBranchProtected` facts (`null` when the probe
could not establish them). The modes gate as follows:

- `draft-pr` and `non-draft-pr` are eligible exactly when the decision-channel
  `publication` report is eligible;
- `non-draft-pr-auto-merge` additionally requires repository auto-merge
  (`autoMergeAllowed === true`) and a protected source branch
  (`sourceBranchProtected === true`); GitHub silently ignores auto-merge without
  branch protection, so an unconfirmed protection fact is ineligible;
- `direct-merge` requires push authority and an unprotected source branch
  (`sourceBranchProtected === false`); a protected or unconfirmed branch is
  ineligible because branch protection rejects direct pushes and Foundry never
  bypasses it.

An unknown capability is ineligible rather than assumed, matching the decision
channel. Branch protection is probed with an additional read-only `GET` only for
the `non-draft-pr-auto-merge` and `direct-merge` modes, so the other modes make
no extra call.

The readiness probe is read-only: it looks up repository identity, the
authenticated viewer's repository permission and advertised token scopes, and
issue-comment readability with `GITHUB_TOKEN` from the environment. It never
performs a mutating GitHub call, never pushes, and never persists the token.
Draft-PR creation/update is derived from repository push permission because the
probe deliberately does not create a PR to prove it. A required capability stays
`unknown` rather than `denied` when the probe cannot establish it, and any
unverified scope or capability makes the report ineligible rather than assume
privilege. A classic token that advertises broad scopes such as `repo`,
`workflow`, or `admin:*` is reported as `broad` and ineligible; a token that does
not advertise scopes (a fine-grained token) is treated as repository-limited.

`doctor` reports a configured-but-ineligible publication as a readiness fact, not
an error; it does not block ordinary approved runs. A project may run without
publication at all, in which case `configured` is `false` with no reason. If a
run later reaches a genuine human-decision outcome while publication is absent or
ineligible, Reviewer routing blocks it for later publication rather than inventing
another human channel.
