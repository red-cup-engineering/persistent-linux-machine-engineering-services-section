# Guix machine release service

Existing source admission, exact dependency-graph assembly, receiver checks and
single-writer machine promotion. Machine snapshots supply deployment policy;
this software does not infer grants, credentials, release targets or channels.

## Source custody

Initial source snapshot: `red-cup-engineering/computer-services-section`, commit
`e26aff3ecb58b134500c96eb6159d62f2d00fef9`, package path
`services/software-development-services-section/services/guix-machine-release-service`.
The original history remains in that repository. This delivery is an exact
package snapshot with explicit corrections, not a claim of a complete Git
history split or retirement of the original copy.

### Recover unprocessed archive-tag JSON without reactivating its machine

The original source-qualified historical Guix consumer is **not** a new
`release.yml` generator. The existing
`scripts/project-release-caller.mjs#inspectHistoricalReleaseConsumerBinding`
accepts a source read from the **original**
`@red-cup-engineering/git-source-reading-service/pinned-source-files`
supplier, with one exact Git commit (not a mutable tag/branch name), numeric
repository ID and original `release-consumer.json` path. The trusted caller
must establish the repository name-to-ID association; this adapter checks
agreement between that supplied identity and the declaration, not an
independent GitHub ID lookup. It converts the validated `owner/name` to the
canonical `https://github.com/owner/name.git` origin required by the source
reader, and requires that exact origin in the returned provenance. It admits the
**same** existing `guix.release-consumer-binding.v2` runtime type as the
ordinary active release caller, rechecks non-executable regular Git blob
identity, source bytes, fatal UTF-8 and the declaration's own repository ID.
The returned `guix.historical-release-consumer-source-observation/v1` names
`gitBlobObjectId`, `contentSha256`, `machineDefinitionPath`,
`workflowPath` and `declaredRunnerLabels` explicitly instead of treating
the old filename or ambiguous `definition` as a present operational
permission. Every historical observation has **no authorized effects** and
explicitly unobserved installation, original Work and independent consumer
receiving. It does not expose a historical binding to the effectful caller.
The 64 KiB check limits accepted declaration bytes, not the reader's acquisition
budget. The caller owns the reader's finite acquisition limits and repository
resolver; `enterDirectory: false` does not by itself prevent acquisition of a
Gitlink that lies on a nested scope. Child provenance never satisfies this
adapter's exact original repository, commit and full-path checks.

