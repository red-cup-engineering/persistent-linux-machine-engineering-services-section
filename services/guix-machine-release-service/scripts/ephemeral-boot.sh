#!/bin/bash
# Ephemeral boot: bring back a machine that has no standing host for a release runner, such as a
# colony in a Claude Code cloud environment. Its container is provisioned fresh, its PID 1 is not
# systemd, and no process outlives the session. Run it from this controller, checked out at the
# commit the machine repository's gitlink records:
#
#   scripts/ephemeral-boot.sh SNAPSHOT [--no-release]
#
# Every stage is idempotent, and a machine already healthy at the snapshot's commit is left running.
# The environment may supply GUIX_MACHINE_SYSTEM_NODE_KEY (the node's identity key, as PEM or its
# one-line base64 body; without it a new key is generated, and the machine returns as a peer its
# peers do not know), GUIX_MACHINE_AGENCY
# (authored agency to link as the state's agency root), GUIX_MACHINE_CA_BUNDLE (the egress
# proxy's CA bundle) and TS_AUTHKEY (a Tailscale OAuth client secret, which never expires, or an auth
# key; with it the machine joins the Group's tailnet while present, so a peer's ingress can reach it;
# without it the machine is outbound only; it also comes from the credential store), and GUIX_MACHINE_CREDENTIALS
# (a checkout of the Group's credential store section, whose credentials for this machine it renders).
#
# The release is local: it runs this controller's own stages (resolve, assemble, seal, receive) under
# the snapshot's committed identity, but it is not an admitted main-merge deployment. That remains
# the deploy mode of github-machine-release.scm.
set -euo pipefail
{ [ $# -ge 1 ] && [ -d "$1" ]; } || { echo "usage: ephemeral-boot.sh SNAPSHOT [--no-release]" >&2; exit 2; }
SNAPSHOT=$(cd "$1" && pwd)
SERVICE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CA_BUNDLE=${GUIX_MACHINE_CA_BUNDLE:-/root/.ccr/ca-bundle.crt}
GUIX=$HOME/.config/guix/current
GUIX_TARBALL=guix-binary-1.5.0.x86_64-linux.tar.xz
# Verified against the release signature (Efraim Flashner, A28BF40C3E551372662D14F741AAE7DCCA3D8351).
GUIX_SHA256=aa41025489c5061543e9c48873eaa829b900b2da75d40f9648913622f5f47817
TAILSCALE_VERSION=1.104.1
DNS_RECONCILER_VERSION=0.3.0
# Published by pkgs.tailscale.com beside the release (tailscale_1.104.1_amd64.tgz.sha256).
TAILSCALE_SHA256=108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528
SUPERVISOR=/var/guix/profiles/per-user/$(id -un)/lagoon-supervisor
LOGS=/var/log/561-group
export PATH=$SUPERVISOR/bin:$GUIX/bin:$PATH SSL_CERT_DIR=/etc/ssl/certs GIT_SSL_CAINFO=$CA_BUNDLE GUIX_LOCPATH=$GUIX/lib/locale
umask 022
mkdir -p "$LOGS"
say() { printf '== %s\n' "$*"; }
refuse() { echo "ephemeral-boot: $*" >&2; exit 1; }
until_ready() { local i; for i in $(seq 180); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; "$@"; }
pinned() { guix time-machine -C "$SNAPSHOT/channels.scm" -- "$@"; }

# --- Guix: the verified binary release, its daemon run without systemd, substitutes through the proxy.
if [ ! -x "$GUIX/bin/guix" ]; then
  say "install Guix 1.5.0"
  tarball=$(mktemp -d)/$GUIX_TARBALL
  curl -sS -fL -o "$tarball" "https://ftp.gnu.org/gnu/guix/$GUIX_TARBALL"
  echo "$GUIX_SHA256  $tarball" | sha256sum -c --quiet -
  [ -d /gnu/store ] || tar --warning=no-timestamp -xf "$tarball" -C /
  rm -f "$tarball"
  mkdir -p "$(dirname "$GUIX")"
  ln -sfn "/var/guix/profiles/per-user/$(id -un)/current-guix" "$GUIX"
fi
getent group guixbuild >/dev/null || groupadd --system guixbuild
for i in $(seq -w 1 10); do
  id "guixbuilder$i" >/dev/null 2>&1 ||
    useradd -g guixbuild -G guixbuild -d /var/empty -s "$(command -v nologin)" -c "Guix build user $i" --system "guixbuilder$i"
done
if ! pgrep -x guix-daemon >/dev/null; then
  say "start guix-daemon"
  env https_proxy="${HTTPS_PROXY:-}" http_proxy="${HTTPS_PROXY:-}" SSL_CERT_FILE="$CA_BUNDLE" \
    nohup "$GUIX/bin/guix-daemon" --build-users-group=guixbuild \
    --substitute-urls="https://bordeaux.guix.gnu.org https://ci.guix.gnu.org" > "$LOGS/guix-daemon.log" 2>&1 &
  until_ready test -S /var/guix/daemon-socket/socket
  guix archive --authorize < "$GUIX/share/guix/ci.guix.gnu.org.pub"
  guix archive --authorize < "$GUIX/share/guix/bordeaux.guix.gnu.org.pub"
fi

# --- The machine, read with the pinned channel's Node; this controller must be the one it pins.
NODE=$(pinned build node | grep -E -- '-node-[0-9.]+$')/bin/node
machine() { "$NODE" -e 'const v=require(process.argv[1])[process.argv[2]];if(v!==undefined)console.log(v)' "$SNAPSHOT/machine.json" "$1"; }
# The machine releases from its own repository and the repositories it mounts; the controller is one of them.
resolved_sources=$("$NODE" "$SERVICE/scripts/source-pins.mjs" "$SNAPSHOT") || refuse "the machine's sources do not resolve from its repository and its gitlinks"
read -r owner_commit owner_path < <("$NODE" -e '
  const spec=JSON.parse(process.argv[1]);
  const pinned=(spec.repositories||[]).filter((source)=>source.repository==="red-cup-engineering/guix-machine-release-service");
  if(pinned.length!==1)throw new Error("the machine repository must mount the release controller exactly once");
  console.log(pinned[0].commit,".");' "$resolved_sources")
[ "$(git -C "$SERVICE" rev-parse HEAD)" = "$owner_commit" ] && git -C "$SERVICE" diff --quiet HEAD &&
  [ "$(realpath "$(git -C "$SERVICE" rev-parse --show-toplevel)/$owner_path")" = "$SERVICE" ] ||
  refuse "run this boot from the release controller at the commit the machine pins, $owner_commit"
[ "$(machine supervisor)" = shepherd ] || refuse "only a machine received under GNU Shepherd boots ephemerally"
NAME=$(machine name)
STATE=$(machine stateRoot)
ENV_FILE=$(machine environmentFile)
SOCKET=$(machine supervisorSocket)
SOCKET=${SOCKET:-/var/run/shepherd/socket}
WORK=$HOME/.cache/561-group/ephemeral-boot/$NAME
mkdir -p "$WORK"

# --- Supervisor: GNU Shepherd from the machine's own pinned channel.
if [ ! -x "$SUPERVISOR/bin/shepherd" ]; then
  say "install GNU Shepherd from the pinned channel"
  pinned package -p "$SUPERVISOR" -i shepherd > "$LOGS/boot-supervisor.log" 2>&1
fi
if ! herd -s "$SOCKET" status >/dev/null 2>&1; then
  say "start GNU Shepherd"
  mkdir -p "$HOME/.config/shepherd" "$(dirname "$SOCKET")"
  [ -f "$HOME/.config/shepherd/init.scm" ] ||
    printf ';;; Machine generations are registered by `herd load root FILE`.\n(register-services (list))\n' > "$HOME/.config/shepherd/init.scm"
  nohup shepherd --config="$HOME/.config/shepherd/init.scm" --socket="$SOCKET" --logfile="$LOGS/shepherd.log" \
    > "$LOGS/shepherd.stdout" 2>&1 &
  until_ready herd -s "$SOCKET" status
fi

# --- Registries: deployment/registry.json is the machine's one registry declaration (the same file the
# registry server reads): its "origin" and "privateScopes" route those scopes to that origin (anonymous
# reads). A machine that declares none routes none; no scope is assumed for it.
REGISTRY=$SNAPSHOT/deployment/registry.json
if [ -s "$REGISTRY" ]; then
  routes=$("$NODE" -e '
    const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    if(typeof r.origin!=="string"||!/^https:\/\/[^\s/]+\/?$/.test(r.origin)||!Array.isArray(r.privateScopes)||!r.privateScopes.every((s)=>typeof s==="string"&&/^@[a-z0-9][a-z0-9._-]*$/.test(s))){
      console.error("deployment/registry.json needs an https origin and a list of @scope names in privateScopes");process.exit(1)}
    const url=r.origin.endsWith("/")?r.origin:r.origin+"/";
    for(const s of r.privateScopes)console.log(`${s}:registry=${url}`)' "$REGISTRY") || refuse "deployment/registry.json is not a registry declaration"
  while read -r line; do
    [ -z "$line" ] || grep -qsxF "$line" "$HOME/.npmrc" || echo "$line" >> "$HOME/.npmrc"
  done <<< "$routes"
fi

# --- Private state and the private environment file. None of it is in any repository.
umask 077
mkdir -p "$STATE" "$(dirname "$ENV_FILE")"
[ -s "$STATE/session-secret" ] || head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$STATE/session-secret"
if [ ! -s "$STATE/system-node-key.pem" ]; then
  if [ -n "${GUIX_MACHINE_SYSTEM_NODE_KEY:-}" ]; then
    # A PEM, or its one-line base64 body: an environment's variables hold single lines.
    case $GUIX_MACHINE_SYSTEM_NODE_KEY in
      *-----BEGIN*) printf '%s\n' "$GUIX_MACHINE_SYSTEM_NODE_KEY" ;;
      *) printf -- '-----BEGIN PRIVATE KEY-----\n%s\n-----END PRIVATE KEY-----\n' "$GUIX_MACHINE_SYSTEM_NODE_KEY" ;;
    esac > "$STATE/system-node-key.pem.new"
    openssl pkey -in "$STATE/system-node-key.pem.new" -noout 2>/dev/null ||
      { rm -f "$STATE/system-node-key.pem.new"; refuse "GUIX_MACHINE_SYSTEM_NODE_KEY is not a private key"; }
    mv "$STATE/system-node-key.pem.new" "$STATE/system-node-key.pem"
  else
    openssl genpkey -algorithm ed25519 -out "$STATE/system-node-key.pem"
    echo "ephemeral-boot: no GUIX_MACHINE_SYSTEM_NODE_KEY; this container's node key is new" >&2
  fi
fi
openssl pkey -in "$STATE/system-node-key.pem" -pubout > "$STATE/system-node-key.pub.pem"
if [ -n "${GUIX_MACHINE_AGENCY:-}" ] && [ -d "$GUIX_MACHINE_AGENCY" ] && [ ! -e "$STATE/agency" ]; then
  ln -s "$GUIX_MACHINE_AGENCY" "$STATE/agency"
fi
{
  printf 'SESSION_SECRET=%s\n' "$(cat "$STATE/session-secret")"
  for key in HTTPS_PROXY https_proxy NO_PROXY no_proxy; do
    if [ -n "${!key:-}" ]; then printf '%s=%s\n' "$key" "${!key}"; fi
  done
  printf 'SYSTEM_NODE_KEY=%s\n' "$STATE/system-node-key.pem"
  printf 'CREDENTIAL_GAPS_FILE=%s\n' "$STATE/credential-gaps.json"
  printf 'NODE_USE_ENV_PROXY=1\nNODE_EXTRA_CA_CERTS=%s\nSSL_CERT_FILE=%s\n' "$CA_BUNDLE" "$CA_BUNDLE"
} > "$ENV_FILE.new"
mv "$ENV_FILE.new" "$ENV_FILE"
umask 022

# --- Credentials: with GUIX_MACHINE_CREDENTIALS (a checkout of the Group's credential store section), the machine is a
# host of the store under its own name. A machine new to the store makes its identity (which never leaves it) and
# pushes its public recipient; holders reseal its grants on their next pull. What the store holds for it renders into
# its private state, as other hosts render into runtime memory, so its tailnet secret and its DNS token come from the
# network's own credentials, not from a person.
CREDENTIALS=$STATE/credentials
# A credential that cannot be had is a gap, never a refusal: the boot goes on, the machine starts with what
# rendered, and each gap is named here (a file the node's health and the boot receipt read) so only the
# features that need it degrade. Messages carry no values.
GAPS=$STATE/credential-gaps.json
: > "$GAPS.lines"
gap() { echo "ephemeral-boot: credential gap: $1: $2" >&2; printf '%s\t%s\n' "$1" "$2" >> "$GAPS.lines"; }
if [ -n "${GUIX_MACHINE_CREDENTIALS:-}" ] && [ -x "$GUIX_MACHINE_CREDENTIALS/bin/credentials" ]; then
  say "render this machine's credentials from the store"
  export CREDENTIALS_HOST=$NAME
  git -C "$GUIX_MACHINE_CREDENTIALS" pull -q --ff-only 2>/dev/null || echo "ephemeral-boot: credential store not refreshed" >&2
  if [ ! -s "$GUIX_MACHINE_CREDENTIALS/data/credentials/hosts/$NAME.identity" ]; then
    if "$GUIX_MACHINE_CREDENTIALS/bin/credentials" init-host > "$LOGS/boot-credentials.log" 2>&1; then
      git -C "$GUIX_MACHINE_CREDENTIALS" add data/credentials/recipients.json &&
        git -C "$GUIX_MACHINE_CREDENTIALS" -c user.name="$NAME" -c user.email=credential-custody@users.noreply.github.com           commit -q -m "Record $NAME's recipient (a new identity)" && git -C "$GUIX_MACHINE_CREDENTIALS" push -q ||
        gap store-recipient "$NAME's new recipient is not pushed; its grants open once it is"
    else
      gap store-identity "the store could not make $NAME's identity; see $LOGS/boot-credentials.log"
    fi
  fi
  "$GUIX_MACHINE_CREDENTIALS/bin/credentials" render-host --to "$CREDENTIALS" >> "$LOGS/boot-credentials.log" 2>&1 ||
    gap store-render "credentials not rendered; see $LOGS/boot-credentials.log"
else
  gap store "no credential store checkout (GUIX_MACHINE_CREDENTIALS)"
fi
credential() { [ -s "$CREDENTIALS/$1.env" ] && sed -n "s/^$2=//p" "$CREDENTIALS/$1.env" | head -1; }
[ -n "${TS_AUTHKEY:-}" ] || TS_AUTHKEY=$(credential tailnet TS_AUTHKEY || true)
[ -n "${TS_AUTHKEY:-}" ] || gap tailnet "no TS_AUTHKEY; the machine is outbound only"

# --- Tailnet: with TS_AUTHKEY, the verified Tailscale release joins the Group's tailnet in userspace
# networking (no TUN device, no systemd), its control and DERP traffic through the egress proxy.
# Inbound tailnet connections reach the machine's loopback listeners, so a peer's ingress fronts
# the machine's origin while it is present. Its tailnet identity is kept in the machine's state.
if [ -n "${TS_AUTHKEY:-}" ]; then
  TAILSCALE=$HOME/.local/share/561-group/tailscale-$TAILSCALE_VERSION
  TS_SOCKET=$STATE/tailscaled.sock
  if [ ! -x "$TAILSCALE/tailscaled" ]; then
    say "install Tailscale $TAILSCALE_VERSION"
    tarball=$(mktemp -d)/tailscale.tgz
    curl -sS -fL -o "$tarball" "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz"
    echo "$TAILSCALE_SHA256  $tarball" | sha256sum -c --quiet -
    mkdir -p "$TAILSCALE"
    tar -xzf "$tarball" -C "$TAILSCALE" --strip-components=1
    rm -f "$tarball"
  fi
  if ! "$TAILSCALE/tailscale" --socket="$TS_SOCKET" status >/dev/null 2>&1; then
    say "join the tailnet as $NAME"
    if ! pgrep -f "tailscaled .*--socket=$TS_SOCKET" >/dev/null; then
      env HTTPS_PROXY="${HTTPS_PROXY:-}" https_proxy="${HTTPS_PROXY:-}" SSL_CERT_FILE="$CA_BUNDLE" \
        nohup "$TAILSCALE/tailscaled" --tun=userspace-networking --state="$STATE/tailscaled.state" \
        --socket="$TS_SOCKET" --socks5-server=127.0.0.1:1055 > "$LOGS/tailscaled.log" 2>&1 &
      until_ready test -S "$TS_SOCKET"
    fi
    # An OAuth client secret (tskey-client-...) never expires: it registers each new container as an
    # ephemeral, pre-authorized node under its tags (TS_TAGS, default tag:colony), so nobody rotates
    # a key. A plain auth key is used as given.
    ts_key=$TS_AUTHKEY ts_tags=()
    case $ts_key in
      tskey-client-*) [[ $ts_key == *\?* ]] || ts_key="$ts_key?ephemeral=true&preauthorized=true"
                      ts_tags=(--advertise-tags="${TS_TAGS:-tag:colony}") ;;
    esac
    "$TAILSCALE/tailscale" --socket="$TS_SOCKET" up --auth-key="$ts_key" "${ts_tags[@]}" --hostname="$NAME" --accept-dns=false
  fi
fi

# --- DNS: a machine that declares its record (deployment/dns.json, the house DNS reconciler's input) and holds a token
# for it (the store's colony-dns credential) sets the record itself, through the Group registry's reconciler.
dns_token=$(credential colony-dns CLOUDFLARE_API_TOKEN || true)
if [ -s "$SNAPSHOT/deployment/dns.json" ] && [ -n "$dns_token" ]; then
  say "reconcile $NAME's DNS record"
  CLOUDFLARE_API_TOKEN=$dns_token NODE_EXTRA_CA_CERTS=$CA_BUNDLE "$(dirname "$NODE")/npm" --registry=https://registry.561.group/ exec --yes \
    --package=@red-cup-engineering/cloudflare-dns-record-reconciliation-service@$DNS_RECONCILER_VERSION -- \
    reconcile-cloudflare-dns-record < "$SNAPSHOT/deployment/dns.json" > "$LOGS/boot-dns.log" 2>&1 ||
    echo "ephemeral-boot: DNS record not reconciled; see $LOGS/boot-dns.log" >&2
fi
[ ! -s "$SNAPSHOT/deployment/dns.json" ] || [ -n "$dns_token" ] || gap colony-dns "no colony-dns token; the DNS record is not set"
unset dns_token
# The gaps, as the JSON the node's health and the boot receipt read: [{"credential":..., "reason":...}].
"$NODE" -e 'const fs=require("fs"),f=process.argv[1];const g=fs.readFileSync(f+".lines","utf8").split("\n").filter(Boolean).map((l)=>{const [credential,reason]=l.split("\t");return {credential,reason}});fs.writeFileSync(f+".new",JSON.stringify(g)+"\n")' "$GAPS"
mv "$GAPS.new" "$GAPS"; rm -f "$GAPS.lines"

[ "${2:-}" = --no-release ] && exit 0

# --- Release: the committed snapshot, resolved, assembled, sealed and received under Shepherd.
SHA=$(git -C "$SNAPSHOT" rev-parse HEAD)
REPOSITORY=$(machine repository)
HEALTH=$(machine health)
# A machine that is down answers nothing; that is the case a boot exists for, not a failure.
running=$({ curl -sS -m 5 "$HEALTH" 2>/dev/null || true; } | "$NODE" -e '
  let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{const h=JSON.parse(s);console.log(h.ok?h.release:"")}catch{console.log("")}})')
