from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Callable
from fnmatch import fnmatchcase
from functools import lru_cache
from pathlib import Path
from typing import Any

from .engines.base import EngineUnavailable

MANIFEST_PATH = Path(__file__).with_name("models.json")
# A failed size check needs the network. It is not retried on every request.
SIZE_RETRY_SECONDS = 300.0

ProgressCallback = Callable[[int], None]


@lru_cache(maxsize=1)
def _manifest() -> dict[str, dict[str, Any]]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def model_pin(model_name: str) -> dict[str, Any]:
    try:
        return _manifest()[model_name]
    except KeyError as error:
        raise EngineUnavailable(
            f"No pinned model revision for '{model_name}'."
        ) from error


def _hub():
    try:
        import huggingface_hub
    except ImportError as error:
        raise EngineUnavailable(
            "Install the server model dependencies with `uv sync --extra engines`."
        ) from error
    return huggingface_hub


def _byte_progress_class(on_progress: ProgressCallback, total: int) -> type:
    """A tqdm class for snapshot_download that reports downloaded bytes.

    snapshot_download sums every file into two byte bars: "Downloading bytes"
    counts network bytes as they arrive, and "Reconstructing" counts bytes
    written to disk, which can lag until a file is complete. Network bytes can
    end below the file size (compression), so the larger of the two is used.
    """
    from tqdm.auto import tqdm

    lock = threading.Lock()
    counts = {"transfer": 0, "written": 0}

    class ByteProgress(tqdm):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            description = str(kwargs.get("desc") or "")
            self._counter = (
                "transfer"
                if description.startswith("Downloading bytes")
                else "written"
                if description.startswith("Reconstructing")
                else None
            )
            kwargs["disable"] = True
            super().__init__(*args, **kwargs)

        def update(self, n: float | None = 1) -> bool | None:
            if self._counter and n:
                with lock:
                    counts[self._counter] += int(n)
                    done = max(counts["written"], counts["transfer"])
                on_progress(min(done, total))
            return super().update(n)

    return ByteProgress


class ModelStore:
    """Downloads, measures and removes the pinned Hugging Face snapshots."""

    def __init__(
        self,
        hub: Callable[[], Any] = _hub,
        cache_dir: str | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._hub = hub
        self._cache_dir = cache_dir or os.environ.get("OPEN_SPEECHY_MODEL_CACHE")
        self._clock = clock
        self._sizes: dict[str, tuple[int, int, float | None]] = {}

    def _pin_arguments(self, model_name: str) -> dict[str, Any]:
        pin = model_pin(model_name)
        return {
            "repo_id": pin["repoId"],
            "revision": pin["revision"],
            "allow_patterns": pin["files"],
            "cache_dir": self._cache_dir,
        }

    def sizes(self, model_name: str) -> tuple[int, int]:
        """(bytes already cached, total bytes) for a pinned snapshot."""
        cached = self._sizes.get(model_name)
        if cached and (cached[2] is None or self._clock() < cached[2]):
            return cached[0], cached[1]
        try:
            # A dry run reads the cached file list, so it only needs the
            # network for a snapshot that was never downloaded.
            files = self._hub().snapshot_download(
                **self._pin_arguments(model_name), dry_run=True
            )
            total = sum(file.file_size or 0 for file in files)
            present = sum(file.file_size or 0 for file in files if file.is_cached)
            self._sizes[model_name] = (present, total, None)
        except Exception:  # noqa: BLE001 - offline: report the pinned size.
            total = int(model_pin(model_name).get("bytes", 0))
            self._sizes[model_name] = (0, total, self._clock() + SIZE_RETRY_SECONDS)
        return self._sizes[model_name][0], self._sizes[model_name][1]

    def download(
        self,
        model_name: str,
        on_progress: ProgressCallback | None = None,
    ) -> Path:
        hub = self._hub()
        arguments = self._pin_arguments(model_name)
        if on_progress is not None:
            present, total = self.sizes(model_name)
            arguments["tqdm_class"] = _byte_progress_class(
                on_progress, max(0, total - present)
            )
        try:
            path = hub.snapshot_download(**arguments)
        except Exception as error:
            raise EngineUnavailable(
                f"Could not download the pinned {model_name} model revision."
            ) from error
        finally:
            self._sizes.pop(model_name, None)
        return Path(path)

    def remove(self, model_name: str) -> int:
        """Delete the pinned revision from the cache. Returns the bytes freed."""
        pin = model_pin(model_name)
        hub = self._hub()
        try:
            cache = hub.scan_cache_dir(self._cache_dir)
        except Exception:  # noqa: BLE001 - no cache directory yet.
            return 0
        revisions = [
            revision.commit_hash
            for repo in cache.repos
            if repo.repo_id == pin["repoId"]
            for revision in repo.revisions
            if revision.commit_hash == pin["revision"]
        ]
        self._sizes.pop(model_name, None)
        if not revisions:
            return 0
        strategy = cache.delete_revisions(*revisions)
        strategy.execute()
        return int(strategy.expected_freed_size)


MODEL_STORE = ModelStore()


def download_snapshot(model_name: str) -> Path:
    return MODEL_STORE.download(model_name)


def local_model_file(model_name: str, snapshot: Path, filename: str) -> Path:
    if filename not in model_pin(model_name)["files"] and not any(
        fnmatchcase(filename, pattern) for pattern in model_pin(model_name)["files"]
    ):
        raise EngineUnavailable(
            f"{filename} is not part of the pinned {model_name} snapshot."
        )
    path = snapshot / filename
    if not path.is_file():
        raise EngineUnavailable(
            f"The pinned {model_name} snapshot is missing {filename}."
        )
    return path


def detect_torch_device() -> str:
    try:
        import torch
    except ImportError:
        return "cpu"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"
