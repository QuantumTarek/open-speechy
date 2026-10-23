from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar, Self

import pytest
from fastapi.testclient import TestClient
from server.align import Aligner
from server.app import create_app
from server.auth import AuthManager
from server.engines.base import EngineUnavailable, Synthesis
from server.engines.registry import ALIGNER_ID, EngineRegistry, ModelBusy
from server.model_store import ModelStore, model_pin

HEADERS = {
    "Authorization": "Bearer test-secret",
    "Origin": f"chrome-extension://{'a' * 32}",
}


@dataclass
class DryRunFile:
    file_size: int
    is_cached: bool


class FakeHub:
    def __init__(self) -> None:
        self.files = [DryRunFile(100, True), DryRunFile(300, False)]
        self.offline = False
        self.dry_runs = 0
        self.deleted: list[str] = []

    def snapshot_download(self, **arguments: object):
        if arguments.get("dry_run"):
            self.dry_runs += 1
            if self.offline:
                raise OSError("offline")
            return self.files
        progress = arguments.get("tqdm_class")
        if callable(progress):
            transfer = progress(desc="Downloading bytes", total=0)
            written = progress(desc="Reconstructing (incomplete total...)", total=0)
            files = progress(desc="Fetching 2 files", total=2)
            transfer.update(120)
            written.update(50)
            files.update(1)
            transfer.update(400)
        self.files = [DryRunFile(file.file_size, True) for file in self.files]
        return "/cache/snapshot"

    def scan_cache_dir(self, cache_dir: object):
        hub = self
        pin = model_pin("kokoro")

        class Strategy:
            expected_freed_size = 400

            def execute(self) -> None:
                hub.deleted.append(pin["revision"])

        class Cache:
            repos: ClassVar[list[type]] = [
                type(
                    "Repo",
                    (),
                    {
                        "repo_id": pin["repoId"],
                        "revisions": [
                            type("Revision", (), {"commit_hash": pin["revision"]})
                        ],
                    },
                )
            ]

            def delete_revisions(self, *revisions: str) -> Strategy:
                assert revisions == (pin["revision"],)
                return Strategy()

        return Cache()


def test_store_measures_a_snapshot_once_and_falls_back_to_the_pinned_size() -> None:
    hub = FakeHub()
    now = [0.0]
    store = ModelStore(hub=lambda: hub, clock=lambda: now[0])

    assert store.sizes("kokoro") == (100, 400)
    assert store.sizes("kokoro") == (100, 400)
    assert hub.dry_runs == 1

    hub.offline = True
    assert store.sizes("silma") == (0, model_pin("silma")["bytes"])
    store.sizes("silma")
    assert hub.dry_runs == 2
    now[0] = 301.0
    store.sizes("silma")
    assert hub.dry_runs == 3


def test_store_reports_download_bytes_and_remeasures_after() -> None:
    pytest.importorskip("tqdm")
    hub = FakeHub()
    store = ModelStore(hub=lambda: hub)
    reports: list[int] = []

    assert store.download("kokoro", reports.append) == Path("/cache/snapshot")

    # Network bytes lead, written bytes trail, and the total caps both.
    assert reports == [120, 120, 300]
    assert store.sizes("kokoro") == (400, 400)


def test_store_removes_only_the_pinned_revision() -> None:
    hub = FakeHub()
    store = ModelStore(hub=lambda: hub)

    assert store.remove("kokoro") == 400
    assert hub.deleted == [model_pin("kokoro")["revision"]]
    assert store.remove("silma") == 0


class FakeStore:
    def __init__(self) -> None:
        self.present = {"pin": 0}
        self.release = threading.Event()
        self.removed: list[str] = []

    def sizes(self, model_name: str) -> tuple[int, int]:
        return self.present[model_name], 1_000

    def download(self, model_name: str, on_progress=None) -> Path:
        assert on_progress is not None
        on_progress(250)
        self.release.wait(5)
        on_progress(1_000)
        self.present[model_name] = 1_000
        return Path("/cache")

    def remove(self, model_name: str) -> int:
        self.removed.append(model_name)
        self.present[model_name] = 0
        return 1_000


class FakeAligner:
    available = True

    def __init__(self, downloaded: bool = True) -> None:
        self.loaded = False
        self.is_downloaded = downloaded

    def downloaded(self) -> bool:
        return self.is_downloaded

    def size(self) -> int:
        return 500

    def download(self, on_progress=None) -> None:
        assert on_progress is not None
        on_progress(500)
        self.is_downloaded = True

    def load(self) -> None:
        self.loaded = True

    def unload(self) -> None:
        self.loaded = False

    def remove(self) -> int:
        self.unload()
        self.is_downloaded = False
        return 500


class ModelEngine:
    id = "fake"
    title = "Fake voice"
    langs: tuple[str, ...] = ("en",)
    models = ("pin",)
    available = True

    def __init__(self, fail: bool = False) -> None:
        self.loaded = False
        self.fail = fail

    def voices(self) -> list[dict[str, object]]:
        return []

    async def warmup(self) -> None:
        if self.fail:
            raise RuntimeError("Model failed to load.")
        self.loaded = True

    def unload(self) -> None:
        self.loaded = False

    async def synthesize(self, words, lang, speed, voice_id) -> Synthesis:
        return Synthesis(audio_wav=b"RIFF", sample_rate=24_000, timings=[])


