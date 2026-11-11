# Atlas Guix operator contract

`build-atlas` is the repository's Guix entrypoint.  It can be invoked from any
working directory:

```sh
/path/to/info/guix/build-atlas
```

The entrypoint resolves its own location, enters the authenticated bootstrap
revision in `guix/bootstrap-channels.scm`, then uses the repository-root
`channels.scm` to run the pinned production Guix release and build the root
`guix.scm` package definition. The build is a direct subcommand of the second
time machine, so it cannot accidentally resolve an ambient host `guix` from
inside a shell. The two-hop route is required on the current Guix 1.4 bootstrap
host because the production revision expects Guile's newer `spawn` binding.

`guix/run-pinned` is the one repository-owned entrypoint for that channel
transition. Package and profile helpers delegate to it so bootstrap and
production revisions cannot drift independently across operator scripts.

`-L "$repository_root/guix"` is intentional: the package definition imports
`(phezi ochage packages atlas)` from the repository's `guix/` module tree;
Guix does not add that local module directory automatically.  The command
therefore does not depend on the caller's current directory or ambient
`GUILE_LOAD_PATH`.

Extra arguments are forwarded to `guix build`.  For example, this checks the
complete pinned evaluation without starting a build:

```sh
/path/to/info/guix/build-atlas --dry-run
```

The entrypoint requires a bootstrap `guix` command on `PATH`; that command is
used only to obtain the pinned release specified by `channels.scm`.

## Shared host-operations profile

`build-host-operations` enters the repository-owned operator and assay profile
shared by Bare Cedar Fog and Cold Red Gate work:

```sh
/path/to/info/guix/build-host-operations
```

The profile pins the repository's Node, Guile, and Python runtimes and carries
Git/SSH, rclone/rsync, OCI clients, structured inspection tools, shell checks,
and cryptographic utilities. Specialized profiles extend this list rather than
redeclaring it. To evaluate the full package graph without realizing it, run
`/path/to/info/guix/check-host-operations`.

This is deliberately a foreign-distribution package profile. It does not
install or configure Guix on a host, own systemd units, activate a container
daemon, materialize npm dependency closures, store credentials, prove a
backup/restore path, or declare that an application is deployed. Those remain
separate host and capability-delivery receipts.

## YouTube operator toolchain

`build-youtube-toolchain` extends the shared host-operations profile with
media, archive, and build tooling used to operate and fabricate the five
YouTube channel services:

```sh
/path/to/info/guix/build-youtube-toolchain
```

The manifest is at `guix/manifests/youtube-toolchain.scm`; its package choices
live in `(phezi ochage manifests youtube-toolchain)`.  It provides tools only.
It deliberately does not run npm, package a channel, store credentials, or
claim that the remote NotebookLM provider is locally reproducible.

To evaluate the pinned manifest without building its large closure:

```sh
/path/to/info/guix/check-youtube-toolchain
```

The upstream default Guix channel carries its built-in authenticated channel
introduction.  `channels.scm` pins a signed upstream commit; all entrypoints
use that file instead of an ambient `guix pull` profile.  On the repository's
Guix 1.4 bootstrap host, the wrappers first enter the authenticated
`guix/bootstrap-channels.scm` revision, then use that Guix to evaluate the
production pin.  This two-hop bootstrap avoids depending on an untracked host
upgrade while newer Guix modules transition to Guile's `spawn` interface.
