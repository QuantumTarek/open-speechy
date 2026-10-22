from __future__ import annotations

import re
from collections.abc import Sequence

ARABIC_MARKS = re.compile(r"[\u064b-\u065f\u0670]")


def estimated_word_timings(
    words: Sequence[str],
    duration_ms: float,
    lang: str,
) -> list[dict[str, float | int]]:
    if not words or duration_ms <= 0:
        return []

    weights: list[int] = []
    for word in words:
        if lang == "ar":
            letters = len(
                [
                    char
                    for char in ARABIC_MARKS.sub("", word)
                    if char.isalpha() or char.isdigit()
                ]
            )
        else:
            letters = len([char for char in word if char.isalpha() or char.isdigit()])
        punctuation = re.search(r"[,.;:!?،؛؟]+$", word)
        pause_weight = 0
        if punctuation:
            for mark in punctuation.group(0):
                pause_weight += 2 if mark in ",،" else 4
        weights.append(max(1, letters) + pause_weight)

    total_weight = sum(weights)
    elapsed = 0.0
    timings: list[dict[str, float | int]] = []
    for index, (word, weight) in enumerate(zip(words, weights, strict=True)):
        start = elapsed
        elapsed = (
            duration_ms
            if index == len(words) - 1
            else elapsed + duration_ms * weight / total_weight
        )
        timings.append(
            {
                "wordIndex": index,
                "startMs": start,
                "endMs": elapsed,
            }
        )
    return timings


def forced_align_words(
    audio: bytes,
    words: Sequence[str],
    sample_rate: int,
    lang: str,
) -> list[dict[str, float | int]] | None:
    """Return None until MMS_FA has been measured for the active model and language."""
    del audio, words, sample_rate, lang
    return None
