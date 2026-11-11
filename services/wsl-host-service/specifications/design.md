# WSL host service: design

## Theory

A WSL2 host is a Windows host running a Hyper-V virtual machine. Its configuration is split across the two sides of that boundary, and each side has its own file formats, privileges and reload semantics. The failures measured on Bare Cedar Fog (see the science note `2026-10-09-note-on-the-wsl2-host-failure-model.md` in computer science) are failures of resources that cross the boundary: swiotlb bounce buffers for storage, contiguous memory for vsock rings, the virtual NIC's segment offload, core dumps and the VHDX onto C:. A defence is therefore a coordinated setting on both sides, and it holds only if both sides are installed from one record. Held as scattered edits, the defences drift, which they did (finding list in the operations record).

## Shape

```
parameters (data, operations) --render--> files (pure) --plan--> state --apply--> host
                                                              \--> live observation
```

- `src/trim-timer.mjs`: the daily fstrim service and timer renderer, and the plan's view of the timer. `src/sparse-disk.mjs`: the sparse-disk declaration, the Windows maintenance script, and the plan checks for sparse state and VHDX allocation against ext4 use.
- `src/wsl-host.mjs`: pure renderers (`renderIni`, `renderSysctl`, `renderUdev`, `renderEnv`, unit renderers, PowerShell renderers), `renderFiles` (the whole file set), `planFiles` (compare), `observeLive` (kernel values), `windowsInstruction`, and `applyPlan` (write, back up, run hooks). Only `applyPlan` and `planFiles` touch the filesystem, through plain reads and writes.
- `scripts/wsl-host.mjs`: the command line, `plan` and `apply`, with `--scope=linux|windows|all` and `--root=<dir>` to stage the whole file set under a directory.
- `assets/`: the two Linux helper scripts (`wsl-orphan-relay-reaper.sh`, `wsl-agent-limits.sh`). Their behaviour is parameterized through arguments and the defaults file, never by editing them.
  `wsl-agent-limits.sh` enables every controller it writes in the root's `cgroup.subtree_control` before writing, because its path unit fires when WSL creates `/non-systemd`, which can be before systemd has enabled `cpu` there.

## Choices

- **Node built-ins only.** The repository's persistent-Linux-machine section normally reaches the filesystem through the Group file services. This tool is the one that must work before any of that is installed, so it reads and writes directly. Everything else in the section that can use the Group services should.
- **Comparison ignores CRLF and trailing whitespace.** Windows editors rewrite line endings; they are not drift.
- **Live reconciliation is part of apply.** Each live check declares its Linux or Windows scope and its existing reload hook. Apply unions changed-file hooks with mismatched managed-live hooks, requires root before either kind of Linux mutation, and runs each hook once. Current files can therefore repair live-only drift. The udev hook reloads the rule and restarts the existing bounded block-queue unit, receiving its two settled events. Kernel-command-line changes remain the host owner's Windows action. After applying, fresh scoped observations determine the terminal status; staging renders files without live hooks.
- **Restoration uses the declared budget.** Bare Cedar Fog's 2026-10-14 plan found an absent user.slice drop-in and sdd at 1267 requests while the sourced record declares 256. Applying the file received the memory budget; the live-only queue requires the same owned reload path. No new host values or resource limits are selected.
- **Windows is written, never executed.** `.wslconfig` takes effect at the next VM start and the Defender and pagefile scripts need elevation. The service writes the files from WSL and prints the one command; the owner decides the moment.
- **A separate boot-time unit for block queues.** The udev rule is kept (it is the correct statement of the limit and it works for hot-added disks), and `wsl-block-queue.service` re-sends a change event after boot, twice, 20 seconds apart, because a boot-time write is refused as busy on disks the kernel still holds. It is `Type=exec` running one shell command, so `multi-user.target` does not wait out the pause (as a `Type=oneshot` it held boot 20.3 s, 2026-10-31).
- **/tmp ages instead of emptying at boot.** `/tmp` is a directory on the root VHDX. Ubuntu's `tmp.conf` (`D /tmp`) empties it in `systemd-tmpfiles-setup`, which `sysinit.target` and so logind, the lingering user manager and the SSH entry wait for; on 2026-10-31 that removal took 94 s of a 117 s boot. `linux.bootTmp` renders `/etc/tmpfiles.d/tmp.conf`, which replaces that file by name with `d /tmp 1777 root root <age>`, and `wsl-tmp-age.timer` (`cleanAfterBoot` after boot, then every `cleanEvery`) runs `systemd-tmpfiles --clean` on that one file at idle priority, removing entries older than the age. It is the service's own timer because this Ubuntu image ships `systemd-tmpfiles-clean.service` without its timer.
- **Reaper timer.** The interval is a parameter (5 minutes on Bare Cedar Fog) and the unit passes the thresholds as arguments, so the script has no constants.
- **In-memory swap before disk swap (WSL-21).** The memory a busy guest can least afford to lose is file-backed: the interactive programs' executables and databases. With swap held small (the disk swap is a VHDX behind `hv_storvsc`), reclaim has nothing else to take. A `zram` device turns idle anonymous memory (editor and app-server heaps) into compressed pages in RAM, so a cgroup at its `memory.high` sheds heap before code. `wsl-zram-swap` creates it once per boot and leaves an active device alone. `disksize` bounds the uncompressed bytes it accepts and `mem_limit` bounds the RAM its pool may take; the budget counts `mem_limit`, because the pool is memory that no cgroup is charged for. The device takes priority above the disk swap, which stays as overflow. The algorithm is a record value because the WSL kernel builds only the LZO backends (2026-10-18: `CONFIG_ZRAM_BACKEND_ZSTD` is not set).
- **Targeted reclaim before a VM-wide drop (WSL-22).** WSL-20's ceiling exists to return memory to Windows, but `drop_caches` evicts every clean page, hot or cold, in every cgroup. `memory.reclaim` on a named cgroup evicts that cgroup's coldest pages first. The guard asks each named cgroup, in record order, for the excess (`swappiness=0`, so only cache), re-reads the cache after each, and falls back to the VM-wide drop only if the cache is still above the ceiling. Batch slices come first in the record and the interactive cgroup last.
- **Read-ahead is a block-queue attribute.** The root VHDX reports a large optimal I/O size, so the kernel sized its read-ahead at 8 MiB (2026-10-18). A fault on an evicted page of a mapped file reads around the fault by that window, so under memory pressure each refault can pull megabytes back in and evict more. `read_ahead_kb` is declared beside the queue depth and checked live like it.
- **The disk swap's I/O ceiling skips in-memory swap (WSL-23).** The helper picks the first swap device that is not `zram`; an in-memory device has no disk traffic to bound.
- **No MetroPlat operation wrapper yet.** MetroPlat may later offer `plan` as a monitored check. The service must not need it.

## Parameter record

