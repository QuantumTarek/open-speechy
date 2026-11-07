"""One disposable, spawned process owns all inference runtime allocations."""

from __future__ import annotations

import asyncio
import multiprocessing
import threading
from multiprocessing.connection import Connection

from .engines.base import EngineUnavailable


def serve(connection: Connection, engine_id: str) -> None:
    from .align import ALIGNER
    from .engines.registry import EngineRegistry

    registry = EngineRegistry(isolated=False)
    engine = registry._engines.get(engine_id)
    try:
        while True:
            method, args = connection.recv()
            try:
                if method == "aligner":
                    ALIGNER.load()
                    result = None
                elif method == "warmup":
                    result = asyncio.run(engine.warmup())
                elif method == "synthesize":
                    result = asyncio.run(engine.synthesize(*args))
                else:
                    raise ValueError("Unknown inference operation")
                connection.send((True, result, ALIGNER.loaded))
            except Exception as error:  # noqa: BLE001 - transport worker failures
                connection.send((False, str(error), ALIGNER.loaded))
    except (EOFError, BrokenPipeError):
        pass
    finally:
        connection.close()


class InferenceWorker:
    def __init__(self, target=serve, timeout: float = 600) -> None:
        self._target = target
        self._timeout = timeout
        self._lock = threading.RLock()
        self._process = None
        self._connection = None
        self.engine_id: str | None = None
        self.ready = False
        self.aligner_loaded = False

    def loaded(self, engine_id: str) -> bool:
        # Status reads must not wait on the inference lock. A worker can be
        # replaced by its IPC thread while the API is reading health.
        process = self._process
        if self.engine_id != engine_id or not self.ready or process is None:
            return False
        try:
            return process.is_alive()
        except ValueError:  # The old process handle was closed during this read.
            return False

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
            if self._process is not None:
                self._process.terminate()
                self._process.join(timeout=5)
                if self._process.is_alive():
                    self._process.kill()
                    self._process.join()
                self._process.close()
            self._process = self._connection = None
            self.engine_id = None
            self.ready = self.aligner_loaded = False

    def call(self, engine_id: str, method: str, *args):
        with self._lock:
            if (
                self.engine_id != engine_id
                or self._process is None
                or not self._process.is_alive()
            ):
                self.close()
                context = multiprocessing.get_context("spawn")
                parent, child = context.Pipe()
                process = context.Process(
                    target=self._target, args=(child, engine_id), daemon=True
                )
                try:
                    process.start()
                except BaseException:
                    parent.close()
                    child.close()
                    raise
                child.close()
                self._process, self._connection = process, parent
                self.engine_id = engine_id
            try:
                self._connection.send((method, args))
                if not self._connection.poll(self._timeout):
                    raise TimeoutError("Inference worker timed out")
                ok, result, self.aligner_loaded = self._connection.recv()
            except (OSError, EOFError, TimeoutError) as error:
                self.close()
                raise EngineUnavailable(
                    "Inference worker stopped; retry the request."
                ) from error
            if not ok:
                raise EngineUnavailable(result)
            if method in {"warmup", "synthesize"}:
                self.ready = True
            return result


class WorkerEngine:
    def __init__(self, engine, worker: InferenceWorker) -> None:
        self._engine, self._worker = engine, worker

    def __getattr__(self, name):
        return getattr(self._engine, name)

    @property
    def loaded(self) -> bool:
        return self._worker.loaded(self.id)

    def voices(self):
        return [{**voice, "installed": self.loaded} for voice in self._engine.voices()]

    async def warmup(self):
        await asyncio.to_thread(self._worker.call, self.id, "warmup")

    async def synthesize(self, words, lang, speed, voice_id):
        return await asyncio.to_thread(
            self._worker.call, self.id, "synthesize", words, lang, speed, voice_id
        )

    def unload(self):
        if self._worker.engine_id == self.id:
            self._worker.close()


class WorkerAligner:
    def __init__(self, aligner, worker: InferenceWorker):
        self._aligner, self._worker = aligner, worker

    def __getattr__(self, name):
        return getattr(self._aligner, name)

    @property
    def loaded(self):
        return self._worker.aligner_loaded

    def load(self):
        self._worker.call(self._worker.engine_id or "aligner", "aligner")

    def unload(self):
        self._worker.close()

    def remove(self):
        self.unload()
        return self._aligner.remove()
