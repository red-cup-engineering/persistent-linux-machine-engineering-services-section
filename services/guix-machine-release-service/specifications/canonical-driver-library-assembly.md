# Canonical driver and library assembly

Leader, 2026-10-12: FeltOS is the driver and MetroPlat its library, as FluffOS
loads Discworld. Production and machine realization belong to Guix; pnpm and
https://registry.561.group provide the admitted dependency closure.

The existing assembler selects the declared FeltOS driver as its application
entry and requires `feltos.mjs`. It requires the declared MetroPlat root world-library
declaration at `metroplat.mjs`. It does not select a separate enterprise-host
executable or infer readiness from a package version.

The selected machine operations already receive root package bindings. Source
preparation no longer injects every business entry into a driver manifest.
Original source dependencies and the reviewed frozen graph remain distinct
from application selection. A missing interface returns to source reconciliation.

This source correction does not resolve the currently stale per-machine lock,
qualify an acquired graph, promote a release or establish operating receiving.
Those obligations continue on the original Group restoration work.

After fabrication the existing host admission reads the actual installed world
and declarations through their exported interfaces and checks the driver with
its Guix Node interpreter. Package self-tests remain engineering source; they
are no longer the production host's admission mechanism. The existing receiver's
isolated boot, exact artifact health, activation, live receiving and rollback
remain required. This follows the Leader's instruction to receive useful effects
rather than use green packages as the unit of success.

The structural receiver's command is `check-host.mjs ARTIFACT`, with the sole
optional `--build-only` mode used by the Guix constructor. Receiving callers do
not pass a source snapshot: installed declarations and code are read from the
sealed artifact's admitted carriers. An extra or unknown argument refuses.

For native shared-software targets, `.metadata` and `deployment` remain exact
symlinks into the authenticated receiver envelope. The constructor copies
`.controller` directly into its canonical Guix output so that it can add the
derived `machine.json`. Admission compares that complete copied tree, including
empty directories, file bytes and executable identity, with the envelope's
controller source. Symlinks, missing or additional source entries and authored
`machine.json` refuse. The only additional file is a direct nonexecutable JSON
object whose repository matches the sealed release and whose state contract is
`preserve-existing`. This check preserves source custody; the constructor and
receiver still own the detailed generated policy and operating checks.

The corrected controller must be selected in the common software composition
before the target envelope is sealed. Changing only the bootstrap controller
does not replace `.controller` copied from that selection. No post-build copy or
mutable source overlay satisfies this requirement.

Native rollback preserves the existing receiver-selected retained-target
contract. Under the writer lease, the receiver records the selected `previous`
store, its actual NAR and original machine revision. The newly fabricated
`prepared-target.json` carries current receiving policy; it is not the artifact
being restored. Attribution binds the selected artifact to the invocation while
keeping its original revision distinct from the invoking source revision.

The current native caller still fabricates that prepared policy target before
it can reach retained-generation selection. This source repair does not qualify
recovery when common fabrication is unavailable, nor does it provide operating
rollback acceptance. That recovery dependency and required receiving remain open;
existing native mode selection and activation holds are preserved.