**Actual input and original receiver:** the historical
`561-group/bare-cedar-fog` tag
`refs/tags/archive/codex-kalshi-production-fabrication-20261022` retains
`release-consumer.json` at exact commit
`9740c39c1474b0940a589b419cad0af55e750f60`, Git blob
`ab173adc9bfadd41b483ae8a3b8e1976c275a077`.
The file is absent from current default. Its historical
`activationHeld:false` and `bare-cedar-fog` self-hosted runner label are
only dated source evidence; **they do not authorize bringing that obsolete
machine or workflow online**. Real receiving belongs to
[original Guix Work #101](https://github.com/red-cup-engineering/guix-machine-release-service/issues/101)
and [Coesite independent repository integration](https://github.com/coesite-operations/operations-services-section/blob/main/lib/agency/skills/receive-repository-integration/SKILL.md),
after correlating the historic data with the current machine controller,
issue history, actual code and ordinary consumer. Retirement of a Git tag,
branch, repository or Work is separate, permissioned GitHub authority.

The existing `test/release-caller-projection.test.mjs` exercises an
actual temporary native Git archive tag and removal of the same file from
`main`, with an injected source-reader port; it checks positive selection and
adverse missing, retargeted, malformed, symlink and forged Git blob evidence.
Malformed decoding cases first carry a matching Git blob hash, and nested
paths and SHA-256 provenance are covered. This suite does not itself exercise
the supplier's acquisition implementation. Private Guix native
CI/installed consumer receiving remain outstanding; passing source inspection
does not certify a Guix deployment or complete the Group's Friday Work.

### Native common-software comparison source admission (retained historical PNPM contract)

The `guix.reviewed-change-request.v3` route below remains available for a
historically selected native PNPM common-root comparison. It is **not** the
current Bare Cedar Fog registry-native software producer: the latter no longer
has the root `pnpm-workspace.yaml` and `pnpm-lock.yaml` assumed by this request.
The active source-owner chain is Code's existing
`@red-cup-engineering/npm-workspace-publication-service/source-registry-closure`
for exact release selection and packed carriers, followed by the established
committed-lock consumer installation and LAGOON's existing portable runtime
input. Do not recreate a superrepo lock, substitute Gitlinks for installed
packages, or report a v3 source-plan receipt as a Guix build.


`receive-pull-requests.mjs ROOT WORK --exact REQUEST_FILE REQUEST_SHA256
--candidate-root=ROOT` accepts the closed `guix.reviewed-change-request.v3`
source request. The request fixes the controlling Guix commit/tree, independent
baseline and candidate common-software roots, each root's fabrication recipe
path/blob, nonempty exact target definitions on both sides, and up to eight
requested owner heads. Each identity is repository/commit/tree; each target
also names its definition coordinate. There are no command, provider, runner,
environment, replacement graph or deployment fields.

The common root supplies its own committed `package.json`,
`pnpm-workspace.yaml`, `pnpm-lock.yaml`, optional `.npmrc`, and all recursive
Gitlink sources. The existing graph walker retains conflicts, cycles, original
edges and every mounted coordinate. Each requested head must actually occur in
the candidate root's graph, including the exact selected controller. Additional,
retired and moved owners remain in the complete baseline/candidate delta.
Native targets supply committed `machine.scm`, `channels.scm` and their whole
definition tree independently of the common root. A target does not need
`machine.json`, a target dependency lock or a duplicate package selection.
Retired targets remain explicit baseline obligations in the target delta.

Admission authenticates complete committed source objects, canonical repository
origins, regular interface bytes, both common roots and the fixed request again
before returning its source plan. The selected commit and every selected
tree/blob are content-hashed offline; redirected/borrowed object storage is
refused. Binary object reads are bounded to 64 MiB per 32-object batch; an
oversized batch refuses admission. Unselected parent-history objects are not
required by this source-only boundary. Working files cannot replace committed locks
or interfaces. This increment deliberately returns `incomplete` at
`native-product-receiving`, with `runtimeAcceptance: false`. It invokes neither
the legacy provider nor any candidate program and never emits `no-regression`,
even for unchanged roots. It does not qualify native fabrication, engineering
assays, target interfaces, a runner or deployment.

The existing LAGOON native fabrication and immutable collection inputs are the
next receiving boundary, specified in
`specifications/candidate-toolchain-qualification.md`. The old hosted adapter
does not admit this request or the current common-software architecture.

### Legacy preparation source evidence

`node scripts/prepare-sources.mjs --source-only SNAPSHOT WORK` prepares a fresh
source-reading artifact through the existing release materializer. The committed
legacy machine's `machine.json` supplied `run.entries`, `run.buildEntries` and
`run.receivingPackages`; its own repository and all recursive Git mounts supply
the source commits. The command uses the same machine-directory, unique package
ownership, workspace dependency, SQLite and literal import/export checks as
ordinary preparation. It accepts no separate source list or source override.

The artifact retains the original lock bytes and digest, every source commit and
tree, committed manifest identities, generated manifest/import witnesses and an
exact refusal when preparation cannot complete. It creates source carriers only
under a fresh output directory. It fetches the exact mounted Git source carriers.
It does not invoke Guix, resolve or acquire registry/vendor dependencies,
build applications, run receiving tests, push source or deliver a
machine. The selected Group parser remains the existing source-reading tool;
application modules and package scripts are not evaluated.

`source-prepared` describes source preparation only. The receipt keeps frozen
lock reading `unread` until a genuinely qualified frozen reader is separately
bound; it establishes neither source admission nor operating acceptance. Missing
mounts, an older `sources.json` formation, source interface failures and DRC-3
refusals remain owning source work, with exact input evidence retained.
The source-only phase remains subject to the caller's bounded source and machine
rules; it does not authorize a recursive superrepo fetch on a development laptop.
This retained package-workspace interface is not a native common-software
selection adapter. Its source controls do not establish current native receiving.

## Runner space

A local builder (no `receiverHost`) runs `scripts/reclaim-runner-space.mjs` before it builds: it removes earlier runs' directories
under `~/.cache/561-group/github-<machine>-runs/` and day-old `github-source-bootstrap` checkouts, then runs
`guix gc --free-space=8GB`. If the disk is still below that floor the release fails there, with a report, instead of mid-build.

## Retention

After a receive passes its live check, `scripts/release-retention.mjs` trims the release root. It keeps
`current`, `previous` (the release just replaced), the pre-Guix `current.before-guix` target and any release
a user unit names; it removes other hashed release trees, stale `.staging-*`/`.probe-*` scratch (older than an hour)
and empty `.materialization-*` markers, never an entry a live process maps or holds as its working directory.
It deletes the release profile's other Guix generations with an explicit generation list. Guix store outputs
are reclaimed by `guix gc` once unrooted; this does not run it. `--dry-run` reports without removing.

## Pre-activation

A machine may declare `preActivation` steps in `machine.json`. They run after the candidate passes its isolated
probe and auxiliary checks and before the switch, so the held release keeps serving throughout. Each step is a
`program` inside the candidate, run by the candidate's own node with its `arguments` (`{stateRoot}` and `{release}`
substituted), under `nice -n 10` and idle-class `ionice`, with only `HOME`, `PATH` and `LANG`, within
`timeoutSeconds` (default 3600). Under systemd an optional `memoryMax` runs it in its own scope with that memory
ceiling, so memory pressure ends the step rather than the serving unit. Each directory a `freeSpace` declaration
counts is logged with its size first. The step's output and errors reach the run log redacted (see below), at most
2000 lines. An optional `freeSpace` (`root`, `carries`, `into`, `marginBytes`) refuses the step unless
the filesystem holding `root` has room for every directory ending in `carries` beyond what its sibling ending in
`into` already holds. Name a program by its path under `packages/`: the
`node_modules/` entry is a symlink, and a script that compares its own path with `import.meta.url` runs nothing
through it. A step may declare `expect`, the `kind` of the JSON report it prints; it then passes only
if some line of its output is a JSON object of that kind, so a step that exits 0 having done nothing cannot pass.
A step that is refused, fails, outruns its budget or does not report its expected kind stops the receive before
the switch.

```json
"preActivation": [{
  "program": "packages/@red-cup-engineering__semiotic-eavt-services-section/scripts/carry-located-indexes.mjs",
  "arguments": ["--root", "{stateRoot}"],
  "memoryMax": "600M",
  "expect": "located-index-carry.v1",
  "freeSpace": {"root": "{stateRoot}", "carries": "index/causal-admission/v2", "into": "index/causal-admission/v3",
                "marginBytes": 2147483648}
}]
```

When a live check fails, the receiver prints the unit's own journal (or its Shepherd status) before recovery:
the last 200 lines, bounded to 30 seconds so a wedged journal cannot hold recovery. Everything the receiver shows
from a command passes through `redact-line`, which replaces Authorization/Bearer values, key/token/secret/password
assignments, known token prefixes (`ghp_`, `gho_`, `sk-`, `xox?-`, `AKIA`, …) and any run of 32 or more token
characters that is all hex or mixes digits with upper and lower case.

## Verification

`npm test` discovers all Node tests, including source materialization,
immutable source identity, explicit controller ownership and test selection.
Owner tests run the shell bootstrap against fixture sources (a recording Git; refusals happen before any clone).
The existing native receiver additionally runs the Guile fixtures in
`test/health-reading.scm` (which loads the receiving and pre-activation fixtures) and `test/controller-owner.scm` through `check-host.mjs`.
Run these in the existing pinned Guile/guile-json environment. Node passes
are not a substitute for those Scheme tests or full machine receiving.

Host admission selects SignChain endpoint regressions, SignCraft history
derivation/projection tests, and FeltOS world/work-cycle/work-status tests from
their actual admitted package paths. The argument-recorder unit test verifies
selection, not provider behavior; the selected provider tests run in receiving.

## Package-owned receiving tests

A trusted source package can own its receiving selection in `package.json`:

```json
{
  "receivingTests": ["test/checkout-health-dispatch-readout.test.mjs"]
}
```

The machine's committed `machine.json` selects package names under `run`:

```json
{
  "run": {
    "receivingPackages": ["@red-cup-engineering/computer-code-development-engine"]
  }
}
```

This allowlist does not add a dependency or source owner. Each selected package
must already be uniquely selected in the existing entry/build-entry dependency
closure, under the existing pinned source ownership and admission rules. An
omitted or empty allowlist preserves legacy-only receiving. A selected package
must declare a nonempty array of unique relative file paths. Paths may contain
only letters, digits, `.`, `_`, `-` and `/`; absolute paths, empty/dot/parent
segments, globs, backslashes, missing files and symlinks are refused. Every test
must be a tracked regular file included by source materialization. No commands,
runner options, scripts, environment values or automatic discovery are accepted.

Preparation reads the exact committed Git tree, even if its checkout differs.
For selected packages, `sources.json` records `receiving.version: 1`, the original
manifest under `receiving.manifest`, and `receiving.tests` entries containing
`path`, `gitBlob` and `sha256`. The existing `sourceManifestSha256` binds the
original manifest's JSON identity before dependency rewriting and removal of dev
dependencies. The test records bind both the committed Git blob identities and
exact file bytes. Manifest-only lock resolution also validates declarations and
records these identities; it does not materialize executable tests and cannot be
used as a receiving artifact.

`check-host.mjs` validates the complete selected set before any legacy or selected
check executes. It checks the original manifest binding, repository/commit
admission, unchanged materialized declaration, path types and test byte hashes.
The existing Guix carrier links its top-level entries to one admitted runtime.
Receiving resolves that boundary only when `packages`, `.metadata` and
`.controller` directly link to the same canonical runtime root, then validates
regular paths beneath it. Package-owned, test and intermediate symlinks remain
refused; direct prepared closures also remain supported with direct metadata and
controller directories when present, never a mixed direct/linked layout. Metadata
`sources.json` must also be a regular file in either layout. This checks the
trusted immutable artifact's layout; coherent links alone do not authenticate an
arbitrary caller-created directory or replace existing source and machine admission.
Selected tests run per package as the candidate's `process.execPath --test` with
explicit absolute paths and that package as working directory. The environment
contains only candidate-first `PATH`, the fixed 384 MiB `NODE_OPTIONS` limit, and
available temporary-directory/locale/timezone variables (`TMPDIR`, `TMP`, `TEMP`,
`LANG`, `LC_ALL`, `TZ`). Caller loader, skip, test-runner and credential variables
are not inherited. These are reviewed executable tests, not a sandbox; the
existing trusted source admission and immutable candidate remain the boundary.
Tests use the admitted dependency graph and do not install dependencies or invoke
package lifecycle scripts. All other legacy checks retain their environment and
order, including the controller's existing `npm test` self-regression.

The first migration supersedes only code-engine's temporary hardcoded bridge.
Because controller and machine source admission can advance independently, that
existing bridge remains as a compatibility fallback until the machine explicitly
selects code-engine in `receivingPackages`. With selection, the complete validated
package declaration runs once and the bridge does not run. Missing or invalid
selected declarations are refused, rather than falling back. A controller-only
update or an absent/empty allowlist therefore cannot silently remove the existing
gate. Admit the consumer manifest before or together with its machine selection.
Thereafter the package changes its own declaration/tests through ordinary owning-
source review; existing automatic source admission carries those changes without
a controller catalog edit. Dependency versions and production dependencies are
unaffected.

## Committed runtime vendor carriers

Source discovery does not select packages beneath `vendor`. Source preparation
normally excludes that directory, but retains exact regular Git blobs reached
from the admitted Node runtime export/bin surface through literal module edges.
The existing Group parser records those files with repository, commit, package,
relative path and Git blob identity. Preparation uses that same record to retain
only reached vendor carriers; their adjacent committed basename `.map` files are
also retained when named by a source-map comment. No vendor directory is copied
wholesale, no checkout bytes are used, and no bundle is regenerated or edited.

Unselected nested package membranes, symlinks, untracked files, `node_modules`,
`.git` and `legacy` remain excluded. Wildcard-only exports outside an authored
`files` surface remain diagnostic and do not expand vendor materialization.
Literal conditional edges retain their named carrier without becoming proof of
unconditional execution. Parse/read gaps remain diagnostic; a reached regular
file keeps its identity, but that does not prove all of its transitive inputs.
The reading remains the runtime export surface, not a complete build-script,
computed-import or parser-unavailable closure claim. Manifest-only resolution
records the same demand and identities without materializing executable files.

## Committed source ownership

The native common software is selected by its own committed repository and
whole root lock. Target declarations remain separate, as described above.
The retained package-workspace preparation contract read the machine's own
repository at the release commit and every
repository it mounts recursively by Gitlink: the repositories mounted by the machine repository and by
the repositories it mounts, each once. A receiving package has what its own repository mounts inside the package
in place at the commits the gitlinks record, so its tests see the repository as committed; this is not specific to
any package or machine. Its legacy `machine.json.run` selected the
entries, build entries and receiving packages. Every
selected package has exactly one home in that graph. Missing owners, conflicting
mount commits and unavailable workspace dependencies refuse before acquisition;
an old parallel `sources.json` machine declaration is refused. Generated
`sources.json` inside a prepared artifact records the derived sources and
manifest witnesses; it does not select a second graph.

The repository mounts `red-cup-engineering/guix-machine-release-service` exactly
once at its committed Gitlink. The package is that repository's root.
`scripts/project-controller-bootstrap.mjs` projects the owned shell bootstrap
into an existing machine workflow. The bootstrap reads that exact mount with
Git. Projection prints a candidate and preserves the existing grants, target,
scheduling and release modes.

Source changes are received through their owning repositories and the machine's
mounted source graph, with its corresponding reviewed dependency lock. The old
parallel pin-advancing and push/deploy procedure was retired by the accepted
source-formation work. Source preparation does not replace lock review or
receiving. Distinct declared release channels keep their existing meaning.

The existing receiver writes correlated result receipts. A successful Actions
job can also mean source advancement or superseded work; only the matching
receiving receipt establishes promotion. This package adds no separate watcher.

A standalone native target can bind `nativeController` (the reviewed controller's
repository, commit and tree) and `nativeInputs` in the existing committed
`release-consumer.json` projector input. This caller authenticates the event,
workflow, exact target source and channels, then requires explicitly configured
`GUIX_COMMON_ASSEMBLY_RECEIPT`, `GUIX_COMMON_SOFTWARE_RECEIPT` and
`GUIX_COMMON_SOURCE_SNAPSHOT`. A target requiring the one-time custody source also
declares `GUIX_ONE_TIME_CUSTODY_SOURCE`. These inputs must be retained on the actual
builder; there is no default host path or old-release fallback. Missing inputs
refuse before controller acquisition and release effects.

The native arm of `github-machine-release.scm` verifies the common Guix store
output, held root and NAR before loading its LAGOON target phase. LAGOON receives
the original assembly/selection/command/compiler receipts and exact committed
target, then forms its authenticated envelope without another package install or
software graph. Guix `build-target` checks that envelope against the same software
receipt. Receiving policy and outcome observations then use the sealed target's
generated `.controller/machine.json`; authored machine JSON and source inventories
are not native caller inputs. The existing receiver retains staging, activation,
rollback, credentials and correlated receipt ownership. Caller projection alone
does not publish or qualify the still-required common artifact inputs.

For rollback, the new target is retained as the prepared policy artifact rather
than mislabeled as the candidate to restore. Under the existing release lease,
the receiver selects the actual retained `previous` store, computes its NAR and
records its original machine revision in the existing receipt directory before
receiving effects. The native outcome reader consumes that exact run/attempt
selection. Invocation source revision and restored artifact revision remain
distinct; receipt attribution requires exact selected store and revision equality.
An unavailable selection or failed receiver stays unavailable or failed.
Native CI requests this mandatory custody with `--record-rollback-target`.
Standalone/manual `previous` receiving retains its existing invocation contract
without GitHub IDs; the shared receiver does not synthesize them or impose CI
attribution on that operation.

The native `receiving-policy` may bind `retainedReleases` as closed, exact original
artifact records. Each record retains its original repository/revision, verified
GitHub repository ID/node ID and transferred repository name, original source
receipt digest, declared entry/host/instance, and explicit hashed files. These are
rollback inputs for that immutable generation, not source graph declarations.
The current structural receiving owner validates those confined bytes, original
sealed metadata, manifest-to-launcher-to-programme relationship and host/instance/
profile declarations. It never executes the original artifact's obsolete package
suite checker or demands that an original programme expose the successor's
FeltOS driver. The existing receiver still owns isolated boot, useful readiness,
custody transition, promotion and recovery. Structural declaration receiving does
not assert useful operating success. Only the exact admitted original runtime's
configuration files, auxiliary declarations, managed retirements and media flag
are selected from its hash-bound sealed machine config. Successor release/receipt
roots, state, lease and semantic custody rollback authority remain current; no
old migration or package preparation is restored. Successor-only managed
configurations retire through the same atomic backup/restore boundary.

## Group agency

A machine whose node reads agency records (`METROPLAT_AGENCY_ROOT`) declares where they come from in
`machine.json`, so no machine depends on a hand-filled copy. `agency.root` is a path in the machine's own
repository. At assembly, `scripts/assemble.mjs` carries every directory under it that organizing reads pools
from (a section's `lib/agency`, or `skills` directly in a `*-section`/`*-service` directory) into the
release's `agency/`, at the same relative paths. It passes over what organizing passes over (`legacy`,
`vendor`, `_archive`, `node_modules` and the rest) and never copies a symbolic link. `agency/.agency.json`
records the declared root, the machine commit and the counts. A declared root outside the repository, or
one holding no agency, stops the assembly.

The node reads it in place. The machine's `machine.scm` environment points `METROPLAT_AGENCY_ROOT` at
`{release}/agency` and `AGENCY_ACTS_LOG` at a journal in its state:

```scheme
("METROPLAT_AGENCY_ROOT" . "{release}/agency")
("AGENCY_ACTS_LOG" . "/home/emsenn/.local/state/561-group/<machine>/agency-acts.jsonl")
```

The release is immutable, so each release reads exactly the records it was built from. A rollback reads the
held release's own records, with nothing to copy, swap or prune. Governing acts the node enacts at runtime
(seatings, foundings, record amendments) go to the acts journal, which organizing reads as the head of each
record's chain over the authored tree (`services/organizing/src/agency/acts.mjs`). The release probe
already runs with its own scratch journal. A node without `AGENCY_ACTS_LOG` would try to write the
authored tree itself, and the read-only store refuses that loudly instead of drifting from the source.

## Machines without systemd, and ephemeral machines

`machine.json` may name its `supervisor`: `systemd-user`, the default, or `shepherd` for a
machine whose PID 1 is not systemd, such as a container. Every generation carries both forms:
the systemd units in `.guix-systemd/` and a GNU Shepherd registration in `.guix-shepherd/`, with
the same launcher and environment files. The receiver drives whichever one the machine names.
Under Shepherd it loads the registration with `herd load`, and it runs the isolated probe and the
auxiliary checks as its own children. A Shepherd machine may not yet declare auxiliary units.

An ephemeral machine has no standing host for a release runner. A colony in a Claude Code cloud
environment, for example, is provisioned fresh and loses its processes when the session ends. It
brings itself back with `scripts/ephemeral-boot.sh SNAPSHOT`, run from this controller checked
out at the commit the snapshot pins. Every stage of the boot is idempotent:

1. Install Guix from the verified binary release, and run its daemon without systemd.
2. Install GNU Shepherd from the machine's pinned channel.
3. Route the private scopes in the machine's registry declaration to its origin
   (`deployment/registry.json`, the same file the registry server reads: `origin` and
   `privateScopes`), then write the private state and environment file. A machine that declares no
   registry has no scope routed; the boot assumes none.
4. Resolve, assemble, seal and receive the committed snapshot by this controller's own stages.

The release is local, under the snapshot's committed identity. It is not an admitted main-merge
deployment, which remains the deploy mode of `github-machine-release.scm`.

## No Python, no REST budget

Releasing needs only what Guix provides (Guile, Node) and git. The workflow bootstrap is shell; build swap
(`prepare-build-swap.mjs`), the run's outcome summary (`record-outcome.mjs`) and the website wake check
(`live-release-matches.mjs`) are Node in this package. GitHub is read through git (`ls-remote`, commit-graph-only
fetches) and GraphQL (`scripts/github-reads.mjs`), never the REST API budget every agent on the account shares.

## Receiving pull requests before merge

`scripts/receive-pull-requests.mjs SNAPSHOT WORK [--limit N] [--dry-run]` reads the open pull requests of
every repository the snapshot pins, into the ref that machine tracks, and runs the change test on each head
commit not yet received. The verdict (regressions, and failures that already fail without the change) is
recorded in the original pull request with a marker for that exact head and machine snapshot. A supplier
change therefore requires new receiving. Original PRs and comments are fully paginated; only comments by
the configured authenticated provider actor count. Unexecuted or uncomposed attempts remain retryable after
one hour. Selection is oldest across repositories. Drafts and forks are skipped; at most `--limit` heads
(default 2) are received per run. The command uses the machine's mounted source
graph and its declared refs. Its invocation belongs to the existing reviewed
workflow and runner; source preparation adds no schedule or runner. It reads
through GraphQL and git. The runner's existing credential
fetches sources and records the verdict; the pull request's own code never sees it. Builds, generators and tests
run with `GH_TOKEN`, `GITHUB_TOKEN` and their enterprise forms removed and gh pointed at an empty configuration
directory.

Change composition uses the reviewed snapshot lock and the same exact pinned
Guix frozen provider as the fixed toolchain assay. It never bootstraps pnpm through
npm or retries a failed frozen install by resolving a different graph. Missing
locks, unqualified tools, SQLite source/dependency carriers and manifest/lock
differences remain named refusals with source evidence retained for correction.
The base is composed lazily once per comparison. Prior mutable workspaces and
completion markers never bypass fresh source and dependency admission. See `specifications/candidate-toolchain-qualification.md` for the
acquisition boundary and the distinct fixed-provider versus composed receiving
scopes. The production acquisition preflight remains closed.

## Design-rule deck and assembly breaks

`scripts/design-rules.mjs SPEC` reads version 1 of the fabrication line's design-rule deck from the exact
committed sources a prepare-sources spec names, each violation under a stable key:

- **DRC-2 one owner:** a package name defined at more than one path across the pinned repositories.
- **DRC-3 no SQL:** a runtime import of `node:sqlite`, `better-sqlite3`, `sqlite3`, `@fedify/sqlite`,
  `@libsql/*`, `pg`, `mysql`, `mysql2`, `knex`, `drizzle-orm` or `@prisma/client` in the closure's runtime
  code, outside the files a package lists in its manifest's `sqlAdmissionPaths`.
- **DRC-6 no misfold:** an operation a package exports (a module its manifest's `exports` names) that only
  re-exports, aliases or forwards to a capability a dependency already exports, read by the owner's
  `misfoldsOfModule` (computer-coding-services-section, `node-js-packages-engineering-services-section/src/misfold.mjs`) as
  the machine composes it. Without that package in the composition DRC-6 is reported `unread`, never passed.
- **copy:** the same code file (Git blob, 1 KiB or more) in two packages of the closure, keyed `copy:<blob>`.
- **DRC-7 legacy kept:** a file deleted under a `legacy/` path (or from a `*-legacy` repository) that no
  `migration-ledger*.json[l]` in the repository names.

The change test runs the deck as a ratchet. The machine as pinned is the baseline, and a violation the change
adds (or an unledgered legacy deletion) is a regression; removed violations are reported. At one machine's
pins on 2026-10-10 the reading holds 23 DRC-2, 11 DRC-3 and 3 DRC-6 violations: the debt of the design's
section 7, recorded and owed.

### Keyed to the Software Process Design Kit

Every violation carries `pdk`, the rule of the July 23 Software Process Design Kit it enforces (bare-cedar-fog
`.../leader-movement-team/content/documents/articles/notes/2026/07/23/2026-07-23-software-process-design-kit.md`):
DRC-1 routing and PDK-4 wiring enforce rule 4 (wiring is code); DRC-2, copies, DRC-6 and DRC-7 enforce rule 5
(fabrication is subtractive); DRC-3 enforces rule 1 (a unit's own append-only records are its only deposit). The kit
adds three checks the deck lacked:

- **PDK-3 law pinned:** a module that reads another Group package's law file (JSON, schema, notation: by
  `resolve` or a JSON import) and never digests it.
- **PDK-4 wiring:** a declared Group dependency that no code of the package imports or resolves, and no manifest
  script names.
- **PDK-7 no assertion:** a committed record (outside tests and fixtures) that stores `health`/`healthy`, or a
  health-word `status`, instead of deriving it by a check.

At that machine's pins the kit's checks add 2 PDK-3 and 326 PDK-4 violations (declarations written by hand
beside the code: dependencies only tests import, or nothing does), and no PDK-7 violation.

### STD-ONE-LOG

Records go through one writer, `semiotic-eavt-services-section/record-semantic-record`. Two checks, both keyed to
kit rule 1, guard that writer:

- **one-log:** runtime code that writes raw SEAVT rows itself, either by calling `appendSeavt`/`appendSeavtEntries` or by importing
  `witness-journal-log-service`. It is keyed `one-log:<package>:<file>:<writer>`. The journal's owners write its rows and are
  exempt: every package of computer-data-services-section, and the witness-journal services of
  semiotic-software-services-section.
- **journal-hand-append:** runtime code that appends to a `.jsonl` file by hand (`appendFileSync`), keyed
  `journal-hand-append:<package>:<file>`.

Tests, legacy paths and comment lines are not read. At that machine's pins on 2026-10-10 the closure holds 3
one-log violations (trashpanda's settlement witness, feltos's roadmap journal, divination's daily reading) and
12 journal-hand-append violations. Folds remove these one PR at a time, and the ratchet refuses new ones.

Every assembly failure is named by its class (`scripts/assembly-breaks.mjs`: `unpinned-workspace-dependency`,
`unexported-interface`, `divergent-copy`, `stale-consumer-after-rename`, `undeclared-import`,
`repository-formation-unavailable` for a clone or fetch that fails, a ref gone while its pin is held, or a commit
the remote no longer serves), written by
prepare-sources as a `561-group.assembly-break` record beside its workspace, returned in a `not-composed`
change-test verdict, and shown in the release outcome summary and the pull-request receiving comment.

## Group session start

Every Claude Code cloud session starts from this controller. `scripts/session-start.sh` puts Node 24 on
`PATH`, points the Group scopes at `https://registry.561.group/`, fetches this controller and the machine repository
it is given (`session-start.sh OWNER/REPO`) for the change test, names any pinned repository the session cannot read yet, and gives the session the
founder's standing rulings. `session/receive-change/SKILL.md` is the receiving skill.

A repository carries the projection: `node scripts/project-session-bootstrap.mjs REPOSITORY --machine OWNER/REPO` writes the
SessionStart hook into `.claude/settings.json` (keeping its other settings), the shim
`.claude/hooks/session-start.sh` (from `session/session-start-shim.sh`; it fetches this controller and runs
its session start, so changing the session start here changes it everywhere) and the skill. `--check`
reports drifted copies without writing. A repository that deliberately ignores `.claude` (bare-cedar-fog)
is refused; its sessions start from the cloud environment's setup script instead:

```sh
git clone -q --depth=50 https://github.com/red-cup-engineering/guix-machine-release-service ~/.cache/561-group/controller
bash ~/.cache/561-group/controller/scripts/session-start.sh --install-user OWNER/REPO
```

which installs the same shim as a user-level SessionStart hook and the skill under `~/.claude/skills`.

## Earlier work
- `lib/legacy/2026-08-29-atlas-guix`: Earlier atlas Guix material. Origin: 561-group/bare-cedar-fog `guix`, restored from commit 9effe0d on 2026-08-29.
