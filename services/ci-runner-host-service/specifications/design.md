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

The host owner selects this root within its section's data tree. On Bare Cedar
Fog the qualified runner record selects `data/state/ci-runner-host-state` under
the Bare Cedar Fog services section, and the download cache is separately owned
under that section's data tree. The former requirement to place a runner outside
every Git working tree contradicted the settled owning-section data requirement;
Git repository containment does not authorize a scan, publication or cleanup of
the runner's private registration or work files. Existing name/scope custody and
resource admission still govern adoption and installation.

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
Structured apply preflights complete same-scope native metadata before any download/link effect, and again immediately before a registration token. A missing local registration needs explicit remote absence; a retained local registration needs the exact native remote agent id. Unknown/ambiguous/incomplete state and a remote occupied name refuse. Native configuration never receives --replace, so a concurrent remote claim cannot be overwritten. Token-supplier failures retain only a fixed public class; original Error/stdout/stderr/cause and token-bearing argv never enter diagnostics.

The optional structured registration supplier is `registration: {executable: <absolute gh path>}`. It is not a generic command adapter. The original installer derives GET runner metadata and POST registration-token endpoints from the exact HTTPS github.com repository/organization scope, fixes the host/method/endpoint arguments itself, and keeps the returned token in the registration call only. Metadata is bounded at100 runners/1MiB/10seconds; incomplete or unavailable observations remain unknown. A present local registration must match the declared scope/name before any registration effect.

An explicitly declared `tarball` is a destination even before its first download. Its parent is created at that path; the SHA256 check still precedes extraction. The composing host record supplies owner data/state or data/logs custody and independently admits physical capacity before materialization. Omitted tarball retains the original legacy fallback; new host composition requires explicit owner custody.

`ci-runner-host-parameters@1`:

- `runners[]`, each with:
  - identity: `name`, `scope` (repository or organization URL), `labels[]`
  - install: `version`, `sha256`, `root`
  - lifecycle: `retain[]`, `diagDays`, `maxBytes`
  - scheduling: `slice`, `nice`, `cpuWeight`, `ioWeight`, `memoryMax`
  - registration: `credentialCommand`, `adopt` (`from`, `oldUnit`)
- `node`
- free provenance fields (`observed-*`)


## Physical admission and existing-flat preventive controls

The storage incident demonstrated that materialization-only host admission did not govern repeated GitHub job preparation, and the actual retained runners use flat roots rather than the old version-store layout. `controls.mode: existing-flat` reconciles those original registrations without migrating them. Its declaration includes current UID/home, canonical CI parameters path, private control directory, original Node/CLI runtime paths and SHA256 pins for the complete original CI module set. Each runner has `existing.id`, `existing.unitFragment`, and `existing.unitFragmentSha256`. Public `.runner`, exact original GitHub GET and native loaded unit metadata must agree before any output. A different `.env` JOB_STARTED hook is a conflict. There is no credential or registration repair in this mode.

`hostAdmission` names the canonical WSL record, `provider: {module, sha256, asset, assetSha256}`, and `phasePeakBytes` for materialization/startup/job. The source is the original WSL capacity module plus its exact sibling native asset; it is checked before and after use. The original producer receives exact destinations and independently verifies current WSL registration, VHD identity and backing-volume mapping. Its original assessment retains percentage reserve, declared growth and overhead. The CI owner adds a positive declared phase peak and enforces at least100GB absolute reserve. No peak can be inferred from retention limits. Production serialized records cannot substitute an assessment callback or a JSON admitted boolean. Original test ports replace native observations only.

Legacy materialization keeps its algorithm and pure identity refusals, but full-set registration preflight and physical admission now precede adoption, download, linking, registration and unit effects. Synchronous direct registration/configuration exports receive only a private same-operation context issued by original physical admission; forged, expired, changed-runner and changed-input contexts refuse. The context is closed at operation termination and is never a persistent capacity cache. Snapshot admission does not solve conserved concurrent funding or prefix/terminal custody.

