# WSL host service

Generic WSL2 host engineering. From one parameter record it renders and idempotently installs a WSL2 host's Windows-side files (`.wslconfig`, Defender exclusions, pagefile, disk compaction) and Linux-side files (`/etc/wsl.conf`, sysctl, block-queue limits, agent cgroup ceilings, orphan-relay reaper, the daily trim and their units). It uses Node built-ins only and does not depend on MetroPlat.

```sh
node scripts/wsl-host.mjs plan  --parameters=<wsl-host.json>
sudo node scripts/wsl-host.mjs apply --scope=linux   --parameters=<wsl-host.json>
node scripts/wsl-host.mjs apply --scope=windows --parameters=<wsl-host.json>
```

Ordinary configuration and capacity observation do not restart WSL. A host whose record declares `windows.backingStorage.sparse` gets `wsl-compact-disk.ps1`, the owner's operation for making the backing VHDX sparse and compacting it below the declared physical floor. With `linux.trimTimer` declared, the daily `wsl-fstrim.timer` returns freed space to Windows, and `plan` reports the sparse state and allocation against ext4 use.

For an authorized maintenance operation from a WSL runner, use the explicit native entrance:

```sh
sudo node scripts/wsl-host.mjs apply --component=trim-timer --scope=linux --parameters=<selected-wsl-host.json>
node scripts/wsl-host.mjs maintain-disk --parameters=<selected-wsl-host.json>
node scripts/wsl-host.mjs maintenance-status --parameters=<selected-wsl-host.json>
```

The trim component installs only the declared service and timer. Disk maintenance launches a separate Windows PowerShell parent with its source, process and result under the Windows owner's `AppData/Local/561-group/wsl-host-service/maintenance`. It waits 90 seconds for the initiating runner to finish, takes the existing distribution-wide maintenance mutex, and executes the rendered operation. Before the offline disk operations, the parent awaits `wsl --terminate` for the verified distribution and records its exit code. A failed stop prevents sparse conversion and compaction. The selected distribution and its runners stop during maintenance; the Windows parent attempts to restart the distribution after every operation outcome. Compaction may take about 40 minutes. A sparse-conversion refusal preserves `allowUnsafe` and remains visible while independently declared below-floor compaction proceeds after a fresh capacity read. The result records stop, conversion and compaction exit codes, restart outcome, sparse state and backing free space. Repeated launch calls return the existing operation; they do not replay it. After recovery, read maintenance status and fresh native capacity before forming another release.

The parameters of Bare Cedar Fog live in `561-group-services-section/services/561-group-operations-services-section/services/bare-cedar-fog-services-section/data/records/wsl-host-service-records/bare-cedar-fog/wsl-host.json`.

Requirements: `specifications/requirements.md`. Design: `specifications/design.md`.


Quarantine state requires an explicit owning `sectionRoot` above `data/`; no
home storage fallback is supported. Existing holds need the separately received
no-gap migration in the design before changing their marker path. Ordinary file
reconciliation never releases a hold.

The service owns [its dedicated repository](https://github.com/red-cup-engineering/wsl-host-service).
Original source history and exact import correspondence are retained in
`data/records/source-origin-records/`. GitHub issues and PRs are ingress messages:
link the original issue or Semioverse subject, provide exact evidence, and retain
publication/deployment/use obligations. A GitHub comment or merge grants no
native authority and does not create a native Work or cell. The existing
[GitHub-to-Semioverse bridge obligation](https://github.com/red-cup-engineering/git-engineering-services-section/issues/1)
remains open; these forms do not claim that projection is deployed.



## Receiving an interrupted Windows parent

`wsl-host maintenance-receive-interruption --parameters=<host-record> --interrupted-request=<exact-request-sha256>` receives one identified stopped parent. It compares the retained launch, process start identity, source files and unchanged host parameters, acquires the original distribution mutex, and requires WSL to report that distribution running. It preserves the original state, output and result files and writes a separate `interruption.json`. A later maintenance launch reobserves those same identities and native conditions before continuing. A live parent, a pending terminal file, changed inputs or an unavailable native distribution remains held.

The maintenance parent is launched by a demand-only Windows Task Scheduler task under the existing owner's interactive token and least privilege. The task has no trigger, stored password, automatic retry or execution timeout. Its registered action is the retained private PowerShell script. The parent receives its running task and account, records its actual PID and creation time, and keeps the distribution-wide mutex through maintenance and restart. This Windows-owned execution does not require breakaway from the initiating WSL process's job. Task status retains its native result and launch diagnostics, including HRESULT, account, session, logon type and run level. Every native maintenance phase is recorded before its command runs; the selected VHDX must be released after stopping the distribution. The existing restart and final result remain in the same script.

If the selected VHDX stays attached for 30 seconds after distribution termination, the owner records WSL's exact running-distribution list. It refuses VM shutdown when another distribution is running. Otherwise it invokes ordinary `wsl --shutdown`, waits another 30 seconds for that same VHDX, and continues the declared disk operation. The result retains the running names and VM shutdown outcome alongside the original stop and restart outcomes.

A launch interrupted before any parent state is written can be received through the same explicit interruption command only after the original caller is gone and its exact idle task is disabled and reobserved. Queued or running tasks remain held. The original parent records and received interruption files are preserved.
