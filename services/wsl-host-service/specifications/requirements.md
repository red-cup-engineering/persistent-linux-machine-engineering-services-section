# WSL host service: requirements

Leader statements taken as theory:

- 2026-10-08: "Leave the WSL shit but as ONE thing clean up all our wsl shit to be real proper engineering a real proper package a real fucking thing."
- 2026-10-08: "we cannot rely on metroplat being up for the WSL shit to stick."
- 2026-10-09: the WSL virtual disk lags and crashes; Windows Defender exclusions were already present.

Each requirement has one shall. Identifiers are stable.

## Parameters and rendering

- WSL-1. The service shall render every WSL2 host file, Windows-side and Linux-side, from one parameter record that declares the schema `wsl-host-parameters@1`.
- WSL-2. The service shall carry no host name, user name, path, size or brand in its code; every particular shall come from the parameter record.
- WSL-3. When a parameter carries a comment, the service shall write that comment into the file it renders, so the evidence for a setting travels with the setting.
- WSL-4. The service shall cover `.wslconfig`, `/etc/wsl.conf`, sysctl files, block-queue limits, the agent cgroup ceilings, the orphan-relay reaper, Windows Defender exclusions, the pagefile and WSL disk compaction.

## Independence

- WSL-5. The service shall run on Node's built-in modules alone, so that it installs the host when MetroPlat, the package registry and the network are all unavailable.
- WSL-6. The service shall hold its Linux helper scripts as assets inside the service, not fetch them.

## Observation and repair

- WSL-7. When asked to plan, the service shall change nothing and report each file as current, drift or absent.
- WSL-8. When asked to plan on a live host, the service shall also compare the live kernel values (sysctl, block-queue attributes, kernel command line tokens) with the parameters and report each mismatch.
- WSL-9. When asked to apply, the service shall write only files that are not current, so a second apply writes nothing.
- WSL-10. When it replaces an existing Windows-side file, the service shall first keep the previous content beside it under a dated name.
- WSL-11. When files or managed live values drift, the service shall run each corresponding Linux reload hook once, and leave a converged host unchanged.
- WSL-12. When a boot-time write of a block-queue attribute is refused as busy, the service shall re-send a change event after boot so the limit holds on every disk.
- WSL-139. Boot shall not wait on host maintenance: the block-queue re-send shall not hold `multi-user.target`, and `/tmp` on the root disk shall age out in the background rather than be emptied inside `systemd-tmpfiles-setup`, which logind, lingering user managers and the SSH entry wait for.

- WSL-17. Apply shall reconcile managed live sysctl, block-queue and memory-budget values even when rendered files are current, using the existing owned hooks.
- WSL-18. Apply shall receive its result by observing the scoped files and live values again, exiting 0 for convergence and 2 for remaining drift.

## Boundaries

- WSL-13. The service shall not restart WSL, shut down the VM or execute Windows configuration actions. Its capacity command shall execute no Windows process.
- WSL-14. When a change needs a Windows action, the service shall print the one command the host's owner runs from Windows.
- WSL-15. If an apply needs root and the caller is not root, the service shall stop before writing and print the sudo command.

## Order

- WSL-16. The owner of the particular values shall be the operations section of the host, and the service shall remain generic engineering, in the order science, engineering, operations.
- WSL-19. When the record declares a system-managed pagefile, the service shall render a script that returns the pagefile to Windows' automatic management, because a host running a WSL VM beside desktop applications commits more than its physical memory (Bare Cedar Fog, 2026-10-14: 35–40 GB committed on 23.3 GB of RAM), and a host without a pagefile then fails allocations.
- WSL-20. When the record sets a page-cache ceiling on the headroom guard, the guard shall drop clean page cache whenever the cache exceeds the ceiling, at most once per its minimum interval. A busy VM never goes idle for WSL's `autoMemoryReclaim`, and its cache otherwise holds Windows memory. Bare Cedar Fog, 2026-10-14, under CI: 6.2 GiB of cache held the VM at 9.95 GB with Windows at 98% commit, and one drop returned 4.4 GB to Windows within 20 s.

## Memory that stays resident

Bare Cedar Fog, 2026-10-18 (operations record `observed-2026-10-18`): the agent cgroup sat at its 3 GiB `memory.high` with 2.05 GB of anonymous memory and its whole 256 MiB swap allowance used, so reclaim could take only file pages. Those were the agents' own executables (Claude Code's 268 MB binary, VS Code's `node`, the Copilot runtime) and the Codex app-server's SQLite pages: 12.4 GiB of refaults a minute at the cgroup's read cap, about 330 throttle events a second, and trivial commands stalled for minutes. The VM had 3.7 GB free. The kernel has no MGLRU, so nothing protects a working set that its budget cannot hold.

- WSL-21. When the record declares an in-memory compressed swap device, the service shall create it at boot at a priority above every disk swap, and count its pool limit in the memory budget. Idle anonymous memory then shrinks in RAM instead of evicting the executables beside it, and swap stops depending on the disk path through `hv_storvsc` that crashed the VM on 2026-10-05.
- WSL-22. When the record names reclaim cgroups for the headroom guard, the guard shall take page cache above its ceiling from those cgroups in order, through `memory.reclaim`, and drop clean cache VM-wide only if the cache is still above the ceiling. On 2026-10-18, 1.9 GB of the 2.3–2.9 GB of cache belonged to batch commands in a user slice, and a VM-wide drop evicts the interactive programs' hot pages with it.
- WSL-23. The agent-limits helper shall apply the swap I/O ceiling only to a disk-backed swap device.

## Receiving conditions

