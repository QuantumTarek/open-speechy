from __future__ import annotations

import asyncio
import importlib.util
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..align import estimated_word_timings, forced_align_words
from ..model_store import detect_torch_device, download_snapshot
from .base import EngineUnavailable, Synthesis, float_pcm_to_wav
from .chatterbox_utils import audio_samples, change_speed


class ChatterboxMultilingualEngine:
    id = "chatterbox_ml"
    langs = ("ar",)

    def __init__(
        self,
        model_factory: Callable[[Path, str], object] | None = None,
        snapshot_provider: Callable[[str], Path] = download_snapshot,
    ) -> None:
        self._model_factory = model_factory
        self._snapshot_provider = snapshot_provider
        self._model: object | None = None
        self.loaded = False
        self.available = (
            model_factory is not None
            or importlib.util.find_spec("chatterbox") is not None
        )

    def voices(self) -> list[dict[str, object]]:
        if not self.available:
            return []
        return [
            {
                "id": "server:chatterbox_ml:default",
                "engineId": "server",
                "lang": "ar",
                "name": "Chatterbox Multilingual (experimental)",
                "quality": "standard",
                "local": True,
                "supportsWordTimings": False,
                "installed": self.loaded,
            }
        ]

    async def warmup(self) -> None:
        if not self.available:
            raise EngineUnavailable(
                "Install the pinned Chatterbox server engine with `uv sync --extra engines`."
            )
        await asyncio.to_thread(self._load_model)

    async def synthesize(
        self,
        words: list[str],
        lang: str,
        speed: float,
        voice_id: str,
    ) -> Synthesis:
        del voice_id
        if lang != "ar" or not words:
            raise EngineUnavailable("Chatterbox Multilingual is configured for Arabic.")
        if not self.loaded:
            await self.warmup()
        samples = await asyncio.to_thread(self._generate, " ".join(words), speed)
        sample_rate = int(self._model.sr)
        audio_wav = float_pcm_to_wav(samples, sample_rate)
        duration_ms = len(samples) / sample_rate * 1_000
        timings = forced_align_words(audio_wav, words, sample_rate, lang)
        return Synthesis(
            audio_wav=audio_wav,
            sample_rate=sample_rate,
            timings=timings or estimated_word_timings(words, duration_ms, lang),
            timing_source="aligned" if timings else "estimated",
        )

    def _load_model(self) -> None:
        if self._model is not None:
            self.loaded = True
            return
        snapshot = self._snapshot_provider("chatterbox_ml")
        device = detect_torch_device()
        if self._model_factory is not None:
            self._model = self._model_factory(snapshot, device)
        else:
            try:
                from chatterbox.mtl_tts import ChatterboxMultilingualTTS

                self._model = ChatterboxMultilingualTTS.from_local(
                    snapshot,
                    device,
                )
            except Exception as error:
                raise EngineUnavailable(
                    "Could not load the pinned Chatterbox Multilingual model."
                ) from error
        self.loaded = True

    def _generate(self, text: str, speed: float) -> list[float]:
        if self._model is None:
            raise EngineUnavailable("Chatterbox Multilingual has not been loaded.")
        try:
            audio: Any = self._model.generate(text, language_id="ar")
            return change_speed(audio_samples(audio), speed)
        except Exception as error:
            raise EngineUnavailable("Chatterbox Multilingual synthesis failed.") from error
