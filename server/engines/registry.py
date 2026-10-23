from __future__ import annotations

import asyncio
import contextlib
import threading
from pathlib import Path
from typing import Protocol

from ..align import ALIGNER
from ..model_store import MODEL_STORE, ProgressCallback
from .base import EngineUnavailable, SpeechEngine, Synthesis
from .chatterbox_ml import ChatterboxMultilingualEngine
from .chatterbox_nano import ChatterboxNanoEngine
from .kokoro import KokoroEngine
from .silma import SilmaEngine

ALIGNER_ID = "aligner"


class ModelBusy(RuntimeError):
    pass


class SnapshotStore(Protocol):
    def sizes(self, model_name: str) -> tuple[int, int]: ...

    def download(
        self, model_name: str, on_progress: ProgressCallback | None = None
    ) -> Path: ...

    def remove(self, model_name: str) -> int: ...


class WordAligner(Protocol):
    @property
    def available(self) -> bool: ...

    @property
    def loaded(self) -> bool: ...

    def downloaded(self) -> bool: ...

    def size(self) -> int: ...

    def download(self, on_progress: ProgressCallback | None = None) -> None: ...

    def load(self) -> None: ...

    def unload(self) -> None: ...

    def remove(self) -> int: ...


class Preparation:
    """Bytes downloaded so far while a model is prepared, across its files."""

    def __init__(self) -> None:
        self.stage = "checking"
        self.total = 0
        self._parts: dict[str, int] = {}
        self._lock = threading.Lock()

    def reporter(self, part: str) -> ProgressCallback:
        def report(done: int) -> None:
            with self._lock:
                self._parts[part] = done

        return report

    @property
    def downloaded(self) -> int:
        with self._lock:
            return min(self.total, sum(self._parts.values()))


def engine_models(engine: SpeechEngine) -> tuple[str, ...]:
    return tuple(getattr(engine, "models", ()))


