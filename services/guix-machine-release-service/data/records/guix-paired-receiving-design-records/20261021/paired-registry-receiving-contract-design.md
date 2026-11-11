# Original Guix149/150 and CDE13: paired registry receiving refinement

This is read-only requirements/design intake, not a new executor, qualification,
merge permission or machine receipt. The original work remains Guix#101 /
BCF#765 and its existing change receiver. No source, graph, binding, test,
build, publication, profile, host, lease or authority was changed by this intake.
The Code full-v2 candidate and its operating-GHS release hold remain separate.

## Original authority and useful capability

Guix149 head e840d63cfbdcff09eab07f68937ce0114efc4920 and Guix150 head
9dd914a1e4b6ce464e396d84a7e264a605363386 both descend from current canonical
Guix main c54c65064e678963c00e36edcded771ac473988c. The mounted checkout is
older 0f4c07a944fbdfb7528b5b5fafc541b38c499d59; it is not current authority.
The retained primary captures include the complete original PR bodies and
the relevant source/specification bytes, with actual Git blob identities.

* [Guix149](https://github.com/red-cup-engineering/guix-machine-release-service/pull/149)
  preserves unavailable measurements and introduces only source admission for
  registry consumers without a root workspace. Its 130-case source receiving
  does not implement the paired native executor; its own contract requires
  incomplete/runtimeAcceptance:false until that executor is received.
* [Guix150](https://github.com/red-cup-engineering/guix-machine-release-service/pull/150)
  owns the existing process/verdict decoder. Parseable stdout cannot override
  spawn error, signal, absent status or contradictory exit status. All four
  recognized outcomes remain; no failed producer may emit the completed marker.
  This does not supply a missing machine product or native Work binding.
* [CDE13](https://github.com/red-cup-engineering/computer-deployment-engine/pull/13)
  head1f94535017573c8c6fcb789d7e9d2f3df0372915, tree654dee5d72e6768943a13a53442b05385c21a367,
  is the unique read-only `check-target CHANNELS STORE PROFILE TARGET` entrance.
  The original accepted review and [comment6230578338](https://github.com/red-cup-engineering/computer-deployment-engine/pull/13#issuecomment-6230578338)
  retain321Guile/Guix+25Node source/packed checks while withholding merge.
  [Comment6269991827](https://github.com/red-cup-engineering/computer-deployment-engine/pull/13#issuecomment-6269991827)
  expressly says current receiving/rollback's internal check-receiving-target,
  later deployments and ancestry do not discharge that distinct entrance.

The explicit CD exact-candidate machine no-regression merge requirement remains.
No source-only exception is inferred. Existing single-product G3 or CDE3.4 native
receipts establish their own useful source/artifact/operating outcomes, not two
sides of this original change comparison. They can qualify reusable suppliers
only within their actual identity and channel contracts.

## Existing-owner allocation

Keep request/custody/result at `scripts/receive-pull-requests.mjs`; retain
`receiveReviewedChanges`, its immutable request digest, repeated source checks
and original-thread result. Put paired orchestration in existing
`scripts/test-change.mjs`, preserving original comparison and test-measurement
semantics. Guix150's single decoder belongs in that same receiver, not a queue.

Keep source facts at `source-pins.mjs` / `materialize-sources.mjs` using their
actual commonSourceIdentity, committedSourceFileIdentity, mountedSourceClosure,
sourceGraphDelta, nativeTargetSourceIdentity and registryConsumerSourceIdentity.
The complete inventory root needs no package.json, workspace or lock. The selected
Node deployment consumer does need its own committed package.json/native lock and
existing `./machine`/`./channels` exports selecting its exact definition. That is
a consumer-specific PNPM precondition, not a universal repository requirement.

Code owns actual frozen installation and runtime packing through published
`receiveSourceRegistryConsumers` and `produceRegistryRuntime`; Guix must not
create another resolver, lock parser, installer, TAR/Git codec or receipt authority.
CDE's existing Guile driver owns build and the sealed target predicate. Adapt
CDE13 at the actual current driver, keeping its unique read-only command and the
current activation/storage/retention capabilities intact; do not patch a retired
driver copy or replace the much larger current package manifest with its old one.

## Closed request and two independent sides

Guix149 already defines exact `guix.reviewed-change-request.v4` keys:
kind/controller/baseline/candidate/changes. Each side has software repository,
commit/tree and nonempty bounded targets. A target includes its exact mounted
coordinate and repository/commit/tree/definition. At most one root consumer per
repository is supported. Reuse this supported boundary first; widening to nested
or multiple consumers is not necessary to complete the original current pair.

Retain all v2/v3 laws and explicit source-only v4 behavior until the executable
refinement and its tests are independently received. Neither silently reinterpret
v3 nor turn receivingTests property presence into enrollment. No caller-selected
test command, package inventory, executable recipe or alleged success receipt is
admitted. Derive engineering obligations from actual committed declarations,
retain removed baseline owners/test paths/enrollment/targets, and establish each
requested head's actual participation in the resulting product or qualified tool.
Registry dependencies must be the exact immutable bytes selected by that side's
lock; separately testing an unselected source checkout is insufficient.

Each side uses separate fresh owner-controlled installation/work/runtime/build
custody. Never borrow the other side's mutable installation or call an old R its
missing baseline. Bind consumer source coordinate and committed manifest, lock,
configuration presence/absence and effective policy; bind graph and target deltas
and every constructor/checker/Guix/channel identity. Keep a positive obligation
inventory, rather than treating empty package results as no-regression.

## First real unreceived supplier edge: effective native policy

Actual installed Code14.24 source-registry-closure API was read, and its bytes
match the unchanged API in the current full-v2 source candidate. It stages the
local manifest, native lock, local pnpm-workspace.yaml when present and .npmrc.
It preserves workspace exception arrays when that local workspace policy exists;
without one it adds only the supplied genuinely received release exclusions.
It can apply manifest registryConsumption.minimumReleaseAge. Its child inherits
process.env and receives a fresh staging directory under the chosen logs.
Its receipt reports local workspacePolicyDigest and minimumReleaseAge, not a
complete inherited-policy/configuration/hook identity. Copying .npmrc alone does
not prove native parent/global/environment precedence remained equivalent.

Therefore Guix149's complete effective-policy prerequisite is still unreceived
for the general paired operation. This is established from the original explicit
contract and actual invoked owner implementation, not from missing projections.
The new Code full-v2 comparison does not modify this policy owner or authenticate
caller-authored operation JSON, so it cannot silently discharge that prerequisite.

Before executable admission, qualify at the existing Code owner one finite native
policy context for each selected consumer: the native PNPM/tool version, actual
source/configuration identity including absent inputs, relevant inherited/project/
user/global/environment policy provenance and supported hooks, and the unchanged
effective settings used by isolated frozen receiving. Either receive the supported
inputs through PNPM's existing native configuration semantics with reproducible
custody, or explicitly refuse unsupported inherited/hook contexts. Do not write a
new configuration parser, import untrusted PNPM hooks as an observer, expose
credentials in receipts, globally zero package age, waive committed consumer law,
or claim package-local digests are complete. Fresh exact received house-release
exclusions must remain source-owned and conform to current Group rules; no broad
external-package exception is introduced here. Exact API/receipt amendment needs
independent detailed design before source implementation.

## Fixed paired operation after supplier admission

For each side, the existing receiver invokes and retains these owning operations:

1. `receiveSourceRegistryConsumers({consumerPaths,releases,logDirectory,...})`
   from the selected authentic published Code supplier, with the received native
   PNPM entry and finite admitted policy context. Require exactly one matching
   frozenInstall row per selected consumer, no refusals, source path/name/version,
   manifest/lock/effective-policy binding and actual invocation/log/output custody.
   A supplied JSON file or node_modules directory is not that operation.
2. Execute all source-declared engineering and valid receiving obligations through
   the existing fixed bounded runner/interpreter context. Removed obligations and
   requested changed suppliers remain visible. Do not fabricate readNodeWorkspace
   for a registry-only inventory; use the actual owning source API where applicable.
3. `produceRegistryRuntime({consumerPath,receiving,destination,transferInstallation:false})`
   receives that same live result/installation. Retain kind
   npm.registry-runtime.produced, source/output/name/version, manifestDigest,
   lockDigest/workspacePolicyDigest/rootIntegrity, confined output and numeric files
   count. Observe any needed final tree inventory under retained custody; files
   is not an inventory. Final consumer/source/configuration identities must hold.
4. Invoke the selected CDE driver's existing `build CHANNELS LOAD-PATH DEFINITION
   SOURCE ROOT`, with this runtime as SOURCE. Retain actual constructor/Guix/channel
   identities, full registered immutable store output, build root and source facts.
   Do not use a release wrapper whose build-only exit follows deployment effects.
5. Invoke source-qualified `check-target CHANNELS STORE PROFILE TARGET` on each
   exact product. Bind store/profile/target/mainUnit/hostKind/instanceId/executionRole
   to the same side. This observes sealed target facts, not Git provenance.
6. Reverify request/controller/both source graphs and configuration, product/store
   integrity and all operation bindings, then apply existing comparison semantics
   only after positive completion of every required stage on both sides.

Premerge bootstrap is a concrete design question, not a reason to merge first:
current accepted CDE has the internal receiving predicate but lacks check-target.
The exact candidate CDE13 driver can be a separately source-qualified read-only
checker under the original trusted qualification route; no profile effects or
runtime installation are intrinsically required to invoke that source command.
Before coding the paired consumer, independently bind which exact checker serves
each side and its imported Guix/channel match. Clarify whether the original
“matching pinned driver” permits one fixed qualified candidate checker to read
both outputs while baseline/candidate constructors remain independently selected.
Do not assume that permission, substitute a private copied predicate, or label a
baseline driver without the entrance as a successful observation. Constructor
changes themselves must participate in the exact candidate product.

## CDE13 behavior which must survive current-source reconciliation

CHANNELS is previously authenticated, effect-free/stdout-free trusted Scheme,
evaluated by existing current-pinned-guix; this API is not a sandbox. It must match
the full channel name/commit list of the imported Guix. STORE must be a registered,
canonical top-level native store directory; registration is checked before/after.
PROFILE is absolute and equals the sealed declaration. Only the existing BCF/CRG
targets are supported. Preserve current regular declaration/unit/environment/
instance/host checks and CRG actor-only/worker support. Emit one JSON object only
on success; unknown arguments and inconsistent bindings refuse nonzero.

Dispatch bypasses activation lease/profile creation. No build, time-machine,
retention-root creation/deletion, install, activation, rollback, health inspection,
host mutation or live service operation occurs inside check-target. The caller's
existing build root retains the output; collection causes refusal, not new roots.
Current CDE0.4.1 is separately being qualified for owner-work oracle fixtures;
its two-file proposal does not provide this command. Reconcile after that source
stabilizes rather than overwriting concurrent CDE work.

## Native closure and existing proof available for reuse

`native-prerequisite-locators.json` binds exact native Code14.24 package/API bytes,
CDE3.4 source/artifact/ordinary/native receipts, current CDE4.1 proposal and the
original selected native Guix command. The latter is
`/gnu/store/4g31m3fhqbkn0md9hnzfliq997j7fgpk-guix-command`,
SHA2565533b8fd9fc23027f67cb07e7d25307c2d7e0d998d72f6b9ac7450a725671296.
Its shebang/imported closure uses Guile3.0.11 and the held Guix module union; the
original native15-case CDE3.4 lifecycle result is real. Merely retaining the wrapper
does not establish a new selected-channel match for both proposed products.
Keep the actual current source-selected Node24.18/Git2.54, declared native PNPM
11.28.5 and existing authentic portable Code supplier graph. The Guix receiver's
qualify-toolchain currently realizes its pinned dependency-toolchain through
installed Guix; use its actual contract and immutable provenance, not a new
toolchain resolver or silent substitution of unrelated G3 tools. No new graph,
CLI clone, checkout, tests or toolchain build was formed during this intake.

## Independent V-model receiving before effects

Receive the detailed existing-owner source design first, then qualify native
policy support and exact CDE13/current-driver reconciliation. Source controls
cover wrong commit/tree/coordinate/lock/configuration, post-run mutation, fabricated
or stale receipts, cross-side work reuse, removed obligations, empty inventories,
missing/unknown measurements, exact process/status agreement and preventing false
completed markers. Native policy controls must show genuine refusal and later
eligibility under unchanged applicable policy. Effect canaries prove excluded
operations absent. CDE source controls preserve actual registered/read-only target
refusals and full existing transaction/native regressions.

The useful integration receipt is the original exact requested machine pair:
both genuine frozen/runtime chains, both registered immutable outputs, both target
readings, positive engineering obligations, final integrity, actual participation
of each requested change and original-thread non-vacuous verdict. That can enable
CDE13's exact-candidate no-regression gate; one R, source/fixture counts or a clean
merge cannot. Then follow ordinary accepted source integration/publication and
the original installed consumer/subsequent real deterministic receiving operation.
Build/activation remain separate authorities. Native Work/Task/Procedure/Endeavor
bindings left open by Guix150 remain open until actual supported operations receive
them; filesystem plans never impersonate native admission.

This plan requests only independent requirements/design receiving and exact owner
allocation. It does not authorize tests, fabrication, publication, merge, billing,
credential expansion, native dispatch, deployment or host changes by its existence.