- WSL-24. The capacity command shall join the current WSL distribution and Linux destination devices to the VHDX and Windows backing volume the host record declares, reading them through the volume's drvfs mount (`volumeMount`). It shall not depend on WSL interop: Windows answers `statfs` and `stat` on a drvfs mount itself, and those answers are the volume's free space and the file's allocation. Leader, 2026-10-30, on admission refusing while interop was broken: "well that's a stupid design".
- WSL-25. The capacity command shall report real backing-volume available bytes, allocation units, VHDX metadata and the operations-owned reserve, growth and overhead estimates separately from guest filesystem capacity.
- WSL-26. Missing, ambiguous, changed, stale, timed-out or unreadable backing identity or capacity shall refuse without invoking any configuration, cleanup, trim, compaction or service operation.
- WSL-27. The existing live plan command shall report low or unknown physical backing capacity as drift when the host record declares it, preserving staged and undeclared legacy plans.
- WSL-28. The capacity command shall bound its observation by the existing local monotonic freshness budget and bind it to a fresh request challenge.
- WSL-43. The operations-owned backing-capacity policy shall declare its physical fabrication floor explicitly. A housekeeping threshold that selects earlier scratch expiry is a separate control and shall not implicitly become a fabrication floor. Admission retains an explicit absolute physical reserve as well as its proportional reserve.
- WSL-44. Physical admission shall retain the greater of that absolute floor and the declared physical-volume share, in addition to the operation's peaks and the existing growth and overhead allowances.

Leader correction, 2026-10-26: Bare Cedar Fog retains at least
100,000,000,000 physical bytes plus the declared simultaneous peaks, growth
and overhead. Lowering a reserve is not a repair for producer data churn.
Compaction is not authorized by low capacity. Disposable producer outputs
must have terminal owner disposition; retained caches require explicit bounds
and consumers. This supersedes the earlier 30 GB uptake allocation below.

The 2026-10-19 incident exhausted Windows C: while guest ext4 reported hundreds
of GiB available. Guest free space is virtual capacity, not permission to expand
its backing VHDX. A declared overhead allowance is an estimate, not an allocation
reservation or a mathematical bound on arbitrary writes. Existing Windows-side
maintenance remains a separately authorized owner action under WSL-14.

## Scoped offline maintenance

- WSL-45. A compaction carrier shall select exactly the existing record's registered distribution, VHDX and backing volume without enumerating alternative disks.
- WSL-29. A compaction carrier shall require the host owner's received maintenance admission referencing the affected original work and its checkpoints before any effect.
- WSL-30. The selected DiskPart or attach-based compaction adapter shall refuse unless its required Windows administrator/privilege and the distribution owner's registry-hive identity are independently established; a different adapter requires qualification against its own documented privilege contract.
- WSL-31. A DiskPart or attach-based compaction carrier shall require the selected disk already detached or read-only without stopping, starting or shutting down any distribution itself. The separately qualified native WSL adapter in WSL-59 owns termination and its exclusive selected-distribution lock within one awaited native operation.
- WSL-32. A compaction carrier shall revalidate the registered target, native file identity and backing volume immediately before its one scoped operation and after its outcome.
- WSL-33. A compaction carrier shall retain its original admission, exact invocation, bounded native outcome and before/after observations in Windows-owned custody outside the target VHDX.
- WSL-34. A compaction carrier shall use an explicitly admitted finite operation and evidence allocation without changing the fabrication reserve policy.
- WSL-35. A timed-out, interrupted or ambiguous maintenance outcome shall remain unknown until its original disk and native operation are reconciled.
- WSL-36. Reopening fabrication shall require a fresh ordinary owner-context capacity join and the original byte/inode and physical-backing admission.
- WSL-36a. Native maintenance and its conditional reentry caller shall receive the selected target through the same qualified registry/handle/volume/quota producer as the ordinary capacity entrance, with exact source, fresh challenge and bounded observation. The metadata child's lifetime shall remain separate from the directly awaited maintenance operation.
- WSL-36b. Native maintenance shall preserve the original record's positive absolute reserve, proportional reserve, growth and overhead. It shall not substitute a historical housekeeping threshold for those source-owned values or infer capacity admission from compaction success.
- WSL-37. Maintenance admission shall require durable boot and reentry holds for affected frozen or otherwise held work before the distribution can stop.

- WSL-38. The existing host record shall bind a user-unit quarantine to the actual owner, original work, an explicitly known capture mode and persistent user-manager condition. Omission retains strict frozen boot/invocation/process receiving; `stopped-no-resident` instead requires an actual loaded selected unit, exact command, absent main/control PID and jobs, terminal state and no live hierarchical cohort.
- WSL-39. Holding a quarantined unit shall preserve its resident process and freezer state and shall not stop, start, restart, thaw, mask, replay or rewrite its cursor.
- WSL-40. A quarantine shall remain authoritative across reboot, unit replacement and declaration omission; ordinary file reconciliation shall never clear its marker.
- WSL-41. Release shall require a source-owned digest of an independently received replacement Resource binding the original hold, unknown-effect reconciliation, exact installed product/controller and native terminal cohort.
- WSL-42. A partial hold or release shall preserve its original outcome and refuse automatic retry or restart until reconciled.

Apart from the storage reclamation of WSL-86 to WSL-90 below, these requirements
do not authorize compaction, elevation, a shutdown, a new principal, a scheduler
or an automatic cleanup hook. The existing all-distro rendering does not meet
them and is not an admitted incident response.

1. `plan` against the host's record exits 0 on a converged host and 2 on drift, naming the files.
2. `apply` run twice writes nothing the second time.
3. Removing MetroPlat from the host changes neither result.
4. The live checks of WSL-8 pass on every disk after a fresh WSL boot, without a manual command.
5. With a declared compressed swap device, `plan` reports it active at its priority after a fresh WSL boot, and `/proc/swaps` lists it above the disk swap.

## Rejected maintenance carriers

- WSL-46. Until the scoped native carrier is independently received, the existing Windows compaction renderer shall emit an effect-free refusal rather than the rejected all-distro script, for every record that does not declare a sparse backing disk under WSL-87.
- WSL-47. Quarantine records and release outcomes shall be filed under an explicitly bound existing owning services section's data/state/wsl-user-unit-quarantine-state, without a home-directory fallback.
- WSL-48. A changed quarantine location shall preserve any original installed condition and marker until its independently received migration has loaded the replacement condition without an admission gap.

- WSL-49. Native capacity children shall launch from the already validated distribution root rather than inherit an arbitrary caller working directory.

## Durable record-owned timer components