`wsl-host-parameters@1`: `windows` (`profileMount`, `profileWindowsPath`, `wslConfig.sections`, `defender`, `pagefile`), `linux` (`wslConf.sections`, `sysctl[]`, `blockQueue`, `bootTmp` {`file`, `age`, `cleanAfterBoot`, `cleanEvery`}, `agentLimits`, `memoryBudget`, `headroomGuard` with optional `reclaimCgroups[]`, `zramSwap` {`description`, `disksize`, `memLimit`, `algorithm`, `priority`}, `relayReaper`, `trimTimer` {`description`, `executable`, `mountpoint`, `calendar`, `bootDelayMinutes`, `randomizedDelayMinutes`, `timeoutMinutes`, `comment`}), `windows.backingStorage.volumeMount` (the backing volume's drvfs mount), `windows.backingStorage.sparse` {`want`, `wslExecutable`, `allowUnsafe`, `compactWhenBelowFloor`, `maxSlackBytes`, `basis`}, and free provenance fields (`observed-*`, `legacy`) that the renderers ignore.

## Backing-volume observation

The explicit `capacity --parameters=RECORD --destinations-json=ARRAY` command is
read-only and builtins-only, and runs no Windows process. `observeBackingVolumeCapacity`
checks an available `WSL_DISTRO_NAME` hint and the native `wslpath -w /`
distribution-root UNC witness. It then reads the backing volume through its drvfs
mount, declared as `volumeMount` (`/mnt/c` on Bare Cedar Fog): `/proc/self/mountinfo`
must show that mount as drvfs for the whole drive that holds the record's VHD base
path, `statfs` on it gives the volume's total, free and caller-available bytes, and
`lstat` on the VHDX through it gives the file's length, allocation (`st_blocks`)
and device/inode identity. Windows answers both calls itself over the drvfs
channel, so the observation does not depend on WSL interop, which can break
while the guest runs (Bare Cedar Fog, 2026-10-30: every Windows executable failed
with Invalid argument and admission refused although C: had 115 GB free). Leader,
2026-10-30, on that refusal: "well that's a stupid design".

NTFS attributes are not visible through drvfs. The VHD is reported sparse when its
allocation is below its length, which an uncompressed NTFS file can only be when
sparse. Available capacity is the minimum of volume free and caller-available
bytes. Current device numbers are observed, never persisted across boots. Every
requested destination must map to the declared Linux mount's actual device.
Unknown devices refuse rather than borrow root capacity. The result carries
decimal byte strings and operations-owned physical reserve/growth/overhead
estimates. Consumers sum simultaneous guest-device peaks once per backing volume,
retaining their ordinary guest byte/inode gates. Observations are snapshots, not
reservations. The whole observation, including identity rechecks, must finish
within `maxAgeMs` on the local monotonic clock; `at` is the Linux observation time.

The host's operations record owns physical fabrication capacity. Admission is
`max(minFreeBytes, totalBytes * minFreePercent / 100)`, rounded upward, plus
the operation's simultaneous peaks, growth and overhead. These are estimates,
not reservations; identity and capacity are reobserved before growth.

Bare Cedar Fog's current physical fabrication reserve is at least
100,000,000,000 bytes, independently of Codex housekeeping, and retains the
record's proportional reserve, simultaneous own peaks, growth and overhead.
Unknown or below-floor physical capacity cannot admit a growing producer.
Producer-owned terminal disposition and bounded reusable custody address data
churn; lowering the floor and compaction do not constitute this incident repair.

Historical rejected decision: the 2026-10-24 uptake selected 30,000,000,000 bytes
and 3% for fabrication while retaining 100 GB only for housekeeping. The Leader
rejected that reduction on 2026-10-26. This historical figure is neither an
operative default, an admission fallback nor authority to modify the record.
Existing historical attempt Resources retain their original bytes as evidence.

This command neither enables sparse VHD nor trims, compacts, shuts down, changes
configuration or removes data. A non-sparse dynamic VHD does not automatically
shrink after guest deletion. Existing compaction rendering is not safe automatic
incident reclamation: it targets every distro and requires independent owner
maintenance admission and exact-disk scoping before use.

The prescribed ordinary `plan` also invokes this owned read port for the root
when the record declares it (outside staged or Linux-only plans). It reports
actual available bytes against max(physical percentage, minimum) + growth +
estimated overhead and exits 2 for low or unknown physical capacity. It never
routes that drift into apply hooks. Legacy records without the declaration retain
their old plan behavior; operators do not need a third health command.

References: Microsoft [WSL disk space](https://learn.microsoft.com/en-us/windows/wsl/disk-space),
[WSL file system mounts](https://learn.microsoft.com/en-us/windows/wsl/filesystems),
and [compact vdisk](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact-vdisk).

## Scoped offline maintenance proposal

This is the design and receiving contract for replacing the unsafe existing
compaction rendering; it is not an implemented carrier or maintenance admission.
The ordinary `plan`, `capacity` and `apply` boundaries remain unchanged. Until
the replacement is fabricated and independently received, the existing generated
`wsl-compact-disk.ps1` must not be used for incident reclamation.

### Target and authority

Reuse `windows.backingStorage`: distribution name, exact Lxss key, base path,
VHD filename, backing-volume ID and Linux mount. Keep the host's operations
record as their owner. Do not find a target by glob, directory census, newest
file, drive letter alone or another distribution's available space.

The maintenance Resource attaches to the existing host/work custody. It names
the parameter digest, original obligations and operation handles, checkpoint
witnesses, target tuple, observed owning Windows SID and registry hive, actual
administrator principal, exact qualified tool, finite allocation, Windows result
location, admission/reopening decision and accountable custodian. A data file,
a checkbox or a privileged token alone is not the owner's admission. A proposal
has no admission. Missing authority or an unreadable witness refuses effects.

Elevation may select a different Windows account. Its HKCU must never silently
replace the distribution owner's hive. Prove the owning SID from the existing
Windows binding and address that exact loaded owner hive, or refuse. Do not
derive a SID from a profile folder, copy a token, mount another hive or create
an administrative identity as a repair.

### Checkpoint and offline boundary

Before the custodian admits any stop, receive all affected original work:
source and human state, current GC/build/materialization handles and their
terminal outcomes, deployment leases and profiles, publication/composition
cursor and unknown Git/ref effects, credential/state custody, and this agent's
own handoff. These are exact owned subjects, not a new host census. Preserve
unknown outcomes and other custodians' deliberate holds.

Kernel freezer state does not survive a distribution stop. The observed
rebooted legacy deployment selector demonstrates why a frozen process receipt
is insufficient. An affected old selector or worker needs an independently
received durable boot/reentry gate before maintenance; main Wants, restart
policies and automatic desktop launches must not admit it during recovery.
Disabling enablement alone does not stop a Wanted unit. Do not promise to
re-freeze it after boot.

The selected DiskPart/attach-based compactor runs from an independently qualified
native Windows administrator session outside the affected distribution. This is
that adapter's privilege contract, not a claim that every Windows compaction API
requires elevation. A different CompactVirtualDisk adapter would need its own
source/native qualification and caller-context authority; none is selected here. It performs no
`wsl --shutdown`, termination, distribution launch or restart. The owner first
admits the affected-work checkpoint, then arranges the exact disk's offline
state through the existing maintenance resource. A distribution-scoped stop
does not prove disk detachment. If the disk cannot be proved detached/read-only,
refuse; shared-VM maintenance needs its own explicitly received affected scope,
never an automatic escalation to shutting down every distribution.

### One disk operation and original result

Before its single operation, join the owner hive's current registration to the
same exact canonical VHDX, reject redirected/reparse targets, obtain its native
file identity and backing volume, and prove its eligible dynamic/offline state.
Revalidate against the captured identity at the actual native operation boundary.
The native operation must acquire the intended disk in the admitted mode; a
path-only preflight followed by a racy attach is not that proof. Busy or changed
identity refuses without retrying, stopping another actor or selecting a
different VHD.

Use the existing renderer and host record after these contracts are implemented;
do not add a controller or clock. Render only parameter data and fixed trusted
operation syntax. Missing exact binding renders a refusal, never the old glob.
A qualified implementation must validate paths as data, bound native output and
duration, and preserve executable supplier identity. No trim, sparse conversion,
resize, deletion, reserve relaxation or attachment of another disk is included.

Retain the started decision before effect in an exclusively created result under
the existing Windows host owner's durable custody, outside the target VHD.
Carry target/owner/admin identities, parameter and script digests, checkpoint
witnesses, native operation identity, timestamps, before/after file and volume
observations, exact native exit/output and terminal or unknown outcome. A shared
`%TEMP%\\compact-wsl.txt` is neither exclusive operation custody nor a receiving
Resource. Retire only that attempt's disposable carrier after its effects are
received. A timeout cannot justify a second compaction or automatic restart.

The Windows result is evidence, not an assertion that storage has reopened.
Physical free-space delta and VHD length delta are distinct observations; no
reclamation amount is promised. Native exit status or English output alone
does not establish completion. An administrator's quota is not the original
fabrication caller's quota.

### Reopening and qualification

After the Windows custodian receives the original operation and admits reentry,
retain the boot holds, reestablish the existing owner's principal/UNC/registry/
VHDX/volume join through the ordinary prescribed WSL plan, and read actual
quota-aware physical capacity. Existing fabrication byte/inode, growth and
reserve gates still decide whether the exact next stage fits. Reopen the old
work only through its own receiver, and receive retained data plus useful
services; merely booting successfully does not release a hold.

Implementation receiving must demonstrate one selected disk, refusal before
effects for missing admission/admin/hive, live or changed target and competing
maintenance, finite timeout with preserved unknown outcome, original result
survival while WSL is stopped, and fresh owner-context capacity after reentry.
Qualify these through an admitted disposable native disk and competent Windows
operator before applying them to an occupied production VHD. Source rendering
tests cannot establish those native conditions.

Microsoft documents that [compact vdisk](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact-vdisk)
requires a dynamic disk that is detached or read-only, and distinguishes
[one-distribution termination from whole-VM shutdown](https://learn.microsoft.com/en-us/windows/wsl/basic-commands#shutdown).
Those APIs establish operation scope, not this enterprise's maintenance
authority or a guaranteed reclamation result.

## Durable user-unit quarantine

The optional `linux.userUnitQuarantine` in the same operations parameter record
owns one explicitly named old user unit. The explicit `quarantine-plan`,
`quarantine-hold` and `quarantine-release` entrances run as that exact UID;
ordinary `apply` neither fabricates nor clears this separate custody. A missing
declaration is a refusal, never a release.

The declaration requires explicit canonical `sectionRoot`, the existing owning
services section above `data/`. The marker and release outcome live under
`sectionRoot/data/state/wsl-user-unit-quarantine-state`; replacement receiving
Resources are private files under that owner's `data/records/`. State and records
remain tracked; privacy grants no untracked-state exception. Raw/reproducible
captures belong in typed `data/logs/`. No owner comes from the installed package,
Git, HOME or CODEX_HOME, and omission never falls back to home storage. The native
user-manager drop-in remains in the explicitly declared user's `.config/systemd/user`:
that is native configuration, not operational data. Existing owner paths and
custody entries must be owned, canonical and non-symlinked; custody stays private.
Original marker format/bytes remain readable after an admitted exact migration,
rather than being rewritten as a new hold identity.
A persistent user-unit drop-in adds `ConditionPathExists=!<marker>`. This is
outside LAGOON's per-profile recovery-hold area: an independently qualified new
controller must be installable while the selector remains blocked. Existing
LAGOON holds still refuse release. No second controller, timer or enablement
identity is introduced. Wants, Restart and later source unit definitions still
pass through the persistent native condition after reboot.

The first hold compares the record's boot ID, MainPID, invocation, cgroup, process
start tick, complete argv and real cwd against the actual frozen resident twice
around the sole native effect, user-manager daemon-reload. Main/control jobs must
be absent. It writes and fsyncs the private marker before the drop-in; a failure
cannot remove either. Receiving must prove the exact loaded drop-in and unchanged
frozen invocation. A partial marker without a loaded condition is held custody,
not a successful boot-safe result. Neither CLI nor ordinary apply stops or thaws
the original process. Omitted and renamed declarations leave existing bytes in
place, so no omission can clear a previous guard.

The explicit `captureMode` union preserves omitted/`frozen-resident` behavior.
`stopped-no-resident` is a separate original capture mode for an already inactive
controller, not permission to start it. The record binds actual boot and exact
loaded `ExecStart`. Native receiving requires `LoadState=loaded`, the exact unit,
zero main/control PID, an absent job, inactive/failed plus dead/failed state,
and no populated actual cgroup. Empty `ControlGroup` is an observed unit fact,
not a fabricated old cohort. Historical `InvocationID` is retained as a unit
property; the capture explicitly records `resident:null`.

The existing exclusive marker-first algorithm rechecks the stopped subject
before/after reload and after effective negative-condition receiving. Unknown
or racing states keep partial custody and refuse success. The marker records
its mode, exact capture and explicit unknown-effect dependencies. Existing
frozen markers and legacy receivers retain their original contract.

A stopped replacement Resource must bind the exact original capture and effect
dependency list. Every dependency requires a private canonical owner-record
terminal-receiving Resource selected by path and digest and received for the
exact unit/invocation/commit, independent receiver and empty unresolved effects.
The destroyed `855f436da72a44a8831f856a7d8a5d0c` promotion at
`5e878170577f3960270ae246586a9337788983c3` remains unknown until that receiving;
KILL, absent native work/lease or unchanged profile does not settle it. This
extends the existing release authority boundary and does not create another
controller, mask, queue or timer.

Release is a separate, explicit owner decision. A later reviewed parameter change
selects the private replacement-receiving Resource by its exact SHA256, with
independent receiver and original subject. Its format is
`WslQuarantineReplacementReceiving@1`: original marker digest and invocation,
unit, selected profile/link/artifact root, native current-record digest, exact
ExecStart, and an explicit independent reconciliation of original unknown effects.
The source-owned expected digest is the authority boundary; a self-authored
checkbox or file does not confer receiving authority. No release Resource is
selected in the incident's initial record.

Before clearing only its own marker, the service checks that Resource against
actual profile link/current record, selected CDE package version/publisher Git
head and selector Git blob; checks the held native unit's exact replacement
command, no main/control process or job; and receives the captured hierarchical
cgroup terminal plus no native LAGOON recovery holds. Reboot or missing PID alone
cannot satisfy the independent reconciliation decision. It fsyncs a release
outcome containing original marker and receiving digests before unlinking its
marker. A partial release refuses further effects for owner reconciliation.
The benign condition remains, and release itself never starts the unit.

Qualification separates pure source/refusal cases from one admitted isolated
native user-unit fixture: freeze an owned harmless unit, install the source-owned
condition without changing its PID/invocation/freezer, prove restart refusal while
held after terminalization and source-definition replacement, then qualify explicit
received release. Fixture effects never touch the production selector. Production
hold application requires independent source/native receiving first; offline
maintenance still requires its separate checkpoint/admin admission.

## Residual work

- A scheduled `plan` that raises drift as work on the board (operations: Bare Cedar Fog).
- Reading the live Defender list needs elevation; the record keeps the 2026-10-05 result file as the last reading.

## Compaction refusal and source recovery

The existing renderer now emits only a terminating PowerShell refusal until
WSL-45 and WSL-29..36 are received through an actual scoped native carrier.
Replacing the unsafe generated file is ordinary owned file reconciliation; it
neither admits nor executes maintenance. No automatic disk action is reachable.
Microsoft's current WSL `--manage <distribution> --compact` implementation calls
`_ConversionBegin`, which terminates the selected instance. Substituting that
command for global shutdown would therefore still interrupt this agent and the
host. It needs a separately qualified adapter and the same affected-work
checkpoint and durable reentry holds. It is not a live read-only capacity probe.

Source for this package was received from the original operating-system owner's
immutable subtree before establishing its dedicated repository. Source history
remains in that original repository; its parent projection must use a gitlink to
the received standalone commit. A source import is not native maintenance,
publication, host migration or useful-operation acceptance.

References: [Microsoft WSL compact implementation](https://github.com/microsoft/WSL/blob/master/src/windows/service/exe/LxssUserSession.cpp),
[WSL command adapter](https://github.com/microsoft/WSL/blob/master/src/windows/common/WslClient.cpp).


## Storage evidence and producer containment

The 2026-10-26 prerequisite receipt preserved logical length but dropped the
observer's actual allocated bytes. Its observer hash and source are received,
yet the stored target alone cannot attribute later physical growth. The original
native target projection now preserves allocation, its API source and attributes,
producer time, request nonce and observer source identity. This adds evidence;
file identity and maintenance admission remain separate. Historical incomplete
receipts are not reconstructed.

Live, rollback and unresolved data keep their custody; completed disposable fetch
and QA intermediates do not acquire indefinite retention merely by being called
caches.

The current incident requirement rejects treating reclamation as the response to
unbounded producer writes. Native Windows backing-volume/caller available bytes
are the capacity measurement. Guest statfs/df use, VHD logical length, native file
allocation and the sparse attribute remain separate facts. Allocation minus
guest used bytes is an accounting difference, not measured recoverable capacity;
it grants zero admission credit and does not establish whether trim works.

`assessBackingReclaim` retains the declared tolerance as diagnostic drift only.
Its report must not promise that sparse files return blocks automatically, that
nonsparse files never return blocks, or that the observed difference will become
Windows free space. Actual recovery requires native before/after Windows
capacity observations; those observations still are not a writer reservation.

Existing explicitly declared trim units retain their original scoped lifecycle.
Their scheduling, native result and discarded-range count do not prove Windows
physical recovery. No new timer is introduced by low capacity. The original
sparse carrier retains its registered target checks, stop/result/reentry custody,
source-owned `allowUnsafe` policy and independent admission boundaries, but
`compactWhenBelowFloor=true` is rejected and its automatic compaction branch is
removed. Current Bare Cedar Fog already declares false; no record or machine
setting is changed by this source repair. The separately qualified explicit
native-compaction API remains a distinct capability with no incident permission.

The ordinary `windowsInstruction` report no longer prints an executable
maintenance invocation merely for sparse or rendered-file drift. A diagnostic
held/admission-required notice may name the missing receiving. Defender,
pagefile and explicit WSL-config restart instructions remain their original
separate operations. No maintenance, trim, shutdown or reentry is executed here.

The physical observer is not an execution fence. Every source/PNPM/Guix producer
must enter its own fresh source-owned physical admission, and old ungated
runtimes require their original native holds until a qualified successor is
received. Producer footprints require bounded active custody and terminal owner
disposition; a successful plan or an immutable product proves neither.

### Original hold storage migration (source contract, not live admission)

Never move/unlink the old marker first: the old negative ConditionPathExists
would become true before the new condition is loaded. Ordinary hold refuses an
existing guard with different bytes before allocating a new marker or reloading;
ordinary apply never performs this migration. No new migration command,
controller or scheduler is introduced.

Before effects, the original custodian receives actual old marker bytes/SHA256,
private mode/UID/native identity, exact loaded drop-in/effective condition,
current boot/unit/invocation/cohort disposition and original unknown-effect and
release holds. A live frozen invocation uses the existing native identity port;
a rebooted or terminal invocation needs its original reconciliation, never a
fabricated old capture. The source record selects the real owning section and
admits this one migration. Source extraction alone is not that admission.

Use the existing qualified manual file/native-manager operation with exact
before/after guards. Keep the old marker and guard throughout. Exclusively copy
the received original marker bytes to private declared state; fsync file and
directory and verify both copies. Preserve its digest and identity fields. Add
an explicitly scoped temporary negative condition for the new marker while the
old loaded negative condition remains. Perform the original bounded daemon-reload
and independently receive both effective conditions and unchanged resident/freezer
or reconciled terminal disposition. Only after double exclusion is received may
the original guard be replaced, preserving its prior bytes and verifying exact
identity/no-clobber conditions, by the canonical new marker condition. Reload and
receive that canonical condition while the old marker still exists. Keep the
bridge and old marker until the original custodian accepts final custody; any
retirement is a separately witnessed operation, not an automatic fallback.

Occupied destinations or uncertain reloads refuse. Retain every original outcome
and all exclusions; an interrupted phase is unknown and cannot be replayed
until reconciled. Pure tests cannot prove the live no-gap condition. This grants
no stop/start/thaw/restart/release, compaction, cursor write or host configuration
action. Independent replacement receiving and original release gates still apply.

## Source and selected effect

Base is proper red-cup-engineering/wsl-host-service 3a7078513bf257397be7b5607570bf12aa437198, actual tree a59982c03b40c70e89fc2e01008f66cb5e123a98, all24 blobs received. Preserve all scoped maintenance, capacity launch and quarantine requirements and implementation. Add a builtin managed-timers module used by the original CLI and renderFiles, plus --component=managed-timers; default all-host behavior is preserved when no timers are declared. Component selection uses only the optional linux.managedTimers list. It never observes or applies unrelated sysctl, memory, Windows or quarantine configuration.

The only generated machine files for this record are /etc/systemd/system/github-reconcile.service and /etc/systemd/system/github-reconcile.timer, through this producer. A system service uses User=emsenn, not root, the actual passwd home, existing gh credential configuration, and exactly the already-qualified v5 command. Explicit environment preserves CODEX_HOME, gh config and typed owner cache/TMPDIR. The actual inherited proxy values are empty, so the declaration records empty values and no credential. Environment tokens and command arguments use systemd quoting/percent/dollar escaping, never a shell. No arbitrary unit text is accepted. Record input checks reject line/control injection, invalid unit/user names, ambient executable lookup and Persistent=true.

OnBootSec=30 plus the existing ten-minute calendar supplies the next bounded pulse after a system-manager/WSL boot; WantedBy=timers.target and enabled native link make it durable. Persistent=false avoids timer stamp writes under .local; cursor overlap and original job journal recover missed observation without replaying received jobs. WSL is already declared systemd=true. No shutdown, WSL restart, user-manager environment or linger change is selected. The selected GHS source is a frozen explicitly retained source-native component, not an installed full package claim; source custody must hold it until a received successor binding.

## Native reconciliation and single-actuator handover

Plan reads declared files plus bounded selected system/user unit metadata and makes no changes. Native ports have finite aggregate deadlines/output. The source-only renderer and lifecycle controls inject those ports. Staging prefixes only the two generated Linux files and invokes no native command.

Before nonstaged effects require root, exact expected source hashes, real/canonical declared section and existing data roots, selected unprivileged passwd UID/home, and safe root-owned configuration parents/targets. Check the system manager has no conflicting declaration. For migration stop only the declared user timer first; immediately re-read the old service and wait within its existing start/stop timeout for the captured invocation and cgroup to become terminal. Do not stop/kill/replay the service. If terminal cannot be received, retain the partial phase and do not start the system timer. Collect only the quiescent old declaration through normal native lifecycle. Do not erase prior journal/state/config or use failed PID tricks.

After drain, reuse original planFiles/applyPlan for the selected two files without generic host hooks, reload the system manager once, and enable --now only github-reconcile.timer. Receive installed effective fragment/command, User/Group/environment, enabled target link, ActiveState and NextElapse before success. On an already converged system timer with the old user role absent/inactive, no write/reload/enable occurs. Application queue/cursor/journal stay byte-untouched by the installer. A source/runtime change while system service active is drained before mutation as well. Interrupted or ambiguous native outcomes must be reconciled from actual files/unit metadata before another effect; no automatic blind retry.

## Qualification and delivery

Add meaningful controls to the original WSL native family: explicit values/escaping, old records unchanged, component-only scope, staged idempotence/no commands, missing/changed sources and unsafe bindings refused, active legacy service race refuses competing enable, successful drain installs one timer, second apply zero effects, disabled/lost enabled timer restored, partial failure faithful. Fixtures only under this WSL owner's data/logs, actual HOME/CODEX preserved. Builtin controls require no dependency graph or host interruption. Separately receive actual native unit parser/privilege/manager entrance, exact BCF record delta and source before any apply. Actual installation and normal next pulse then prove useful recovery; no forced reboot or old source-job replay. Source publication/package obligations and full-machine operations remain distinct.

### Complete installed timer source selection

The original `managed-timers` module is available through the standalone
package's `./managed-timers` export, including its existing declaration reader,
renderer and native actuator. The public `MAX_MANAGED_TIMER_SOURCE_BINDINGS`
constant supplies its finite file-count limit to source producers. Neither the
export nor preparation grants machine authority; native apply retains its root,
owner, source, target, drain and readback conditions.

The installed GHS 0.3.9-dev.668 selection received on 2026-10-26 contains
85 modules in the original Code observation. Including physical ancestor
package manifests, all nine shipped GHS schemas, the operating declaration,
original observer and native lock requires 112 exact source bindings. The old
64-file admission cannot represent that complete selection. Its bound is now
128, with the original one-MiB maximum per file, canonical regular non-symlink
source paths, immutable digests and mode admission unchanged. This permits at
most 128 MiB of file content in one complete receiving pass per timer; it does
not allocate that content simultaneously. The existing maximum of eight timer
declarations, native deadline and timer memory/CPU/time/cadence limits remain.

Actual local preparation selected 1,109,310 bytes across the 112 bindings.
Code's explicit computed-import boundary remains in the receiving record;
the selection does not assert completeness of arbitrary dynamic programs.
The original native suite receives the final file at the exact 128 bound,
refuses a 129th before native observation/effects, and retains final-file
changed-byte, one-MiB and symlink refusals. The host must receive the prepared
configuration and original record through its existing owner before the
original root-capable `--component=managed-timers` application. Source
preparation, package issue and a per-user Guix profile do not establish that
system timer application.

### Explicit legacy timer command transition

A managed timer declaration that replaces the captured transient user timer may name `expectedLegacyCommand` using the same absolute executable and bounded literal argument-vector grammar as its target `command`. The producer receives the old service against that separately declared command before any drain and afresh immediately before pausing its timer and stopping its quiet service. Fresh service and timer identities must also retain the original `/run/user/<uid>/systemd/transient/<unit>` fragment path at those boundaries; a persistent unit raced in with identical argv is still unreceived. The target command remains the new exact runtime. A changed or unreadable legacy command refuses; it does not grant permission to stop an unrelated producer. Without this optional field, the original same-command requirement remains. The field is invalid when `replacesUserTimer` is false. This is a declaration of the original handover identity, not a new executor or a manual stop step.

### Recovered native WSL 3.0.3 maintenance (2026-10-23)

The earlier DiskPart-only proposal is not the privilege/quiescence contract of
every adapter. The BCF original maintenance record
`capacity-recovery-maintenance-20261021.native-compact.proposal.json`, independent
source/caller reviews and `native-compact.windows-result.json` received the
Microsoft WSL 3.0.3 adapter. Its original Windows parent was 6035 bytes, SHA256
`1d2b2d3489b30dc4c0f7f495ac7e3d1da7ec97a2b4911d0646fa1ec7c55aa3fd`.
It issued one directly awaited `wsl.exe --manage Ubuntu --compact`; the native
provider, under the distribution owner's identity, terminates that selected
distribution and holds its Compacting lock against concurrent startup until the
actual operation returns. It does not require the DiskPart adapter's elevation
or caller-induced detach. A prior shutdown/list attempt had raced an automatic
restart and never dispatched compaction; it remains its own terminal attempt.

Qualification is pinned to Microsoft/WSL tag 3.0.3: LxssUserSession.cpp Git blob
`9ea6a26a28e4ba114d817edfad6cbc67684aabea` (CompactDistribution and
_ConversionBegin, selected-instance termination and lock); WslCoreFilesystem.cpp
`39c10fef6bb995c065c4c898c5e047c1c7e16702` (native CompactVirtualDisk);
WslClient.cpp `48b5c4fe89337f2b30897e8cdee52f865f6f354d` (synchronous result).
The executable entry in `src/windows/wsl/main.cpp`, blob
`934a09bf49e70e8f5ac067584b0bedafa03c266f`, directly calls `WslClient::Main`.
The new caller invokes that same hash-qualified `C:\Program Files\WSL\wsl.exe`
directly, removing the historical caller's unqualified System32 forwarding hop.
The actual qualified executable was separately started and directly awaited with
read-only `--help`; it exposed `--manage` and `--compact` and emitted no stderr.
Its help terminal is -1 (usage), not a compaction success receipt. Shell launch
of that executable is not an await proof; the native Process parent is required.
The adapter validates the already qualified installed 3.0.3.0 executable and
service hashes afresh. A changed provider needs original source qualification,
not a relaxed version comparison. Native internal offline trim is intrinsic to
this received offline adapter; it never dispatches the separately admitted
mounted-root discard described below, or applies any cleanup policy.

`src/native-compaction.mjs` renders only. It neither gathers health, reads
credentials, adjudicates authority, stops actors nor launches Windows. The
existing parameter record binds the exact backing target and an optional
`windows.nativeCompaction` declaration (actual Windows owner SID, pre-existing
private Windows custody directory, finite operation/output allocation). An
explicit admission supplies the original request, exact parameter-record digest,
fresh validity interval and digest-bound original authority, checkpoint and
independent-receiving Resources, each in that owner's Windows custody. The
checkpoint must cover every affected original job, dirty source, cursor,
unknown effect and durable boot/reentry hold. The original holder/receiver must
actually receive those contents before dispatch. Syntax/digest validation is
not an institutional grant or evidence of a quiet machine. No historical
checkpoint, old independent review or selected provider version admits a new run.

The rendered parent verifies resource hashes, freshness, current SID, qualified
provider, exact registry target and backing volume. A native handle supplies
volume serial/file index before and after; target and custody ancestors must not
be reparse points. Before the only effect it creates an exclusive private
request directory and flushes admission and dispatch intent to Windows-owned
files outside the VHDX. It records the child PID immediately after launch and
streams bounded evidence to those files while directly awaiting the same child.
The original per-task caller wrote its result only after a guest bootstrap;
that late-custody defect is repaired here. The new carrier never bootstraps WSL.
The tiny unavoidable start-to-PID-write window remains an unknown started intent
if the parent dies; exclusive request custody forbids a replay.

Deadline or output overflow records a failed allocation while continuing to
await actual terminal without killing or retrying. A parent interruption leaves
started custody to reconcile against the original native operation; no second
request may evade unresolved work. After actual terminal, flush the result,
revalidate the same target and retain any failure without a new tool or restart.
The custodian receives that Windows outcome before separately admitting guest
reentry with all durable holds retained. Only the ordinary native capacity join
can reopen fabrication under the unchanged operations-owned absolute floor,
proportional reserve, concurrent stage peak, growth and overhead. Compaction is
not a capacity reservation and its reclaim remains uncertain: the received
2026-10-21 operation freed only 627,916,800 physical bytes. No scratch deletion,
retention exception, Guix GC or guest trim is inferred from this recovery.

### Native maintenance uses the original capacity producer

The 2026-10-26 source and host receiving separated two complete operations.
Microsoft WSL 3.0.3 `SetSparse` refuses an already running distribution; a
caller's earlier terminate, shutdown or released file probe does not hold the
provider's lock until that later call. `CompactDistribution` instead owns
selected-instance termination and its Compacting lock through offline trim and
synchronous compaction. The selected native adapter continues to call only that
one operation. It neither repeats the failed sparse sequence nor claims sparse
conversion as part of compaction.

Both the Windows maintenance parent and the conditional reentry caller now
receive their target through the exact `assets/observe-backing-capacity.ps1`
source. The original
renderer binds those bytes in its immutable packet. A fresh, bounded metadata
child receives the same registry, native VHD handle, volume, quota and allocation
join with a new challenge. It uses the actual Windows PowerShell interpreter,
without loading an alternate volume lookup or starting a distribution. Its
timeout may cancel only that read-only child; the separate native compaction
child is still awaited to its real terminal and never killed or retried.
The new shared receiving asset is part of the exact guest receiver closure.

The native renderer retains the positive absolute reserve selected in the
original host record, together with its percentage, growth and overhead fields.
Current Bare Cedar Fog policy requires the declared 100,000,000,000-byte reserve,
in addition to the percentage, growth and overhead calculation. The earlier
rationale for treating 100 GB only as housekeeping is rejected history under the
2026-10-27 Leader instruction. No incident response may lower that reserve; the
stage's concurrent peak remains in its admission.
Maintenance success remains independent from capacity admission: the ordinary
owner-context observer must receive sufficient physical bytes after the actual
native terminal and separately authorized reentry.

Primary source receiving: Microsoft WSL tag `3.0.3`,
`src/windows/service/exe/LxssUserSession.cpp` (Git blob
`9ea6a26a28e4ba114d817edfad6cbc67684aabea`),
`src/windows/common/WslClient.cpp` (`48b5c4fe89337f2b30897e8cdee52f865f6f354d`)
and `src/windows/common/WslCoreFilesystem.cpp`
(`39c10fef6bb995c065c4c898c5e047c1c7e16702`). These source identities qualify
the operation contract; actual installed executable and service bytes remain
mandatory receiving inputs before every launch.

### Physical allocation before choosing reclamation

The original capacity asset now receives the selected existing VHD through a
read-attributes handle and `GetFileInformationByHandleEx(FileCompressionInfo)`.
Its `CompressedFileSize` reports disk allocation for sparse/compressed files;
the handle's ordinary file information separately reports logical length,
attributes and native volume/file identity. Re-read the same handle to refuse
length/attribute/identity drift during observation. No VHD payload is read and
no disk, trim or maintenance command runs. The existing registry/volume/current
root join, nonce, caller quota and finite timeout/output/freshness remain.

The producer returns `allocatedBytes`, `allocationSource`, `fileIdentity` and
`compressed` alongside the original `lengthBytes`/`sparse` fields. Node receives
exact decimal values and known producer identity; it never substitutes length
when allocation is missing. The existing host `plan` displays logical and
allocated bytes, so the prescribed two-command health entrance supplies the
causal distinction without a separate raw probe. A large logical-minus-guest
gap can exist when Windows has already deallocated blocks; even actual file
allocation does not predict a safely reclaimable amount. Only fresh volume
available bytes admit fabrication. API reference:
https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_compression_info

### Selected mounted-root discard before considering interruption

The 2026-10-23 ordinary owner plan received 545,312,997,376 VHD bytes both
logical and allocated, with only 52,174,499,840 physical bytes available. This
establishes an allocation problem, not a promise of a reclaimable amount.
Microsoft WSL 3.0.3 `src/linux/init/main.cpp` blob
`175c1742402822c63ee06df0d729edb365001d35` logs an unsuccessful offline
`e2fsck -E discard` and still returns trim response zero; its outer session
also tolerates trim failure before compaction. Historical compact success
therefore does not prove that discard happened.

The explicit `mounted-discard` entrance uses only `/usr/sbin/fstrim --verbose
-- /` with `LC_ALL=C`, qualified util-linux 2.39.3 source
`sys-utils/fstrim.c` blob `96b7d2d484657b388e73d922376e7b5efc9456c3`,
and installed SHA256
`000943de62b2ca1c7e2adba6bd22c4e8e491c6ae05ff43408f5aef29c15f8fe4`.
The single-mount path opens the selected filesystem and calls FITRIM; unsupported
and failed ioctls return failure. Its verbose count comes from `range.len`,
which can repeat already-discarded ranges and is not newly available Windows
capacity. Provider source: https://github.com/util-linux/util-linux/blob/v2.39.3/sys-utils/fstrim.c

The record's optional `linux.mountedDiscard` binds the original canonical
services-section root, a pre-existing private custody directory below its
data, actual custody owner UID, finite deadline and output budget. Admission
binds exact parameter bytes, request, a maximum ten-minute current interval,
current boot and mount namespace, and three distinct original Resource files
under that custody directory. The native caller must actually receive those
authority/checkpoint/independent-receiving contents, including concurrent
actors and discard's I/O impact, before invoking the operation. This source
does not grant privilege, manufacture those Resources or equate hashes with
acceptance. Native root and CAP_SYS_ADMIN are required without sudo or any
automatic privilege path. The native root caller creates only private request
files in the existing holder-owned custody directory and assigns those new
files to its declared original holder UID; no existing file owner changes.

Before dispatch the adapter receives the registered backing join, current
ext4 writable root/mount identity and qualified executable through no-follow
handles, then durably creates a fixed exclusive claim in that owner directory.
It retains the exact record, admission, Resources and intent before starting
the one child. It executes the held qualified provider descriptor and keeps
the root descriptor open, records PID, concurrently drains capped output and
awaits terminal even beyond the budget. A failure after claiming remains
unknown and blocks further attempts; no automatic expiry/unlink or new UUID
bypasses the claim. The original receiver must reconcile that custody before
any separately admitted later maintenance. Terminal success requires unchanged
root identity, native exit zero, no stderr, exact single-root verbose output,
and intact time/evidence allocations. No trim executes from ordinary plan,
capacity, apply, timers or compaction, and no WSL interruption or file deletion
is part of this operation.

### Receiving a retained legacy boot hold without changing it

The exact selector hold predates the canonical section-data requirement. Its
existing `90-wsl-host-quarantine-<id>.conf` still names the retained marker at
`<declared-home>/.local/state/wsl-host-service/quarantines/<id>.json`. Refusing
to create new custody there does not erase this original hold or prove that
its loaded condition remains operative. An explicit
`linux.legacyUserUnitQuarantine` declaration binds the original id, unit, UID,
home, origin and canonical sectionRoot plus both exact SHA256 values.
`receiveLegacyQuarantine` reads only that one pre-existing marker and guard,
checks private unredirected owner paths and original subject/origin, and uses
the existing bounded native user-manager port to receive the exact loaded
negative marker condition. Ordinary live plan includes this receiving when
declared; `quarantine-legacy-receive` exposes the same operation separately.

The receiver returns the retained original invocation as historical custody,
with no claim that its process survived a previous boot. It writes nothing,
reloads nothing and grants no release, migration, new legacy quarantine or
unknown-effect settlement. A canonical new hold still uses only section data;
the existing migration requirement retains its force if migration is selected.

## Finite native maintenance file caller

`src/native-maintenance-caller.mjs` supplies separately selected preparation,
launch, read and transfer operations. Its Windows scripts are source-owned,
bounded inputs to the existing same-user PowerShell port. Preparation creates
only the declared custody root (its parent must already exist), with an ACL
for the actual owner, SYSTEM and Administrators, and an exclusive
`<request>.caller` directory. It retains exact original renderer bytes as
`parent.ps1`, exact parameter/admission text, original Resource bytes and a
manifest. It does not launch that parent. Resource paths for this carrier are
the three fixed role files inside this caller directory. Existing custody is
validated without ACL changes and occupied caller custody is never reused.

Launch re-receives the exact manifest, parent and Resources and the current
admission interval. A durable exclusive launch claim precedes the same-user
PowerShell `-File` ShellExecute call with no inherited WSL standard handles.
The acknowledgement records the actual Windows parent PID; uncertain launch
custody remains held. The original parent still owns all native provider,
target, private intent/PID/stream/terminal and exclusive selected-distribution
checks. Neither preparation nor a source digest supplies original authority,
affected-work fencing or the user's other-work readiness.

A shared modern outcome validator receives only explicit bounded files. The
native parent's prior-claim loop and the separate reader use it to require
the exact packet/parameters/admission and Resource copies, matching intent and
native PID, identical target path/volume/file identity, actual zero exit within
the declared elapsed deadline, and complete non-overflowing/error-free streams.
A terminal status by itself does not prove success and cannot bypass a failed
request by allocating another UUID. Unknown custody has no automatic clearing
or reconciliation flag.

Transfer is a distinct operation with a fresh reentry admission binding the
received outcome and original reentry Resources. It selects only the original
distribution, explicit Linux user and qualified Node/owner receiver. All
payload bytes travel through bounded stdin, not command arguments; both native
streams are drained while awaiting the same child. The guest receiver verifies
the modern custody and reentry binding again, then exclusively flushes a result
under declared canonical private owner data. The compactor never bootstraps
the guest, the transfer never invokes compact, and neither releases a hold,
resumes an unmanaged chat or reopens fabrication. Those are original-holder
and ordinary prescribed-health receiving steps after independently admitted
reentry. Historical per-task scripts remain evidence, not compatible providers.

The Node entry is `scripts/native-maintenance.mjs prepare|launch|read`, with
explicit `--parameters`, `--admission` and either `--resources` (a role-to-exact
UTF-8-text JSON object) or `--receiving` (the independently received request,
parent SHA256 and admission SHA256). Preparation returns all private file
hashes. Maintenance Resource paths must be
`<custodyDirectory>\<request>.caller\<role>.resource.json`; it never overwrites
files. `launch` is the only command that starts the compacting parent.

Preparation also retains `read.ps1`, `prepare-reentry.ps1` and `transfer.ps1`
for a Windows holder to use after the guest is stopped. These exact `-File`
helpers verify their own manifest hashes and the original parent hash. The
reader emits the modern bounded custody bundle; it does not start a guest.
The reentry preparer takes at most 131072 UTF-8 bytes on stdin containing
`reentryText` and the three role-to-text `resources`, validates them against
the successful original outcome, and exclusively retains those files. The
transfer reads these exact files again and checks the current registered
target, native VHD identity and qualified provider immediately before its
one guest invocation. Neither a new admission nor a changed UUID bypasses
unresolved launch, native or transfer custody.

The optional native-compaction `reentry` declaration fixes `linuxUser`, the
Guix `node` executable, absolute original `receiver` path and `receiverSha256`,
`ownerUid`, canonical `sectionRoot` and an existing private `outputDirectory`
below its `data/logs`. A reentry admission has type
`WslNativeCompactionReentryAdmission`, version 1, the original `request`,
`outcomeSha256`, `parameterSha256`, `maintenanceAdmissionSha256`, a fresh
at-most-ten-minute `notBefore`/`expiresAt` interval, exact `invocation` and the
same three original Resource roles. Its resource paths are the fixed
`reentry-<role>.resource.json` files under that caller directory.

The transfer represents the repeated exact parameter/admission/packet texts
once, retaining the original packet digest; the guest derives those repeated
bytes through the original renderer and validates all native evidence again.
Its entire fatal-UTF-8 JSON stdin allocation remains 131072 bytes. Exceeding
this bound refuses before dispatch. The guest writes a single exclusive
`<request>.windows-outcome.json`, flushes file and directory, and returns a
receipt that explicitly leaves capacity, holds and chats unchanged.

`receiverClosure` fixes SHA256 values for exactly the receiver entry, native
maintenance caller module, native compaction module, backing-capacity module
and their four source-owned PowerShell assets (native parent, modern outcome,
file caller and backing observer). The small guest entry imports only Node
builtins, checks this complete fixed closure and its own entry digest before
dynamically importing the original implementation, and repeats the checks
before persistence. The Windows caller receives this same closed declaration.
The shared outcome validator compares the complete declaration, backing target
and admission objects with their exact original text, so a second unbound
packet declaration cannot choose different reentry code or output custody.

## Conditional finite Windows continuation

`observe-custody` and `prepare-custody` precede maintenance admission when its
Windows parent hierarchy does not exist. Optional `nativeCompaction.custodyPreparation`
fixes `existingParent` and at most eight literal `components`; their exact join
must equal the existing `custodyDirectory`. Observation receives that one existing
parent's actual owner SID, holder SID, effective writable principals, ACL digest,
no redirects and native directory identity. The 2026-10-23 original read-only
consumer refused `C:\Users\emsen` when the first implementation incorrectly
required the ancestor to have the final private directory's owner. The ancestor
is a distinct receiving subject: preparation requires its actual owner and all
effective writers to be the actual holder, SYSTEM or Administrators, exactly the
principals already trusted by original private custody. Inherit-only rules do
not grant writes to that ancestor. An unreceived owner/writer still refuses.
Every new final custody directory remains strictly owned by the actual holder
with the original protected private ACL; no ancestor ACL/owner is changed.
Preparation
takes independently addressed `WslNativeCompactionCustodyParentReceiving` containing
that exact observation, stable template digest and original receiver Resource.
Before creating directories it exclusively flushes a source-owned deterministic
bootstrap claim under that received existing parent. Bootstrap claim/intent/result
files are created exclusively with the holder's protected private file ACL at
creation, so ancestor inheritance never exposes or expands their writers. Every existing component is
received without ACL changes; every missing component is created with original
private custody ACL. The claim retains partial/unknown failures. A completed
original receipt and unchanged private hierarchy permit subsequent no-write
receiving. These APIs use only the parameter record/parent receiving; no fake
maintenance request, authority, readiness or admission is needed for data setup.

The optional `reentry.continuation` declaration selects
`one-successful-outcome-transfer`, algorithm `wsl-native-complete-success-v1`,
the stable original file-caller PowerShell template SHA256, an absolute UTC
`expiresAt`, `reentryValidityMs` (1..600000) and `parentDeadlineMs` (1000..3660000).
Its overall validity cannot exceed the maintenance admission's expiry plus
the native deadline and ten minutes. A newly generated admission cannot extend it.
These fields select the original service's finite caller, never another program.

For this mode, the original three Resources have strict semantic schemas:
`WslNativeCompactionConditionalAuthority` addresses request/parameter digest,
holder actor and original authority Resource, exact target/SID/reentry invocation
and receiver closure, one-transfer limit and overall expiration;
`WslNativeCompactionConditionalCheckpoint` addresses that authority digest,
the actual final work checkpoint, four original host-main/host-ingress/composer/
selector hold receiving Resources, affected work and an actual human other-work
readiness answer; `WslNativeCompactionConditionalReceiving` addresses both prior
Resources, exact stable template/closed receiver and independent qualification of
the source-owned algorithm and caller. Every referred Resource has an explicit
original path/SHA256; there are no approval flags. Source validation receives
schema and exact scope; actual original-holder and independent receiving still
receive the referenced records before preparation/launch. Hash equality supplies
neither authority nor the currently unanswered readiness.

Before Windows preparation, the Linux original caller reads only those addressed
prior files: canonical regular files in original typed owner data, owned by this
UID with no unreceived writer, each at most 131072 bytes and at most 2MiB in total.
Each actual byte digest must match its semantic Resource reference. Missing or
changed prior custody refuses before the Windows preparation port. These are
prior actual records, not synthetic paths or an authority flag.

Preparation retains a source-owned `continue.ps1` alongside the existing helpers,
and the manifest hashes its actual rendered bytes. The separate launch still
claims `launch.claim` once before ShellExecute. For the explicit conditional mode
it starts that surviving Windows caller without inherited WSL pipes. The caller
exclusively claims its one continuation, receives original private custody and
scope, starts the same retained native parent, durably records its actual PID and
awaits that same process. If its deadline is exceeded it continues awaiting exit
and refuses continuation; it never kills or substitutes another child. The native
parent retains its existing terminal-first custody and never starts a guest.

Before that native child, the surviving Windows caller receives the original
launch claim and, within a fixed five-second handoff interval, the launcher's
durable acknowledgement naming its actual PID. A missing/changed acknowledgement
refuses before offline dispatch. It retains its own holder PID and correlates the
awaited native parent's actual PID with that parent's original intent. Current
qualified provider files and target are locked/received before derivation and
again by the original transfer entrance. Its separate transfer-file process is
also awaited to actual terminal; unknown outcome never initiates another call.

Only after full successful modern outcome/target/provider receiving does the
Windows caller derive three reentry Resources. They identify the original role
Resource, original prior human/checkpoint/independent facts, actual outcome digest
and observation time, and this algorithm's receiving. They do not invent a new
human grant, later independent human review, application drain or all-actor fence.
The caller flushes outcome/derivation receiving first, then exact derived Resource
bytes and fresh reentry admission, re-receives all files, and calls the same
original transfer entrance/claim. Guest receiving independently reconstructs and
checks those semantic derivations before persistence. Unknowns and all holds stay.

The original manual read/preparation/transfer entrances remain separate operations
and cannot bypass shared launch/transfer claims or occupied conditional custody.
Actual Windows native qualification uses private finite fixtures and benign
children only, including survival of a benign initiating process, exact parent
PID/terminal awaiting, shared-claim exclusion, failed evidence refusals and one
positive derived transfer. No fixture stops, compacts or starts a real distro.


## Complete an explicitly selected original legacy hold

The retained October19 marker predates canonical owner data/state. Read-only receiving already binds that exact marker and native condition; forcing a second hold/migration solely to release a qualified successor adds custody without useful authority. The existing release entrance therefore accepts an explicit legacy subject selector, shares the original release validation, and leaves default canonical behavior intact. Both declarations together are ambiguous and refuse. The original independently received replacement Resource and reviewed source digest remain the authority; the selector grants none.

Native Guix host generations deliberately share package.json with a registry runtime. Following that link identifies the code carrier, not the registered host artifact. The finite native port invokes the selected immutable CDE profileArtifact codec with the source-bound qualified Guix package query. It neither duplicates the profile parser nor starts a controller. All source, old-effect, command, hierarchical-cgroup and recovery-hold requirements remain. The profile record/link are checked again before the durable outcome. The original marker parent, including the explicitly selected legacy directory, is fsynced after release; no new marker or guard is created.


## Address one native backing volume within the existing deadline

The original 2026-10-24 phase observation reached native allocation at about 6.7 seconds and then timed out loading/querying Get-Volume within its unchanged ten-second budget. The producer now obtains the normalized volume GUID from GetFinalPathNameByHandleW on the same registered VHD handle, and uses GetDiskFreeSpaceW only for sectors-per-cluster times bytes-per-sector. It never uses that API's cluster counts for large-volume capacity. The original file identity, allocation and named-file rechecks remain.

One filtered MSFT_Volume query receives Path, HealthStatus, Size, SizeRemaining and DriveLetter without loading Storage's cmdletization module or discovering a volume from a path. The received path must equal both native handle and declared volume; Healthy remains numeric zero. DriveInfo still supplies the original caller's quota and the minimum of caller/volume free bytes remains authoritative. Unknowns refuse. No cached capacity, new worker, timeout extension or offline maintenance is introduced. Native receiving returned fresh capacity in approximately 5.5 seconds of monotonic observation with the original nonce and freshness checks.

Primary contracts: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew ; https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-volume ; https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdiskfreespacew .

The online observation binds the same native file identity and attributes around allocation, and reopens the named path to receive that identity again. Normal content writes or VHD growth do not replace a handle or invalidate its native allocation sample. Requiring content length or write-time quiescence wrongly coupled this read-only capacity observation to an idle distro; those volatile fields never authorized a discount against Windows free capacity. Actual allocation and logical length remain bounded observations, not a reservation. Independent healthy-volume free bytes, caller quota, full growth charges, nonce and monotonic freshness retain the admission law. Offline maintenance and quarantine controls are unchanged. Native qualification includes a concurrently written disposable file and the actual user-manager capacity context.

### Live service working-set receiving

2026-10-24 service-manager receiving: budget the measured anonymous working set. The native WSL plan observed user.slice at 3,737,382,912 bytes with 3,580,792,832 anonymous bytes against a 3,670,016,000-byte high, 94.93% full memory pressure over 60 seconds, 3,629,788 KiB VM memory available, and no OOM kill; even systemd user property reads timed out. Keep agents above their former 3 GiB failure floor: move exactly 596 MiB of their 4 GiB share to services (agents 3500M, user.slice 4G). The observed agent anonymous set was 2,118,643,712 bytes with 1,156,399,104 file bytes; the new share retains that anonymous set and about 1 GiB of file cache. Preserve Guix 1536M (its documented 1G regression), agent/service hard ceilings, zram 1G, and kernel headroom 2G. High-water sums remain 12,204 MiB within the 12,288 MiB VM. Apply and receive through the existing WSL host service; this is neither new runtime machinery nor Windows/offline maintenance.

### Bounded issuer factory receiving

2026-10-24 bounded issuer factory receiving: the measured 633 KB/107-file native closure stalled before inference while the factory used about 61 MiB RSS. Fixed-counter USE showed about 3.8 GiB VM memory available, user.slice near its soft threshold, and Guix about 261 MB current with negligible anonymous memory. A bounded trial moves 128 MiB of soft share from Guix to user services: user 4224M, Guix 1408M. Preserve agents 3500M, all hard ceilings, zram 1G and kernel headroom 2G; the total remains 12204 MiB of 12288 MiB. Guix remains above its documented 1.2 GiB request. Native Linux apply converged. Later exact-job receiving located the immediate stall in the nested agent-work.slice, where an unnecessary additional parent wrapper had placed this admitted small Codex command; it did not establish parent-budget recovery. Reconcile the already-declared shared containment projection through codex-home apply --scope=harness and use the actual controller admission without adding parent containment. Native isolated assay limits remain unchanged. The trial is not useful-operation receiving and does not authorize successive blind increases, process kills, cache drops or Windows/offline maintenance.


## Sparse-maintenance parent interruption and independent lifetime

The 2026-10-26 sparse request `30e31cab2d6400505c1cd70a005b58174ee9425a768730ab4d5d34ae368a8279` retained Windows PID32384 and its start time, then remained in `running` after that process disappeared. It had no terminal pending file or result. Its output recorded `WSL_E_DISTRO_NOT_STOPPED`; subsequent native capacity observations came from the running Ubuntu distribution. The source therefore needs both an explicit distribution stop and a Windows parent whose lifetime survives that stop.

The original sparse owner now uses a shared native Windows process helper. `CreateProcessW` requests breakaway from a containing job and inherits no handles; the actual child independently reads `IsProcessInJob` before the original maintenance mutex, delay and script. A failed creation produces a native failed-launch terminal state. A started parent that cannot receive its own independence records failure before stopping a distribution. The [Windows job-object contract](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) defines that breakaway behavior. This change leaves the separate original native-compaction controller and its authority inputs intact.

Interruption receiving is an explicit action for one exact prior request. It requires the same owner SID, recorded PID/start pair, identical host parameters and retained source hashes; the recorded process must be gone. While holding the original distribution mutex it reads WSL's running-distribution list and requires the exact selected distribution. The original incomplete state stays unchanged. A separate interruption record binds its state and launch digests to these native observations. Every subsequent launch checks the retained record and reobserves the dead parent, mutex and running distribution. This receives an interrupted process as such and preserves its original operation history.

The sparse script durably writes its phase and native result fields before stop, conversion and restart, and after each returned operation. Interruption during a later attempt therefore retains the last reached phase. The native provider still owns its distribution and disk locks. Current sparse policy rejects `compactWhenBelowFloor=true`; its automatic compaction branch is removed. The retained separately qualified native compaction API is not launched or authorized by this incident repair.


# Retire the declared Work timer without a backslide

The canonical BCF record still selected github-reconcile as active after the
Leader stopped it. The original host producer would therefore restore its
persistent enabled link. WSL-95..99 supersede WSL-53/54 for this explicitly
retired role; maintenance timers and other declared roles retain their contracts.

Move the complete original declaration into `linux.retiredManagedTimers`, with
its retirementReason and exact command/source provenance. Keep the active list
empty for this role. This is one record-owned lifecycle, not another scheduler
or work registry. Old producers see no active declaration, so they cannot restore
this timer. The current producer validates the combined bounded, unique role set.

The original managed-timers renderer emits files only for active declarations.
The original plan reads both lifecycles. The native actuator receives each retired
role's installed system fragments, absence of drop-ins, unprivileged owner,
working directory and exact command, and its declared transient predecessor.
Retirement does not execute or requalify an abandoned application source closure.
It uses only systemctl disable --now on that exact system timer and stops a
received transient predecessor timer if needed. It never stops a service, waits
in a polling loop, resets failure, reloads the daemon, deletes files or touches
application state for retirement. A still-running service or uncertain native
result remains an attributable partial outcome; its original job must finish.

Native receiving then requires persistent disabled/masked status, no next trigger,
quiescent service and predecessor. An idempotent apply executes no commands. Mixed
active/retired selections retire first, then reuse the existing active installer;
an unresolved retirement cannot begin an active installation. Staging emits only
active files and no lifecycle effects. Regression cases cover active compatibility,
retirement/idempotence, a running job, changed native identity, lost enablement,
old-reader-safe record shape and uncertain native disablement. Host adoption uses
only the original --component=managed-timers CLI and canonical BCF WSL record.

## Canonical local origin: scoped OS integration

The 2026-10-26 Leader request and independent network review select the existing
Windows Tailscale daemon, WSL NAT, a loopback Caddy HTTPS listener and original
MetroPlat HTTP listener. A second VPN daemon or custom TLS/ACME implementation
is unnecessary. src/local-origin.mjs owns this host integration; the explicit
--component=local-origin scope performs no storage, timer or memory reconciliation.

The original host record's localOrigin supplies hostname, unprivileged owner,
private state directory, Caddy binary/digest, scoped credential environment,
public DNS resolvers, loopback upstream and exact Windows paths/node identity.
Its linux.wslConf selects network.generateHosts=false. This component reuses
the existing renderIni, preserving other settings/comments without restarting WSL.

One uniquely marked hosts block owns only the canonical hostname. Both readers
reject competing mappings outside it; Linux rejects redirected paths and both
preserve unrelated content. Windows retains UTF-8 BOM/CRLF. Caddy binds only
127.0.0.1:443, disables its admin endpoint and automatic HTTP redirects, and
uses DNS-01 with explicitly public resolvers so local hosts changes cannot
redirect challenge discovery. Only the scoped DNS credential enters its
EnvironmentFile. The native system service runs as the declared user with
CAP_NET_BIND_SERVICE, NoNewPrivileges and read-only system/home protection;
its declared state directory is its only persistent writable location.

The Windows scope renders a separate PowerShell operation and never launches
an apply implicitly. Default invocation is read-only. Explicit -Apply checks
native Administrator standing, original Windows Tailscale node identity, no
selected 443 conflict/Funnel, and current hosts/Serve inputs before effects.
It backs up prior hosts/Serve state, changes only its hosts block/TCP443 forward,
and independently compares the selected forward and unrelated Serve entries.
Uncertain or failed effects retain backups and fail closed; no operation restores
a public tunnel. Converged apply has no writes or lifecycle commands. The Linux
service starts/restarts only for changed selected configuration or missing activity.

Cloudflare public DNS/tunnel changes remain their original provider's separate
operation. WSL Host does not invent an ACME client, DNS server, relay, scheduler,
login or federation treaty. Windows/WSL TLS, real Tailnet receiving, old edge
refusal and disconnected browser use remain actual installed receipts.

### Additive preventive quarantine custody

A stopped monitor can still be re-enabled by its original installer. Under backing-volume pressure, an observed disable is immediate containment; the original WSL record also needs a persistent admission condition that survives that enablement. `userUnitQuarantines` adds up to 32 declarations to the existing single subject. The owner validates the entire set before selection, observes all entries by default, and requires `--quarantine-id=<id>` (the library operation's third argument) for ambiguous mutations. An explicitly supplied empty/unknown selector refuses. Legacy receiving remains a separate exact-byte subject and does not consume or reinterpret the collection.

`releasePolicy: "hold-only"` is explicit and valid with either `stopped-no-resident` or `frozen-resident`. It accepts absent/empty dependencies and encodes the policy in the marker; it grants no CDE effect receiving authority. Every old marker without this field retains the default `cde-release` meaning, including stopped markers. Default frozen and CDE-stopped encoding remains unchanged. Reinterpreting a held subject through a changed declaration refuses. The existing private marker-first write, native stopped snapshots and manager-loaded negative ConditionPathExists receiving are reused, including the post-condition snapshot that detects terminal-to-terminal races. Partial receiving failures retain custody. Hold-only release stops before any release effect even if a caller supplies a replacement receiving object.

The opt-in `test:native:quarantine-preventive` fixture (`WSL_TEST_PRIVATE_USER_MANAGER=1`) uses one collision-checked own harmless runtime unit, RAM custody and a unique native drop-in in the executing user's declared home. It proves the command can run before the hold, that the loaded condition denies reentry, and that no release record appears. Cleanup first receives zero PIDs, no job and a terminal state, then removes only exact-owned links/drop-in/fixture files; unknown receiving retains custody. It does not touch a production unit or require a CDE profile, installation or build.

### Preventive frozen runner custody

A runner that has already registered may continue accepting work even when a workflow is disabled, and stopping an old shell wrapper can leave its listener alive. The immediate native containment is an explicitly authorized freeze of the exact owned systemd cgroup, preserving every raced-in process and its custody. The original quarantine owner can then bind that frozen invocation with explicit `hold-only` policy and its existing private marker/loaded negative condition. This is a preventive policy, not CDE replacement receiving: release always refuses, no fictional dependency is recorded, and no stop/kill/thaw operation is added. Default frozen and CDE-stopped marker encoding and release receiving remain unchanged.

New frozen preventive plans recapture the current native frozen identity; creation and idempotent receiving also recapture after the manager-loaded condition. A changed process, invocation, job or freezer state refuses a received pause while retaining the marker and guard. After boot or disappearance, custody cannot be silently reinterpreted as a terminal job: its persistent startup guard remains, and the unknown resident/effect boundary requires original-owner receiving. A native own-unit fixture freezes a harmless sleeping unit, receives the exact resident and loaded guard, and retires only that fixture after terminal receiving. Production runner resumption separately requires the original runner owner, preserved registrations and native Windows physical reserve plus declared job peaks.

Ordinary host health rendering prints compact current rows for positively received quarantine subjects from the same original observation, alongside its existing failed-check rows. This exposes the configured holds without extra manager/capacity queries and grants no job-admission, release or thaw authority.


### Completing the same interrupted hold

An original marker can survive before its guard is created or its daemon reload is received. Reentry receives that marker through the existing parser, captures the same paused native subject, and pins its digest throughout this operation. Exact already-loaded guard receiving keeps the prior no-reload path. Otherwise the original exclusive safe-path writer may create the exact missing guard; an existing guard must already match the original bytes. Unknown manager observations are not treated as an absent guard. Before and after the one original daemon reload, and after actual loaded negative-condition receiving, the marker digest and original paused capture must still match. Failures retain the marker and any staged guard; a subsequent exact reentry can complete them. No marker rewrite, permission repair or unit lifecycle operation is introduced, and the existing release implementation is unchanged.

The independent fixture suite retains the original 42 cases, updates only the failed-reload reentry expectation from impossible completion to a repeated actual reload failure, and adds eight partial-operation controls. A group-writable fixture path is changed only by the fixture itself to model a separately received owner prerequisite; hold never fixes modes. This source receiving does not constitute a production permission change, a native runtime installation or a unit release.

### Explicit quarantine owner-path prerequisite

`quarantine-prepare-owner-paths --parameters=<canonical record> --parameters-sha256=<independently received current whole digest> --quarantine-id=<exact id>` is a separate original-owner operation. It loads `linux.quarantineOwnerPathPreparation: {path,sha256}` from the canonical record, receives that private original product and its stable normalized selected declaration digest, and binds the exact retained marker device/inode/owner/digest. The historical whole-record beforestate in the product is evidence; it does not hash the newly linked canonical record and create a cycle. The CLI invokes only the production-default native port, recapturing the same paused native subject before and after the helper. Ordinary hold, plan/apply and release paths do not invoke this prerequisite.

The source-pinned private Python worker opens only the declared home, `.config` and `.config/systemd` using actual no-follow directory descriptors. Both exact0775 native prestates must match before any permission effect; then `fchmod(fd, before & ~0020)` and directory fsync are followed by identity/mode/path/xattr receiving and a fsynced original receipt step. An exclusive exact-id owner fence serializes cooperating operations. An interrupted unreceipted mode remains unknown, never silently treated as an owned effect. No kernel conditional fchmod exists: descriptors prevent redirected effects, immediate checks detect supported races, and interference by an uncooperative same-UID/privileged writer remains outside the claimed atomicity boundary. No content/owner/ACL writes, recursive walk, general permission API, automatic retry or default permission flag is added.

The operation records its intent and contiguous per-directory results in `<original quarantine area>/<id>.owner-path-preparation.jsonl`. Matching received steps can be observed/reused without another chmod; unknown chains, bindings, identities and modes refuse. A process interruption can retain the fixed fence for explicit original-owner receiving. This receipt never settles unknown publisher effects or grants worker resume. The same original hold is subsequently invoked as a separate operation to create/load its guard. Actual syscall fixtures use only disposable owned directories; they do not fabricate native pause authority.

The canonical and preparation file reads use a private two-slot receiver, not the write-path predicate. Its slots are `parametersPath` and `preparationPath` within the selected canonical section's data/records; it refuses redirects, public/nonregular files, foreign native owners, hardlinks, excessive size, changed expected bytes or descriptor/path identity. Fstat receives the64KiB bound before buffer allocation. The original issuer compares the returned native identity and content before/after effects. A0775 committed records ancestor is not mutated or treated as permission authority. Every actual effect path keeps the original strict checks; the receiver has no package export or mutation/admission capability. Its source digest joins the original issuer/helper source binding.

## Selected native storage-provider health

The original capacity producer remains the admission snapshot and its fast call path is unchanged. Incident588 revealed an attribution gap: WSL3.0.3 creates default swap below LocalAppData/temp/<live VM ID>/swap.vhdx, while a direct Temp/swap.vhdx absence does not receive it. An optional windows.storageProviders declaration selects a read-only plan component, also observed by ordinary host plan. It reuses the original capacity asset's native same-handle allocation helper, binds the actual WSL executable/version, profile/configuration and native wslinfo VM identity, and rechecks that VM identity after receiving. The bounded native asset reports per-provider typed received/unknown states; VSS initialization failure remains unknown, and PageFileUsage MiB is not a native file-allocation measurement. Docker data remains unknown without original source-owned location receiving. A compact row preserves timestamp/source/identity or exact failure; these points are neither sums nor physical capacity credit or historical attribution. No writes, elevation, scans, timers, repair or admission override are introduced.

For an explicit swapFile, the shared PowerShell resolver accepts only a drive-absolute non-wildcard path without parent traversal. Microsoft WSL3.0.3 WslCoreVm.cpp525–530 appends the .vhdx extension if the selected extension differs; this exact native rule is retained, including append rather than extension replacement. The same resolver is qualified by an effect-free native PowerShell batch for default, explicit and refused inputs; no alternate-file probing is introduced.

## Guest capacity command refusal

The operations record may declare `linux.capacityCommands` with two exact
package-owned commands, their original SHA256 digests and guest diagnostic
paths, the package-managed system Bash and dpkg entrances, and the original native
physical-capacity argv. `--component=capacity-commands plan|apply` alone owns
these effects. Ordinary health observes this declaration without installing it.

A guard rendered from an earlier declaration (for example after the parameters file moved, 2026-10-30) is still this service's own image: the diversion is LOCAL to the declared guest path and the guest holds the original bytes. Plan reports it as a stale guard instead of an unreceived replacement, and apply re-renders only the guard; the diversion and the kept original are not touched again.

The df command refuses space output rather than fabricating a POSIX filesystem
whose free blocks equal Windows host-free. Filesystem stat mode refuses too;
file stat forwards unchanged, including formats that contain literal `-f`.
This boundary covers the selected merged-/usr command entrances, not arbitrary
Python/Node statfs syscalls or immutable alternate coreutils copies. Producer
admission must continue using the authoritative native backing observer.

Installation first receives all original package/path/digest/diversion tuples,
creates an exclusive small guard file, hard-links the exact original image to
its explicit diagnostic path (no binary copy), records a local dpkg diversion
with `--no-rename`, rechecks custody, and atomically selects the guard. Dpkg
therefore sends later package images to the original diagnostic location. A
partial preparation is reenterable only while the exact original tuple still
matches; foreign bytes/diversions refuse. Successful directory fsyncs and a
fresh plan receive selection. A package change is drift requiring receipt of
its new digest; it never silently restores misleading output. No shell aliases,
boot timer, deletion or storage ceiling is used.

Rollback is an explicit reviewed original-owner operation: receive the guard
digest, original diagnostic and local diversion again, atomically restore the
original image, then remove only that exact diversion with `--no-rename`. It
is never inferred from a missing or changed declaration.

The diversion protocol follows Debian dpkg-divert(1) local/no-rename ownership;
GNU coreutils df/stat retain their original guest diagnostic semantics.

## Explicit original WSL orphan-swap retirement

Microsoft WSL3.0.3 source15ea3b3846c5f18318722d1381186b2ff6ed72eb creates swap below native LocalAppData/temp/<VM ID> and deletes a newly created swap at VM terminal cleanup (WslCoreVm.cpp517–554,853–870). Interrupted cleanup left two source-derived, native-owner/identity-qualified files. Their current operation is a finite declared target set, not a retention service. The original renderer validates instance data and emits one source-hashed Windows request. Actual admin/native HCS and exclusive file handles provide production preconditions; fixture observations cannot issue them. Use Microsoft HCS JSON through ComputeCore, native no-follow file handles and FileDispositionInfo, and one private temporary JSONL result for durable per-file receiving into the existing incident record. Hold every target before any disposition; retain partial/error custody instead of replaying unknown effects. Never delete an arbitrary caller path or the current swap, infer detachment from DiskImage, scan Temp, change Windows protection or weaken original capacity/CI/pause behavior.

An explicit stable swapFile is an existing native producer configuration, not a new quota. It keeps one source-owned path across future VM starts and retains current memory/default swap size; no running VM is restarted to select it. The active old path remains received separately from the desired future configuration.

The first elevated observe refused before journaling because ordinary Windows Temp and the historical GUID directories inherit sandbox/capability write ACEs. The retirement now binds the exact received parent identity and native owner+DACL SDDL digest, holding only those two no-follow directory handles with read/write sharing and no delete sharing. File objects remain pinned by exclusive read/delete handles; security is read through those handles. The Temp root is neither locked exclusively nor rewritten. A private CreateNew journal opens before administrator/version/interop admission, receiving actual token/error stage on refusal; a failure to create it is explicitly returned on the process channel. The first failed observation caused no file dispositions and cannot qualify a later retirement.

Stable swap prevention uses the existing wslConfig entry renderer and scoped Windows apply, with only swapFile added. Microsoft WSL15ea3b3846c5f18318722d1381186b2ff6ed72eb WslCoreVm.cpp517-544 selects per-VM Temp only for an empty path and reopens an existing explicit VHD;853-870 performs normal new-file/temp cleanup. A crash can leave one reusable stable file instead of a new forgotten file per VM. No shutdown, forced lifecycle change, swap-size change, memory change or recurring cleanup is introduced. The optional provider swapFileTransition carries fromVmId/fromFileIdentity/toWindowsPath. While that exact native VM remains, the source-derived default live swap is still received and bound to its prior identity; the newly configured path is explicitly pending. After a VM change, the actual configuration must select the declared stable path. Native path/volume/file observations remain read-only and grant no admission authority.

Explicit user-unit retirement is separate from managed timer operation. The original managed-timer receiver intentionally binds system-owned declarations and transient legacy user units; it must not be weakened to adopt unrelated persistent manual units. linux.userUnitRetirements instead names exact already-quiet user fragments plus original qualified artifact files. The original native managed-timer observation port supplies typed ExecStart, owner and cohort facts. Private application uses only default native ports, re-receives quiet bindings before every unlink and reload, and receives native not-found afterward. File handles bind recorded owner, device/inode, mode and SHA256; every ancestor is checked without following symlinks. Empty-directory removal is atomic, never recursive. A missing fragment still loaded in systemd requires reload-only reentry; absent files alone are not current. Ordinary plan observes configured retirements, while mutation remains a selected component. The obsolete root host retention templates are preserved as tiny audit data in the existing incident record, not shipped as executable pruning machinery.


## Original local-origin offline client qualifier

`scripts/qualify-local-origin-offline.mjs` owns the finite read-only receiving operation, separate from host configuration. Root invokes the original SYSTEM `systemd-run --collect --wait --pipe` entrance with one random unit, unprivileged declared UID, `IPAddressDeny=any` and `IPAddressAllow=localhost`. The same client first must fail its explicit external HTTPS control, then receive page, health and graph via curl's canonical-host `--resolve` to127.0.0.1, trusted TLS and no proxy/redirect. Each network IO has a native diagnostic deadline; no global network state changes. The parent independently receives not-found after terminal execution. Unknown/lingering native state is a failed qualification with its exact unit identity, never a cleanup or whole-machine-offline claim.

The served HTML supplies module entries and its actual import map. The original pure `served-importmap` helper normalizes URL/scoped/exact/prefix/null selections; the caller confines every selected graph URL to the canonical HTTPS origin. A selected hash-bound existing original JavaScript parser supplies literal static/dynamic requests; Node's SourceTextModule separately checks ESM syntax. Nonliteral dynamic requests are counted as unreceived, literal node: dynamic requests are listed as nodeSchemeDynamicImports and excluded without claiming their execution condition, and neither code nor authenticated browser is executed. Bodies are discarded after hash/parse; graph digests bind URL, bytes, SHA and selected edges. No module body, temporary source file, output fixture directory or persistent diagnostic service is created. Historical result-only receiving is retained in its original incident record; this source replaces the missing replayable procedure.


Replay with the selected existing Node24 and original parser source, for example:

```sh
sudo env NODE_DISABLE_COMPILE_CACHE=1 /selected/node scripts/qualify-local-origin-offline.mjs \
  --origin=https://machine.example --uid=1000 \
  --parser-module=/gnu/store/received-parser/src/javascript-parser.mjs \
  --parser-sha256=<received-parser-file-sha256>
```

Select the real original parser file/hash and unprivileged host owner rather than the illustrative paths. The optional `--external-control=https://example.com/` must first receive trusted HTTP200 outside the diagnostic client; its actual remote address is pinned in the denied client so DNS failure alone cannot satisfy the egress control. No curlrc, proxy or caller CA-file override participates. A response is received only with HTTP200, TLS verification0 and actual127.0.0.1; redirects never follow. Native per-request IO bounds and a180-second transient service lifetime apply only to this diagnostic client, with no application/work/generation limits. `NODE_DISABLE_COMPILE_CACHE=1` prevents diagnostic Code-cache writes (the selected Node24 has no --disable-compile-cache flag). The transient service also clears inherited cache/coverage/warning-file/Node-option variables; this does not alter the caller shell. See https://nodejs.org/download/release/v24.15.0/docs/api/module.html#module-compile-cache. The parsed HTML carrier is ordinary script/importmap/base markup, not a complete browser DOM; ambiguous import-map ordering/carriers refuse. The application HTTP byte total counts each fetched body once and does not double-count inline modules already present in the page. Before/after source hashes bind the exact qualifier/resolver/parser selection. Terminal FAIL still awaits the same native collected-unit absence; unknown state returns nonzero with the exact unit.

The helper follows WHATWG resolving-an-imports-match: non-special URL schemes permit exact map matches but no prefix remapping (https://html.spec.whatwg.org/multipage/webappapis.html#resolving-an-imports-match). Classified child kind/stage/name and fixed-enum native signal/error code are forwarded on a failed qualification; arbitrary stderr/error messages, URLs, headers, application bodies and unknown labels are discarded. Unit receiving retains its own numeric exit and safe native diagnostic.


## Maintenance reentry follows the canonical Data owner

The reentry declaration is an operative future output binding, not merely historical commentary. Leaving its sectionRoot/outputDirectory on a retired services layout can recreate that directory during an otherwise separately admitted transfer. A layout correction therefore updates only those two original host-record fields to the current owner's section and the same data/logs suffix. Receiver path, all closure hashes, owner UID/SID, Windows custody, reserve and existing maintenance capability remain unchanged. Existing parameter/admission/custody evidence keeps its original bytes and is not silently rebound.

The ordinary Windows renderer does not consume these reentry paths; it manages its existing four configuration files. Receive identical before/after rendered files and a zero-write, zero-command scoped reconciliation. Do not manufacture an admission or run the receiver to demonstrate a path correction. If the pinned historical receiver or its output directory is absent, report that fact; no substitute, directory creation, compaction, guest lifecycle or capacity credit follows. Current canonical records are authoritative for subsequent separately admitted operations, while prior receipts and quarantine owner labels remain historical evidence.

## Selected Docker allocation points (WSL-135)

The original observer previously returned unknown for every Docker point even after an operator qualified a native location. An optional `storageProviders.dockerData` declaration now carries `rule: declared-native-docker-artifacts-v1` and an ordered `artifacts` list of `{name,path,volumeId}`. This is a selection of observations, not an ownership or cleanup capability. Original machine configuration receives the location evidence separately. The same Windows request nonce, freshness budget and original `WslBackingFileAllocation.Observe` handle receiver bind the resulting path/volume/file identity and allocation. Missing files or changed volumes remain unknown; duplicate identities refuse to prevent hardlink aliases being counted twice. The health text explicitly reports selected-artifact scope. No total Docker usage or recoverable-byte sum is inferred. The existing undeclared behavior and all other providers remain intact. Actual native qualification and source/record receiving precede adoption; no helper files, Docker lifecycle commands or scan are introduced.

## Original derived-Code-cache retirement (WSL-136/137)

The native metadata index exposed an old four-executable plugin cache, not a disposable profile. Its installed original maker compares cache content with the selected local CLI, recreates missing/different managed entries in staging, and bypasses this old cache in the current managed Windows runtime. Retiring only independently selected superseded signed derived binaries is therefore distinct from deleting unique profile Data or removing a capability. The record retains the actual maker range/hash, installed package and local replacement supplier, stable configuration hashes and exact native target/parent receipts. An old self-reference in historical profile Data is preserved; a current managed registration selecting the retired cache refuses.

`derived-code-cache-request` is a separate explicit source-owned operation, never hidden in ordinary host apply. Rendering is effect-free; the Windows leaf re-receives authority-relevant native facts. It imports the existing orphan-swap asset's qualified native file identity/security/disposition implementation, without calling its VM/HCS policy, and adds held-handle SHA and native stream enumeration. Only the selected four executable names and single native links are eligible. The held no-delete parent and exclusive file handles prevent ordinary rename/write races. All four are received before the first mark. Each completed file must be natively absent; unknown or partial results retain custody and do not mint recovery credit. Source/provider/configuration/native-host checks run again before marking. Legitimate unrelated ACLs are bound, not rewritten. The one private CreateNew JSONL outcome uses the existing original request/launch/receiving discipline; there is no new store, daemon, timer or automatic sweep. Ordinary physical admission and the reserve remain unchanged.


### Redundant installer download cache ownership

The PowerToys 0.100.2 updater uses default Windows.Web.Http caching and then copies the completed response into its pending Updates installer. Native USN and WinINet receiving identified two distinct byte-identical installer objects; state readyToInstall requires preserving the Updates object. The explicit WinINet leaf therefore binds one cache key by digest and one native cache object, holds the pending installer against write/delete, and asks the original WinINet owner to release only its redundant entry. A held cache read handle denies writes but permits native delete; native DeletePending and final absence distinguish accepted requests from reclaimed allocation. The machine record selects exact objects; ordinary plan/apply does not invoke retirement. Native signature, ID/security/hash/streams and update-state rechecks protect the selected bytes; read-only observation or JSON alone grants no disposal authority. The installed third-party updater is not claimed patched by this one-shot operation; its download-only NoCache source correction is a separate owner delivery.


## Finish a captured unit rather than perpetuating a hold

`completeQuarantine` finishes the existing quarantine owner with the same explicit declaration and identity port. A small current outcome at the marker's owner location moves from retiring to retired to completed. Original marker bytes bind every reentry. The native retirement port applies KILL to the still-frozen unit cohort and then stop, so the obsolete code is never thawed to perform more work. Terminal receiving precedes removing the exact owned controls; partial control clearing resumes from the durable retired phase. The operation does not start a replacement or alter any other controller guard. The deployment owner can then install its corrected immutable runtime through its normal entrance. This retires an obsolete invocation; it does not fabricate a receipt for external HTTP or storage effects.

Completion installs an owned temporary service drop-in with Restart=no and an appended ExecCondition=/usr/bin/false. It receives both loaded properties before retiring or thawing an empty cohort. This also fences a restart queued before the repair; the original ExecStart and other owners' condition commands are unchanged. The native deadline bounds waiting for a guarded queued attempt to become terminal. The operation removes its temporary drop-in only after receiving terminal PIDs, jobs and cohort, then verifies all of its controls are gone. Reentry never repeats KILL on an empty captured cohort.
