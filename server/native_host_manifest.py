"""Register or remove the native messaging host with Chromium-based browsers.

Usage: python native_host_manifest.py install|uninstall BASE_DIR

The installers run this. It writes a launcher for native_host.py and a host
manifest that lets the Open Speechy extension start it. Standard library only,
so the uninstallers can run it with any Python 3.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path

HOST_NAME = "dev.openspeechy.host"
# Fixed by the "key" in wxt.config.ts. A store build has its own ID, which can
# be added through OPEN_SPEECHY_EXTENSION_IDS (comma separated).
DEV_EXTENSION_ID = "bomfkndoodmcdkcemfdncddboldmlcna"
EXTENSION_ID = re.compile(r"[a-p]{32}")

# Chrome reads user-level hosts from NativeMessagingHosts in each browser's
# user data directory. The first entry is always written.
MAC_BROWSERS = (
    "Google/Chrome",
    "Google/Chrome Beta",
    "Google/Chrome Dev",
    "Google/Chrome Canary",
    "Google/Chrome for Testing",
    "Chromium",
    "BraveSoftware/Brave-Browser",
    "Microsoft Edge",
    "Vivaldi",
    "Arc/User Data",
)
LINUX_BROWSERS = (
    "google-chrome",
    "google-chrome-beta",
    "google-chrome-unstable",
    "chromium",
    "BraveSoftware/Brave-Browser",
    "microsoft-edge",
    "vivaldi",
)
WINDOWS_REGISTRY_KEYS = (
    r"Software\Google\Chrome\NativeMessagingHosts",
    r"Software\Chromium\NativeMessagingHosts",
    r"Software\Microsoft\Edge\NativeMessagingHosts",
    r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
)


def allowed_extension_ids(base_dir: Path, environ: dict[str, str]) -> list[str]:
    ids = [DEV_EXTENSION_ID]
    ids += environ.get("OPEN_SPEECHY_EXTENSION_IDS", "").split(",")
    paired = base_dir / "extension-id"
    if paired.exists():
        ids.append(paired.read_text(encoding="utf-8"))
    ids = [value.strip() for value in ids]
    return [value for value in dict.fromkeys(ids) if EXTENSION_ID.fullmatch(value)]


def write_launcher(base_dir: Path, platform: str) -> Path:
    server_dir = base_dir / "server"
    if platform == "win32":
        python = server_dir / ".venv" / "Scripts" / "python.exe"
        launcher = base_dir / "native-host.bat"
        launcher.write_text(
            f'@echo off\r\ncd /d "{base_dir}"\r\n"{python}" -m server.native_host %*\r\n',
            encoding="utf-8",
        )
        return launcher
    python = server_dir / ".venv" / "bin" / "python"
    launcher = base_dir / "native-host"
    launcher.write_text(
        "#!/bin/sh\n"
        f"cd {shlex.quote(str(base_dir))} || exit 1\n"
        f'exec {shlex.quote(str(python))} -m server.native_host "$@"\n',
        encoding="utf-8",
    )
    launcher.chmod(0o700)
    return launcher


def manifest_for(launcher: Path, extension_ids: list[str]) -> dict[str, object]:
    return {
        "name": HOST_NAME,
        "description": "Open Speechy local server helper",
        "path": str(launcher),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{value}/" for value in extension_ids],
    }


def browser_directories(home: Path, platform: str, environ: dict[str, str]) -> list[Path]:
    if platform == "darwin":
        root = home / "Library" / "Application Support"
        names = MAC_BROWSERS
    else:
        root = Path(environ.get("XDG_CONFIG_HOME") or home / ".config")
        names = LINUX_BROWSERS
    directories = [root / name for name in names]
    return [directories[0], *[path for path in directories[1:] if path.is_dir()]]


def install(
    base_dir: Path,
    home: Path,
    platform: str = sys.platform,
    environ: dict[str, str] | None = None,
) -> list[str]:
    environ = dict(os.environ) if environ is None else environ
    launcher = write_launcher(base_dir, platform)
    manifest = manifest_for(launcher, allowed_extension_ids(base_dir, environ))
    text = json.dumps(manifest, indent=2) + "\n"
    if platform == "win32":
        manifest_path = base_dir / f"{HOST_NAME}.json"
        manifest_path.write_text(text, encoding="utf-8")
        import winreg

        for key in WINDOWS_REGISTRY_KEYS:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"{key}\{HOST_NAME}") as handle:
                winreg.SetValue(handle, "", winreg.REG_SZ, str(manifest_path))
        return [str(manifest_path)]
    written = []
    for directory in browser_directories(home, platform, environ):
        target = directory / "NativeMessagingHosts" / f"{HOST_NAME}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        written.append(str(target))
    return written


def uninstall(
    base_dir: Path,
    home: Path,
    platform: str = sys.platform,
    environ: dict[str, str] | None = None,
) -> list[str]:
    environ = dict(os.environ) if environ is None else environ
    removed = []
    if platform == "win32":
        import winreg

        for key in WINDOWS_REGISTRY_KEYS:
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, rf"{key}\{HOST_NAME}")
            except FileNotFoundError:
                continue
            removed.append(key)
        paths = [base_dir / f"{HOST_NAME}.json", base_dir / "native-host.bat"]
    else:
        paths = [
            directory / "NativeMessagingHosts" / f"{HOST_NAME}.json"
            for directory in browser_directories(home, platform, environ)
        ]
        paths.append(base_dir / "native-host")
    for path in paths:
        if path.exists():
            path.unlink()
            removed.append(str(path))
    return removed


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] not in {"install", "uninstall"}:
        print(
            "Usage: python native_host_manifest.py install|uninstall BASE_DIR",
            file=sys.stderr,
        )
        return 2
    action = install if argv[0] == "install" else uninstall
    for location in action(Path(argv[1]).expanduser(), Path.home()):
        print(location)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