Controls-only apply writes the private source-checking hook and additional80drop-in, reloading only on change. It never starts/stops/restarts/enables/disables/thaws a resident and never runs the old completion cleanup hook. ExecCondition guards the startup prefix before Listener/action preparation. The standard job-start hook is supplementary: native actions/runner2.338.2 JobExtension.PrepareActionsAsync precedes JOB_STARTED. The existing frozen resident cannot receive the new environment until a future native start; persistent quarantine remains authoritative, and no resume is admitted while unknown peaks or the physical floor remain unmet. The fixed exclusive `.pending` slot retains interrupted custody and blocks successor allocation.


Production mutation contexts use only the actual default native WSL producer. Observation test ports cannot issue them. `hostAdmission.ciParametersPath` binds the full canonical CI record; selected runners must be exact members and original `runner-layout.mjs` derives every materialization destination. Existing-flat controls declarations cannot issue growth contexts even after physical capacity recovers. Startup requires both a positive declared startup prefix and a positive selected job envelope including native preparation, and adds both to original headroom requirements. This remains a preventive snapshot rather than a funded continuous-Listener lifecycle.

For retained controls, `controls.pauseProvider: {module, sha256}` selects the already-qualified original WSL quarantine observation. Each `existing.pause` binds `id`, `markerSha256`, `guardSha256` and exact sorted `cohort: [{pid,startTime}]`. The original producer receives the current canonical host declaration, loaded90negative marker condition and resident identity. Frozen cases additionally read only the selected cgroup's native freeze/events/procs, reject unexpected child cgroups, and compare each original process birth. The same pause is received before writes and after reload. A remote busy sample neither admits pause nor causes work cancellation. The complete pinned runtime is CLI plus original CI main, admission, existing-controls and shared layout modules.

The explicit `test:native-controls` command takes a unique receipt path and qualified original WSL source paths. It creates one disposable harmless user unit, installs refusal controls through the original CI owner while an original own stopped90hold is received, then receives terminal state and retires only that disposable90experiment before isolating the80ExecCondition assay. It never calls hold-only release, changes a production guard or claims resident hook adoption. Actual native journal invocation, skipped startup, absent sentinel, supplemental job refusal, source-digest refusal and terminal exact cleanup are recorded. Native inactive-unit garbage collection can clear transient ExecCondition status, so the receiver uses the exact unique unit journal rather than assuming show retains exit status.


Current control state includes native manager-loaded80drop-in, exact startup condition and the selected configured JOB_STARTED path; matching files alone are insufficient. Typed native D-Bus service metadata returns only the expected safe hook path or unknown, never an environment dump. EnvironmentFile overrides and matching UnsetEnvironment prevent a configured-hook claim without reading their possibly secret contents. The original runner .env is also checked conservatively for a competing hook.

A caught interruption before daemon-reload retains creation receipts for exact owned control paths/device/inode/hash/mode. Reload-only reentry freshly receives the same original pause/cohort, preserves current file inodes, reloads only, and receives native declarations after reload. The explicit own native qualification takes receipt path, received fixture SHA256 and fixed frozen-case scenario; it pins those in intent before native effects. One disposable harmless frozen resident demonstrates interrupted reload and default native recovery, then is stopped through its original owner and received terminal before its own90experiment is retired and a separate80startup assay runs. Old stopped-unit diagnostic failures and inactive garbage-collection behavior remain distinct evidence, not a fabricated failed reload.


The actual original runner units are registered links in the user manager, pointing to the retained flat installer's units directory. `existing.unitFragmentLink: {target, device, inode, uid}` receives that native link explicitly; device/inode are decimal strings. The only allowed target is dirname(runner.root)/units/unitName, a canonical owned regular file bound by existing.unitFragmentSha256. The controller verifies the home lookup slot, exact link identity/target, native fragment alias or canonical target, loaded command/working directory and original paused cohort. It rechecks the same link and target receipts after reload. It never replaces or writes through the original link, and additional80outputs retain strict canonical destinations. Missing declarations, changed link instances, wrong targets and target inode replacement remain refusal; ordinary regular fragments continue to work.
