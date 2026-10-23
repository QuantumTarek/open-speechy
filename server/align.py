from __future__ import annotations

import importlib.util
import io
import math
import os
import re
import threading
import urllib.request
from collections.abc import Callable, Sequence
from functools import lru_cache
from pathlib import Path

from .engines.base import EngineUnavailable

ARABIC_MARKS = re.compile(r"[\u064b-\u065f\u0670]")
MMS_INVALID = re.compile(r"[^a-z']")


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


# How far ahead of the last matched token a model token may be found. A token
# the model rewrote is skipped instead of throwing later tokens off.
TOKEN_SEARCH_WINDOW = 32


def token_word_timings(
    words: Sequence[str],
    tokens: Sequence[tuple[str, float | None, float | None]],
) -> list[dict[str, float | int]] | None:
    """Word timings from a model's own timed tokens: (text, start s, end s).

    Tokens are found in the words' text in order, and each word takes the span
    of the timed tokens it overlaps. Words left without a token fill the gap
    around them. None when fewer than half of the words were matched.
    """
    if not words:
        return None
    text = " ".join(words).lower()
    starts = []
    position = 0
    for word in words:
        starts.append(position)
        position += len(word) + 1
    spans: list[tuple[float, float] | None] = [None] * len(words)
    cursor = 0
    for token_text, start, end in tokens:
        needle = token_text.strip().lower()
        found = text.find(needle, cursor) if needle else -1
        if found < 0 or found - cursor > TOKEN_SEARCH_WINDOW:
            continue
        cursor = found + len(needle)
        if start is None or end is None:
            continue
        for index, word_start in enumerate(starts):
            if word_start < cursor and word_start + len(words[index]) > found:
                span = spans[index]
                spans[index] = (
                    (min(span[0], start), max(span[1], end)) if span else (start, end)
                )
    if sum(span is not None for span in spans) * 2 < len(words):
        return None
    timings: list[dict[str, float | int]] = []
    previous_end = 0.0
    for index, span in enumerate(spans):
        if span is None:
            following = next((later[0] for later in spans[index + 1 :] if later), None)
            span = (previous_end / 1_000, following or previous_end / 1_000)
        start_ms = max(span[0] * 1_000, previous_end)
        end_ms = max(span[1] * 1_000, start_ms)
        timings.append({"wordIndex": index, "startMs": start_ms, "endMs": end_ms})
        previous_end = end_ms
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

        bundle, model, tokenizer, aligner = _load_mms_fa()
        waveform, input_rate = torchaudio.load(io.BytesIO(audio))
        waveform = waveform.mean(dim=0, keepdim=True)
        if input_rate != bundle.sample_rate:
            waveform = torchaudio.functional.resample(
                waveform,
                orig_freq=input_rate,
                new_freq=bundle.sample_rate,
            )
        transcript = mms_transcript(words, lang)

        with torch.inference_mode():
            emissions, _ = model(waveform)
            token_spans = aligner(emissions[0], tokenizer(transcript))

        word_spans = [
            {
                "start": spans[0].start,
                "end": spans[-1].end,
                "score": sum(span.score * len(span) for span in spans)
                / max(1, sum(len(span) for span in spans)),
            }
            for spans in token_spans
        ]
        duration_ms = waveform.shape[-1] / bundle.sample_rate * 1_000
        return word_spans_to_timings(
            word_spans,
            words,
            duration_ms,
            emissions.shape[1],
        )
    except Exception:  # noqa: BLE001 - alignment failure uses estimated timings.
        return None


def mms_transcript(words: Sequence[str], lang: str) -> list[str]:
    """Map each word onto the MMS_FA alphabet (lowercase a-z and apostrophe).

    Arabic is romanized first. A word with no usable letters, such as a number
    or a dash, becomes "*", the aligner's wildcard token, so word counts match.
    """
    transcript = []
    for word in words:
        text = _romanize_arabic(word) if lang == "ar" else word
        text = MMS_INVALID.sub("", text.lower())
        transcript.append(text or "*")
    return transcript


# torchaudio's MMS_FA bundle (wav2vec2, 1.26 GB) downloads its weights through
# torch.hub on first use. The server downloads them while it prepares a voice
# instead, with progress, so no synthesis request waits on that download.
ALIGNER_URL = (
    "https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt"
)
ALIGNER_BYTES = 1_262_047_414


class Aligner:
    """The word aligner's weights in the torch.hub cache."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        return importlib.util.find_spec("torchaudio") is not None

    @property
    def loaded(self) -> bool:
        return _load_mms_fa.cache_info().currsize > 0

    def path(self) -> Path:
        import torch

        return Path(torch.hub.get_dir()) / "checkpoints" / "model.pt"

    def downloaded(self) -> bool:
        return self.available and self.path().is_file()

    def size(self) -> int:
        return self.path().stat().st_size if self.downloaded() else ALIGNER_BYTES

    def download(self, on_progress: Callable[[int], None] | None = None) -> None:
        with self._lock:
            target = self.path()
            if target.is_file():
                return
            target.parent.mkdir(parents=True, exist_ok=True)
            partial = target.with_name(f"{target.name}.partial")
            received = 0
            try:
                with (
                    urllib.request.urlopen(ALIGNER_URL, timeout=30) as response,
                    partial.open("wb") as output,
                ):
                    expected = int(response.headers.get("Content-Length") or 0)
                    while chunk := response.read(1 << 20):
                        output.write(chunk)
                        received += len(chunk)
                        if on_progress:
                            on_progress(received)
                if expected and received != expected:
                    raise EngineUnavailable("The word aligner download was incomplete.")
                os.replace(partial, target)
            except OSError as error:
                raise EngineUnavailable(
                    "Could not download the word aligner."
                ) from error
            finally:
                partial.unlink(missing_ok=True)

    def load(self) -> None:
        _load_mms_fa()

    def unload(self) -> None:
        _load_mms_fa.cache_clear()

    def remove(self) -> int:
        self.unload()
        if not self.downloaded():
            return 0
        path = self.path()
        size = path.stat().st_size
        path.unlink()
        return size


ALIGNER = Aligner()


@lru_cache(maxsize=1)
def _load_mms_fa():
    import torchaudio

    if not ALIGNER.downloaded():
        # Without this, torchaudio would download the weights mid-request.
        raise FileNotFoundError("The word aligner is not downloaded.")
    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model().cpu().eval()
    return bundle, model, bundle.get_tokenizer(), bundle.get_aligner()


def _romanize_arabic(text: str) -> str:
    return _uroman().romanize_string(text)


@lru_cache(maxsize=1)
def _uroman():
    from uroman import Uroman

    return Uroman()


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
