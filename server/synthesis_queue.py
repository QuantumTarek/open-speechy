from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable


class DuplicateRequestError(RuntimeError):
    pass


class QueueFullError(RuntimeError):
    pass


class SynthesisQueue:
    def __init__(self, max_jobs: int = 8) -> None:
        self._semaphore = asyncio.Semaphore(1)
        self._max_jobs = max_jobs
        self._jobs: dict[str, tuple[str, asyncio.Task[object]]] = {}

    async def run(
        self,
        engine_id: str,
        request_id: str,
        operation: Callable[[], Awaitable[object]],
    ) -> object:
        if request_id in self._jobs:
            raise DuplicateRequestError("Request ID is already active.")

        if len(self._jobs) >= self._max_jobs:
            raise QueueFullError("Speech queue is full; retry shortly.")
        semaphore = self._semaphore

        async def execute() -> object:
            async with semaphore:
                # Cancelling an asyncio waiter cannot stop native inference.
                # Keep ownership until its worker actually finishes.
                worker = asyncio.create_task(operation())
                try:
                    return await asyncio.shield(worker)
                except asyncio.CancelledError:
                    while not worker.done():
                        try:
                            await asyncio.shield(worker)
                        except asyncio.CancelledError:
                            continue
                        except Exception:  # noqa: BLE001 - preserve the cancellation result.
                            break
                    if not worker.cancelled():
                        worker.exception()
                    raise

        task = asyncio.create_task(execute())
        self._jobs[request_id] = (engine_id, task)
        try:
            return await task
        finally:
            if self._jobs.get(request_id, (None, None))[1] is task:
                self._jobs.pop(request_id, None)

    def cancel(self, request_id: str) -> bool:
        job = self._jobs.get(request_id)
        if job is None:
            return False
        job[1].cancel()
        return True

    def active_count(self, engine_id: str | None = None) -> int:
        return sum(
            1
            for job_engine, task in self._jobs.values()
            if not task.done() and (engine_id is None or job_engine == engine_id)
        )
