from __future__ import annotations

import json
import os
from fnmatch import fnmatchcase
from functools import lru_cache
from pathlib import Path
from typing import Any

from .engines.base import EngineUnavailable

MANIFEST_PATH = Path(__file__).with_name("models.json")


@lru_cache(maxsize=1)
def _manifest() -> dict[str, dict[str, Any]]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def model_pin(model_name: str) -> dict[str, Any]:
    try:
        return _manifest()[model_name]
    except KeyError as error:
        raise EngineUnavailable(f"No pinned model revision for '{model_name}'.") from error


def download_snapshot(model_name: str) -> Path:
    pin = model_pin(model_name)
    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise EngineUnavailable(
            "Install the server model dependencies with `uv sync --extra engines`."
        ) from error

    cache_dir = os.environ.get("OPEN_SPEECHY_MODEL_CACHE")
    try:
        path = snapshot_download(
            repo_id=pin["repoId"],
            revision=pin["revision"],
            allow_patterns=pin["files"],
            cache_dir=cache_dir,
        )
    except Exception as error:
        raise EngineUnavailable(
            f"Could not download the pinned {model_name} model revision."
        ) from error
    return Path(path)


def local_model_file(model_name: str, snapshot: Path, filename: str) -> Path:
    if filename not in model_pin(model_name)["files"] and not any(
        fnmatchcase(filename, pattern)
        for pattern in model_pin(model_name)["files"]
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
