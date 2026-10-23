from __future__ import annotations

import hmac
import os
import re
import secrets
import time
from pathlib import Path


class AuthManager:
    _EXTENSION_ORIGIN = re.compile(r"^chrome-extension://[a-p]{32}$")

    def __init__(
        self,
        token_path: str | Path | None = None,
        extension_id: str | None = None,
        token: str | None = None,
    ) -> None:
        configured_path = token_path or os.environ.get("OPEN_SPEECHY_TOKEN_FILE")
        configured_home = os.environ.get("OPEN_SPEECHY_HOME")
        default_home = Path(configured_home) if configured_home else Path.home() / ".open-speechy"
        self._token_path = Path(
            configured_path or default_home / "token"
        )
        self._extension_path = self._token_path.parent / "extension-id"
        configured_id = os.environ.get("OPEN_SPEECHY_EXTENSION_ID", "")
        # The native host binds the extension by writing the ID file while the
        # server runs, so the file is re-read when it changes.
        self._watch_extension_file = not configured_id
        self._extension_id = extension_id or configured_id
        self._extension_mtime: int | None = None
        if self._extension_id:
            self._extension_mtime = self._extension_file_mtime()
        else:
            self._reload_extension_id()
        if self._extension_id and not re.fullmatch(r"[a-p]{32}", self._extension_id):
            raise ValueError("Chrome extension ID must contain 32 letters from a to p.")
        self._provided_token = token
        self._token: str | None = None

    @property
    def token_path(self) -> Path:
        return self._token_path

    @property
    def extension_id(self) -> str:
        self._reload_extension_id()
        return self._extension_id

    @property
    def extension_origin(self) -> str | None:
        extension_id = self.extension_id
        if not extension_id:
            return None
        return f"chrome-extension://{extension_id}"

    def _extension_file_mtime(self) -> int | None:
        try:
            return self._extension_path.stat().st_mtime_ns
        except FileNotFoundError:
            return None

    def _reload_extension_id(self) -> None:
        if not self._watch_extension_file:
            return
        mtime = self._extension_file_mtime()
        if mtime is None or mtime == self._extension_mtime:
            return
        self._extension_mtime = mtime
        value = self._extension_path.read_text(encoding="utf-8").strip()
        if re.fullmatch(r"[a-p]{32}", value):
            self._extension_id = value

    def can_pair_origin(self, origin: str | None) -> bool:
        # The one-time code proves the user approved this browser, so a valid
        # code may move the binding to a reinstalled or reloaded extension.
        return bool(origin and self._EXTENSION_ORIGIN.fullmatch(origin))

    def bind_extension_origin(self, origin: str) -> bool:
        if not self.can_pair_origin(origin):
            return False
        if self.extension_origin == origin:
            return True
        self._extension_id = origin.removeprefix("chrome-extension://")
        self._extension_path.parent.mkdir(
            parents=True,
            exist_ok=True,
            mode=0o700,
        )
        os.chmod(self._extension_path.parent, 0o700)
        self._extension_path.write_text(
            f"{self._extension_id}\n",
            encoding="utf-8",
        )
        os.chmod(self._extension_path, 0o600)
        self._extension_mtime = self._extension_file_mtime()
        return True

    @property
    def token(self) -> str:
        if self._token is not None:
            return self._token
        if self._provided_token is not None:
            self._token = self._provided_token
            return self._token

        self._token_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self._token_path.parent, 0o700)
        try:
            descriptor = os.open(
                self._token_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
        except FileExistsError:
            self._token = self._token_path.read_text(encoding="utf-8").strip()
        else:
            self._token = secrets.token_urlsafe(32)
            with os.fdopen(descriptor, "w", encoding="utf-8") as token_file:
                token_file.write(f"{self._token}\n")
        if not self._token:
            raise RuntimeError("Local server token file is empty.")
        os.chmod(self._token_path, 0o600)
        return self._token

    def accepts(self, authorization: str | None) -> bool:
        scheme, _, supplied = (authorization or "").partition(" ")
        return (
            scheme.lower() == "bearer"
            and bool(supplied)
            and hmac.compare_digest(supplied, self.token)
        )


class PairingManager:
    def __init__(
        self,
        auth: AuthManager,
        ttl_seconds: int = 300,
        now=time.monotonic,
    ) -> None:
        self._auth = auth
        self._ttl_seconds = ttl_seconds
        self._now = now
        self._code: str | None = None
        self._expires_at = 0.0
        self._attempts = 0

    def current_code(self) -> str:
        if (
            self._code is None
            or self._now() >= self._expires_at
            or self._attempts >= 5
        ):
            self._code = f"{secrets.randbelow(1_000_000):06d}"
            self._expires_at = self._now() + self._ttl_seconds
            self._attempts = 0
        return self._code

    def exchange(self, supplied: str) -> str | None:
        if self._attempts >= 5 or self._code is None:
            return None
        if self._now() >= self._expires_at:
            self._code = None
            return None
        self._attempts += 1
        if not hmac.compare_digest(supplied, self._code):
            return None
        self._code = None
        return self._auth.token


if __name__ == "__main__":
    print(AuthManager().token)