if [ "$running" = "$SHA" ]; then say "$NAME is running at $SHA"; exit 0; fi
git -C "$SNAPSHOT" diff --quiet HEAD || refuse "the machine snapshot has uncommitted changes"
TOOLS=(guile guile-json git-minimal node coreutils findutils sed grep tar gzip)

say "resolve $REPOSITORY@$SHA"
(cd "$WORK" && pinned shell "${TOOLS[@]}" -- \
  guile --no-auto-compile "$SERVICE/scripts/github-machine-release.scm" "$SNAPSHOT" "$WORK/resolve" resolve) > "$LOGS/boot-resolve.log" 2>&1
git -C "$SNAPSHOT" diff --quiet HEAD || refuse "resolving changed the reviewed dependency lock"

say "assemble"
BUILD=$WORK/build
rm -rf "$BUILD/workspace" "$BUILD/artifacts"
mkdir -p "$BUILD"
"$NODE" -e 'const fs=require("fs"),p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));p.output=process.argv[3];fs.writeFileSync(process.argv[2],JSON.stringify(p))' \
  "$WORK/resolve/prepare.json" "$BUILD/prepare.json" "$BUILD/workspace"
pinned shell "${TOOLS[@]}" -- bash -c '
  set -euo pipefail
  node "$1/scripts/prepare-sources.mjs" "$2/prepare.json"
  cp "$3/dependencies.lock.yaml" "$2/workspace/pnpm-lock.yaml"
  npm --registry=https://registry.npmjs.org/ exec --yes --package=pnpm@11.9.0 -- \
    pnpm --registry=https://registry.npmjs.org/ --dir "$2/workspace" install --frozen-lockfile --ignore-scripts --cache-dir "$2/registry-cache"
  GITHUB_SHA="$4" GITHUB_REPOSITORY="$5" node "$1/scripts/assemble.mjs" "$2/workspace" "$3" "$2/artifacts" > "$2/assembled.json"
