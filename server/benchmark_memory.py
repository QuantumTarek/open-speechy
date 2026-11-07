"""Offline lifecycle smoke test: python -m server.benchmark_memory.

Uses the installed Kokoro model. Verifies repeated synthesis and worker reclamation;
this is not a long-duration leak benchmark or a measurement of peak memory.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time

from .engines.registry import EngineRegistry


async def benchmark(cycles: int = 3) -> None:
    registry = EngineRegistry()
    try:
        for cycle in range(cycles):
            start = time.monotonic()
            result = await registry.synthesize(
                "server:kokoro:af_heart",
                "en",
                ["This", "is", "a", "memory", "test."],
                1.0,
            )
            assert result.audio_wav.startswith(b"RIFF") and result.timings
            worker_pid = registry._worker._process.pid
            assert "torch" not in sys.modules
            assert registry.release_idle(0)
            assert registry._worker.engine_id is None
            try:
                os.kill(worker_pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise AssertionError("Worker survived cleanup")
            print(
                json.dumps(
                    {
                        "cycle": cycle + 1,
                        "wav_bytes": len(result.audio_wav),
                        "seconds": round(time.monotonic() - start, 2),
                        "worker_exited": True,
                        "torch_in_parent": False,
                    }
                ),
                flush=True,
            )
    finally:
        registry.close()


if __name__ == "__main__":
    os.environ["HF_HUB_OFFLINE"] = "1"
    asyncio.run(benchmark())
