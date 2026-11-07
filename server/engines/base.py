from __future__ import annotations

import io
import wave
from dataclasses import dataclass
from typing import Protocol

import numpy as np


class EngineUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class Synthesis:
    audio_wav: bytes
    sample_rate: int
    timings: list[dict[str, float | int]]
    timing_source: str = "estimated"


class SpeechEngine(Protocol):
    id: str
    langs: tuple[str, ...]
    loaded: bool
    available: bool

    def voices(self) -> list[dict[str, object]]: ...

    async def warmup(self) -> None: ...

    async def synthesize(
        self,
        words: list[str],
        lang: str,
        speed: float,
        voice_id: str,
    ) -> Synthesis: ...


def float_pcm_to_wav(samples, sample_rate: int) -> bytes:
    output = io.BytesIO()
    # Work in bounded blocks; never create one Python object per audio sample.
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        for start in range(0, samples.size, 65_536):
            block = np.nan_to_num(
                samples[start : start + 65_536],
                copy=True,
                nan=0.0,
                posinf=1.0,
                neginf=-1.0,
            )
            np.clip(block, -1.0, 1.0, out=block)
            block *= 32767
            np.rint(block, out=block)
            wav_file.writeframesraw(block.astype("<i2").tobytes())
    return output.getvalue()