- WSL-50. The service shall render explicitly declared managed timer components from the existing host parameter record using the same builtin-only host reconciliation entrance.
- WSL-51. A selected managed-timer plan or apply shall leave all unrelated Linux, Windows, maintenance and quarantine files and hooks untouched.
- WSL-52. Each declared timer shall run its selected command as its declared unprivileged owner, retaining the declared canonical section working directory, actual home and explicit owned temporary/cache locations.
- WSL-53. Apply shall receive the selected timer's installed files, persistent enablement, effective command and active next trigger before reporting convergence.
- WSL-54. A declared timer shall recover through the existing system boot target without a transient user-manager registration or a manual command.
- WSL-55. Handover from an explicitly declared same-purpose user timer shall stop only that timer, drain and receive its existing service to terminal, and preserve its data and outcomes before enabling the system timer.
- WSL-56. Handover shall retain a partial or uncertain native outcome without starting a competing actuator or replaying an application job.
- WSL-57. Installation shall refuse malformed, redirected, secret-bearing or changed source/owner bindings before host configuration effects.
- WSL-58. A second converged component apply shall write no files and execute no lifecycle commands.

## Received native WSL maintenance adapter

- WSL-59. The service shall preserve the previously independently received Microsoft WSL 3.0.3 native `--manage <declared-distribution> --compact` adapter as a separately selected, source-only renderer. Its provider owns selected-distribution termination, offline trim and the exclusive Compacting lock. It shall never substitute a shutdown/list sequence, another disk, a generic compactor, cleanup or elevation.
- WSL-60. Rendering shall require the original host record's exact backing target and a digest-bound maintenance admission naming current holder authority, affected original work/checkpoints, durable boot/reentry holds and independent source/caller receiving. Resource references shall identify existing owner records, not approval booleans manufactured by the renderer. Rendering or matching a digest shall not attest that authority or quiescence was received.
- WSL-61. The Windows parent shall verify its actual user SID, the qualified installed executable/service version and hashes, exact registered target, native file identity, backing volume and all admitted Resource digests before dispatch. It shall refuse an expired admission, changed target, redirected path or pre-existing request custody.
- WSL-62. Before termination, the Windows parent shall exclusively create and flush private request custody outside the VHDX containing the admission, exact selected invocation and started intent. It shall flush the native PID immediately after dispatch, and retain the terminal or unknown outcome in that same custody before any guest reentry. Interrupted started custody shall block replay of that request.
- WSL-63. The parent shall directly await the one original native process, drain bounded stdout/stderr concurrently and retain its actual terminal code. Deadline or evidence exhaustion shall preserve uncertainty and prohibit retry, alternate tools, kill and guest bootstrap. A deadline is not permission to abandon or report success for a still-running child.
- WSL-64. A terminal success shall not restart the guest, release a hold or reopen fabrication. The original custodian must receive the Windows outcome and admit reentry separately; fresh ordinary owner-context capacity must satisfy at least 100,000,000,000 bytes, the proportional reserve, declared concurrent peak, growth and overhead before fabrication. The historical 2026-10-21 result reclaimed only 627,916,800 physical bytes; apparent VHD slack is not a recovery guarantee.
- WSL-65. The original bounded read-only backing-capacity producer shall distinguish the selected VHD's logical length from its actual Windows file allocation, through the drvfs file status (`st_size` and `st_blocks`) and its device and inode identity. Missing or invalid allocation observations shall remain unknown, never fall back to logical length as physical allocation. The ordinary host plan shall display both values; neither their difference nor guest free space shall authorize compaction, discard, cleanup or fabrication.

## Separately admitted mounted-root discard

- WSL-66. A separately selected mounted-discard operation shall receive the exact current registered distribution/root/backing-volume join through the original capacity producer before dispatch. It shall select only the current writable ext4 root and the received util-linux 2.39.3 single-mount FITRIM provider; it shall not select all filesystems, fstab entries, a block device, dry run, quiet-unsupported, another tool or an automatic timer.
- WSL-67. Dispatch shall require an explicit record declaration and fresh digest-bound original authority, checkpoint and independent receiving Resources, plus the actual root owner's CAP_SYS_ADMIN. The checkpoint must receive concurrent original actors and I/O impact; a matching digest shall not manufacture authority, terminal custody or quiescence. The service shall never elevate itself or stop/restart actors.
- WSL-68. Before the one effect, the original owner shall durably and exclusively claim the declared request in private canonical section data, retaining exact parameters, admission, resource bytes, native mount/boot identity, provider digest and dispatch intent. Existing custody, including an interrupted intent, shall refuse replay and new-request bypass until its original receiver reconciles it. No age, process disappearance or caller boolean shall clear custody.
- WSL-69. The same native process shall be awaited to terminal without kill, fallback or retry, with a finite declared deadline and bounded concurrently drained evidence. Deadline/output exhaustion or missing durable PID/outcome shall remain unreceived even if the process later exits zero. A selected-mount successful FITRIM byte count shall be reported separately from physical bytes reclaimed and shall never reopen fabrication; fresh ordinary capacity under WSL-64 is still required.
- WSL-70. An explicitly declared read-only legacy-quarantine receiver shall bind the exact retained original owner, marker bytes and guard bytes to the actual user manager's loaded negative condition. It shall neither create legacy custody nor use it as an implicit fallback for canonical quarantine. Missing, changed, redirected or unloaded custody shall refuse. Receiving an existing persistent boot hold shall not claim a current resident, settle an old effect, migrate or release custody, or stop/start/thaw any unit.

## Finite Windows maintenance file carrier