' ephemeral-boot "$SERVICE" "$BUILD" "$SNAPSHOT" "$SHA" "$REPOSITORY" > "$LOGS/boot-assemble.log" 2>&1
CLOSURE=$("$NODE" -e 'console.log(require(process.argv[1]).closure)' "$BUILD/assembled.json")

say "seal $CLOSURE"
(cd "$SERVICE" && GITHUB_SHA="$SHA" guix repl -- "$SERVICE/scripts/guix-deployment.scm" build \
  "$SNAPSHOT/channels.scm" "$SERVICE/src" "$SNAPSHOT/machine.scm" "$CLOSURE" \
  "$(machine gcRoot)-$(date +%s)") 2> "$LOGS/boot-seal.log" | tail -1 > "$BUILD/candidate.json"
STORE=$("$NODE" -e 'console.log(require(process.argv[1]).storePath)' "$BUILD/candidate.json")
rm -rf "$CLOSURE" "$BUILD/workspace"

say "receive $STORE"
(cd "$SERVICE" && env GUIX_MACHINE_SNAPSHOT="$SNAPSHOT" GITHUB_SHA="$SHA" GITHUB_REPOSITORY="$REPOSITORY" \
  guix repl -- "$SERVICE/scripts/pinned-guix.scm" "$SNAPSHOT/channels.scm" shell guile guile-json -- \
  guile --no-auto-compile "$SERVICE/scripts/receive.scm" "$SNAPSHOT/machine.json" "$STORE") > "$LOGS/boot-receive.log" 2>&1
curl -sS -m 5 "$HEALTH"; echo
