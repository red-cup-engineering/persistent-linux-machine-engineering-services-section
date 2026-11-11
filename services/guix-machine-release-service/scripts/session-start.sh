#!/bin/bash
# House session start: give every Claude Code cloud session what it needs to test and merge its own work
# the way the machines receive it. Each repository's .claude/hooks/session-start.sh is a shim that fetches
# this controller and runs this script (scripts/project-session-bootstrap.mjs writes the shim), so there is
# one session start for the whole estate. Idempotent; only stdout is the hook's JSON answer.
#
#   session-start.sh MACHINE                 as a SessionStart hook (the shim runs it)
#   session-start.sh --install-user MACHINE  from an environment setup script, for a repository that ignores .claude:
#                                            installs the hook and the receive-change skill at user level, so the
#                                            session starts the same way without committing .claude.
#
# MACHINE is the repository (OWNER/REPO) that holds the machine definition the session's changes are tested against
# (its machine.json); without it the session gets the house rules and no change test.
set -euo pipefail
HOUSE="$HOME/.cache/561-group"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mkdir -p "$HOUSE"

machine_repository="${HOUSE_MACHINE_REPOSITORY:-}"
if [ "${1:-}" = "--install-user" ]; then
  machine_repository="${2:-$machine_repository}"
  mkdir -p "$HOME/.claude/skills/receive-change"
  cp "$here/session/receive-change/SKILL.md" "$HOME/.claude/skills/receive-change/SKILL.md"
  node_bin=$(ls -d /opt/nvm/versions/node/v24.*/bin 2>/dev/null | sort -V | tail -1 || true)
  install -m 755 "$here/session/session-start-shim.sh" "$HOUSE/session-start-shim.sh"
  "${node_bin:+$node_bin/}node" "$here/scripts/project-session-bootstrap.mjs" --user "$HOME/.claude/settings.json" "bash $HOUSE/session-start-shim.sh${machine_repository:+ $machine_repository}"
  exit 0
