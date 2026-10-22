from __future__ import annotations

import io
import struct
import wave
from dataclasses import dataclass
from typing import Protocol


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


def float_pcm_to_wav(samples: list[float], sample_rate: int) -> bytes:
    output = io.BytesIO()
    pcm = bytearray()
    for sample in samples:
        clamped = max(-1.0, min(1.0, sample))
        pcm.extend(struct.pack("<h", round(clamped * 32767)))
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm)
    return output.getvalue()
