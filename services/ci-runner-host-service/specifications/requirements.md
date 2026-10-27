# CI runner host service: requirements

Leader statements taken as theory (2026-10-14):

- "We need CI on the laptop for now, but we should make it more durable software, like 'install this on your linux box to be a CI endpoint for the <insert parameters for Group or whatever>'."
- "lol at _work with 15gb, clearly we need to fix all that shit. Bare Cedar Fog is our local laptop, Cold Red Gate is our weak-ass VPS."
- "IF THE TECHNOLOGY WERE DESIGNED WELL PEOPLE WOULD NOT KEEP TURNING IT OFF."

Measured on Bare Cedar Fog the same day:

- **The runner was hand-installed.** GitHub Actions runner 2.338.0, unit `github-bare-cedar-fog-guix.service`, registered to `emsenn/bare-cedar-fog` as `bare-cedar-fog-guix`, with updates disabled.
- **Disk.** It lived in `~/.cache/561-group/cold-red-gate-cicd/runner-bcf`, inside a 24 GB folder.
  - `_work` held 11–15 GB: a 7.0 GB cached checkout of the superrepo, which every job reuses, and 3.4 GB of one release job's temporary build.
  - The other ~13 GB of the folder was agent scratch beside the runner (assemble logs, failure logs, health dumps, PR drafts) with no owner.
- **Jobs in 24 h.** `receive` 46 succeeded, `absolute-symlinks` 23 succeeded, `lockfile-fresh` 24 failed (every run).
- **Memory.** `user.slice` peaked at 5.2 GB with the runner in it. A 2 GB soft cap applied at 15:43 throttled it 25,778 times. A cap that slows the work it contains gets turned off.

Each requirement has one shall. Identifiers are stable.

## One record, any Linux host

- CR-1. The service shall install, run, check and remove a GitHub Actions self-hosted runner from one parameter record that names the scope (a repository or an organization URL), the runner name and labels, and the host's particulars, so the same service makes a laptop or a VPS a CI endpoint.
- CR-2. The service shall carry no host, owner, repository, path or size in its code.
- CR-3. The service shall install the runner version the record pins, verify the download against the record's SHA-256 before unpacking, and keep each version in its own directory so a change of version is a switch, not an overwrite.
- CR-4. The service shall never store a registration or removal token in the record, the repository or the runner's directory. It shall obtain one at the moment of registering from the credential command the record names, and adopt an existing registration instead of registering again.

## Placement and lifecycle

- CR-5. The service shall keep everything a runner owns (versions, registration, work folder, diagnostics) under one root directory selected by the host owner's record within that section's data tree and apart from other tools' files.
- CR-6. The service shall keep the work folder bounded. After every job, through the runner's job-completed hook, it shall remove the job's temporary files and every workspace not named in the record's `retain` list. Retained workspaces are caches that make the next job cheaper.
- CR-7. The service shall delete runner diagnostic logs older than the record's retention days.

## Sharing the machine

- CR-8. The service shall run the runner as a systemd unit in its own slice whose CPU weight, I/O weight and nice value come from the record, so interactive work wins under contention.
- CR-9. The service shall bound the runner's memory only with a hard ceiling above its measured peak (the record's `memoryMax`), never with a soft limit below its working set, so that it is protected against runaway without being throttled in normal work.

## Observation

- CR-10. When asked to plan, the service shall change nothing and report, from small files, the unit's state and counters only:
  - the installed and pinned versions
  - registration present
  - unit active
  - the root's size against the record's `maxBytes`, by class (retained caches, temporary, diagnostics)
  - the last job results from the unit's journal

  Plan exits 0 when converged and 2 on drift.
- CR-11. When asked to apply, the service shall change only what is not current, so a second apply changes nothing.
- CR-12. When asked to apply now, the service shall stop the old runner (GitHub records the running job as cancelled, to be re-run) instead of waiting for an idle moment, because a busy runner may never be idle ("don't wait on idle, you won't get it", Leader, 2026-10-14).

