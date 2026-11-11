# Frozen full-graph reading

The owner is `red-cup-engineering/guix-machine-release-service`. The consumer
remains `readFrozenWorkspace` before the stock, reviewed pnpm10.34.6 frozen
installation. This corrects two data-reading assumptions; it does not change
source selection, dependency locks, registry integrity, package acquisition,
source admission, machine activation or the required exact toolchain.

## Pinned YAML API, one complete input

The inspected YAML2.9.0 CLI streams pipe chunks into its parser. A genuine
514,823-byte production lock fails with `BLOCK_AS_IMPLICIT_KEY` through that
route, while the identical bytes parse through the same provider's API and a
regular-file stdin. A pipe's chunk boundary is not part of the lock's meaning.

`parseFrozenYaml` retains the explicit absolute YAML provider and exact 2.9.0
manifest check. It starts the owning `parse-frozen-yaml.mjs` adapter using the
same Node and isolated environment, passing the `dist/index.js` API from that
same provider directory. The normal Guix entry still verifies the entire
inspected provider inventory and exact Node identity before this call.

The adapter reads all stdin bytes as UTF-8 once and calls that genuine API's
`parseAllDocuments` with `strict: true`. Exactly one document and no parsing
errors are required. Empty/comment-only input, multiple documents, duplicate
mapping keys, malformed syntax and unresolved aliases refuse. Warnings and JSON
serialization retain the provider's behavior. There is no private YAML parser,
ambient package lookup, version switch, resolution retry or malformed-input
fallback. Importing the owning adapter as a module performs no parsing.

The fixed-provider fixture recognizes exactly this owning script plus the exact
inspected API path, with exactly two subprocess arguments. Other paths, extra
arguments and all existing unexpected process/network/worker operations remain
refused. A new adapter needs fresh genuine fixed-provider receiving; source or
data-reading results alone do not replace that acquisition assay.

## Selected source links in registry snapshots

The inspected pnpm10.34.6 `dist/pnpm.cjs` `lockfileToDepGraph` passes `.` for
registry snapshot children (line 164976) and the importer ID for direct children
(line 164986). `getChildrenPaths` resolves `link:` against `lockfileDir`, that
base and the reference suffix (lines 165094–165101). Snapshot references are
therefore lockfile-root-relative; direct references are importer-relative.
These distinct bases must not be interchanged.

`readFrozenWorkspace` first parses and performs the existing SQLite lock check,
then verifies the exact flat importer/directory set and all selected manifests.
Directories cannot redirect; manifest files must be regular; selected source
package names must exist and be unique. Existing declaration/specifier,
package-manager, runtime/configuration and SQLite checks remain in force.
Only then does it pass the complete manifest map and generated workspace
overrides to `assertFrozenRegistryGraph`.

Every source link must be a canonical relative path to an exact selected
`packages/` importer, with a corresponding admitted manifest whose package name
equals the dependency edge's name. A transitive snapshot link additionally
requires that both the reviewed lock override and generated workspace override
for that same package name equal `workspace:*`. This is the existing source
composition's explicit override, not an unqualified arbitrary local reference.
Missing evidence, aliases to another package, absolute/escaped/noncanonical
paths, redirected/missing sources, wrong-base paths and changed/missing overrides
refuse. Direct importer links do not need a transitive override, retaining the
existing synthetic provider fixture's ordinary workspace-link contract.

The pure graph checker now needs `{sourceManifests, workspaceOverrides}` to
validate linked graph identities. Its map is data supplied by the existing
workspace reader after filesystem/source checks; calling the graph checker
alone is not filesystem or source-custody verification. A graph containing links
without that evidence refuses. Ordinary registry-only graphs remain supported.
The existing metadata, SHA-512, snapshot-completeness, unqualified-protocol,
Git-hosted archive, hook, patch and SQL refusals stay intact.

## Receiving scope

`test/frozen-workspace-reading.test.mjs` is source-only: its subprocess port is
closed and evaluates neither providers nor packages. It covers both link bases,
matching source/override identities, path/identity failures, unchanged lock
bytes and the retained registry/SQL/toolchain/configuration guards.

`test/qualification/frozen-workspace-reading.test.mjs` is data-only. It requires
an explicit `DRC3_YAML_PACKAGE` already matching every YAML2.9.0 inventory file
and a fresh `ASSAY_OUTPUT`. It checks a large document, strict refusals, ordinary
YAML semantics, a complete synthetic linked workspace and exact parser-boundary
receiving. It invokes no pnpm, Guix, package installation, application module or
network API. It does not acquire a missing provider.

For the actual application lock, separately materialize the exact selected
manifests and frozen lock without executing their source. Run the same reader
against a fresh copy, exercise changed specifier/name/override/importer/path,
SQL and registry-integrity controls, and retain byte hashes before and after.
The October 11 data-only check includes 247 selected manifests, 248 importers,
554 registry packages, 561 snapshots and eight transitive selected-source links.
The unchanged lock SHA-256 is
`84de8bcf17da262100d21cf7daf5a9628af2fb8a23c70abf1ee4d9119748e1af`.

These results establish reading and admission of that exact manifest/lock
composition. They do not establish acquired package contents, executable-suite
SQL freedom, actual provider installation, exact Guix Node24.18 receiving,
application tests, or machine activation. The local data-only execution used
Node24.19.0; the required fixed Guix toolchain and its genuine acquisition assay
remain separate obligations. No source pin, lock or frozen receiving packet is
updated by this adapter correction.
