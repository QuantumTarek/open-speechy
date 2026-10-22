from __future__ import annotations

import asyncio
import importlib.util
from collections.abc import Callable
from pathlib import Path

from ..align import estimated_word_timings, forced_align_words
from ..model_store import download_snapshot
from .base import EngineUnavailable, Synthesis, float_pcm_to_wav

KOKORO_VOICES = (
    "af_heart",
    "af_alloy",
    "af_aoede",
    "af_bella",
    "af_jessica",
    "af_kore",
    "af_nicole",
    "af_nova",
    "af_river",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_echo",
    "am_eric",
    "am_fenrir",
    "am_liam",
    "am_michael",
    "am_onyx",
    "am_puck",
    "am_santa",
    "bf_alice",
    "bf_emma",
    "bf_isabella",
    "bf_lily",
    "bm_daniel",
    "bm_fable",
    "bm_george",
    "bm_lewis",
)


class KokoroEngine:
    id = "kokoro"
    langs = ("en",)

    def __init__(
        self,
        pipeline_factory: Callable[..., object] | None = None,
        snapshot_provider: Callable[[str], Path] = download_snapshot,
    ) -> None:
        self._pipeline_factory = pipeline_factory
        self._snapshot_provider = snapshot_provider
        self._pipeline: object | None = None
        self.loaded = False
        self.available = (
            pipeline_factory is not None
            or importlib.util.find_spec("kokoro") is not None
        )

    def voices(self) -> list[dict[str, object]]:
        if not self.available:
            return []
        return [
            {
                "id": f"server:kokoro:{voice}",
                "engineId": "server",
                "lang": "en",
                "name": f"Kokoro {voice}",
                "quality": "standard",
                "local": True,
                "supportsWordTimings": False,
                "installed": self.loaded,
            }
            for voice in KOKORO_VOICES
        ]

    async def warmup(self) -> None:
        if not self.available:
            raise EngineUnavailable(
                "Install the pinned Kokoro server engine with `uv sync --extra engines`."
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
        audio_wav = float_pcm_to_wav(samples, sample_rate)
        timings = forced_align_words(audio_wav, words, sample_rate, lang)
        return Synthesis(
            audio_wav=audio_wav,
            sample_rate=sample_rate,
            timings=timings or estimated_word_timings(words, duration_ms, lang),
            timing_source="aligned" if timings else "estimated",
        )

    def _load_pipeline(self) -> None:
        if self._pipeline is not None:
            self.loaded = True
            return
        factory = self._pipeline_factory
        snapshot = self._snapshot_provider("kokoro")
        if factory is None:
            try:
                from kokoro import KPipeline
            except ImportError as error:
                raise EngineUnavailable(
                    "Install the pinned Kokoro server engine with `uv sync --extra engines`."
                ) from error
            factory = KPipeline
        self._pipeline = factory(lang_code="a", repo_id=str(snapshot))
        self.loaded = True

    def _generate(self, text: str, speed: float, voice_id: str) -> list[float]:
        if self._pipeline is None:
            raise EngineUnavailable("Kokoro has not been loaded.")
        if voice_id not in KOKORO_VOICES:
            raise EngineUnavailable(f"Unknown Kokoro voice: {voice_id}")
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
