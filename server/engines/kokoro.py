from __future__ import annotations

import asyncio
import importlib.util
import os
from collections.abc import Callable

from ..align import estimated_word_timings
from .base import EngineUnavailable, Synthesis, float_pcm_to_wav


class KokoroEngine:
    id = "kokoro"
    langs = ("en",)

    def __init__(
        self,
        pipeline_factory: Callable[..., object] | None = None,
    ) -> None:
        self._pipeline_factory = pipeline_factory
        self._pipeline: object | None = None
        self.loaded = False
        self.available = (
            os.environ.get("OPEN_SPEECHY_ALLOW_UNVERIFIED_MODELS") == "1"
            and (
                pipeline_factory is not None
                or importlib.util.find_spec("kokoro") is not None
            )
        )

    def voices(self) -> list[dict[str, object]]:
        if not self.available:
            return []
        return [
            {
                "id": "server:kokoro:af_heart",
                "engineId": "server",
                "lang": "en",
                "name": "Kokoro Heart",
                "quality": "standard",
                "local": True,
                "supportsWordTimings": False,
                "installed": self.loaded,
            }
        ]

    async def warmup(self) -> None:
        if not self.available:
            raise EngineUnavailable(
                "Kokoro server weights are disabled until their revision and "
                "checksums are verified. Set OPEN_SPEECHY_ALLOW_UNVERIFIED_MODELS=1 "
                "only for local testing."
            )
        await asyncio.to_thread(self._load_pipeline)

    async def synthesize(
        self,
        words: list[str],
        lang: str,
        speed: float,
        voice_id: str,
    ) -> Synthesis:
        if lang != "en" or not words:
            raise EngineUnavailable("Kokoro server voice supports English only.")
        if not self.loaded:
            await self.warmup()
        samples = await asyncio.to_thread(
            self._generate,
            " ".join(words),
            speed,
            voice_id.rsplit(":", 1)[-1],
        )
        sample_rate = 24_000
        duration_ms = len(samples) / sample_rate * 1_000
        return Synthesis(
            audio_wav=float_pcm_to_wav(samples, sample_rate),
            sample_rate=sample_rate,
            timings=estimated_word_timings(words, duration_ms, lang),
        )

    def _load_pipeline(self) -> None:
        if self._pipeline is not None:
            self.loaded = True
            return
        factory = self._pipeline_factory
        if factory is None:
            try:
                from kokoro import KPipeline
            except ImportError as error:
                raise EngineUnavailable(
                    "Install the optional Kokoro server dependency first."
                ) from error
            factory = KPipeline
        self._pipeline = factory(lang_code="a")
        self.loaded = True

    def _generate(self, text: str, speed: float, voice_id: str) -> list[float]:
        if self._pipeline is None:
            raise EngineUnavailable("Kokoro has not been loaded.")
        chunks: list[float] = []
        output = self._pipeline(text, voice=voice_id, speed=speed)
        for _, _, audio in output:
            if hasattr(audio, "detach"):
                audio = audio.detach().cpu().numpy()
            if hasattr(audio, "reshape"):
                audio = audio.reshape(-1)
            chunks.extend(float(sample) for sample in audio)
        if not chunks:
            raise EngineUnavailable("Kokoro returned no audio.")
        return chunks
