from __future__ import annotations

import asyncio
import os
import stat
import tempfile
import unittest

from server.align import estimated_word_timings
from server.auth import AuthManager, PairingManager
from server.synthesis_queue import DuplicateRequestError, SynthesisQueue


class AuthTests(unittest.TestCase):
    def test_token_is_created_once_with_private_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "token")
            auth = AuthManager(token_path=path)

            first = auth.token
            second = AuthManager(token_path=path).token

            self.assertEqual(first, second)
            self.assertGreaterEqual(len(first), 40)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_pairing_code_exchanges_once_and_expires(self) -> None:
        now = [10.0]
        auth = AuthManager(token="local-secret", extension_id="b" * 32)
        pairing = PairingManager(auth, ttl_seconds=5, now=lambda: now[0])
        code = pairing.current_code()

        self.assertEqual(len(code), 6)
        self.assertEqual(pairing.exchange(code), "local-secret")
        self.assertIsNone(pairing.exchange(code))

        next_code = pairing.current_code()
        now[0] += 6
        self.assertIsNone(pairing.exchange(next_code))


class TimingTests(unittest.TestCase):
    def test_estimated_timings_are_monotonic_and_cover_the_audio(self) -> None:
        timings = estimated_word_timings(["مرحبا،", "بالعالم."], 800, "ar")

        self.assertEqual(timings[0]["startMs"], 0)
        self.assertEqual(timings[0]["endMs"], timings[1]["startMs"])
        self.assertEqual(timings[-1]["endMs"], 800)


class QueueTests(unittest.TestCase):
    def test_one_request_per_engine_runs_at_a_time(self) -> None:
        async def run() -> None:
            queue = SynthesisQueue()
            active = 0
            peak = 0

            async def operation() -> object:
                nonlocal active, peak
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.01)
                active -= 1
                return object()

            await asyncio.gather(
                queue.run("kokoro", "first", operation),
                queue.run("kokoro", "second", operation),
            )
            self.assertEqual(peak, 1)

        asyncio.run(run())

    def test_duplicate_ids_and_cancelled_jobs_are_reported(self) -> None:
        async def run() -> None:
            queue = SynthesisQueue()
            started = asyncio.Event()
            pending = asyncio.Event()

            async def operation() -> object:
                started.set()
                await pending.wait()
                return object()

            task = asyncio.create_task(queue.run("silma", "active", operation))
            await started.wait()
            with self.assertRaises(DuplicateRequestError):
                await queue.run("silma", "active", operation)

            self.assertTrue(queue.cancel("active"))
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertFalse(queue.cancel("active"))

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
