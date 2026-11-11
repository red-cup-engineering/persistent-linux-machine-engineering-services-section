# Reviewed-source admission handoff

This is a callable entry to the existing Guix release operator procedure,
`scripts/advance-reviewed-sources.mjs`. It adds no office appointment, native
allocation, capability assertion or claim that GitHub is the canonical work
system. The existing machine PR comment is the original degraded work carrier;
the resulting source admission and later deployment still need their real
receiving evidence and any outstanding native sync-back.

## Method and authority

On an existing machine PR targeting `main`, an authorized repository writer
posts exactly `/release advance`. The fixed command names the existing workflow
mode. It cannot carry a branch, executable, shell fragment, target repository,
credential, environment override or deployment mode. The workflow handles only
new comments and uses code checked out from machine `main`, never the PR head.
Other events retain their existing behavior.

The procedure re-reads the original comment, its author identity and PR through
GitHub. It verifies the author's current base repository permission through
`GET /repos/{owner}/{repo}/collaborators/{username}/permission`, accepting only
`write` or `admin`. This follows GitHub's documented write-access requirement for
`workflow_dispatch`; the metadata endpoint maps `maintain` to `write` and
`triage` to `read`. `author_association`, a copied actor name and a caller-supplied
authorization flag are insufficient. Authorization is checked before existing
workflow maintenance, then again immediately before the request is claimed.
No token scope, grant, runner, deployment target or credential is added.

The existing advance concurrency group and compute `flock` remain in force.
After acquiring that lease the workflow fetches and checks out current `main`.
The procedure compares the checked-out commit with the observed remote main
before claiming the request, refusing a race rather than running stale code.
The existing advance program then performs its own isolated-worktree,
reviewed-owner-merge, exact-lock and moving-main checks. Its successful push
continues through the existing deployment workflow and receiver.

## Request and uncertain-effect custody

The GitHub comment ID and verified repository/PR/actor identity bind a request.
Its receipt is stored beneath the existing machine `receiptRoot`, in
`source-admission-requests/`. A full JSON claim is prepared and file-synced,
installed exclusively using a same-directory hard link, and the directory is
synced before the external procedure can start. Updates use a synced temporary
file, atomic rename and directory sync. This relies on the existing host
filesystem honoring those operations; it does not claim hardware fault immunity.
No credential value enters these receipts.

A repeated event rechecks current authorization and reads the retained claim.
It never executes admission again. A prior attempt still running remains
unresolved. A completed attempt that retained only its claim is reported as
`procedure-outcome-unknown`; it is not interpreted as a failed write. A
nonzero procedure exit is `procedure-failed-effects-unresolved`, because a push
may have succeeded before summary or cleanup failed. The coordinator must
reconcile that original operation before requesting a new effect.

## Output and receiving

The handler reports back to the same PR with the original comment reference,
workflow run, procedure result, before snapshot and observed main afterward.
The latter is an observation, not proof that this request authored that commit:
the procedure can find no changes, and other admitted writers can move main.
`procedure-succeeded` is therefore not a deployment or native-work acceptance.
Independent readback of the resulting selected sources and matching actual
receiver outcome remains required.

Reply transmission is itself claimed before POST. The handler fetches its
returned comment for exact body/author/thread readback. A lost response is
reconciled against the existing CI identity and exact retained reply, without
posting a replacement. At most ten pages of one hundred comments are read;
truncation, ambiguity or missing evidence remains unresolved. Re-running that
original failed workflow attempt can reconcile/report its claim, but cannot
replay admission. No second request is created automatically.

GitHub source selection continues using the existing git/GraphQL carrier. The
request-time authority and same-thread reporting operations above are a bounded
REST exception to the controller's source-read convention. Each provider call
has a fifteen-second and 64-KiB limit. Transport exceptions, response bodies and
credential material are not copied into failure messages.

## Source projection and release order

`scripts/project-release-request.mjs` prints a one-file candidate map for the
existing `.github/workflows/release.yml`. This follows the existing owned
controller-bootstrap projection: the machine's declaration-only file policy is
unchanged. The workflow contains exact copies of the owner's request handler and
canonical CLI-entry helper as literal step-environment data. Those literals
are materialized only beneath a newly created private runner-temp directory,
removed by an EXIT trap after literal printf materialization. The source-data
variables are unset before any child procedure. The generator rejects GitHub
expression tokens and ambiguous trailing newlines, and refuses a pre-existing
projection whose bytes drifted. Each run block is checked against GitHub’s
21,000-character limit; source data is outside the shell program.
No event text is interpolated into the source or shell.

The workflow compares its GitHub-provided `GITHUB_WORKFLOW_SHA` workflow blob
with the checked-out workflow, before using the literals and again after the
lease/current-main refresh. Missing immutable source evidence, malformed
identity or a changed workflow refuses before admission. Source-only movement
with unchanged workflow code is allowed. A shallow checkout can fetch the exact
missing workflow commit; no floating ref chooses executable code.

Projection is necessary for bootstrap: the machine's selected controller may
predate the new handler. The existing resolver admits this workflow-only change
without adding application files or relaxing its guard. Controller and machine
publication both require independent source review; source selection is never
changed by hand. The generator itself does not publish or invoke anything.

The functional machine update has a bootstrap preflight before candidate build
or promotion. For a main push, the owned helper checks the actual Git before and
after commits for changes to the workflow projection path. A shallow
checkout fetches only the exact missing before commit; initial, deleted,
unavailable or mismatched identities refuse. A handoff change first invokes the
existing source-admission program under the shared compute lease. The workflow
re-reads main even if that program exits nonzero. If main advanced, this snapshot
never deploys; the successor's ordinary sources/lock-only push owns deployment.
Its diff does not contain handoff changes, so it does not recurse into admission.

If admission failed and main did not move, the run stops. Before every automatic
push deployment, including a zero/no-successor result or an ordinary
source/lock-only successor, the selected controller's handler and canonical-entry
helper must match the literal machine workflow projection byte for byte. Then
the exact reviewed owner test `test/cli-entry.test.mjs`, Git blob
`dd700325d6d23b917f12742c5f19c85ce23ae1b5`, must pass all thirteen cases with
zero skips, cancellations or failures. That existing fixture tests all eight
receiver CLI entries through the actual Guix symlink carrier with effect ports
closed. The child receives only Node's PATH and a temporary directory, has a
sixty-second/one-MiB bound, and never inherits credential or loader environment.
Missing, changed or unsuccessful proof refuses before ordinary deployment. This
is source compatibility, not live health or permission evidence. An older
provider lacking that admitted implementation refuses instead of deploying the
known pre-correction generation. A successor that advanced only another provider
while holding an incompatible controller also refuses. A CLI-compatible owner
with absent or mismatched handoff bytes also refuses. Source or configuration
changes that are already compatible retain the ordinary path without another
admission invocation.
This does not change a source pin or manufacture a no-op commit.

Release order is independent review and integration of this source owner, then
independent review and integration of the exact functional machine projection.
The projection's initial push must admit the reviewed owner before deployment.
Acceptance requires the real selected source snapshot and its matching receiver
outcome; fixture output and source publication do not satisfy it. The first
authorized comment exercises the callable handoff and same-thread receiving,
including the valid case where the bootstrap already admitted the newest source
and the command therefore has no further source changes to write.

References:
- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow
- https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#issue_comment
- https://docs.github.com/en/actions/reference/workflows-and-actions/variables

- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsrun
