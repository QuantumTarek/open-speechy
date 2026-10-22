from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import io
import os
from collections.abc import Callable
from importlib.resources import files
from pathlib import Path
from typing import Any

from ..align import estimated_word_timings, forced_align_words
from ..model_store import detect_torch_device, download_snapshot, local_model_file
from .base import EngineUnavailable, Synthesis, float_pcm_to_wav


class SilmaEngine:
    id = "silma"
    langs = ("ar", "en")

    def __init__(
        self,
        model_factory: Callable[[Path, Path, str], object] | None = None,
        snapshot_provider: Callable[[str], Path] = download_snapshot,
        steps: int | None = None,
        reference_audio: str | None = None,
    ) -> None:
        self._model_factory = model_factory
        self._snapshot_provider = snapshot_provider
        self._steps = steps or int(os.environ.get("OPEN_SPEECHY_SILMA_STEPS", "16"))
        self._reference_audio = reference_audio
        self._model: object | None = None
        self.loaded = False
        self.available = (
            model_factory is not None
            or importlib.util.find_spec("silma_tts") is not None
        )

    def voices(self) -> list[dict[str, object]]:
        if not self.available:
            return []
        return [
            {
                "id": "server:silma:default",
                "engineId": "server",
                "lang": lang,
                "name": "SILMA Arabic" if lang == "ar" else "SILMA English",
                "quality": "standard",
                "local": True,
                "supportsWordTimings": False,
                "installed": self.loaded,
            }
            for lang in self.langs
        ]

    async def warmup(self) -> None:
        if not self.available:
            raise EngineUnavailable(
                "Install the pinned SILMA server engine with `uv sync --extra engines`."
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
        if lang not in self.langs or not words:
            raise EngineUnavailable(f"SILMA does not support {lang}.")
        if not self.loaded:
            await self.warmup()
        samples, sample_rate = await asyncio.to_thread(
            self._generate,
            " ".join(words),
            lang,
            speed,
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
        model_snapshot = self._snapshot_provider("silma")
        vocoder_snapshot = self._snapshot_provider("silma_vocoder")
        device = detect_torch_device()
        if self._model_factory is not None:
            self._model = self._model_factory(
                model_snapshot,
                vocoder_snapshot,
                device,
            )
        else:
            self._model = self._load_pinned_silma(
                model_snapshot,
                vocoder_snapshot,
                device,
            )
        self.loaded = True

    def _load_pinned_silma(
        self,
        model_snapshot: Path,
        vocoder_snapshot: Path,
        device: str,
    ) -> object:
        try:
            import silma_tts.api as silma_api
            import silma_tts.infer.utils_infer as silma_utils
        except ImportError as error:
            raise EngineUnavailable(
                "Install the pinned SILMA server engine with `uv sync --extra engines`."
            ) from error

        original_cached_path = silma_api.cached_path
        original_hf_download = silma_utils.hf_hub_download

        def resolve_silma_file(url: str, cache_dir: str | None = None, **kwargs: Any):
            prefix = "hf://silma-ai/silma-tts/"
            if url.startswith(prefix):
                return str(local_model_file("silma", model_snapshot, url[len(prefix) :]))
            return original_cached_path(url, cache_dir=cache_dir, **kwargs)

        def resolve_vocoder_file(
            repo_id: str,
            filename: str,
            *args: Any,
            **kwargs: Any,
        ):
            if repo_id == "charactr/vocos-mel-24khz":
                return str(
                    local_model_file("silma_vocoder", vocoder_snapshot, filename)
                )
            return original_hf_download(repo_id, filename, *args, **kwargs)

        silma_api.cached_path = resolve_silma_file
        silma_utils.hf_hub_download = resolve_vocoder_file
        try:
            return silma_api.SilmaTTS(
                device=device,
                enable_normalizer=False,
                force_tashkeel=False,
            )
        except Exception as error:
            raise EngineUnavailable(
                "Could not load the pinned SILMA model and vocoder."
            ) from error
        finally:
            silma_api.cached_path = original_cached_path
            silma_utils.hf_hub_download = original_hf_download

    def _generate(
        self,
        text: str,
        lang: str,
        speed: float,
    ) -> tuple[list[float], int]:
        if self._model is None:
            raise EngineUnavailable("SILMA has not been loaded.")
        reference = self._reference_audio or os.fspath(
            files("silma_tts").joinpath("infer/ref_audio_samples/ar.ref.24k.wav")
        )
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
                io.StringIO()
            ):
                audio, sample_rate, _ = self._model.infer(
                    ref_file=reference,
                    ref_text=(
                        "ويدقق النظر في القرآن الكريم وسائر الكتب السماوية ويتبع "
                        "مسالك الرسل العظام عليهم الصلاة والسلام."
                    ),
                    gen_text=text,
                    nfe_step=self._steps,
                    speed=speed,
                    normalize_numbers=False,
                    force_tashkeel=False,
                    show_info=lambda *_: None,
                )
        except Exception as error:
            raise EngineUnavailable("SILMA synthesis failed.") from error
        if hasattr(audio, "detach"):
            audio = audio.detach().cpu().numpy()
        if hasattr(audio, "reshape"):
            audio = audio.reshape(-1)
        samples = [float(sample) for sample in audio]
        if not samples:
            raise EngineUnavailable("SILMA returned no audio.")
        return samples, int(sample_rate)

    async def dispose(self) -> None:
        self._model = None
        self.loaded = False
