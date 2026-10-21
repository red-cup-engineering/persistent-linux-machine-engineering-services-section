# CI runner host service: design

## Theory

A self-hosted runner is a long-lived process that turns a machine's spare capacity into CI. It fails its host in three known ways, all measured on Bare Cedar Fog: it accumulates disk with no lifecycle, it competes with interactive work for memory and CPU, and it is installed by hand, so nobody can reproduce, move or remove it. The defence is ordinary operations practice:

- an installer driven by declared parameters
- a lifecycle for every byte the runner writes, through the runner's own job hooks
- scheduling priority instead of throttling: weights and nice to yield, plus a hard ceiling only against runaway

Throttling a batch job below its working set makes it slow and flaky, and gets the limit removed. Lower priority lets it use what is idle and yield what is not.

## Shape

```
record (operations) --plan--> items {current | drift, measured}
                    \-apply--> root/{versions/<v>, runner/, hooks/} + user unit + slice
```

Under `root`:

- `versions/<v>/`: the unpacked runner, verified by SHA-256 (CR-3).
- `runner/`: the runner's working directory, holding its registration (`.runner`, `.credentials*`), `.env`, `_work` and `_diag`. Its `bin` and `externals` are **hard-linked copies** of `versions/<v>` (`cp -al`: no extra disk, the version store unchanged). They are not symlinks, because the runner locates its registration from its binaries' real path. With symlinks it looked in `versions/<v>`, reported "Not configured" and exited in a loop (Bare Cedar Fog, 2026-10-14 17:05–17:25).
- **Health is positive evidence.** `plan` requires the unit to be `running` with zero restarts and its journal since the last start to show "Listening for Jobs". `active` alone also matches a unit cycling through restarts.
- `hooks/job-completed.sh`: after each job, removes `_work/_temp/*` and every `_work/<owner>/<repo>` not in `retain`, and deletes `_diag` files older than `diagDays` (CR-6, CR-7). The runner calls it via `ACTIONS_RUNNER_HOOK_JOB_COMPLETED` in `runner/.env`.

## Choices

- **Adopt, don't re-register.** If `adopt.from` names an existing runner directory with a registration, `apply` moves it to `root/runner` with a rename on the same filesystem, keeping its cache. It does this only while no `Runner.Worker` is running, then disables the old unit. Registration with a token from `credentialCommand` happens only when there is nothing to adopt.
- **Retained workspaces are caches.** A retained checkout makes the next job's checkout incremental; on Bare Cedar Fog that is the 7 GB superrepo. Everything else under `_work` is per-job. `_tool`, `_actions` and `_PipelineMapping` belong to the runner itself and are kept.
- **Priority, plus one ceiling.** The unit sets `Slice=`, `Nice=`, `CPUWeight=`, `IOWeight=` and `MemoryMax=` from the record. It never sets `MemoryHigh`.
- **Parent caps are reported, not hidden.** A user unit sits under `user.slice`. `plan` reads `memory.max` up the cgroup chain and reports drift when an ancestor's ceiling is below the runner's `memoryMax`, because then the parent's limit, not this record, decides. That conflict is resolved in the host's memory budget (`wsl-host-service` on a WSL host), not here.
- **Plan reads small things.** Unit state, the `.runner` file, the versions directory, the journal's last job results, and sizes of `runner/_work` and `_diag`. The sizes are a walk of the runner's own bounded folder at idle I/O priority. Nothing outside `root` is walked.
- **Node built-ins only.** The service runs where Node 22+ is available. The tarball is fetched with `fetch` and unpacked with the system `tar`.

## Parameter record

`ci-runner-host-parameters@1`:

- `runners[]`, each with:
  - identity: `name`, `scope` (repository or organization URL), `labels[]`
  - install: `version`, `sha256`, `root`
  - lifecycle: `retain[]`, `diagDays`, `maxBytes`
  - scheduling: `slice`, `nice`, `cpuWeight`, `ioWeight`, `memoryMax`
  - registration: `credentialCommand`, `adopt` (`from`, `oldUnit`)
- `node`
- free provenance fields (`observed-*`)
