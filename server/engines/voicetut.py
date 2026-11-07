from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import io
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from ..align import estimated_word_timings, forced_align_words
from ..model_store import detect_torch_device, download_snapshot
from .base import EngineUnavailable, Synthesis, float_pcm_to_wav
from .chatterbox_utils import audio_samples

# Built-in speakers in the pinned model's reference_speakers/references.json,
# as (voice ID key, speaker_name). The model looks speakers up by speaker_name,
# which does not always match the audio file name: tarek.wav is "Tareq". The
# key stays "tarek" so saved voice preferences keep working.
VOICETUT_SPEAKERS = (
    ("ahmed", "Ahmed"),
    ("ali", "Ali"),
    ("hassan", "Hassan"),
    ("karim", "Karim"),
    ("mahmoud", "Mahmoud"),
    ("mohammed", "Mohammed"),
    ("mostafa", "Mostafa"),
    ("ramy", "Ramy"),
    ("shaker", "Shaker"),
    ("tarek", "Tareq"),
    ("yehia", "Yehia"),
    ("youssef", "Youssef"),
    ("hadeer", "Hadeer"),
    ("hanan", "Hanan"),
    ("mariam", "Mariam"),
    ("rana", "Rana"),
    ("sarah", "Sarah"),
    ("yara", "Yara"),
    ("yasmin", "Yasmin"),
)
DEFAULT_SPEAKER = "mohammed"


class VoiceTutEngine:
    """Egyptian Arabic speech from VoiceTut-TTS, a fine-tuned OmniVoice model."""

    id = "voicetut"
    title = "VoiceTut Egyptian Arabic"
    langs = ("ar",)
    models = ("voicetut",)

    def __init__(
        self,
        model_factory: Callable[[Path, str], object] | None = None,
        snapshot_provider: Callable[[str], Path] = download_snapshot,
        steps: int | None = None,
    ) -> None:
        self._model_factory = model_factory
        self._snapshot_provider = snapshot_provider
        self._steps = steps or int(os.environ.get("OPEN_SPEECHY_VOICETUT_STEPS", "16"))
        self._model: Any = None
        self.loaded = False
        self.available = model_factory is not None or (
            importlib.util.find_spec("voicetut_tts") is not None
            and importlib.util.find_spec("omnivoice") is not None
        )

    def voices(self) -> list[dict[str, object]]:
        if not self.available:
            return []
        return [
            {
                "id": f"server:voicetut:{speaker}",
                "engineId": "server",
                "lang": "ar",
                "name": f"{speaker_name} (Egyptian)",
                "quality": "standard",
                "local": True,
                "supportsWordTimings": False,
                "installed": self.loaded,
            }
            for speaker, speaker_name in VOICETUT_SPEAKERS
        ]

    async def warmup(self) -> None:
        if not self.available:
            raise EngineUnavailable(
                "Install the pinned VoiceTut server engine with `uv sync --extra engines`."
            )
        await asyncio.to_thread(self._load_model)

    async def synthesize(
        self,
        words: list[str],
        lang: str,
        speed: float,
        voice_id: str,
    ) -> Synthesis:
        if lang != "ar" or not words:
            raise EngineUnavailable("VoiceTut speaks Egyptian Arabic only.")
        key = voice_id.split(":", 2)[2] if voice_id.count(":") >= 2 else ""
        speakers = dict(VOICETUT_SPEAKERS)
        speaker = speakers.get(key, speakers[DEFAULT_SPEAKER])
        if not self.loaded:
            await self.warmup()
        samples, sample_rate = await asyncio.to_thread(
            self._generate, " ".join(words), speaker, speed
        )
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
        snapshot = self._snapshot_provider("voicetut")
        device = detect_torch_device()
        if self._model_factory is not None:
            self._model = self._model_factory(snapshot, device)
        else:
            try:
                from voicetut_tts import VoiceTutTTS

                self._model = VoiceTutTTS.from_pretrained(
                    os.fspath(snapshot),
                    references=os.fspath(
                        snapshot / "reference_speakers" / "references.json"
                    ),
                    device=device,
                    # Half precision is about twice as fast on CUDA and Apple
                    # GPUs; CPUs need full precision.
                    dtype="float32" if device == "cpu" else "float16",
                    language="arz",
                )
            except Exception as error:
                raise EngineUnavailable(
                    "Could not load the pinned VoiceTut model."
                ) from error
        self.loaded = True

    def _generate(
        self, text: str, speaker: str, speed: float
    ) -> tuple[np.ndarray, int]:
        if self._model is None:
            raise EngineUnavailable("VoiceTut has not been loaded.")
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                audio = self._model.synthesize(
                    text,
                    speaker=speaker,
                    language="arz",
                    num_step=self._steps,
                    speed=speed,
                )
            samples = audio_samples(audio)
        except Exception as error:
            raise EngineUnavailable("VoiceTut synthesis failed.") from error
        return samples, int(getattr(self._model, "sampling_rate", 24_000))

    def unload(self) -> None:
        self._model = None
        self.loaded = False

    async def dispose(self) -> None:
        self.unload()
