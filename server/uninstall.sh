#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$HOME/.open-speechy"
PLIST_PATH="$HOME/Library/LaunchAgents/dev.openspeechy.server.plist"

if [[ -f "$PLIST_PATH" ]]; then
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
  launchctl enable "gui/$(id -u)/dev.openspeechy.server" >/dev/null 2>&1 || true
  rm "$PLIST_PATH"
  echo "The LaunchAgent was removed."
fi

if [[ -f "$BASE_DIR/server/native_host_manifest.py" ]]; then
  python3 "$BASE_DIR/server/native_host_manifest.py" uninstall "$BASE_DIR" >/dev/null
  echo "The extension helper was unregistered."
fi
if [[ -f "$BASE_DIR/server.pid" ]]; then
  kill -TERM -- "-$(cat "$BASE_DIR/server.pid")" 2>/dev/null || true
  rm -f "$BASE_DIR/server.pid"
fi

echo "The server environment, token, and any model cache were left in ~/.open-speechy."
echo "Remove that directory yourself only if you also want to delete those local files."
