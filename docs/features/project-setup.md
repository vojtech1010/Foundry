# Project setup

The Foundry checkout runs the compiled CLI. The target Git repository owns task
branches, execution worktrees, and ignored `.agent` run data.

## Prerequisites

- Node.js, npm, and Git versions pinned by the Foundry repository;
- a clean target Git repository;
- a reachable authoritative source remote and branch;
- project-owned deterministic verification commands;
- one configured live role harness for real runs; and
- GitHub credentials only if Reviewer decision escalation may publish a draft
  PR.

Use a disposable repository first. Keep `.agent` ignored and restrict credentials
to the target repository.

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
  "runtimeMode": "live",
  "timeouts": {
    "roleMs": 1800000,
    "settleMs": 30000,
    "pollMs": 100
  },
  "retryBudgets": {
    "architect": 1,
    "coder": 2,
    "tester": 1,
    "reviewer": 1
  },
  "projectProfile": {
    "commands": {
      "bootstrap": ["npm", "ci"],
      "formatCheck": ["npm", "run", "format:check"],
      "lint": ["npm", "run", "lint"],
      "typecheck": ["npm", "run", "typecheck"],
      "test": ["npm", "test"],
      "build": ["npm", "run", "build"]
    }
  },
  "decisionPublication": {
    "remote": "origin",
    "draft": true,
    "maintainersCanModify": true
  },
  "artifacts": {
    "retentionDays": 30,
    "maxEvidenceBytes": 26214400,
    "maxTerminalCaptureBytes": 10485760,
    "maxRunBytes": 104857600,
    "redactionPatterns": []
  }
}
```

This is the intended Foundry contract, not a compatibility promise to the
source project's configuration schema. Documents are closed and unknown fields
must be rejected.

`decisionPublication.draft` is always `true`; non-draft automated publication
is unsupported. The publication remote must equal `sourceRemote`.

## Validate before work

```powershell
node dist/cli/index.js doctor --config .\target\.agent\foundry.config.json
node dist/cli/index.js init --dry-run --config .\target\.agent\foundry.config.json --task-id example-change
node dist/cli/index.js profile-check --config .\target\.agent\foundry.config.json
```

- `doctor` validates tooling, configuration, storage, target identity, runtime,
  and optional GitHub decision-publication readiness.
- `init --dry-run` displays resolved source, branch, worktree, harness, and
  artifact paths without mutation.
- `profile-check` runs configured project commands in order and fails if they
  mutate tracked Git state.

## Provisioning identity

Before role work begins, retain the target repository identity, source branch
and confirmed source commit, assigned task branch, and execution worktree. Role
and worker resource records additionally identify their owned runtime sessions
and working directories. A workspace or pane identifier alone does not prove
which repository, branch, or role conversation is active.

Keep source/Git provenance and resource-provisioning evidence linked but
distinct: a ready runtime is not proof of source ancestry, and a valid source
commit is not proof that runtime provisioning or cleanup succeeded.

## Project commands and runtime

Project commands execute directly, without a shell, in the run-owned worktree.
Working and log paths stay inside the target repository. Bootstrap may install
or generate dependencies but cannot rewrite tracked source or create a commit.

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

Command names are labels, not coverage guarantees. Inspect the executable and
arguments behind each profile entry: two labels may invoke the same command,
and a root test or typecheck command may omit a workspace package. Make required
coverage explicit rather than inferring it from names such as `lint` or `test`.

## Project guidance

Foundry may snapshot repository-owned role guidance at run creation. Saved
guidance is immutable for the run, hashed, size-bounded, and injected through
the prompt contract. Recovery never rereads live guidance files. Guidance cannot
override schemas, Git safety, role permissions, or output requirements. Retain
the guidance role, snapshot path/hash, verification status, and prompt hash as
provenance. Inject verified guidance at conversation bootstrap; retries and
artifact repairs continue against that recorded context rather than rereading
live guidance or asking the role to reopen the snapshot.

## GitHub escalation readiness

Normal approved runs do not publish. If decision escalation is enabled, verify
that:

- the source remote is GitHub and matches the publication remote;
- authentication permits non-force push and draft PR creation;
- task branch names cannot collide with protected branches; and
- no credential grants merge, deployment, or unrelated repository access.

A project may run without eligible GitHub publication, but Reviewer decision
escalation will then block rather than invent another human channel.
