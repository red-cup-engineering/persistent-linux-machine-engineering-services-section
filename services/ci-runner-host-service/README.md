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
