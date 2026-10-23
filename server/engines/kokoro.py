from __future__ import annotations

import asyncio
import importlib.util
from collections.abc import Callable
from pathlib import Path

from ..align import estimated_word_timings, forced_align_words, token_word_timings
from ..model_store import download_snapshot
from .base import EngineUnavailable, Synthesis, float_pcm_to_wav

KOKORO_REPO = "hexgrad/Kokoro-82M"
SAMPLE_RATE = 24_000
KOKORO_ACCENTS = {"a": "American", "b": "British"}

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
    title = "Kokoro"
    langs = ("en",)
    models = ("kokoro",)
    # Kokoro times its words from its own duration predictions, so it does not
    # need the word aligner.
    aligns_words = False

    def __init__(
        self,
        pipeline_factory: Callable[..., object] | None = None,
        snapshot_provider: Callable[[str], Path] = download_snapshot,
    ) -> None:
        self._pipeline_factory = pipeline_factory
        self._snapshot_provider = snapshot_provider
        self._pipelines: dict[str, object] = {}
        self._voice_dir: Path | None = None
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
                "name": voice.split("_", 1)[1].capitalize(),
                "description": (
                    f"{KOKORO_ACCENTS[voice[0]]} · "
                    f"{'male' if voice[1] == 'm' else 'female'} · Kokoro"
                ),
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
        samples, tokens = await asyncio.to_thread(
            self._generate,
            " ".join(words),
            speed,
            voice_id.rsplit(":", 1)[-1],
        )
        duration_ms = len(samples) / SAMPLE_RATE * 1_000
        audio_wav = float_pcm_to_wav(samples, SAMPLE_RATE)
        timings = token_word_timings(words, tokens)
        timing_source = "model"
        if not timings:
            timings = forced_align_words(audio_wav, words, SAMPLE_RATE, lang)
            timing_source = "aligned"
        if not timings:
            timings = estimated_word_timings(words, duration_ms, lang)
            timing_source = "estimated"
        return Synthesis(
            audio_wav=audio_wav,
            sample_rate=SAMPLE_RATE,
            timings=timings,
            timing_source=timing_source,
        )

    def _load_pipeline(self) -> None:
        if self._pipelines:
            self.loaded = True
            return
        snapshot = self._snapshot_provider("kokoro")
        factory = self._pipeline_factory or _pinned_pipeline_factory(snapshot)
        # One G2P pipeline per accent: "a" (American) and "b" (British) voices.
        self._pipelines = {code: factory(lang_code=code) for code in ("a", "b")}
        self._voice_dir = snapshot / "voices"
        self.loaded = True

    def unload(self) -> None:
        self._pipelines = {}
        self._voice_dir = None
        self.loaded = False

    def _generate(
        self, text: str, speed: float, voice_id: str
    ) -> tuple[list[float], list[tuple[str, float | None, float | None]]]:
        """Audio samples, and each token's text with its start and end in seconds."""
        if not self._pipelines or self._voice_dir is None:
            raise EngineUnavailable("Kokoro has not been loaded.")
        if voice_id not in KOKORO_VOICES:
            raise EngineUnavailable(f"Unknown Kokoro voice: {voice_id}")
        pipeline = self._pipelines[voice_id[0]]
        voice_file = str(self._voice_dir / f"{voice_id}.pt")
        chunks: list[float] = []
        tokens: list[tuple[str, float | None, float | None]] = []
        output = pipeline(text, voice=voice_file, speed=speed)
        for result in output:
            _, _, audio = result
            # A long text comes back in parts, each timed from its own start.
            offset = len(chunks) / SAMPLE_RATE
            for token in getattr(result, "tokens", None) or ():
                start, end = token.start_ts, token.end_ts
                timed = start is not None and end is not None
                tokens.append(
                    (
                        token.text,
                        offset + start if timed else None,
                        offset + end if timed else None,
                    )
                )
            if hasattr(audio, "detach"):
                audio = audio.detach().cpu().numpy()
            if hasattr(audio, "reshape"):
                audio = audio.reshape(-1)
            chunks.extend(float(sample) for sample in audio)
        if not chunks:
            raise EngineUnavailable("Kokoro returned no audio.")
        return chunks, tokens


def _pinned_pipeline_factory(snapshot: Path) -> Callable[..., object]:
    try:
        from kokoro import KModel, KPipeline
    except ImportError as error:
        raise EngineUnavailable(
            "Install the pinned Kokoro server engine with `uv sync --extra engines`."
        ) from error
    # Kokoro only accepts Hub repo IDs, not local paths, so pass the pinned
    # snapshot files explicitly to keep it from downloading anything.
    model = KModel(
        repo_id=KOKORO_REPO,
        config=str(snapshot / "config.json"),
        model=str(snapshot / "kokoro-v1_0.pth"),
    ).eval()

    def create(lang_code: str) -> object:
        return KPipeline(lang_code=lang_code, repo_id=KOKORO_REPO, model=model)

    return create
