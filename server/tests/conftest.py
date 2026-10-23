from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def isolated_server_home(tmp_path, monkeypatch) -> None:
    # AuthManager writes the token and paired extension ID under the server
    # home. Without this, tests would overwrite a real install's pairing.
    monkeypatch.setenv("OPEN_SPEECHY_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("OPEN_SPEECHY_TOKEN_FILE", raising=False)
    monkeypatch.delenv("OPEN_SPEECHY_EXTENSION_ID", raising=False)
