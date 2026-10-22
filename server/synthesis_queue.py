from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable


class DuplicateRequestError(RuntimeError):
    pass


class SynthesisQueue:
    def __init__(self) -> None:
        self._semaphores: dict[str, asyncio.Semaphore] = {}
        self._jobs: dict[str, tuple[str, asyncio.Task[object]]] = {}

    async def run(
        self,
        engine_id: str,
        request_id: str,
        operation: Callable[[], Awaitable[object]],
    ) -> object:
        if request_id in self._jobs:
            raise DuplicateRequestError("Request ID is already active.")

        semaphore = self._semaphores.setdefault(engine_id, asyncio.Semaphore(1))

        async def execute() -> object:
            async with semaphore:
                return await operation()

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
