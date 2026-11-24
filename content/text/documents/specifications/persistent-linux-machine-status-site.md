# bare-cedar-fog.561.group

An HTTP server for one host ("bare-cedar-fog"). It serves a Google OAuth-gated
status dashboard for that machine (load, memory, disk, running processes,
active systemd units, and recent Codex/Claude session activity), proxies
ActivityPub federation traffic and x402 metered-inference requests to local
provider processes running on the same host, and relays chat-style messages
to a local swarm-message service. It runs one mutable listener bound to
`127.0.0.1` and any number of read-only listeners for remote-facing
transports (e.g. a Cloudflare tunnel); write endpoints are refused outright
on the read-only listeners, before authentication is even checked.

## Install

```sh
npm install
```

## Run

```sh
npm run serve   # node src/server.mts
```

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1:19748` | Public-facing listener |
| `LOCAL_HOST` / `LOCAL_PORT` | `127.0.0.1:19749` | Machine-local (mutable) listener |
| `PRIVATE_RELAY_HOST` / `PRIVATE_RELAY_PORT` | unset | Optional extra read-only listener |
| `PUBLIC_BASE_URL` | `http://HOST:PORT` | External URL this server is reachable at |
| `BARE_CEDAR_FOG_ALLOWED_EMAIL` | `morgan.sennhauser@gmail.com` | Only Google account allowed to authenticate |
| `RUNTIME_NODE_NAME` | `unknown-runtime-node` | Node name reported in the machine graph |
| `BARE_CEDAR_FOG_STATE_DIR` | `./data/state/oauth` | Where OAuth token state is persisted |
| `SWARM_MESSAGE_PROVIDER_URL` | `http://127.0.0.1:8796/messages` | Loopback swarm-message backend |
| `COLONY_REPORT_PROVIDER_URL`, `UNION_REPORT_PROVIDER_URL` | unset | Upstream report sources for `/api/colony-report` and `/api/union-report` |
| `ACTIVITYPUB_PROVIDER_ROUTES` | unset | Comma-separated `actor:port` / `actor=https://host` bindings for the ActivityPub proxy |
| `X402_PROVIDER_ROUTES` | unset | Comma-separated `provider:port` bindings for the x402 proxy |

A systemd unit for running this as a service is in
`data/records/systemd/bare-cedar-fog-561-group.service`.

## Test

```sh
npm test    # node --test test/*.test.mts
npm run check   # tsc --noEmit
```

## API

All `/api/*` routes require a Google-OAuth bearer token for the allowed
account, except when reached through the machine-local listener, which
serves them unauthenticated.

- `GET /` — the dashboard page (sign-in gate, then the dashboard once authenticated).
- `GET /healthz` — `{ ok: true, colony: "bare-cedar-fog" }`.
- `GET /api/dashboard-fragment` — the authenticated dashboard's HTML fragment.
- `GET /api/fars/machine` — this host's health, processes, systemd units, and recent agent-session activity, as JSON.
- `GET /api/fars/graph` — the same data as raw resource-graph triples.
- `GET /api/dashboard-observation` — a status summary: whether the request arrived on the mutable or read-only face, whether a local OAuth session exists, and whether the configured peer status endpoint answered.
- `GET /api/colony-report` / `GET /api/union-report` — pass through JSON reports fetched from `COLONY_REPORT_PROVIDER_URL` / `UNION_REPORT_PROVIDER_URL`; `503` if unconfigured or unreachable.
- `POST /api/swarm/messages` — `{ "message": "<text>" }` (max 16000 bytes), forwarded to `SWARM_MESSAGE_PROVIDER_URL`. Mutable-face only.

Well-known endpoints:

- `GET /.well-known/agent-card.json` — this node's Codex agent card.
- `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource` — OAuth server metadata.
- `GET /.well-known/webfinger`, `GET /.well-known/nodeinfo`, `GET /nodeinfo/2.1` — proxied to the routed ActivityPub provider.

ActivityPub (proxied to the provider configured in `ACTIVITYPUB_PROVIDER_ROUTES`):

- `GET|HEAD|POST /actors/:actor`, `/actors/:actor/inbox`, `/actors/:actor/outbox`
- `POST /inbox` — shared inbox; routes by the activity's `to`/`cc` recipients.
- `GET|HEAD|POST /activities/:a/:b/:c`

x402 metered inference (proxied to the provider configured in `X402_PROVIDER_ROUTES` or the tollbooth port):

- `POST /compute/inference`, `GET /compute/status`, `POST /compute/occupation-entropy`
- `GET|POST /x402/:provider/offer|invoke|result/:id|recover/:id`
- A fixed set of brokerage routes under `/v1/...` and `/.well-known/brokerage-products`
