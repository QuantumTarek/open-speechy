#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$HOME/.open-speechy"
SERVER_DIR="$BASE_DIR/server"

if ! command -v uv >/dev/null 2>&1; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "Install uv first: https://docs.astral.sh/uv/getting-started/installation/" >&2
    exit 1
  fi
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi

UV_PATH="$(command -v uv)"
mkdir -p "$BASE_DIR"
chmod 700 "$BASE_DIR"
mkdir -p "$SERVER_DIR"
cp -R "$SOURCE_DIR/." "$SERVER_DIR/"

uv sync --project "$SERVER_DIR" --python 3.11 --no-dev --extra engines
OPEN_SPEECHY_TOKEN_FILE="$BASE_DIR/token" \
  uv run --project "$SERVER_DIR" python "$SERVER_DIR/auth.py" >/dev/null

if [[ "$(uname -s)" == "Darwin" ]]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_PATH="$PLIST_DIR/dev.openspeechy.server.plist"
  mkdir -p "$PLIST_DIR"
  BASE_DIR="$BASE_DIR" SERVER_DIR="$SERVER_DIR" UV_PATH="$UV_PATH" \
    python3 - "$SOURCE_DIR/launchd/dev.openspeechy.server.plist" "$PLIST_PATH" <<'PY'
import os
import plistlib
import sys
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
with source.open("rb") as template_file:
    plist = plistlib.load(template_file)

replacements = {
    "__BASE_DIR__": os.environ["BASE_DIR"],
    "__SERVER_DIR__": os.environ["SERVER_DIR"],
    "__UV_PATH__": os.environ["UV_PATH"],
}

def replace(value):
    if isinstance(value, str):
        for marker, replacement in replacements.items():
            value = value.replace(marker, replacement)
        return value
    if isinstance(value, list):
        return [replace(item) for item in value]
    if isinstance(value, dict):
        return {key: replace(item) for key, item in value.items()}
    return value

with target.open("wb") as output_file:
    plistlib.dump(replace(plist), output_file)
PY
  chmod 600 "$PLIST_PATH"
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  echo "Open Speechy local server will start at login."
else
  echo "Server files are installed. Start it with:"
  printf '  (cd "%s" && uv run --project "%s" python -m server.app)\n' \
    "$BASE_DIR" "$SERVER_DIR"
fi

echo "Token file: $BASE_DIR/token"
echo "Open the extension settings, choose Local server, and pair with the code at:"
echo "  http://127.0.0.1:5123/pair"
