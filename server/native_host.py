"""Chrome native messaging host for the Open Speechy local server.

The extension calls this through chrome.runtime.sendNativeMessage to read the
server state, connect without a pairing code, and start or stop the server.
Chrome launches it only for the extension IDs in the host manifest that the
installer writes, so handing over the token here is safe.

Chrome reads replies from stdout, so nothing else may print there.
"""

from __future__ import annotations

import json
import os
import signal
import struct
import subprocess
import sys
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO, Protocol

from .auth import AuthManager

HOST_NAME = "dev.openspeechy.host"
SERVER_URL = "http://127.0.0.1:5123"
LAUNCH_AGENT_LABEL = "dev.openspeechy.server"
WINDOWS_TASK_NAME = "Open Speechy Local Server"
MAX_MESSAGE_BYTES = 64 * 1024
START_TIMEOUT_SECONDS = 30.0
STOP_TIMEOUT_SECONDS = 15.0

Runner = Callable[..., subprocess.CompletedProcess]
# os.killpg does not exist on Windows, where ProcessControl is not used.
KILL_GROUP: Callable[[int, int], None] = getattr(os, "killpg", os.kill)


class ServerControl(Protocol):
    def can_manage(self) -> bool: ...

    def start(self) -> None: ...

    def stop(self) -> None: ...


def run_quietly(*command: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        list(command),
        capture_output=True,
        text=True,
        check=False,
        stdin=subprocess.DEVNULL,
    )


class LaunchAgentControl:
    """macOS: the installer's LaunchAgent, which has KeepAlive set."""

    def __init__(self, home: Path, run: Runner = run_quietly) -> None:
        self._plist = home / "Library" / "LaunchAgents" / f"{LAUNCH_AGENT_LABEL}.plist"
        self._domain = f"gui/{os.getuid()}"
        self._service = f"{self._domain}/{LAUNCH_AGENT_LABEL}"
        self._run = run

    def can_manage(self) -> bool:
        return self._plist.exists()

    def start(self) -> None:
        self._run("launchctl", "enable", self._service)
        if self._run("launchctl", "print", self._service).returncode == 0:
            self._run("launchctl", "kickstart", self._service)
            return
        result = self._run("launchctl", "bootstrap", self._domain, str(self._plist))
        if result.returncode != 0:
            raise RuntimeError(
                (result.stderr or "").strip() or "launchctl could not start the server."
            )

    def stop(self) -> None:
        # KeepAlive restarts a killed server, so the agent is unloaded. Disabling
        # it also keeps it from starting at the next login until started here.
        self._run("launchctl", "disable", self._service)
        self._run("launchctl", "bootout", self._service)


class ScheduledTaskControl:
    """Windows: the installer's logon task."""

    def __init__(self, run: Runner = run_quietly) -> None:
        self._run = run

    def can_manage(self) -> bool:
        return self._run("schtasks", "/Query", "/TN", WINDOWS_TASK_NAME).returncode == 0

    def start(self) -> None:
        self._run("schtasks", "/Change", "/TN", WINDOWS_TASK_NAME, "/ENABLE")
        result = self._run("schtasks", "/Run", "/TN", WINDOWS_TASK_NAME)
        if result.returncode != 0:
            raise RuntimeError(
                (result.stderr or "").strip() or "The scheduled task could not start."
            )

    def stop(self) -> None:
        self._run("schtasks", "/End", "/TN", WINDOWS_TASK_NAME)
        self._run("schtasks", "/Change", "/TN", WINDOWS_TASK_NAME, "/DISABLE")


class ProcessControl:
    """Linux and others: a detached server process tracked by a PID file."""

    def __init__(
        self,
        base_dir: Path,
        python: str = sys.executable,
        popen: Callable[..., subprocess.Popen] = subprocess.Popen,
        kill_group: Callable[[int, int], None] = KILL_GROUP,
    ) -> None:
        self._base_dir = base_dir
        self._pid_file = base_dir / "server.pid"
        self._python = python
        self._popen = popen
        self._kill_group = kill_group

    def can_manage(self) -> bool:
        return (self._base_dir / "server" / "app.py").exists()

    def start(self) -> None:
        if self._running_pid() is not None:
            return
        with (
            open(self._base_dir / "server.log", "ab") as log,
            open(self._base_dir / "server-error.log", "ab") as error_log,
        ):
            process = self._popen(
                [self._python, "-m", "server.app"],
                cwd=self._base_dir,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=error_log,
                start_new_session=True,
            )
        self._pid_file.write_text(f"{process.pid}\n", encoding="utf-8")

    def stop(self) -> None:
        pid = self._running_pid()
        if pid is None:
            raise RuntimeError(
                "The server was not started from the extension. Stop it where it was started."
            )
        self._kill_group(pid, signal.SIGTERM)
        self._pid_file.unlink(missing_ok=True)

    def _running_pid(self) -> int | None:
        try:
            pid = int(self._pid_file.read_text(encoding="utf-8").strip())
            os.kill(pid, 0)
        except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
            return None
        return pid


