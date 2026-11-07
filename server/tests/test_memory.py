import asyncio
from types import SimpleNamespace

from server.engines.registry import EngineRegistry
from server.synthesis_queue import SynthesisQueue


def test_idle_release_preserves_busy_models():
    class Model:
        id = "test"
        loaded = True

        def unload(self):
            self.loaded = False

    model = Model()
    aligner = Model()
    registry = EngineRegistry([model], aligner=aligner)
    registry._active = 1
    assert not registry.release_idle(0)
    assert model.loaded
    registry._active = 0
    registry._tasks["test"] = SimpleNamespace()
    assert not registry.release_idle(0)
    registry._tasks.clear()
    assert registry.release_idle(0)
    assert not model.loaded and not aligner.loaded
    assert not registry.release_idle(0)


def test_cancel_keeps_slot_until_worker_finishes():
    async def scenario():
        queue = SynthesisQueue()
        started, finish, second_started = (asyncio.Event() for _ in range(3))

        async def first():
            started.set()
            await finish.wait()

        async def second():
            second_started.set()

        task = asyncio.create_task(queue.run("engine", "first", first))
        await started.wait()
        assert queue.cancel("first")
        next_task = asyncio.create_task(queue.run("engine", "second", second))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not second_started.is_set()
        assert queue.active_count() == 2
        finish.set()
        results = await asyncio.gather(task, next_task, return_exceptions=True)
        assert isinstance(results[0], asyncio.CancelledError)
        assert second_started.is_set()
        assert queue.active_count() == 0

    asyncio.run(scenario())


def test_global_queue_limit_and_cross_engine_serialization():
    from server.synthesis_queue import QueueFullError

    async def scenario():
        queue = SynthesisQueue(max_jobs=2)
        started, finish, second_started = (asyncio.Event() for _ in range(3))

        async def first():
            started.set()
            await finish.wait()

        async def second():
            second_started.set()

        task = asyncio.create_task(queue.run("a", "one", first))
        await started.wait()
        other = asyncio.create_task(queue.run("b", "two", second))
        await asyncio.sleep(0)
        try:
            await queue.run("c", "three", second)
        except QueueFullError:
            pass
        else:
            raise AssertionError("Queue must reject overflow")
        assert not second_started.is_set()
        queue.cancel("two")
        await asyncio.gather(other, return_exceptions=True)
        assert queue.active_count() == 1
        finish.set()
        await task
        await queue.run("c", "four", second)
        assert second_started.is_set()

    asyncio.run(scenario())


def fake_worker(connection, engine_id):
    import os

    try:
        while True:
            method, _args = connection.recv()
            if method == "hang":
                connection.recv()
            if method == "crash":
                os._exit(1)
            connection.send((True, (os.getpid(), engine_id), False))
    except EOFError:
        pass


def test_worker_switch_exit_and_crash_recovery():
    import pytest
    from server.engines.base import EngineUnavailable
    from server.inference_worker import InferenceWorker

    worker = InferenceWorker(target=fake_worker, timeout=5)
    try:
        first_pid, _ = worker.call("a", "warmup")
        assert worker.loaded("a")
        assert worker.call("a", "synthesize")[0] == first_pid
        second_pid, engine = worker.call("b", "warmup")
        assert second_pid != first_pid and engine == "b"
        assert not worker.loaded("a")
        with pytest.raises(EngineUnavailable):
            worker.call("b", "crash")
        assert not worker.loaded("b")
        assert worker.call("b", "warmup")[0] != second_pid
    finally:
        worker.close()
    assert not worker.loaded("b")
    assert worker.engine_id is None


def test_pcm_encoding_is_clipped_little_endian_and_chunked():
    import io
    import wave

    import numpy as np
    from server.engines.base import float_pcm_to_wav
    from server.engines.chatterbox_utils import audio_samples

    samples = audio_samples([-2, -1, 0, 1, 2])
    assert samples.dtype == np.float32
    samples = np.tile(samples, 20_000)
    encoded = float_pcm_to_wav(samples, 24_000)
    with wave.open(io.BytesIO(encoded)) as wav:
        assert wav.getnframes() == 100_000
        assert wav.getframerate() == 24_000
        decoded = np.frombuffer(wav.readframes(100_000), dtype="<i2")
    assert decoded[:5].tolist() == [-32767, -32767, 0, 32767, 32767]


def test_worker_timeout_reclaims_process():
    import pytest
    from server.engines.base import EngineUnavailable
    from server.inference_worker import InferenceWorker

    worker = InferenceWorker(target=fake_worker, timeout=5)
    try:
        worker.call("a", "warmup")
        worker._timeout = 0.05
        with pytest.raises(EngineUnavailable):
            worker.call("a", "hang")
        assert worker.engine_id is None
        assert worker._process is None
    finally:
        worker.close()
