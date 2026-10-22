#!/usr/bin/env bash
set -euo pipefail

PLIST_PATH="$HOME/Library/LaunchAgents/dev.openspeechy.server.plist"

if [[ -f "$PLIST_PATH" ]]; then
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
  rm "$PLIST_PATH"
fi

echo "The LaunchAgent was removed."
echo "The server environment, token, and any model cache were left in ~/.open-speechy."
echo "Remove that directory yourself only if you also want to delete those local files."
