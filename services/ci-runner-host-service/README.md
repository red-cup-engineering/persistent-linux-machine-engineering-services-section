# CI runner host service

Makes any Linux host a GitHub Actions runner for a repository or an organization, from one parameter record. It handles:

- **Install:** the pinned runner version, verified by SHA-256.
- **Registration:** adopts an existing registration, or registers with a token from a command named in the record. No token is ever stored.
- **Disk:** bounded. A job-completed hook keeps only the declared cache workspaces and recent diagnostics.
- **Scheduling:** runs as a systemd user unit started through GitHub's `runsvc.sh`, in a shared slice with one hard memory ceiling (`sliceMemoryMax`), and that yields to interactive work by CPU and I/O weight and nice. Its only memory limit is a hard ceiling above its measured peak.

Node built-ins only.

```sh
node scripts/ci-runner-host.mjs plan  --parameters=<ci-runner-host.json>   # read-only; exit 0 converged, 2 drift
node scripts/ci-runner-host.mjs apply --parameters=<ci-runner-host.json>   # idempotent
```

To make another box a CI endpoint, write it a record (scope, name, labels, root, retain, priorities) and run `apply` there.

Bare Cedar Fog's record: `bare-cedar-fog/data/records/service-records/ci-runner-host-service-records/bare-cedar-fog/ci-runner-host.json`. Its `defaults` apply to every runner; one runner per Group organization serves that organization's private repositories.

Requirements: `specifications/requirements.md`. Design: `specifications/design.md`.


## Explicit physical-admission records

This release cannot execute records declaring `hostAdmission` or
`controls.mode: existing-flat`. For those records, `plan` reports the unsupported
policy and exits 2; `apply` refuses before registration or local changes.
A generic plan is not a physical-capacity observation, and a job-start hook
does not establish a fence before the runner prepares actions.

For a declared `hostAdmission`, the planning result's
`possibleWriteTargets` enumerates the current generic controller's possible
explicit local destinations, including its reconcile checkout and user units.
An enumerated directory does not attest its descendants or their mounts.
The list contains no capacity evidence. Registration, service-manager effects, the
child release's behavior and Listener action preparation remain unqualified.
Unknown or over-bound layouts return no partial list. The refusal stays in
place regardless of this inventory.

When `hostAdmission.ciParametersPath` names the canonical file opened by
`loadRecord`, the plan can also return a `parameterRecord` digest. The file
and ownership are checked again before the receipt is returned; changed raw
bytes, file identity, normalized parameters or effective target paths leave
the plan unbound. This is source provenance only. It is not a physical
capacity receipt, reservation, or permission to run `apply`.
The Linux parameter loader refuses nonregular and over-4 MiB files before
parsing. The stricter provenance read additionally requires a canonical
owner-custodied file of at most 256 KiB.
