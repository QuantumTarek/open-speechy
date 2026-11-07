from __future__ import annotations

from typing import Any

import numpy as np


def audio_samples(audio: Any) -> np.ndarray:
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    if hasattr(audio, "squeeze"):
        audio = audio.squeeze()
    if hasattr(audio, "reshape"):
        audio = audio.reshape(-1)
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    if not samples.size:
        raise ValueError("Chatterbox returned no audio.")
    return samples


def change_speed(samples: np.ndarray, speed: float) -> np.ndarray:
    if speed == 1:
        return samples
    import librosa
    import numpy

    stretched = librosa.effects.time_stretch(
        numpy.asarray(samples, dtype=numpy.float32),
        rate=speed,
    )
    return np.asarray(stretched, dtype=np.float32)