- WSL-71. Native maintenance preparation shall be a separate, non-disruptive owner operation. It may create only the declared private Windows custody directory beneath an existing non-redirected parent, and one immutable request-specific caller directory containing the exact renderer output and three digest-bound original Resources. Existing private custody may be received without changing its ACL; foreign, redirected, writable-by-unreceived-principal or occupied request custody shall refuse. Preparation shall never launch maintenance, manufacture an admission, weaken a hold or change the host record.
- WSL-72. A separately invoked launch shall require a fresh original maintenance admission and independently received exact private parent-file bytes. It shall use the same Windows user and a retained PowerShell `-File` parent through ShellExecute without inherited WSL pipes. An exclusive durable launch claim shall precede dispatch; its actual Windows parent PID shall be retained. Missing or interrupted acknowledgement shall require original reconciliation, never a new launch or request bypass. This is one addressed maintenance caller, not a scheduler or a new principal.
- WSL-73. A prior claim shall remain held unless its complete original packet, intent, native PID, streams and terminal outcome prove matching request/admission/target identity and successful bounded native completion. `terminal-confirmed` alone, a failed/nonzero/late/overflow outcome, missing PID, changed identity or malformed evidence shall not admit a later request. No new reconciliation boolean or caller-controlled bypass shall clear custody.
- WSL-74. The original owner shall read the modern Windows outcome from explicit bounded private files before any guest start. Receiving shall correlate exact original parameters/admission, Resource bytes, intent, native PID, selected path/volume/file identity, actual zero exit and elapsed deadline, and both stream lengths/errors/overflow. Missing, ambiguous, mismatched or failed custody shall refuse result transfer and reentry; the historical writer's incompatible schema shall not be silently accepted.
- WSL-75. Result transfer shall require a distinct fresh digest-bound original reentry admission naming the successfully received Windows outcome, exact one-distribution/user/Node/owner-receiver invocation and current authority, checkpoint and independent receiving Resources. The Windows caller shall revalidate/lock the original outcome and reentry Resources before the one bounded stdin transfer. The guest receiver shall validate the same modern evidence and exclusively flush it in declared owner data. It shall never rerun compaction, release holds, assume capacity or promise unmanaged desktop-chat resumption. Other-work readiness and refreshed affected-work checkpoints remain actual original-holder obligations, not facts inferred by the carrier.
- WSL-76. Modern outcome receiving shall bind the complete original packet declaration, backing declaration and admission to the exact parameter/admission text. The guest receiver entry shall use only Node builtins until it has verified the exact closed original receiver source/assets, including its imported implementation, against the admitted per-file digests. Changed imported code with an unchanged entry file shall refuse before importing that code or writing guest data.
- WSL-77. An explicitly selected conditional continuation shall require semantically validated original authority, final affected-work/checkpoint/hold receiving and independent algorithm/caller receiving before offline maintenance. It shall bind one request, exact target, Windows holder, user/Node/closed receiver and bounded overall authority expiration. Opaque hash-matched bytes shall not authorize generation. Other-work readiness must refer to an actual addressed human answer; the caller shall never infer it.
- WSL-78. A surviving same-user Windows original file caller may exercise that separately received conditional authority only after awaiting the same native parent and positively receiving its complete modern successful outcome. It shall durably retain the factual algorithmic receiving, three derived role Resources and a distinct fresh at-most-ten-minute reentry admission before the existing one-transfer actuator. Derived records shall distinguish prior human/checkpoint/independent receiving from actual current native observations, preserve unknowns and never extend original authority expiration.
- WSL-79. Conditional and manual paths shall share original exclusive launch and transfer custody. Missing, failed, late, overflowing, changed, expired or ambiguous evidence and interrupted/occupied derived custody shall remain held without maintenance/transfer retry, request bypass, hold release, capacity reopening or unmanaged-chat restart. The actual rendered Windows continuation file shall be manifest-bound; source/template qualification shall refer to stable source bytes rather than a self-referential rendered-script digest.
- WSL-80. Custody hierarchy observation/preparation shall be a separate original-owner data operation requiring no maintenance admission. It shall receive one independently addressed existing Windows parent, native directory identity, actual holder SID, actual owner and effective writable principals/ACL, then exclusively journal before creating at most eight declared private hierarchy components. Only the holder, SYSTEM and Administrators already trusted by original private custody may own/write that ancestor; every new private directory shall remain owned by the holder. It shall not redirect, overwrite or change existing ACLs, invent an effect admission, or lose partial preparation custody. Completed preparation may be re-received without writes; unknown/interrupted preparation remains held.


## Explicit completion of retained legacy quarantine

- WSL-81. The existing quarantine-release operation may select exactly one retained legacy subject only through linux.quarantineReleaseSubject=legacy. It shall independently receive the exact declared legacy marker and loaded guard before the unchanged replacement-resource checks; omitted, unknown or simultaneous canonical subjects shall refuse. It shall not migrate or duplicate the hold.
- WSL-82. Release shall receive the registered host artifact through the selected immutable CDE profileArtifact codec and source-bound exact Guix supplier, rather than infer the artifact from a shared registry package.json. Original unknown-effect receiving, source identity, native command, cohort-terminal and recovery-hold predicates remain mandatory.
- WSL-83. Release shall durably retain its original-subject outcome in canonical owner data/state, then remove only the selected marker and fsync its actual parent; guard bytes and every other custody path remain unchanged.

- WSL-84. Capacity observation shall derive the actual volume GUID and allocation unit from the registered VHD's same native open handle, then address that exact Windows storage object directly. Its healthy state, free capacity and drive-letter association, and the original caller's quota shall remain independently observed. The bounded path shall avoid Storage-module path discovery. Request challenges, monotonic freshness, all identity checks, the ten-second maximum probe timeout and admission reserves remain unchanged.

- WSL-85. Online capacity shall retain native handle identity and attributes and the independent named-path identity recheck while allowing ordinary content writes and logical growth during the bounded observation. Volatile write time or length shall not become an implicit idle-distro requirement. Allocation shall remain the actual native sample, never a logical or guest-space estimate; no admission discount or reservation follows from it. Offline maintenance and quarantine authority remain separate and unchanged.

## Storage evidence, producer containment and separately admitted reclamation

Current Leader requirement, 2026-10-27: stop the producers exhausting Windows
physical storage; preserve at least 100,000,000,000 physical bytes plus declared
peaks/growth/overhead. No compaction or lowered reserve is authorized as this
incident response. The earlier 2026-10-25 statement that bringing the system down
to compact twice a day is unacceptable remains the motivation, not a maintenance
grant. Historical Windows VHD allocation and ext4-used figures are different
measurements; their difference is not measured recoverable Windows capacity.

