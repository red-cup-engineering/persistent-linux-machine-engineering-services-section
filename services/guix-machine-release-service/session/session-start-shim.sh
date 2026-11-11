#!/bin/bash
# House session start shim. The session start itself is owned by red-cup-engineering/guix-machine-release-service
# (scripts/session-start.sh); this fetches that controller and runs it, so every repository starts the same way. Arguments (the machine repository)
# are passed on.
# Written by the controller's scripts/project-session-bootstrap.mjs; change the controller, not this copy.
set -uo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
controller="$HOME/.cache/561-group/controller"
mkdir -p "$(dirname "$controller")"
if [ -d "$controller/.git" ]; then
  { git -C "$controller" fetch -q --depth=50 origin main && git -C "$controller" checkout -q --detach FETCH_HEAD; } >&2 2>&1
else
  git clone -q --depth=50 https://github.com/red-cup-engineering/guix-machine-release-service.git "$controller" >&2 2>&1
fi
if [ -f "$controller/scripts/session-start.sh" ]; then HOUSE_CONTROLLER_FRESH=1 exec bash "$controller/scripts/session-start.sh" "$@"; fi
printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The 561 Group session start could not fetch its owner, red-cup-engineering/guix-machine-release-service. Attach it with add_repo, then run: bash ~/.cache/561-group/controller/scripts/session-start.sh"}}'
