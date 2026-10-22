from __future__ import annotations

import io
import math
import re
from collections.abc import Sequence
from functools import lru_cache

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
    if not audio or not words or sample_rate <= 0:
        return None
    try:
        import torch
        import torchaudio

        bundle, model, aligner = _load_mms_fa()
        waveform, input_rate = torchaudio.load(io.BytesIO(audio))
        waveform = waveform.mean(dim=0, keepdim=True)
        if input_rate != bundle.sample_rate:
            waveform = torchaudio.functional.resample(
                waveform,
                orig_freq=input_rate,
                new_freq=bundle.sample_rate,
            )
        text = " ".join(words)
        if lang == "ar":
            text = _romanize_arabic(text)
        tokens, aligned_words = aligner(text)
        if len(aligned_words) != len(words):
            return None

        with torch.inference_mode():
            emissions, _ = model(waveform)
            aligned_tokens, scores = torchaudio.functional.forced_align(
                emissions,
                tokens,
                blank=0,
            )
            token_spans = torchaudio.functional.merge_tokens(
                aligned_tokens[0],
                scores[0],
                blank=0,
            )
            word_spans = aligner.find_word_spans(token_spans, aligned_words)

        duration_ms = waveform.shape[-1] / bundle.sample_rate * 1_000
        return word_spans_to_timings(
            word_spans,
            words,
            duration_ms,
            emissions.shape[1],
        )
    except Exception:  # noqa: BLE001 - alignment failure uses estimated timings.
        return None


@lru_cache(maxsize=1)
def _load_mms_fa():
    import torchaudio

    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model().cpu().eval()
    return bundle, model, bundle.get_aligner()


def _romanize_arabic(text: str) -> str:
    from uroman import Uroman

    return Uroman().romanize_string(text)


def word_spans_to_timings(
    spans: Sequence[object],
    words: Sequence[str],
    duration_ms: float,
    frame_count: int,
) -> list[dict[str, float | int]] | None:
    if (
        not words
        or len(spans) != len(words)
        or duration_ms <= 0
        or frame_count <= 0
    ):
        return None

    frame_ms = duration_ms / frame_count
    timings: list[dict[str, float | int]] = []
    previous_end = 0.0
    for index, span in enumerate(spans):
        start = _span_value(span, "start")
        end = _span_value(span, "end")
        score = _span_value(span, "score")
        if (
            start is None
            or end is None
            or not math.isfinite(start)
            or not math.isfinite(end)
            or start < 0
            or end < start
            or end > frame_count
            or start * frame_ms < previous_end
        ):
            return None
        if score is not None and math.isfinite(score) and 0 <= score <= 1 and score < 0.05:
            return None

        start_ms = start * frame_ms
        end_ms = end * frame_ms
        timings.append(
            {
                "wordIndex": index,
                "startMs": start_ms,
                "endMs": end_ms,
            }
        )
        previous_end = end_ms
    return timings


def _span_value(span: object, key: str) -> float | None:
    value = span.get(key) if isinstance(span, dict) else getattr(span, key, None)
    if isinstance(value, (int, float)):
        return float(value)
    return None