- WSL-86. An explicitly declared `linux.trimTimer` shall retain its record-owned rendering and observed native scheduling/result; the service shall not infer physical recovery from its presence, success or discarded-range count.
- WSL-87. A declared sparse-conversion carrier shall preserve exact registered target verification and its existing separately admitted owner/checkpoint/stop/reentry protocol; rendering or sparse drift shall grant no execution or interruption authority.
- WSL-89. The host plan shall report Windows native VHD allocation and guest filesystem used bytes as separate measurements, label their difference only as diagnostic accounting against the declared tolerance, and grant it zero physical capacity credit.
- WSL-90. The host plan shall distinguish a declared trim timer's native state/result from actually measured Windows available bytes; nonsparse state, a scheduled timer or successful trim shall not prove recovery or authorize reclamation.
- WSL-110. The sparse renderer shall reject `compactWhenBelowFloor=true` and contain no native compaction operation; separately admitted explicit native-compaction capabilities remain distinct and unlaunched.
- WSL-111. Low capacity, sparse drift or maintenance-file drift shall not cause the ordinary plan/apply report to issue an executable sparse-maintenance or compaction command without the separate original owner admission.
- WSL-112. The service shall identify capacity as a snapshot rather than an allocation reservation or universal writer fence; actual producer execution admission and terminal resource disposition must be received at their original effect owners.
- WSL-113. A stopped capture shall bind the actual boot and loaded selected `ExecStart` to the record; not-found units, unknown modes, queued or control work, restart-pending/active states and populated cohorts shall refuse before writes. It shall record observed historical unit invocation separately from `resident:null`, never invent a process identity.
- WSL-114. The original marker-first hold shall re-receive stopped/no-resident state before and after manager reload and after the exact negative condition is loaded. Race, reload or partial-write uncertainty shall retain original custody without a successful held result; no stop/start/thaw shall obtain missing evidence.
- WSL-115. Reading and release shall receive the marker's capture-mode discriminator and exact unresolved effect dependencies; absent discriminators retain the original frozen format and never relax it. A canonical stopped hold shall not reuse or recreate an absent legacy home marker.
- WSL-116. Stopped-mode release shall retain every original replacement/profile/source/native-command and unknown-effect receiving predicate, bind the exact original capture and dependency list in the independent replacement Resource, and receive each dependency through a canonical private source-owned terminal-receiving Resource bound by path and digest. A copied boolean, KILL, missing workroot/lease, unchanged profile or observed free space shall not reconcile the old promotion.
- WSL-117. The 2026-10-27 selector hold shall retain the unknown promotion invocation `855f436da72a44a8831f856a7d8a5d0c`, host commit `5e878170577f3960270ae246586a9337788983c3` and original unit as an exact terminal-receiving dependency. Omission, changed subject, missing independent receiver or unresolved effects shall preserve the hold.


### Rejected historical rule, not an operative requirement

The earlier storage rule reused identifier WSL-88, already used below for the
memory-budget rule. Retain it here solely as rejected history; current WSL-88
continues to identify the memory requirement. No consumer may select this text
as current maintenance authority:

> WSL-88. That script shall also compact once, through one directly awaited native `--manage <declared-distribution> --compact`, only when the backing volume's available bytes are below the record's physical floor (the greater of `minFreeBytes` and `minFreePercent` of the volume), and shall do nothing and leave WSL running when the VHDX is already sparse and the volume is above its floor.

That automatic below-floor compaction rule is rejected by the current explicit
Leader instruction. It is not an alternate path around WSL-110/111.

### Live service working-set receiving

2026-10-24 service-manager receiving: budget the measured anonymous working set. The native WSL plan observed user.slice at 3,737,382,912 bytes with 3,580,792,832 anonymous bytes against a 3,670,016,000-byte high, 94.93% full memory pressure over 60 seconds, 3,629,788 KiB VM memory available, and no OOM kill; even systemd user property reads timed out. Keep agents above their former 3 GiB failure floor: move exactly 596 MiB of their 4 GiB share to services (agents 3500M, user.slice 4G). The observed agent anonymous set was 2,118,643,712 bytes with 1,156,399,104 file bytes; the new share retains that anonymous set and about 1 GiB of file cache. Preserve Guix 1536M (its documented 1G regression), agent/service hard ceilings, zram 1G, and kernel headroom 2G. High-water sums remain 12,204 MiB within the 12,288 MiB VM. Apply and receive through the existing WSL host service; this is neither new runtime machinery nor Windows/offline maintenance.

### Bounded issuer factory receiving

2026-10-24 bounded issuer factory receiving: the measured 633 KB/107-file native closure stalled before inference while the factory used about 61 MiB RSS. Fixed-counter USE showed about 3.8 GiB VM memory available, user.slice near its soft threshold, and Guix about 261 MB current with negligible anonymous memory. A bounded trial moves 128 MiB of soft share from Guix to user services: user 4224M, Guix 1408M. Preserve agents 3500M, all hard ceilings, zram 1G and kernel headroom 2G; the total remains 12204 MiB of 12288 MiB. Guix remains above its documented 1.2 GiB request. Native Linux apply converged. Later exact-job receiving located the immediate stall in the nested agent-work.slice, where an unnecessary additional parent wrapper had placed this admitted small Codex command; it did not establish parent-budget recovery. Reconcile the already-declared shared containment projection through codex-home apply --scope=harness and use the actual controller admission without adding parent containment. Native isolated assay limits remain unchanged. The trial is not useful-operation receiving and does not authorize successive blind increases, process kills, cache drops or Windows/offline maintenance.

- WSL-88. A `memoryBudget.units` entry with `scope: "user"` and `user` shall be bounded by a drop-in under `/etc/systemd/user/<unit>.d/` and applied by a reload of that login's user manager, never a restart of the unit. An entry with `within` names a group of the budget it lives inside: it shall fit that group's high and max and shall not add to the sum of shares. A service's `oomPolicy` shall be written so a process killed at MemoryMax does not stop the unit. Reason: an unbounded service inside a budgeted slice (Bare Cedar Fog 2026-10-25, bare-cedar-fog-sshd.service, every Claude CLI, peak 4 GB, 692 s full memory stall) is throttled as the slice, taking its neighbours with it.