## Receiving conditions

- CR-13. A declared download path shall remain the download destination when it does not yet exist, so caches stay in the host owner's declared data custody.
- CR-14. A structured GitHub registration supplier shall execute only the exact scope's native runner metadata and just-in-time registration-token endpoints through its declared absolute GitHub CLI executable.
- CR-15. The service shall receive actual GitHub runner id, name, scope, online state and declared labels rather than treat local registration bytes or a workflow selector as capacity.
- CR-16. Structured registration shall pass no credential through a shell, record, diagnostic or job environment.
- CR-17. A live local registration for a different scope or name shall refuse reconfiguration until its original custody is reconciled.

1. On Bare Cedar Fog the existing registration is adopted with no new token, and jobs keep running.
2. After a job, the work folder holds only the retained caches.
3. `plan` exits 0 on the converged host, and `apply` run twice changes nothing.
4. The same service and a second record make another Linux host a runner for another scope.


## Original physical admission and retained controls

- CR-18. Direct apply, registration and configuration effects shall require a fresh operation-scoped admission from the original WSL native backing-volume producer. Missing source binding, unknown phase peak/job-preparation envelope, changed source/host record, or insufficient physical capacity shall refuse before mutable effects. The physical reserve shall never fall below100,000,000,000bytes; declared phase peak is additional to original reserve, growth and overhead.
- CR-19. The original record may select existing-flat controls-only reconciliation, binding actual public registration id/name/scope and the loaded user-unit fragment/working directory/command. It shall preserve retained registration, credentials, binaries, work, diagnostics, original fragment and unrelated drop-ins without registration, download, adoption, cleanup or runner state transitions.
- CR-20. Controls-only plan shall use bounded exact files, original scope-bound runner metadata and selected native unit observations, without directory size walks, global process scans or journal inventories. Whole selected-set preflight shall precede control writes.
- CR-21. Startup admission shall be an original systemd ExecCondition before the Listener starts. A standard JOB_STARTED hook shall perform a supplemental fresh admission before workflow steps; it shall not be represented as preceding native action preparation, which occurs earlier in the native runner. Installed controls shall not change a frozen resident's environment or thaw it.
- CR-22. Tiny preventive control installation shall not invent a materialization/job peak or require growth permission merely to install refusal. Unknown phase peaks shall remain unknown and prevent startup/job admission. Physical observation is a snapshot, not a conserved reservation; complete funded job lifecycle and safe resume remain separate receiving conditions.
- CR-23. Only new owner-private admission hook and exact additional80-ci-runner-host-admission.conf may be written in existing-flat mode, with no overwrite of competing bytes, redirects or foreign owners. The original runtime source set shall be pinned and checked by the hook before execution. Changed control bytes require explicit original-owner receiving.
- CR-24. Control staging shall use one exclusive fixed pending slot per target. Interrupted custody shall block successor writes before allocation; normal receiving shall remove only the exact owned staging inode. No age-based pruning or unbounded retry directories are permitted.

- CR-25. Production mutation admission shall accept only actual original native observations, derive destinations from exact canonical CI record members through original layout producers, refuse controls-only growth contexts, and never promote fixture observations or caller-selected unrelated paths into mutation authority.
- CR-26. Retained controls shall freshly receive the original source-pinned WSL preventive quarantine, exact boot/invocation/process identity, marker/loaded guard, and actual kernel-frozen exact process cohort before control writes and after reload. A changed or unknown cohort shall refuse a protection claim while preserving custody. Remote busy=false is not pause authority; raced-in frozen work is preserved.

- CR-27. Existing-flat reconciliation shall preserve original registered systemd unit links when the record explicitly binds the native link owner/device/inode, the canonical original flat units/name.service target and target SHA256. Native lookup alias and canonical target identify the same original fragment. No write may follow that link; target/link drift must refuse before or after control receiving, and all other redirect refusals remain unchanged.
