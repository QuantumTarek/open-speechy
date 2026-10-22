from __future__ import annotations

from typing import Any


def audio_samples(audio: Any) -> list[float]:
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    if hasattr(audio, "squeeze"):
        audio = audio.squeeze()
    if hasattr(audio, "reshape"):
        audio = audio.reshape(-1)
    samples = [float(sample) for sample in audio]
    if not samples:
        raise ValueError("Chatterbox returned no audio.")
    return samples


def change_speed(samples: list[float], speed: float) -> list[float]:
    if speed == 1:
        return samples
    import librosa
    import numpy

    stretched = librosa.effects.time_stretch(
        numpy.asarray(samples, dtype=numpy.float32),
        rate=speed,
    )
    return [float(sample) for sample in stretched]