## Explicit retirement of a record-owned Work timer

Leader forbids clock-based substitutes for native MAPE-K monitors. The original
engineering-delivery endeavor and Group campaign #390 require github-reconcile
retirement to survive host reconciliation, not merely a manual stop.

- WSL-95. A role moved from `linux.managedTimers` to `linux.retiredManagedTimers`
  shall render no timer/service files and shall never be enabled by reconciliation.
  An older producer that knows only the active list shall also select no activation.
- WSL-96. Before retirement effects, receive the exact installed system service,
  timer fragments, effective owner, working directory and command, and declared
  transient user predecessor. Reject ambiguous or changed roles before effects.
- WSL-97. Retire only the selected timer's persistent enablement and future wakes.
  Preserve service execution, failures, declarations, queues, journals and receipts.
  A running service remains explicitly unreceived; do not kill it, poll its state,
  reset its failure or replay a job to complete retirement.
- WSL-98. Receive persistent disabled/masked status, no next trigger and quiescence
  of the original service and transient predecessor before reporting convergence.
  A second converged apply performs zero writes and lifecycle commands.
- WSL-99. Active and retired declarations share the original eight-role bound and
  unique unit names; malformed lifecycle lists, missing reasons and conflicts fail
  before effects. All unrelated host configuration remains untouched.

## Canonical local origins and private mesh ingress

Leader demand, 2026-10-26: the existing Bare Cedar Fog origin must be private
to Tailnet machines and resolve locally from Windows and WSL without Internet.
Original Work: ni:///sha-256;ojhpdlpE4rnbo4M0EpPYHkymkZXHGFqLaAtZcn22bvs.
The source-owned behavioral specification is local-canonical-origin.md.
The independently reviewed network scope preserves current authentication;
passkeys and offline initial human enrollment are separately owned work.

- WSL-100. A scoped local-origin operation shall derive its host particulars
  from the original host parameter record, without requiring MetroPlat.
- WSL-101. The Linux operation shall preserve unrelated hosts entries while
  owning one explicit canonical-host loopback block and disabling WSL's hosts
  generation through the record's existing wsl.conf renderer.
- WSL-102. The selected TLS endpoint shall bind only loopback and delegate TLS,
  DNS-01 and reverse proxying to the digest-pinned Caddy provider.
- WSL-103. Before Linux effects, the operation shall receive the selected binary
  digest, Cloudflare DNS module, private single-credential environment and valid
  Caddy configuration, refusing unsafe paths and competing hostname mappings.
- WSL-104. The system service shall run under the declared unprivileged owner
  with only network-port binding capability and private writable certificate state.
- WSL-105. Windows apply shall require an Administrator token before changing
  its owned hosts block or the selected Tailscale TCP forward.
- WSL-106. Windows apply shall preserve UTF-8 BOM and newline convention,
  unrelated hosts/Serve entries and original backups, refusing selected-port
  conflict, changed inputs and Funnel exposure before dependent effects.
- WSL-107. Converged local-origin apply shall perform no configuration writes or
  service lifecycle commands; read-only plan shall perform no effects.
- WSL-108. Local-origin reconciliation shall not restart WSL, change NAT mode,
  act on disks, grant application authority or reopen public ingress.
- WSL-109. Installed receiving shall distinguish local trusted HTTPS, real
  Tailnet-peer receiving, old-public-route refusal and disconnected operation.

- WSL-118. Native target receipts shall preserve the already observed VHD logical length, allocated bytes, allocation API source, attributes and sparse/compressed flags, together with the producer observation time, request identity and observer source identity. Allocation is a changing sample, not immutable file identity or capacity credit. Historical receipts missing these fields remain incomplete and shall not be reconstructed or used to attribute physical growth.

- WSL-113. The original quarantine owner shall support an optional nonempty bounded `linux.userUnitQuarantines` collection (at most 32 entries) additively with the original single `linux.userUnitQuarantine`. It shall validate all declarations and reject duplicate ids, units, derived markers or guards before effects. Default observation shall receive every entry; mutations over multiple declarations require an exact nonempty `--quarantine-id` (library third argument). Missing, empty or unknown selectors shall not select a first entry.
- WSL-114. An explicitly declared `releasePolicy: "hold-only"` shall establish a preventive persistent hold with either a received `stopped-no-resident` or `frozen-resident` capture, with absent or empty effect dependencies. It shall not invent a CDE promotion effect or replacement product. Its marker shall bind the explicit policy and release shall always refuse before any release write, marker deletion or native mutation. Omitting or changing the declaration cannot release or reinterpret custody.
- WSL-115. Original frozen and CDE-stopped declarations retain their default CDE release policy, marker encoding, exact dependency receiving and native release checks. Original legacy marker and guard paths/bytes remain unchanged and independently observable alongside the collection. Ordinary apply never clears any hold.
- WSL-116. Preventive receiving shall retain original stopped-native checks (loaded unit, owner, boot, exact ExecStart, zero main/control PID, no job, terminal state, empty cohort), private marker-first custody and actual loaded negative condition. PID, job, command, invocation or terminal-state changes across custody/reload/loaded-condition receiving shall refuse success and retain partial custody.
- WSL-117. This preventive policy supports unsafe automatic writers whose original installers can re-enable a disabled unit: a disabled unit alone does not enforce the Windows physical backing reserve. The canonical host record shall declare such a hold through this owner alongside retained controller custody; tests shall use only an explicit own harmless runtime unit and receive its terminal cleanup. No stop, start, thaw, withdrawal, release authority or storage-recovery claim is added to production hold operations.

- WSL-119. Preventive frozen capture shall preserve the exact native resident and its frozen cohort without stopping, killing, thawing or claiming terminal job effects. Its explicit policy field shall bind custody without adding fields to default frozen CDE markers. A frozen preventive plan and the final loaded-condition receiving shall recheck the exact frozen invocation, so thaw, PID, job or birth-identity drift cannot appear received. Existing runner cgroups may be conservatively frozen while their original owner reconciles registrations and installs native Windows physical admission; no runner may be thawed on this hold receipt alone.

