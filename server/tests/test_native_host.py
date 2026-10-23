from __future__ import annotations

import io
import json
import os
import signal
import struct
import subprocess
from pathlib import Path

import pytest
from server.auth import AuthManager
from server.native_host import (
    LaunchAgentControl,
    NativeHost,
    ProcessControl,
    caller_origin,
    main,
    read_message,
    write_message,
)

ORIGIN = f"chrome-extension://{'b' * 32}"


class FakeControl:
    def __init__(self, manageable: bool = True) -> None:
        self.manageable = manageable
        self.calls: list[str] = []

    def can_manage(self) -> bool:
        return self.manageable

    def start(self) -> None:
        self.calls.append("start")

    def stop(self) -> None:
        self.calls.append("stop")


class FakeServer:
    def __init__(self, running: bool) -> None:
        self.running = running
        self.pings = 0

    def ping(self) -> dict | None:
        self.pings += 1
        return {"app": "open-speechy", "version": "0.1.0"} if self.running else None


def make_host(
    control: FakeControl,
    server: FakeServer,
    auth: AuthManager | None = None,
) -> NativeHost:
    now = [0.0]

    def sleep(seconds: float) -> None:
        now[0] += seconds

    return NativeHost(
        auth or AuthManager(token="host-secret"),
        control,
        ping=server.ping,
        sleep=sleep,
        clock=lambda: now[0],
    )


def framed(message: dict) -> io.BytesIO:
    stream = io.BytesIO()
    write_message(stream, message)
    stream.seek(0)
    return stream


def test_messages_use_chrome_length_prefixed_json() -> None:
    stream = framed({"type": "status"})
    assert struct.unpack("=I", stream.getvalue()[:4])[0] == len(b'{"type": "status"}')
    assert read_message(stream) == {"type": "status"}
    assert read_message(io.BytesIO()) is None


def test_caller_origin_comes_from_chrome_arguments() -> None:
    assert caller_origin([f"{ORIGIN}/"]) == ORIGIN
    assert caller_origin(["--parent-window=0", f"{ORIGIN}/"]) == ORIGIN
    assert caller_origin([]) is None


def test_status_reports_whether_the_server_answers() -> None:
    host = make_host(FakeControl(), FakeServer(running=True))

    assert host.handle({"type": "status"}, ORIGIN) == {
        "ok": True,
        "running": True,
        "version": "0.1.0",
        "canManage": True,
    }


def test_connect_hands_over_the_token_and_binds_the_caller() -> None:
    auth = AuthManager(token="host-secret")
    server_side = AuthManager(token="host-secret")
    host = make_host(FakeControl(), FakeServer(running=True), auth)

    reply = host.handle({"type": "connect"}, ORIGIN)

    assert reply["token"] == "host-secret"
    assert reply["url"] == "http://127.0.0.1:5123"
    # A running server picks up the binding the host wrote.
    assert server_side.extension_origin == ORIGIN
    refused = host.handle({"type": "connect"}, "https://example.com")
    assert refused["ok"] is False
    assert "token" not in refused


def test_start_and_stop_wait_for_the_server() -> None:
    control = FakeControl()
    server = FakeServer(running=False)
    host = make_host(control, server)

    original_start = control.start

    def start() -> None:
        original_start()
        server.running = True

    control.start = start  # type: ignore[method-assign]
    assert host.handle({"type": "start"}, ORIGIN)["running"] is True

    original_stop = control.stop

    def stop() -> None:
        original_stop()
        server.running = False

    control.stop = stop  # type: ignore[method-assign]
    assert host.handle({"type": "stop"}, ORIGIN)["running"] is False
    assert control.calls == ["start", "stop"]


def test_main_reports_failures_as_replies() -> None:
    host = make_host(FakeControl(manageable=False), FakeServer(running=False))
    output = io.BytesIO()

    main([f"{ORIGIN}/"], framed({"type": "start"}), output, host)

    output.seek(0)
    reply = read_message(output)
    assert reply == {
        "ok": False,
        "error": "The server service is not installed. Run the installer again.",
    }


def test_launch_agent_is_enabled_before_it_is_loaded(tmp_path: Path) -> None:
    calls: list[tuple[str, ...]] = []
    loaded = False

    def run(*command: str) -> subprocess.CompletedProcess:
        calls.append(command[1:2])
        return subprocess.CompletedProcess(command, 0 if loaded or command[1] != "print" else 113)

    plist = tmp_path / "Library" / "LaunchAgents" / "dev.openspeechy.server.plist"
    plist.parent.mkdir(parents=True)
    plist.write_text("<plist/>")
    control = LaunchAgentControl(tmp_path, run)

    control.start()
    assert calls == [("enable",), ("print",), ("bootstrap",)]
    calls.clear()
    loaded = True
    control.start()
    assert calls == [("enable",), ("print",), ("kickstart",)]
    calls.clear()
    control.stop()
    assert calls == [("disable",), ("bootout",)]


def test_process_control_starts_a_detached_server_and_stops_its_group(
    tmp_path: Path,
) -> None:
    (tmp_path / "server").mkdir()
    (tmp_path / "server" / "app.py").write_text("")
    spawned: dict = {}
    killed: list[tuple[int, int]] = []

    class Process:
        # A live PID, so stop() finds the process. kill_group is a fake.
        pid = os.getpid()

    def popen(command, **options):
        spawned.update(command=command, **options)
        return Process()

    control = ProcessControl(
        tmp_path,
        python="/venv/bin/python",
        popen=popen,
        kill_group=lambda pid, sig: killed.append((pid, sig)),
    )
    assert control.can_manage()
    control.start()

    assert spawned["command"] == ["/venv/bin/python", "-m", "server.app"]
    assert spawned["cwd"] == tmp_path
    assert spawned["start_new_session"] is True
    assert (tmp_path / "server.pid").read_text().strip() == str(os.getpid())

    control.stop()
    assert killed == [(os.getpid(), signal.SIGTERM)]
    assert not (tmp_path / "server.pid").exists()
    with pytest.raises(RuntimeError):
        control.stop()


def test_installer_registers_the_host_with_installed_browsers(tmp_path: Path) -> None:
    from server.native_host_manifest import DEV_EXTENSION_ID, install, uninstall

    home = tmp_path / "home"
    base = home / ".open-speechy"
    base.mkdir(parents=True)
    (base / "extension-id").write_text(f"{'c' * 32}\n")
    support = home / "Library" / "Application Support"
    (support / "Chromium").mkdir(parents=True)
    environ = {"OPEN_SPEECHY_EXTENSION_IDS": f"{'d' * 32}, not-an-id"}

    written = install(base, home, "darwin", environ)

    assert sorted(written) == sorted(
        [
            str(support / "Google/Chrome/NativeMessagingHosts/dev.openspeechy.host.json"),
            str(support / "Chromium/NativeMessagingHosts/dev.openspeechy.host.json"),
        ]
    )
    manifest = json.loads(Path(written[0]).read_text())
    assert manifest["name"] == "dev.openspeechy.host"
    assert manifest["path"] == str(base / "native-host")
    assert manifest["allowed_origins"] == [
        f"chrome-extension://{DEV_EXTENSION_ID}/",
        f"chrome-extension://{'d' * 32}/",
        f"chrome-extension://{'c' * 32}/",
    ]
    launcher = (base / "native-host").read_text()
    assert "-m server.native_host" in launcher
    assert os.access(base / "native-host", os.X_OK)

    uninstall(base, home, "darwin", environ)
    assert not any(Path(path).exists() for path in written)
    assert not (base / "native-host").exists()
