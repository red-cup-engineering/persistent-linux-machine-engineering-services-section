# Retained release-outcome observation

The existing release invocation, receiver and outcome recorder own this evidence.
It adds no release authority, watcher, schedule, deployment or native work claim.

The release program writes `release-invocation.json` into its existing run work
directory before building: selected machine revision, repository, GitHub run URL,
actual run attempt and requested mode. Candidate output preserves its existing
store path, root and Guix NAR digest, adding that same invocation binding.
Receiver receipts preserve their existing fields and add `runAttempt` from the
actual environment. Absent attempt stays false; no attempt one is invented.
Guard failures before the invocation write remain without invocation evidence;
they are preserved as unknown, not attributed failed receiving. Existing GC-root
name fallbacks do not provide run-attempt attribution. The current candidate
producer returns exactly storePath/root/narSha256, disjoint from appended fields.

`record-outcome.mjs` observes those files, the existing latest-receipt read port,
and the assembly-break record owned by the existing assembly-break implementation.
Its pure projection retains exact bytes as base64, SHA256 over those bytes, JSON
reading state and parsed objects when available. This is not a receipt signature,
a fresh Guix NAR verification, JSON canonicalization or permanent health claim.

An attributed candidate matches the invocation repository, revision, run,
attempt and mode and has its store/NAR identity. An attributed receiver receipt
additionally matches machine and candidate store identity. Staging is only
staging; promotion needs the writer's success/live-check observation for deploy
or rollback. A rollback without a bound candidate remains unattributed. Job
completion, source admission and recovery are separate observations. Incomplete,
legacy, mismatched, unreadable and malformed data remain unknown/unattributed;
readable historical evidence is retained rather than called failed deployment.

The finite failure vocabulary includes the writer's `pre-activation`,
`custody-prepare`, `custody-bind` and `custody-receive` stages. Recovery additionally
recognizes `restore-main-stop`, `restore-custody-stop`, `restore-custody`,
`restore-first-install-stop`, `restore-main-activation` and
`restore-first-install-reload`. These are observed writer stages, not permission
or success. Build and deliberate-failure previews remain confined to host-check,
staging, auxiliary-check and pre-switch-check; unknown stage names remain
unattributed. Native rollback retains the receiver's `guix.rollback-target.v1`
selection as its candidate observation. Its selected store/NAR are exact, and its
selected release revision must match the receiver receipt; the invoking source
revision remains separately bound. The prepared policy artifact is preserved as
`preparedTarget` evidence and cannot substitute for that selected artifact.

This attribution contract still depends on fabrication of the prepared native
policy target before the receiver can select a retained generation. Source
qualification and actual recovery when fabrication fails remain separate open
requirements; these source corrections neither remove rollback selection nor
establish operating rollback acceptance.

The recorder retains `release-outcome.json` beneath the existing run-and-attempt
work directory. It writes and syncs a private temporary file, installs it using
an exclusive hard link and syncs the directory, following source-admission's
existing receipt-custody pattern. Repetition with identical bytes is idempotent.
Conflicting observations refuse replacement and need reconciliation. Durability
depends on the existing filesystem; no new retention daemon or fault immunity is
claimed. This directory is not among disposable sources/workspace/artifacts or
registry-cache roots.
Each repeated recording reads latest receipt again. A changed latest observation
therefore conflicts rather than replacing the first result, even when its new
receipt belongs to another run. Assembly evidence already removed by successful
cleanup is reused from the retained exact bytes. Existing-file retries repeat
directory synchronization to reconcile an earlier link-then-sync interruption.
The existing runner-cache parent is the custody boundary. The recorder may
create its immediate run directory and synchronizes its parent entry; it does
not recursively create a new custody hierarchy.

Only after retention succeeds does the recorder emit the full machine-readable
observation in the existing Actions job log, append its path as the optional
`release_outcome_path` step output and append the human summary. Disposable
scratch is removed last. A retention or reporting failure cannot erase original
scratch. Existing Actions log retention governs remote availability; this is not
an indefinitely stored GitHub artifact or an installed automatic consumer.

The live health reader remains a separate consumer of receiver evidence; it
cannot infer every attempted build from `latest.json`. No authenticated new
endpoint or undeclared observer is introduced here. Consumers must distinguish
the latest receiver observation from the currently running release and from the
latest attempted build. Source publication alone does not qualify machine use.

Qualification includes pure exact-attribution and conflict tests, filesystem
retention/reporting checks with effects closed, and genuine existing Scheme
receiving for producer/receiver changes. Passing JavaScript projection fixtures
does not stand in for the latter or actual end-to-end receiving.
Both new Node fixture files match the existing package's `node --test
test/*.test.mjs` selection; no new runner, dependency or workflow is introduced.

## Pre-merge change-process outcome agreement

The existing ordinary PR receiver and exact reviewed-change receiver must apply
one process-result contract before reporting a completed comparison. A parseable
JSON payload alone is not evidence that its producer executed successfully.

The existing strict interface supplies the required rule: kind is change-test;
the only verdicts are no-regression, regression, incomplete and not-composed;
no-regression requires exit status zero, and the other recognized verdicts
require status one. A spawn error, termination signal, missing exit status,
malformed/null payload, unknown kind/verdict or contradictory status refuses.
Refusal reaches the existing not-run reporting path and cannot publish the
completed house-change-test marker. This changes no retry schedule or authority.

Allocation and design: keep validation in scripts/receive-pull-requests.mjs,
shared by runChangeTest and runExactChangeTest. Preserve each caller's command,
toolchain/environment and source-binding responsibilities. Do not duplicate the
controller, grant a merge, relax repository checks, or let a source-only assay
claim Guix/native receiving. The injectable process port defaults to the original
spawnSync and exists for explicit process-outcome fixtures, not caller authority.

Verify all four consistent verdict/status pairs and malformed, failed,
signal-terminated, unknown and contradictory results; exercise the existing
comment formatter to ensure a failed process cannot suppress later receiving
with a completed marker. Preserve the original ordinary receiver tests. Its
synthetic target must have the current committed machine.scm/channels.scm and
canonical Git origin, rather than the retired machine.json identity alone.
Legacy exact-receiver fixtures must bind their real canonical Git origin, including
local clones. Candidate-definition tests change and observe the target's committed
channels instead of expecting the retired target-local software lock to select a
runtime. Keep every source-integrity and refusal assertion; never weaken the
production identity contract to make historical fixtures pass. Package/machine
qualification, publication, host installation and a subsequent autonomous real
job remain distinct receiving obligations.