- WSL-120. Ordinary read-only host plan shall print a compact current row for each positively received quarantine check while retaining existing failed/unknown checks and exit status, so configured persistent holds are visible at the established health entry without a second native probe or any new effect.


## Retained CI runner preventive controls


- WSL-122. Reentering the same original partial hold may complete an absent exact guard or reload an exact guard not yet loaded, only while the private marker remains byte-identical, the original capture is still the same paused native invocation, and original owner paths remain safe. A complete already-loaded hold remains idempotent without reload. Unknown native observations, changed marker/capture, unsafe paths and competing guard bytes shall refuse and retain custody. Completion shall never rewrite the marker, repair permissions, stop/start/thaw/release the unit or relax existing release predicates.

- WSL-123. A separately selected quarantine owner-path preparation operation may remove only group-write from the exact two derived `.config` and `.config/systemd` directories with received0775 prestates, producing0755. The original canonical record shall bind an exact preparation product with selected-quarantine projection, original marker identity, native owner/directory identities and source hashes; the current complete canonical digest is checked separately at invocation. Default hold/apply shall never call it. Authority requires default native receiving of the same original paused invocation; injected observations and serialized approval flags cannot issue it. Both no-follow descriptor prestates must be received before either chmod; original content, owner, ACL and other mode bits remain unchanged. The original operation shall retain durable per-step custody, refuse uncertain unreceipted modes or drift, and make no release, thaw, guard-loaded or storage-capacity claim.

The two committed preparation input slots are read-only content-bound records: receive only canonical section record paths through no-follow final descriptors, actual regular/private native owner identity and exact expected digest, with descriptor/path identity rechecked around the operation. A group-writable read ancestor alone shall not become a request to chmod that ancestor. The64KiB record allocation is checked from fstat before reading. This read contract adds no waiver to marker, journal, guard or permission-target write safety and cannot issue native pause authority.

- WSL-124. A separately declared read-only storage-providers plan shall report exact selected native WSL swap file identity/allocation, Windows PageFileUsage and target-volume shadow-storage observations or explicit provider errors. The qualified WSL3.0.3 default joins native known-folder LocalAppData/temp, native live VM ID and swap.vhdx; an explicitly configured absolute swapFile shall use only the original pinned native suffix rule (append .vhdx when its extension differs), without alternate paths or discovery. Receive native version and configuration, bind the native VM identity to the point and recheck that VM identity after receiving. Missing/unsupported/raced data stays unknown. Ordinary host health shall expose these observations without adding calls to the mandatory capacity/admission producer. No provider sums, recovery credit, historical writer attribution, generic filesystem search, state change or repair authority is granted. Unchanged Ubuntu VHD allocation does not exclude guest-induced shadow copy-on-write; absent Docker registration targets do not prove absence of Docker data disks.

## Truthful physical capacity command boundary

Leader correction, 2026-10-27: guest Linux free-space reports must not be
presented as Windows-backed disk availability. Produce less data through
source reuse and completed publication, rather than pruning useful work.

- WSL-125. A declared capacity-command component shall refuse the ordinary
  guest df entrance and filesystem-capacity stat modes with nonzero status,
  no free-space stdout and the original native physical-capacity command.
  Ordinary file stat operations shall preserve the package implementation.
- WSL-126. Command installation shall receive original package ownership,
  binary digest, root-owned paths and the exact local dpkg diversion; it shall
  preserve the original binary without copying its contents, reject competing
  diversions and replacements, and converge without writes on reentry.
- WSL-127. Explicit guest diagnostics shall retain guest bytes and inodes as
  separate dimensions, never physical growth permission. Existing producer
  guest-fit checks require that explicit diagnostic and the original Windows
  backing admission. No synthetic df/statfs output, syscall interception,
  extra quota, pruning timer, compaction or capacity credit is introduced.

- WSL-128. An explicit original-owner orphan-swap request may retire only its exact declared prior-VM swap objects under native LocalAppData/temp/<VM GUID>/swap.vhdx, qualified against Microsoft WSL3.0.3 ephemeral swap creation/terminal cleanup. Before any disposition receive the actual administrator/same SID/machine, fresh original HCS JSON with the approved current WSL VM positively Running and all target VMs absent, live swap negative sharing control, all selected exclusive read/delete no-follow handles, exact native identities/allocation/header/owner and identity/security-bound unredirected parents. Recheck the current and target VM identities around the operation. Unknown/changed inputs refuse without deleting; observed DiskImage Attached=false is never authority. Keep per-file durable native outcomes and independently observed physical before/after capacity; no sweep, age predicate, service/controller action, compaction or reserve change is granted.
- WSL-129. The existing wslConfig declaration may select an explicit stable swapFile through the original WSL producer to avoid new per-VM forgotten swap files after interruption. Preserve the memory and swap size/capability; write no swap content and force no restart/shutdown. Distinguish desired configuration from the still-running VM's received swap path until a natural VM start receives the new setting.

The explicit WSL-128 retirement receives each selected GUID parent through a no-follow directory handle which denies delete/rename while permitting unrelated reads/writes. Its exact native identity and owner+DACL digest are declaration-bound. Existing sandbox/capability ACLs remain intact; private Temp ancestry is not assumed. Entry refusals receive actual SID, administrator state, stage and original exception in a private CreateNew journal before native target access when the original owner/profile is received. Identity/output creation refusals return the same error on the process channel without claiming a journal or any administrator state.

## WSL-130: Stable native swap lifecycle without capability reduction

After explicit historical orphan retirement, the original Windows configuration may declare one stable per-user swapFile for future natural VM starts. Memory and swap sizing remain unchanged; this operation neither restarts WSL nor attaches/resizes a live disk. The pinned WSL3.0.3 native producer reuses an existing explicit swap file after interrupted cleanup instead of allocating another per-VM path. A declared read-only swapFileTransition binds the still-running VM and its received original default swap identity: health must report that live object while configuration awaits a new VM, then receive the configured object after the native VM ID changes. Configuration/identity mismatch stays unknown; no capacity credit, timer or pruning follows.

## WSL-131: Explicit retirement of obsolete user units and their qualified artifacts

