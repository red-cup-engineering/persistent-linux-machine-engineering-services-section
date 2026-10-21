# CI runner host service

Makes any Linux host a GitHub Actions runner for a repository or an organization, from one parameter record. It handles:

- **Install:** the pinned runner version, verified by SHA-256.
- **Registration:** adopts an existing registration, or registers with a token from a command named in the record. No token is ever stored.
- **Disk:** bounded. A job-completed hook keeps only the declared cache workspaces and recent diagnostics.
- **Scheduling:** runs as a systemd user unit that yields to interactive work by CPU and I/O weight and nice. Its only memory limit is a hard ceiling above its measured peak.

Node built-ins only.

```sh
node scripts/ci-runner-host.mjs plan  --parameters=<ci-runner-host.json>   # read-only; exit 0 converged, 2 drift
node scripts/ci-runner-host.mjs apply --parameters=<ci-runner-host.json>   # idempotent
```

To make another box a CI endpoint, write it a record (scope, name, labels, root, retain, priorities) and run `apply` there.

Bare Cedar Fog's record: `561-group-services-section/services/561-group-operations-services-section/services/bare-cedar-fog-services-section/data/records/ci-runner-host-service-records/bare-cedar-fog/ci-runner-host.json`.

Requirements: `specifications/requirements.md`. Design: `specifications/design.md`.
