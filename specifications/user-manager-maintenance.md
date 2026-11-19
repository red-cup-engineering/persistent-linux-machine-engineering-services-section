# Native user-manager maintenance

The original CRG registry incident requires retiring the exact captured broken
publisher without starting its old entry. systemd 257.9 leaves a killed frozen
service in `activating/auto-restart-queued`, with zero resident processes,
no cgroup and no job. `ThawUnit` accepts only `UNIT_ACTIVE`; start and stop
reject non-running freezer state. `reset-failed` does not change this service
state. The manager serializes the frozen state, so ordinary reexecution
preserves the trap. An isolated original-version native fixture independently
received all these states and received a stopped unit after replacing only its
private manager. This is the existing registry-repair work, not new publication
authority or proof that external effects are settled.

The persistent Linux machine owner supplies one generic maintenance operation.
CDE's existing main-and-ingress maintenance contract retains its two-unit scope;
it is not a substitute for receiving an entire user-manager scope.

The operation must receive every active service and activation unit, reject
foreign execution scopes, outstanding native jobs, nonterminal frozen residents
and nonempty SSH-agent identity custody. It binds original unit/profile files
and the original system user-manager unit by exact bytes and link identities.
The original system unit and private user-runtime directory are explicit
resource identities. Kernel UID, executable mode, process start time and runtime
environment identify a real `systemd --user` process; its API-bus owner PID must
agree. This supports an independently owned test manager through the same native
actuator, without a replacement command or fixture-only restart implementation.
Native `EnvironmentFiles`, credential source files, inline environment and
credential digests, actual Guix profile pointers and explicit original owner
inputs are received without printing or retaining secret values. Inactive units
are read on one D-Bus connection using `LoadUnit`/`RefUnit`/`UnrefUnit`; their
metadata must not depend on another subprocess keeping an object loaded.
All service files, including templates, receive an owned runtime drop-in with
a negative `ConditionPathExists` on this operation's existing private outcome,
`Restart=no` and an appended `ExecCondition=/usr/bin/false`. Existing conditions,
commands, drop-ins, quarantine markers, profiles and application state are never
replaced. Actual loaded fences must be received before stopping any consumer.

Ordinary native stops must receive zero main/control PIDs, no queued job and
terminal original cohorts. Activation units must also be stopped. Empty frozen
units remain held. A controller outside the affected manager subtree requests
the original system unit's restart, using its existing native privilege. A new
manager PID, absence of the old PID, unchanged original configuration and
terminal held units are separately received before restoration. The caller
must launch this controller through the original system supervisor; a process
inside the affected user manager cannot perform this phase.
Fresh-manager activation units are stopped again before any application fence
opens. The management bus service derives from its original D-Bus daemon PID and
native cgroup; only its actually loaded owned fences open first. The operation
receives that original transport and API owner PID equal to the new manager PID
before recording `restarted`. This restores the management API without starting
applications or assuming a fixed publisher-specific service policy.
Original manager-environment bindings are hash-received before stopping and
again before restoring applications. The shared Linux importer obtains values
from an original private environment projection parsed by systemd's own
`EnvironmentFile` implementation. It verifies that this source process is the
declared outside system importer unit and the file is its actual native input,
then applies explicit same-custody variable mappings with `import-environment`.
Values travel only in the native child environment; arguments, private outcomes
and diagnostics contain no values. Typed native JSON readback must match every
original digest. Credential custody, recipient sealing and normal file rendering
remain with the existing credential-custody service, not this host operation.

Only services that were actually running are restored. Previously completed
`RemainAfterExit` jobs are retained as original invocation evidence and never
explicitly restarted; frozen held units remain stopped for their original owner
to finish. Restored timers retain their normal original scheduling semantics;
this does not establish application-level replay safety for every future job.
Only fences actually loaded by prior running ordinary services open for their
restoration. All remaining service fences, including each completed canonical
unit, remain through ordinary receiving: a `Requires` or `Wants` edge cannot
replay a completed oneshot during recovery. Installed native aliases are resolved before the original unit snapshots. Actual
alias/template fence multiplicity and membership are received in one tracked
D-Bus snapshot, including the native loaded drop-in paths. Remaining controls retire
after useful ordinary restoration and before future activation; no permanent
replacement command or suppression shim is installed.
Restoration receives native service state and each original TCP listening
endpoint, then restores and receives prior sockets, timers and path units.
The socket reader explicitly requests Netid with TCP+UDP output, admits TCP
rows only, and binds their actual local endpoint rather than the peer wildcard.
Dynamic UDP endpoints and application request completion are separate provider
receiving; the operation never claims application drain or reconciled external
effects. The original WSL quarantine completion and CDE replacement receiver
remain responsible for their own marker retirement and new publisher selection.

The private owner-work outcome precedes every effect. `restarting` is written
before the one native manager restart request; an unreceived response cannot
cause another restart. `receive-restart` observes the actual manager instead.
Fencing and removal of this operation's exact own controls resume safely after
an interrupted reply. Configuration or identity drift is preserved and refused,
never restored from stale bytes. No receipt is an independent approval grant.

The native interface is systemd's existing unit/drop-in, D-Bus and systemctl
contract, with Linux procfs/cgroup observations. The causal counterexample is
qualified against upstream v257.9 `src/core/unit.c`, `unit-serialize.c`,
`service.c` and `cgroup.c`; external source corrections are not inferred from a
version number. Source tests cover actual own control files, native-port
boundaries, changed cohorts/configuration, foreign work, SSH keys, partial
fencing, an unreceived restart, completed-job non-replay and missing listeners.
Those tests are distinct from original-version native fixture qualification and
the independently received production maintenance outcome.
The complete CRG native fixture uses two bounded exclusively owned system units
(outside controller and delegated private manager), actual credential and
environment sources, a TCP application and native alias requiring the completed
oneshot counter, a frozen
empty cohort and a timer. It receives application counter 1→2, completed counter
1→1, held counter 1→1, unchanged original marker and exact fixture cleanup.
Native dependencies are the qualified host's Node, systemd tools, Linux procfs/
cgroup interfaces, `ss`, sudo and installed Python D-Bus client. The Python
observer emits only native metadata and hashes, never credential property bytes.

A transient invocation is identified by its captured native fragment at the
selected runtime's exact `systemd/transient/<unit>` path. Once its original
process and cgroup are terminal, systemd may collect that ephemeral fragment.
The outcome retains the original configuration hashes and receives current
terminal absence; it never recreates the invocation. Persistent services form
the restoration set. Interrupted transient jobs retain their own stop-post
receipts and are not replayed by host recovery; their restored original
dispatchers retain responsibility for future work. Persistent configuration
absence still refuses recovery. Native qualification includes both a completed
transient invocation and a running transient with a terminal stop-post counter.

If another actor removes all this operation's controls after stopping, the
original owner can receive that interruption while the original manager is
unchanged. It archives the exact original stopping outcome, records the actor as
unknown, receives original configuration and environment, and starts only the
original management transport from its unchanged native declaration. API-owner
and native bindings are received before fresh cohorts replace the active
capture. Original persistent restoration and TCP endpoints still owed remain
obligations; conserved inputs and profiles and an immutable predecessor link
remain attached. Existing fence/stop/restart then handles that fresh capture.
An old restart request is never replayed, and an unknown actor grants no rights.