class EngineRegistry:
    def __init__(
        self,
        engines: list[SpeechEngine] | None = None,
        store: SnapshotStore | None = None,
        aligner: WordAligner | None = None,
    ) -> None:
        configured = (
            engines
            if engines is not None
            else [
                KokoroEngine(),
                SilmaEngine(),
                ChatterboxNanoEngine(),
                ChatterboxMultilingualEngine(),
            ]
        )
        self._engines = {engine.id: engine for engine in configured}
        self._store = store or MODEL_STORE
        self._aligner = aligner or ALIGNER
        self._preparations: dict[str, Preparation] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._errors: dict[str, str] = {}

    def health(self) -> list[dict[str, object]]:
        return [
            {
                "id": engine.id,
                "loaded": engine.loaded,
                "langs": list(engine.langs),
            }
            for engine in self._engines.values()
        ]

    def voices(self) -> list[dict[str, object]]:
        return [
            voice
            for engine in self._engines.values()
            if engine.available
            for voice in engine.voices()
        ]

    def models(self) -> list[dict[str, object]]:
        """Downloadable models and their state. May check sizes on the network."""
        entries = []
        for engine in self._engines.values():
            pins = engine_models(engine)
            if not engine.available or not pins:
                continue
            sizes = [self._store.sizes(pin) for pin in pins]
            entries.append(
                self._model_entry(
                    engine.id,
                    getattr(engine, "title", engine.id),
                    list(engine.langs),
                    sum(present for present, _ in sizes),
                    sum(total for _, total in sizes),
                    engine.loaded,
                )
            )
        if self._aligner.available and entries:
            downloaded = self._aligner.downloaded()
            size = self._aligner.size()
            entries.append(
                self._model_entry(
                    ALIGNER_ID,
                    "Word timing aligner",
                    sorted({lang for entry in entries for lang in entry["langs"]}),
                    size if downloaded else 0,
                    size,
                    self._aligner.loaded,
                )
            )
        return entries

    def _model_entry(
        self,
        model_id: str,
        name: str,
        langs: list[str],
        present: int,
        total: int,
        loaded: bool,
    ) -> dict[str, object]:
        preparation = self._preparations.get(model_id)
        if preparation:
            state = "downloading" if preparation.stage == "downloading" else "loading"
        elif loaded:
            state = "loaded"
        elif model_id in self._errors:
            state = "error"
        else:
            state = "downloaded" if total and present >= total else "missing"
        entry: dict[str, object] = {
            "id": model_id,
            "name": name,
            "kind": "aligner" if model_id == ALIGNER_ID else "voice",
            "langs": langs,
            "bytes": total,
            "downloadedBytes": present,
            "state": state,
        }
        if preparation and preparation.stage == "downloading":
            entry["progress"] = {
                "downloaded": preparation.downloaded,
                "total": preparation.total,
            }
        if state == "error":
            entry["error"] = self._errors[model_id]
        return entry

    def preparing(self, model_id: str) -> bool:
        return model_id in self._tasks or (model_id == ALIGNER_ID and bool(self._tasks))

    def start_prepare(self, model_id: str) -> None:
        """Prepare in the background. models() reports the progress."""
        self._require_model(model_id)
        self._preparation_task(model_id)

    async def prepare(self, model_id: str) -> None:
        engine = self._engines.get(model_id)
        if engine is not None and engine.loaded:
            return
        self._require_model(model_id)
        # A cancelled request must not cancel a download other requests share.
        await asyncio.shield(self._preparation_task(model_id))

    async def warmup(self, engine_ids: list[str]) -> None:
        for engine_id in dict.fromkeys(engine_ids):
            if engine_id not in self._engines:
                raise EngineUnavailable(f"Unknown speech engine: {engine_id}")
            await self.prepare(engine_id)

    async def remove(self, model_id: str) -> int:
        self._require_model(model_id)
        if self.preparing(model_id):
            raise ModelBusy("Wait until the model finishes preparing.")
        self._errors.pop(model_id, None)
        if model_id == ALIGNER_ID:
            return await asyncio.to_thread(self._aligner.remove)
        engine = self._engines[model_id]
        unload = getattr(engine, "unload", None)
        if unload is not None:
            unload()
        freed = 0
        for pin in engine_models(engine):
            freed += await asyncio.to_thread(self._store.remove, pin)
        return freed

    async def synthesize(
        self,
        voice_id: str,
        lang: str,
        words: list[str],
        speed: float,
    ) -> Synthesis:
        parts = voice_id.split(":")
        if len(parts) < 3 or parts[0] != "server":
            raise EngineUnavailable("Unknown server voice identifier.")
        engine = self._engines.get(parts[1])
        if engine is None or not engine.available:
            raise EngineUnavailable(
                f"Speech engine '{parts[1]}' is not installed or verified."
            )
        if lang not in engine.langs:
            raise EngineUnavailable(
                f"Speech engine '{parts[1]}' does not support {lang}."
            )
        await self.prepare(engine.id)
        return await engine.synthesize(words, lang, speed, voice_id)

    def _require_model(self, model_id: str) -> None:
        if model_id == ALIGNER_ID:
            if not self._aligner.available:
                raise EngineUnavailable("The word aligner is not installed.")
            return
        engine = self._engines.get(model_id)
        if engine is None:
            raise KeyError(model_id)
        if not engine.available:
            raise EngineUnavailable(
                f"Speech engine '{model_id}' is not installed or verified."
            )

    def _preparation_task(self, model_id: str) -> asyncio.Task[None]:
        task = self._tasks.get(model_id)
        if task is None:
            preparation = Preparation()
            self._preparations[model_id] = preparation
            self._errors.pop(model_id, None)
            task = asyncio.create_task(self._prepare(model_id, preparation))
            self._tasks[model_id] = task
            task.add_done_callback(lambda done: self._finish(model_id, done))
        return task

    def _finish(self, model_id: str, task: asyncio.Task[None]) -> None:
        self._tasks.pop(model_id, None)
        self._preparations.pop(model_id, None)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            self._errors[model_id] = str(error) or "The model could not be prepared."

    async def _prepare(self, model_id: str, preparation: Preparation) -> None:
        engine = self._engines.get(model_id)
        pins = engine_models(engine) if engine else ()
        missing: list[tuple[str, int]] = []
        for pin in pins:
            present, total = await asyncio.to_thread(self._store.sizes, pin)
            if present < total:
                missing.append((pin, total - present))
        # Only an explicit request downloads the aligner: it is 1.26 GB, and
        # voices without it use estimated word timings.
        fetch_aligner = (
            engine is None
            and self._aligner.available
            and not self._aligner.downloaded()
        )
        preparation.total = sum(size for _, size in missing) + (
            self._aligner.size() if fetch_aligner else 0
        )
        if preparation.total:
            preparation.stage = "downloading"
        for pin, _ in missing:
            await asyncio.to_thread(
                self._store.download, pin, preparation.reporter(pin)
            )
        if fetch_aligner:
            await asyncio.to_thread(
                self._aligner.download, preparation.reporter(ALIGNER_ID)
            )
        preparation.stage = "loading"
        if engine is not None:
            await engine.warmup()
        if self._aligner.downloaded() and (
            engine is None or getattr(engine, "aligns_words", True)
        ):
            # Alignment is optional: a failure here leaves estimated timings.
            with contextlib.suppress(Exception):
                await asyncio.to_thread(self._aligner.load)