def default_control(home: Path, base_dir: Path) -> ServerControl:
    if sys.platform == "darwin":
        return LaunchAgentControl(home)
    if sys.platform == "win32":
        return ScheduledTaskControl()
    return ProcessControl(base_dir)


def ping_server(url: str = SERVER_URL, timeout: float = 1.0) -> dict | None:
    try:
        with urllib.request.urlopen(f"{url}/ping", timeout=timeout) as response:
            body = json.load(response)
    except (OSError, ValueError):
        return None
    if isinstance(body, dict) and body.get("app") == "open-speechy":
        return body
    return None


class NativeHost:
    def __init__(
        self,
        auth: AuthManager,
        control: ServerControl,
        ping: Callable[[], dict | None] = ping_server,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._auth = auth
        self._control = control
        self._ping = ping
        self._sleep = sleep
        self._clock = clock

    def handle(self, message: object, origin: str | None) -> dict:
        kind = message.get("type") if isinstance(message, dict) else None
        if kind == "status":
            return self._status()
        if kind == "connect":
            if not origin or not self._auth.bind_extension_origin(origin):
                return {"ok": False, "error": "This extension cannot connect to the server."}
            return {**self._status(), "token": self._auth.token, "url": SERVER_URL}
        if kind == "start":
            self._require_control()
            self._control.start()
            self._wait_until(lambda: self._ping() is not None, START_TIMEOUT_SECONDS)
            return self._status()
        if kind == "stop":
            self._require_control()
            self._control.stop()
            self._wait_until(lambda: self._ping() is None, STOP_TIMEOUT_SECONDS)
            return self._status()
        return {"ok": False, "error": "Unknown request."}

    def _status(self) -> dict:
        ping = self._ping()
        return {
            "ok": True,
            "running": ping is not None,
            "version": ping.get("version") if ping else None,
            "canManage": self._control.can_manage(),
        }

    def _require_control(self) -> None:
        if not self._control.can_manage():
            raise RuntimeError("The server service is not installed. Run the installer again.")

    def _wait_until(self, done: Callable[[], bool], timeout: float) -> None:
        deadline = self._clock() + timeout
        while not done() and self._clock() < deadline:
            self._sleep(0.25)


def read_message(stream: BinaryIO) -> object | None:
    header = stream.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    if length > MAX_MESSAGE_BYTES:
        raise ValueError("Native message is too large.")
    return json.loads(stream.read(length).decode("utf-8"))


def write_message(stream: BinaryIO, message: dict) -> None:
    body = json.dumps(message).encode("utf-8")
    stream.write(struct.pack("=I", len(body)))
    stream.write(body)
    stream.flush()


def caller_origin(argv: list[str]) -> str | None:
    # Chrome passes the calling extension's origin as an argument.
    for argument in argv:
        if argument.startswith("chrome-extension://"):
            return argument.rstrip("/")
    return None


def main(
    argv: list[str] | None = None,
    stdin: BinaryIO | None = None,
    stdout: BinaryIO | None = None,
    host: NativeHost | None = None,
) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    source = stdin or sys.stdin.buffer
    sink = stdout or sys.stdout.buffer
    try:
        message = read_message(source)
        if message is None:
            return 0
        if host is None:
            auth = AuthManager()
            base_dir = auth.token_path.parent
            host = NativeHost(auth, default_control(Path.home(), base_dir))
        reply = host.handle(message, caller_origin(arguments))
    except Exception as error:  # noqa: BLE001
        # Every failure goes back to the extension as a reply.
        reply = {"ok": False, "error": str(error) or "The native host failed."}
    write_message(sink, reply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