def model(registry: EngineRegistry, model_id: str) -> dict[str, object]:
    return next(entry for entry in registry.models() if entry["id"] == model_id)


def test_registry_prepares_with_progress_then_removes() -> None:
    store = FakeStore()
    aligner = FakeAligner(downloaded=False)
    engine = ModelEngine()
    registry = EngineRegistry([engine], store=store, aligner=aligner)

    async def run() -> None:
        assert model(registry, "fake")["state"] == "missing"
        assert model(registry, ALIGNER_ID)["state"] == "missing"

        registry.start_prepare("fake")
        for _ in range(100):
            await asyncio.sleep(0.01)
            if model(registry, "fake").get("progress"):
                break
        entry = model(registry, "fake")
        assert entry["state"] == "downloading"
        # The 1.26 GB aligner is not part of a voice's download.
        assert entry["progress"] == {"downloaded": 250, "total": 1_000}
        with pytest.raises(ModelBusy):
            await registry.remove("fake")

        store.release.set()
        await registry.prepare("fake")
        assert engine.loaded
        assert model(registry, "fake")["state"] == "loaded"
        assert model(registry, ALIGNER_ID)["state"] == "missing"

        # Downloading it is a separate choice.
        await registry.prepare(ALIGNER_ID)
        assert aligner.loaded
        assert model(registry, ALIGNER_ID)["state"] == "loaded"

        assert await registry.remove("fake") == 1_000
        assert store.removed == ["pin"]
        assert model(registry, "fake")["state"] == "missing"
        assert await registry.remove(ALIGNER_ID) == 500
        assert model(registry, ALIGNER_ID)["state"] == "missing"

    asyncio.run(run())


def test_only_voices_that_need_it_load_the_aligner() -> None:
    class SelfTimedEngine(ModelEngine):
        id = "self_timed"
        aligns_words = False

    store = FakeStore()
    store.present["pin"] = 1_000
    aligner = FakeAligner()
    registry = EngineRegistry(
        [SelfTimedEngine(), ModelEngine()], store=store, aligner=aligner
    )

    async def run() -> None:
        await registry.prepare("self_timed")
        assert not aligner.loaded
        await registry.prepare("fake")
        assert aligner.loaded

    asyncio.run(run())


def test_registry_reports_a_failed_preparation() -> None:
    store = FakeStore()
    store.present["pin"] = 1_000
    registry = EngineRegistry(
        [ModelEngine(fail=True)], store=store, aligner=FakeAligner()
    )

    async def run() -> None:
        with pytest.raises(RuntimeError):
            await registry.prepare("fake")
        entry = model(registry, "fake")
        assert entry["state"] == "error"
        assert entry["error"] == "Model failed to load."

    asyncio.run(run())


def test_model_routes_list_prepare_and_remove() -> None:
    store = FakeStore()
    store.present["pin"] = 1_000
    registry = EngineRegistry([ModelEngine()], store=store, aligner=FakeAligner())
    app = create_app(
        auth=AuthManager(token="test-secret", extension_id="a" * 32),
        engines=registry,
    )
    with TestClient(app, base_url="http://127.0.0.1:5123") as client:
        assert client.get("/models").status_code == 401
        listed = client.get("/models", headers=HEADERS).json()["models"]
        assert [(entry["id"], entry["state"]) for entry in listed] == [
            ("fake", "downloaded"),
            (ALIGNER_ID, "downloaded"),
        ]
        assert (
            client.post("/models/unknown/prepare", headers=HEADERS).status_code == 404
        )
        assert client.post("/models/Bad-Id/prepare", headers=HEADERS).status_code == 400
        assert client.post("/models/fake/prepare", headers=HEADERS).status_code == 202
        for _ in range(200):
            if model(registry, "fake")["state"] == "loaded":
                break
            time.sleep(0.01)
        assert model(registry, "fake")["state"] == "loaded"

        removed = client.delete("/models/fake", headers=HEADERS)
        assert removed.status_code == 200
        assert removed.json() == {"freedBytes": 1_000}
        assert client.delete("/models/unknown", headers=HEADERS).status_code == 404


class TempAligner(Aligner):
    def __init__(self, path: Path) -> None:
        super().__init__()
        self._path = path

    @property
    def available(self) -> bool:
        return True

    def path(self) -> Path:
        return self._path


class FakeResponse:
    def __init__(self, body: bytes, length: int) -> None:
        self._chunks = [body[:3], body[3:]]
        self.headers = {"Content-Length": str(length)}

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self, _size: int) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""


def test_aligner_downloads_with_progress_and_discards_a_partial_file(
    tmp_path, monkeypatch
) -> None:
    target = tmp_path / "hub" / "checkpoints" / "model.pt"
    aligner = TempAligner(target)
    monkeypatch.setattr(
        "server.align.urllib.request.urlopen",
        lambda *_args, **_kwargs: FakeResponse(b"weights", 9),
    )
    with pytest.raises(EngineUnavailable):
        aligner.download()
    assert not target.exists()
    assert list(target.parent.iterdir()) == []

    monkeypatch.setattr(
        "server.align.urllib.request.urlopen",
        lambda *_args, **_kwargs: FakeResponse(b"weights", 7),
    )
    reports: list[int] = []
    aligner.download(reports.append)
    assert reports == [3, 7]
    assert target.read_bytes() == b"weights"
    assert aligner.downloaded() and aligner.size() == 7
    assert aligner.remove() == 7
    assert not aligner.downloaded()
