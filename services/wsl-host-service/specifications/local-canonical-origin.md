# Local canonical web origins on a WSL host

Status: retained behavioral specification, 2026-10-26 America/Chicago.
Independent network specification, architecture/design and source review were
received from the separate review agent before scoped service deployment. The
original proposal text below records its pre-implementation baseline and stage
questions. Actual installed receiving is retained by Bare Cedar Fog in
`data/records/operating-observation-records/2026-10-26-local-canonical-origin.json`.
Passkeys remain separate work. Immediate offline receiving uses the existing
application authentication; offline initial sign-in after logout is not claimed.

Original Work: `ni:///sha-256;ojhpdlpE4rnbo4M0EpPYHkymkZXHGFqLaAtZcn22bvs`.
Original Leader messages:
`services/internal-services-section/data/records/leader-source-records/2026-10-26-capital-machine-private-browser-workspace.json`.
Immutable source: [Leader request and follow-up](https://github.com/561-group/internal-services-section/blob/c7bb2303322c27cd85487b1d09e236ec8b501c22/data/records/leader-source-records/2026-10-26-capital-machine-private-browser-workspace.json).
Current WSL source: `07aeffcf80389a7b43885c52aaaae3a309049844`.
Current host factory source: `0866a586170b819515d4e8fd929a45912e739219`.
Concurrent timer-retirement edits are a separate source obligation.

## 1. Problem and boundary

Bare Cedar Fog's canonical origin currently resolves to public Cloudflare
addresses and returned an unauthenticated HTTP/2 200 at 2026-10-27T01:02:50Z.
Its existing WSL application listens at 127.0.0.1:18807. Windows Tailscale reports
a running node at 100.114.48.122 with an empty Serve configuration. Linux has no
selected Tailscale service in the observed scope.

The Leader requires the unchanged canonical HTTPS origin to select the local
instance on both WSL and Windows without Internet access; remote access is
restricted to authorized Tailnet machines. Current `renderFiles` does not
manage hosts mappings, a local HTTPS listener or Windows Tailscale serving.
Putting an unknown key in wsl-host.json would provide no operating behavior.

WSL Host owns OS name-resolution integration and host effects. The existing
deployment owner owns the instance and its selected ingress. DNS/TLS providers
retain their actual protocol implementations. Application authentication belongs
to the shared web authentication owner; neither a loopback connection nor a
Tailnet address grants human, office or Work authority.

BCP 14 keywords below describe the proposed behavior, pending independent
review; they do not claim an accepted implementation.

## 2. Required observable behavior

| ID | Traces to original Work | Requirement |
| --- | --- | --- |
| LO-1 | r1 | The origin MUST retain its HTTPS scheme, hostname, default port, realm and original Actor identities across local and remote routes. |
| LO-2 | r2 | Remote ingress MUST accept traffic only through the selected private mesh boundary and its current access policy. |
| LO-3 | r3 | The former public route MUST cease forwarding requests to this instance, including requests using its old edge address with the original Host/SNI. |
| LO-4 | r4 | The Windows system resolver MUST select a host-local route for the canonical name while Internet and Tailnet coordination are unavailable. |
| LO-5 | r5 | The WSL system resolver MUST select a guest-local route for the canonical name under the same outage. |
| LO-6 | r6 | Both paths MUST present a currently valid certificate for the unchanged hostname through the ordinary browser trust path. |
| LO-7 | r7 | Read-only plan MUST distinguish desired declaration, installed configuration and actual native receiving without changing any of them. |
| LO-8 | r7 | Scoped apply MUST preserve unrelated name mappings, WSL settings, mesh services and ingress hosts. |
| LO-9 | r7 | A repeated converged apply MUST produce no configuration writes or lifecycle commands. |
| LO-10 | r7 | Reconciliation and ordinary host startup MUST preserve the selected private/local configuration. |
| LO-11 | r7 | A changed original file, foreign writer, conflicting mapping or occupied listener MUST refuse its dependent effect without overwriting the conflicting owner. |
| LO-12 | r7 | An uncertain native effect MUST retain its original operation identity and evidence rather than retrying with a new operation. |
| LO-13 | r7 | The operation MUST retain a recoverable prior configuration before replacing its own selected entries. |
| LO-14 | r14 | A route change MUST preserve local state, original journals, credentials, capability checks and peer identities. |
| LO-15 | r4, r5 | Local page load MUST NOT require public DNS, a remote machine, an online identity-provider round trip or mesh coordination. |
| LO-16 | r7 | A missing Windows Administrator token MUST be reported before any privileged Windows effect. |
| LO-17 | r7 | Ordinary ingress reconciliation MUST NOT stop WSL, switch NAT to mirrored networking or introduce a disk-maintenance operation. |
| LO-18 | r7 | A privileged native operation MUST receive the exact reviewed input and preserve its source identity through installed readback. |
| LO-19 | r6 | An offline endpoint with an expired or invalid certificate MUST fail honestly without disabling certificate verification. |
| LO-20 | r7 | Secrets MUST remain outside source, command arguments, configuration receipts and ordinary logs. |

## 3. Receiving matrix

The customer-facing native receiving must include every row. An isolated
fixture is useful source evidence but cannot satisfy an installed row.

| Boundary | Ordinary case | Materially different valid case | Refusal or failure case |
| --- | --- | --- | --- |
| Canonical identity | Same domain reaches original WSL instance | Real Tailnet peer reaches same instance | Alternate public edge cannot forward original Host/SNI |
| Windows local route | System resolver and HTTPS client use local endpoint | Repeat while Internet is unavailable | Missing elevation leaves mappings unchanged |
| WSL local route | System resolver and HTTPS client use loopback | Repeat after ordinary WSL startup | Generated hosts cannot silently erase selection |
| Mesh boundary | Authorized peer reaches selected endpoint | Another permitted peer under current policy | Non-Tailnet LAN and public clients cannot reach instance |
| TLS | Actual browser trusts canonical hostname | Existing certificate works during connectivity loss | Wrong hostname, expiry or missing key never triggers bypass |
| Reconciliation | Scoped apply installs received configuration | Converged apply performs no effects | Concurrent edit, symlink/reparse redirection or ambiguity refuses |
| Recovery | Known failed effect restores qualified prior selection | Repeated read observes same terminal state | Unknown outcome retains custody; no blind replay |
| Authentication boundary | Existing authorized session retains its identity | Future local passkey sign-in uses same realm | Network presence alone never enrolls a credential or grants an office |
| Federation | Original peer addresses and authorities remain | Disconnected peer retains its treaty/identity | No journal merge or implicit cross-peer authority |

Freshness and timeout limits, source/file bounds, mutex identity, retention,
native provider versions, privilege carriers and precise rollback predicates
are design obligations. They MUST be sourced from measured receiving and
existing owner contracts rather than fabricated here.

### 3.1 Additional served names (`routes`)

A declaration serves one name by default: its `hostname`, proxied to its
`upstream`. The optional `parameters.localOrigin.routes` array lets the same
origin serve further names, for example a node's package registry. Each entry
is an object of exactly these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `hostname` | yes | Canonical DNS name, validated by the same rule as the primary `hostname`. |
| `upstream` | yes | Loopback HTTP URL, validated by the same rule as the primary `upstream` (`http://127.0.0.1:<port>`, port 1 to 65535). |
| `requestBodyMaxSize` | no | Caddy request body limit matching `^[1-9][0-9]{0,5}(KB\|MB\|GB)$`, such as `64MB`. |

Validation refuses, with a `local origin refused` error: a `routes` value that
is not an array, an entry that is not an object, an unknown entry field, an
entry whose `hostname`, `upstream` or `requestBodyMaxSize` fails its rule, and a
`hostname` that duplicates another route or the primary `hostname`. A missing or
empty `routes` behaves exactly as a declaration without the field.

Rendering. The Caddyfile keeps its single global options block. After the
primary site block it carries one site block per route, in declaration order.
Each has the same `bind 127.0.0.1` and the same `tls { dns cloudflare ...
resolvers ... }` as the primary and proxies to its own `upstream`. A route with
`requestBodyMaxSize` also carries a `request_body { max_size <size> }` block
before `reverse_proxy`; a route without it carries none. With no routes the
rendered Caddyfile is byte-identical to the single-name rendering.

Hosts. The managed hosts block maps every served name, primary first and then
each route in order, to 127.0.0.1, one line per name. The refusal of a
competing hostname mapping outside the owned block covers every served name,
so a route name already mapped elsewhere in the hosts file is refused and the
file is left unchanged. A managed block written before routes existed is
rewritten in place to the full set of served names. With no routes the block is
unchanged.

The Windows resolver script is not changed by `routes`: it still maps the
primary `hostname` only.

## 4. Architecture inputs, not an admitted architecture

The existing Windows Tailscale node and WSL NAT boundary are the observed
incumbents. Microsoft's NAT documentation permits Windows-to-WSL localhost
access. The current host record deliberately retains NAT after an observed
mirrored-networking failure; this proposal retains that constraint.

Tailscale's HTTPS Serve names are limited to the Tailnet's ts.net domain.
Its raw TCP forwarding is a candidate transport for end-to-end custom-domain
TLS. A local TLS endpoint plus independently managed name mappings is one
candidate; the installed 443 binding, Windows forwarding interaction and
restart behavior still need native qualification.

Caddy is already used by another Group host. DNS-01 can obtain a publicly
trusted custom-domain certificate without exposing an origin port. The
observed Cold Red Gate Caddy binary lacks the Cloudflare DNS module: it is
not a qualified DNS-01 provider for this host. No binary, plugin, CA account,
DNS token, certificate or deployment is selected by this proposal.

A second Linux Tailscale daemon, custom DNS daemon, mirrored networking,
self-signed browser exception, browser command-line host override, public
relay, and remote-only certificate broker each create additional dependencies
or fail an original requirement. Evaluate actual alternatives during the
architecture admission; do not introduce a custom reverse proxy or ACME client.

Public DNS removal alone is insufficient privacy: receive the old tunnel
route independently. Cached DNS may persist. Retain the private canonical
identity rather than renaming Actors to transport addresses.

## 5. Cutover and original dependent consumers

Before selecting an operating change, receive the private listener, trusted
TLS and both local paths. Then receive a genuine Tailnet peer. Only the
original ingress owner may retire its public route; verify refusal through
the old route as well as the new DNS answer. A terminal or unknown cutover
must preserve the last qualified recovery inputs and original state.

Cloud-hosted connectors that currently reach the public origin will lose that
route. The Leader's Tailnet-only requirement applies to them too. A future
relay or public discovery surface requires separate explicit authority.
Cold Red Gate is an observed Tailnet member, but peer connectivity does not
establish application-level federation receiving.

The current WSL service must not be extended with inert declaration fields,
boot-command shell scripts or an unrelated timer that writes hosts files.
Reusable executable behavior belongs to its Engineering owner and must pass
the existing requirements/specification/architecture/design/native-fabrication
chain. Particular hostnames, ports, addresses and credential references belong
to the original operations-owned host records after their consumers exist.

## 6. Normative source references and limits

- [BCP 14 requirements language](https://www.rfc-editor.org/rfc/rfc8174).
- [WSL NAT localhost access](https://learn.microsoft.com/en-us/windows/wsl/networking).
- [WSL generateHosts behavior](https://learn.microsoft.com/en-us/windows/wsl/wsl-config).
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).
- [Tailscale raw TCP forwarding](https://tailscale.com/docs/reference/tailscale-cli/serve).
- [Caddy DNS challenge](https://caddyserver.com/docs/automatic-https#dns-challenge).
- [Cloudflare DNS module's credential contract](https://github.com/caddy-dns/cloudflare).

These are applicability inputs, not a claim of installed conformance. The
proposal contains no implementation, accepted architecture, fabricated source,
actual certificate, operating cutover or independent customer receipt.