fi

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
machine_repository="${1:-$machine_repository}"
machine_directory="$HOUSE/machines/${machine_repository//\//__}"
project="${CLAUDE_PROJECT_DIR:-$PWD}"
# This repository as OWNER/REPO, read from its remote (a proxy URL keeps the path's last two segments).
repository=$(git -C "$project" remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#^.*[/:]([^/:]+/[^/]+)$#\1#' || true)

# Node 24: the house packages need 22.18 or later, and the cloud image ships 24 under nvm.
node_bin=$(ls -d /opt/nvm/versions/node/v24.*/bin 2>/dev/null | sort -V | tail -1 || true)
if [ -n "$node_bin" ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$node_bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

# House package scopes resolve anonymously from the Group's registry.
for scope in 561-group causeway-services coesite-operations emsenn emsweb harmonious-union koios-news \
             lenticule-science red-cup-engineering red-cup-science rsc-quiescent turntide-islands union-officer-academy; do
  grep -qs "^@$scope:registry=" "$HOME/.npmrc" || echo "@$scope:registry=https://registry.561.group/" >> "$HOME/.npmrc"
done

# The release controller (its change test) and the machine repository it composes against, when this
# session can read them. A repository the session was not started with is reported, not fatal. The shim
# has already refreshed the controller this script runs from.
missing=""
fetch() {
  if [ -d "$2/.git" ]; then
    { git -C "$2" fetch -q --depth=50 origin main && git -C "$2" checkout -q --detach FETCH_HEAD; } >&2 2>&1 || true
  elif ! git clone -q --depth=50 "https://github.com/$1.git" "$2" >&2 2>&1; then
    missing="$missing $1"
  fi
}
[ "${HOUSE_CONTROLLER_FRESH:-}" = "1" ] || fetch red-cup-engineering/guix-machine-release-service "$HOUSE/controller"
[ -z "$machine_repository" ] || fetch "$machine_repository" "$machine_directory"
[ -d "$HOUSE/controller/.git" ] || missing="$missing red-cup-engineering/guix-machine-release-service"
# The change test runs with the controller commit the machine pins, so a session builds exactly what the machine
# builds; this controller (main) keeps only the session start. Falls back to main when the pin cannot be read.
machine_controller="$HOUSE/controller" machine_controller_commit=""
# The machine releases from its own repository and the repositories it mounts (source-pins.mjs reads them).
machine_sources=""
if [ -f "$machine_directory/machine.json" ] && [ -d "$HOUSE/controller/.git" ]; then
  machine_sources=$("${node_bin:+$node_bin/}node" "$HOUSE/controller/scripts/source-pins.mjs" "$machine_directory" 2>/dev/null || true)
fi
if [ -n "$machine_sources" ]; then
  machine_controller_commit=$("${node_bin:+$node_bin/}node" -e '
    const pin=JSON.parse(process.argv[1]).repositories.find(r=>r.repository==="red-cup-engineering/guix-machine-release-service");
    if(pin&&/^[0-9a-f]{40}$/.test(pin.commit))console.log(pin.commit);' "$machine_sources" 2>/dev/null || true)
  if [ -n "$machine_controller_commit" ]; then
    if { git -C "$HOUSE/controller" fetch -q --depth=1 origin "$machine_controller_commit" &&
         if [ -d "$HOUSE/machine-controller/.git" ] || [ -f "$HOUSE/machine-controller/.git" ]; then
           git -C "$HOUSE/machine-controller" checkout -q --detach "$machine_controller_commit"
         else
           git -C "$HOUSE/controller" worktree add -q --detach "$HOUSE/machine-controller" "$machine_controller_commit"
         fi; } >&2 2>&1; then
      machine_controller="$HOUSE/machine-controller"
    else machine_controller_commit=""; fi
  fi
fi
# The change test clones every repository the machine pins; name the ones this session cannot read yet.
if [ -n "$machine_sources" ]; then
  unreadable=$("${node_bin:+$node_bin/}node" -e 'for(const r of JSON.parse(process.argv[1]).repositories)console.log(r.repository)' "$machine_sources" 2>/dev/null |
    xargs -r -P 8 -I{} sh -c 'timeout 20 git ls-remote -q "https://github.com/{}.git" HEAD >/dev/null 2>&1 || echo {}' | sort | tr '\n' ' ' || true)
  [ -z "$unreadable" ] || missing="$missing ${unreadable% }"
fi

if [ -n "$machine_controller_commit" ]; then controller_label="the release controller at ${machine_controller_commit:0:7}, the commit ${machine_repository} pins"
else controller_label="the release controller's main: the controller ${machine_repository:-no machine} pins could not be read"; fi
if [ -n "$machine_repository" ]; then
  change_test="- Test with the real dependencies, never stand-ins: commit, then run
  node $machine_controller/scripts/test-change.mjs $machine_directory $HOUSE/test-change ${repository:-OWNER/REPO}=$project
  ($controller_label)
  It composes the machine's workspace with your commit, installs from https://registry.561.group/, builds, and reports only the failures your change introduced. Node 24 is on PATH. The receive-change skill has the steps."
else
  change_test="- This session start was given no machine repository, so there is no change test to run here: start sessions with the repository that holds the machine definition (session-start.sh OWNER/REPO)."
fi
context="561 Group house rules for ${repository:-this repository}.
- You receive your own work. Test the exact commit for real, record the result on the pull request, and merge it with a merge commit, then delete the branch; no office will do it for you. The machine's release controller then receives the merged commit (sealed-store tests, probe, live health, automatic recovery), and a failed receipt reopens the work. Never wait on a receiving office.
$change_test
- Everything is signed, cell-typed data: use the house machinery (@red-cup-engineering/signcell predication cells, @red-cup-engineering/semiotic-eavt-services-section witness journals); never invent a new record format.
- Search the estate before writing anything new; extend and activate what exists, legacy code included, and never delete a capability.
- Governance and orchestration are running systems, never prose rules standing in for them.
- Only real-money risk, credentials and calls the founder has reserved go to the founder: name them once and keep working on everything else.
- Report in plain terms: what you did, what is next, and what is blocked on whom."
if [ -n "$missing" ]; then
  context="$context
- This session cannot read:$missing. Attach them (add_repo) before running the change test."
fi
"${node_bin:+$node_bin/}node" -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:process.argv[1]}}))' "$context"
