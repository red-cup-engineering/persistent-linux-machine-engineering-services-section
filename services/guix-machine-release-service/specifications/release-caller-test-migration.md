# Caller test migration

The historical retired projector imported the deliberately retired
`project-release-request.mjs` and recognized legacy production fragments. The
current generic API takes complete committed consumer data and generates the whole caller; it has no machine catalog.
Retired YAML/source-admission fragments are not compatibility inputs.

## Old cases retained under current contracts

- `release-caller-projection.test.mjs` retains exact candidate source,
  actor/event/mode refusal, existing runner/lease, separate concurrency, minimal
  execution environment, lexical Guix selection, wrong Node-directory shadowing,
  pure-control ordering, source-before-execution and actual shell-byte checks.
  It now proves the invariant ordinary body from one template instead of retaining
  an arbitrary input body by fragment replacement.
- The same suite adds complete binding/schema agreement, every required field,
  unknown event/mode/runner/command options, repository ID, actual BCF effect
  inventory, explicit CRG migration hold, exact snapshot-definition binding,
  candidate root separation, fixed request digest, the21k run-body limit with
  paired roots and longest allowed branch, and current API refusal of old
  YAML. Source identities used by tests are visibly synthetic, never deployable.
- `release-caller-carriers.test.mjs` moves every exact PR event mutation from the
  old exact-receiving test: event/action, actor/sender/author case, repository
  name/ID, branch/base/head/merge, ref/number/state/fork and stale payload cases.
  It preserves genuine Git sole-parent/merge-parent evidence, shallow objects,
  whole-tree source/lock/add/delete/rename/symlink/mode/extra-parent refusals,
  all workflow-path symlink segments, hidden index edits, absolute-Git isolation,
  generated gate execution and fixed per-command reader fallback. It adds
  authenticated event-byte custody across those reads and a genuine missing
  promisor-object refusal with all verifier transports disabled.
- New source-carrier cases exercise actual repository root versus nested
  definition, commit/tree/channel and repository mismatch, hidden blob/mode,
  ignored/untracked/missing source, symlink ancestors and executable controller
  Gitlink refusal. No parser substitute or real application executor is used.
- `controller-owner.test.mjs` retains its real Git bootstrap owner, duplicate,
  missing-owner and exact-clone cases. Its projection test now accepts one current
  marker-delimited block and rejects retired forms, missing/multiple/cross-step
  markers, preserving idempotence and surrounding workflow effects. Actual
  bootstrap tests execute `controllerBootstrap()` rather than the now-refused
  raw template. Genuine file-only Git acquisition and reuse prove clean reuse,
  dirty/untracked/ignored modules, assume-unchanged and skip-worktree edits,
  hidden executable bits, cached verifier replacement, local fsmonitor
  nonexecution, same-size clean/process-filter edits, staged-only index edits and
  nested .git refusal. A clean cache with configured process filter and an absent
  local remote proves verified reuse needs neither fetch nor checkout. Every fresh
  local acquisition has inert global/system/environment filter controls and
  asserts explicit existing reader inputs survive; none of those filters run.
  The carrier control also accepts empty retired mount directories. Failed cache verification publishes no path and executes no
  selected code, even when the calling shell omits errexit. Both full workflows
  and deferred bootstrap blocks retain idempotent projection. The final owner
  root currently enrolls 22 cases. The immutable-source wrapper requires child
  exit zero, zero failed/cancelled/skipped/todo cases, and named bootstrap,
  cache-custody and recursive-source scenarios. It keeps the full immutable
  byte/mode fingerprint. It does not couple its boundary to the aggregate child
  count when either owning suite adds unrelated coverage.

## Intentionally replaced old fragment tests

The previous exact-receiving cases mutated textual preflight switch arms,
comments, grep clauses, repeated guards, early command forms and YAML aliases to
probe whether a fragment remained recognizable. Their property was that unknown
source/effect code could not gain authority. The replacement has no caller-text
input or free-form effect fields: old strings and every unknown binding/option
are rejected wholesale, and ordinary/diagnostic bodies are generated separately.
The historical conservative SQL-name refusal over sources.json+lock is
explicitly retained as a one-way current CRG policy over committed root
.gitmodules+nested machine.json+lock, with genuine local committed-byte refusal
tests and authoritative graph/provider checks remaining separate.
No test now asserts that retired `advance`, owner-map or `sources.json` guards are
accepted. Current graph, SQL, lock and provider refusals remain in their existing
owning suites; this is not permission to remove them.

## Historical final2 migration boundaries (not current cb5 edits)

In original Guix04482 `test/exact-change-receiving.test.mjs`:

1. Remove the projector import on line10 and retired release-request import on
   line11, after moving their caller coverage into the two suites above.
2. Remove only `receiving event rejects unrelated comments, principals,
   repositories and modes` (original lines31–36), covered by the current caller's
   stricter exact binding/dispatch/comment tests.
3. Remove the block beginning `const oldWorkflow=` (original line162) through
   the projected shell/request-digest test (ending line292), stopping before
   `qualified change interpreter reading refuses absent, mismatched and malformed
   identities` (line296). Do not remove the qualified interpreter/source tests.
4. Remove `const prBinding=` (original line336) through end of file. Those exact
   carrier and event cases are now in `release-caller-carriers.test.mjs`.

The receiver request/graph tests remain owned by the shared graph/receiver change.
No receiver tests are removed from this separate patch. Integrators must reconcile
these named boundaries against their current mutable candidate rather than apply
old numeric ranges blindly. The aggregate suite should contain no import of the
retired generator after integration.


## Current generic reconciliation

The accepted cb5 owner has already retired the old projector. Do not reapply the
historical numeric removal ranges to it. The new module is
scripts/project-release-caller.mjs and its test root is
release-caller-projection.test.mjs; no old projector file or compatibility export
is restored. The existing machine-neutral source scan is unchanged.

Valid new repository/actor/channel/runner/lease values are now authored consumer
authority, not catalog lookups. The old catalog-equality mutation cases therefore
move to immutable event/request mismatch checks after binding selection; malformed
values, unknown fields, executable strings and unsupported behavior still refuse
at structural admission. A third synthetic consumer proves real generic behavior.
The CLI's real-Git fixture proves committed data provenance, dirty/hidden edits,
symlink refusal and complete binding/digest embedding. Consumer fixtures retain
BCF explicit manual effects and now-merged PR718 trigger correction, plus CRG's
build-only hold, CPU setting, queued-head checks and outcome-cache option.

## Existing TypeScript fixture port

Change composition uses the selected toolchain Node for acquisition and builds.
The original acquisition-only fixture port now checks that exact requested Node
for every call, accepts only its declared inert compiler/descriptor argv, and
executes them through local Node. Original build order, once-only recipe and
nonzero/no-completion assertions remain; emitted-output assertions are added.
This is actual routing and process-status evidence using the original inert
recorder, not real TypeScript or Guix toolchain qualification. The first paired
full-run failures remain recorded rather than reclassified as successful tests.