The original host record may declare terminal user-unit retirements with exact original native owner, fragment paths/bytes/identities and individually qualified artifact files/directories. Receive actual user-manager units, command bindings, disabled/static future activation, no active job/PID and empty native cohorts before unlinking any file. Changed owner/hash/identity, redirected paths or active/unknown native state refuse. Remove only declared files and atomically empty declared artifact directories; preserve all unexpected content. Only the original user-manager daemon-reload is permitted. Reentry receives native not-found and exact path absence, including reload-only recovery after interrupted file retirement. Do not execute the retired program, enable a replacement, add a scheduler, prune by age, collect stores or touch application state. Staging produces no native lifecycle/admission authority.


## Read-only local-origin offline qualification

- WSL-132. The original service shall preserve a repeatable explicitly invoked local-origin qualifier. A transient SYSTEM-manager client shall deny all IP egress except localhost, positively receive a denied external HTTPS control, trusted canonical HTTPS page and health, and the actual served import map plus static/literal ESM graph. Each request shall resolve the canonical host to loopback with normal certificate verification and refuse redirects or cross-origin graph edges. Bodies remain only in process memory; output contains compact counts/digests and explicit unexecuted/dynamic limitations, never application bodies. No authenticated browser, whole-host outage, login enrollment or storage/capacity claim follows.
- WSL-133. The qualifier shall create no persistent configuration, Data/download/cache tree or GC root, change no host network policy, and restart no application. Its uniquely named transient unit shall be awaited and collected; receive native unit absence after terminal PASS/FAIL, preserve an explicit unknown unit identity otherwise, and never report success from an unenforced filter. Source tests shall cover import-map URL/scoped/prefix/null semantics and actual parser/transport failures without mirroring a fake green receipt.


## Canonical owner paths for separately admitted maintenance reentry

- WSL-134. When an owner layout changes, the original host record shall rebind native-compaction reentry.sectionRoot and outputDirectory to the current canonical owner, preserving the exact output suffix, receiver and closure pins, owner identities, maintenance declarations and physical reserve. This is a configuration-only correction: observing or reconciling it shall not create output custody, execute a receiver, admit maintenance, compact storage, restart WSL or reinterpret historical admissions and quarantine labels. An absent preexisting receiver remains explicitly unreceived until its original preparation and authority are separately received.

## Declared Docker backing allocation observations

- WSL-135. The original storage-provider observer may receive an explicit finite selection of Docker artifact names, absolute Windows paths and native volume IDs from its machine record. Select those paths from actual Docker configuration/registration and supported owner documentation before operating record adoption. Reuse the original no-follow native file-allocation receiver; report fresh file identities, logical and allocated bytes for each selection. Refuse missing observations, redirected files, changed volumes and duplicate native identities. An undeclared, missing or inaccessible selection remains unknown, never a fabricated zero. These selected artifacts do not assert a complete Docker inventory, engine usage, disposal eligibility, source custody, storage admission or physical recovery. No Docker startup, stop, pruning, deletion, configuration change, new schedule or recursive filesystem scan follows.

## Explicit retirement of superseded derived Code caches

- WSL-136. The original service may prepare an explicitly selected observe/retire request for the four vendor-signed executables of a superseded Codex plugin app-server cache. Receive its original installed maker's source identity, regeneration from the retained local provider, current managed runtime and configuration/registration bindings before selecting this operation. The machine record names exact native file/parent identities, content and security descriptor hashes, allocation, single-link names and ordinary streams. The operation preserves the profile, authored Code, source, state, credentials, threads, current provider, offline capability and rollback bindings; it is not profile pruning or a cache-age policy.
- WSL-137. Reuse the original qualified Windows no-follow handle identity/security/disposition primitive. Hold the received parent against rename and all selected files with exclusive read/delete handles before the first disposition. Compare held content, complete streams, native identities, owner/DACL, allocation and named paths; recheck original maker/provider/configuration/registrations immediately before marking. Native sharing/unknown state refuses rather than assuming inaccessible process images are quiet. Receive each mark and terminal native absence, preserve partial/pending custody, support exact reentry, and obtain both native volume-free and caller-available counters. A pending mark or target-byte sum is never physical recovery or admission credit. No VM/process stop, update disablement, useful-data deletion, compaction, scheduler or reserve reduction follows.


## Exact redundant WinINet installer cache entry

- WSL-138. An explicit original-owner operation may release one declared WinINet download-cache entry only through DeleteUrlCacheEntry, after receiving its exact native file/parent identity, content, security, single-link/default-stream metadata and complete native cache-key match. Preserve an independently held byte-identical pending installer and its unchanged owner update-state declaration. Keep the cache read handle open denying writes while permitting the native cache owner to delete; never directly unlink its file. Receive native pending state and terminal absence separately, with both Windows free counters and honest partial/reentry outcomes. No cache sweep, update execution/disablement, configuration rewrite, arbitrary age criterion or reserve change follows.

## Explicit completion of an original unit quarantine

The owner shall provide `quarantine-complete` for an exact declared existing quarantine. It shall receive the captured invocation and its loaded owner controls, record retirement intent durably, kill the still-frozen captured cohort without thawing it, stop the unit, and receive zero resident/control PIDs, no queued job and a terminal hierarchical cohort before clearing that quarantine's marker and guard. It shall leave the unit stopped and never install, enable or start a replacement. Independent controller pending/start guards remain untouched. Completion shall retain its original marker bytes and terminal observations, permit observed terminal reentry after an interruption without repeating a kill, and report that stopping a process does not reconcile external effects. Ordinary plan/apply and the old release operation shall not implicitly complete a quarantine.

Completion installs an owned temporary service drop-in with Restart=no and an appended ExecCondition=/usr/bin/false. It receives both loaded properties before retiring or thawing an empty cohort. This also fences a restart queued before the repair; the original ExecStart and other owners' condition commands are unchanged. The native deadline bounds waiting for a guarded queued attempt to become terminal. The operation removes its temporary drop-in only after receiving terminal PIDs, jobs and cohort, then verifies all of its controls are gone. Reentry never repeats KILL on an empty captured cohort.
