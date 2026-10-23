from __future__ import annotations

import asyncio
from pathlib import Path

from server.align import mms_transcript, token_word_timings, word_spans_to_timings
from server.engines.chatterbox_ml import ChatterboxMultilingualEngine
from server.engines.chatterbox_nano import ChatterboxNanoEngine
from server.engines.kokoro import KOKORO_VOICES, KokoroEngine
from server.engines.registry import EngineRegistry
from server.engines.silma import SilmaEngine
from server.model_store import model_pin


class FakeKokoroPipeline:
    def __init__(self, **kwargs: object) -> None:
        assert kwargs["lang_code"] in {"a", "b"}

    def __call__(self, text: str, voice: str, speed: float):
        assert text == "hello there"
        assert voice == "/pinned/kokoro/voices/af_heart.pt"
        assert speed == 1.0
        return [(None, None, [0.1, -0.1, 0.2])]


class FakeSilma:
    def infer(self, **kwargs: object):
        assert kwargs["gen_text"] == "مرحبا"
        assert kwargs["nfe_step"] == 16
        assert kwargs["force_tashkeel"] is False
        return [0.1, -0.1, 0.2], 24_000, None


class FakeChatterbox:
    sr = 24_000

    def generate(self, text: str, **kwargs: object):
        assert text
        return [0.1, -0.1, 0.2]


def test_pinned_model_revisions_are_committed_and_immutable() -> None:
    for name in (
        "kokoro",
        "silma",
        "silma_vocoder",
        "chatterbox_nano",
        "chatterbox_ml",
    ):
        revision = model_pin(name)["revision"]
        assert len(revision) == 40
        assert all(character in "0123456789abcdef" for character in revision)


def test_kokoro_adapter_loads_a_pinned_pipeline_and_returns_audio() -> None:
    engine = KokoroEngine(
        pipeline_factory=FakeKokoroPipeline,
        snapshot_provider=lambda _: Path("/pinned/kokoro"),
    )

    async def run() -> None:
        await engine.warmup()
        result = await engine.synthesize(
            ["hello", "there"],
            "en",
            1.0,
            "server:kokoro:af_heart",
        )
        assert result.audio_wav.startswith(b"RIFF")
        assert result.sample_rate == 24_000
        assert result.timings
        assert result.timing_source in {"aligned", "estimated"}

    asyncio.run(run())
    assert len(engine.voices()) == len(KOKORO_VOICES)


def test_silma_adapter_passes_the_configured_step_count() -> None:
    engine = SilmaEngine(
        model_factory=lambda *_: FakeSilma(),
        snapshot_provider=lambda _: Path("/pinned/silma"),
        reference_audio="/tmp/silma-reference.wav",
    )

    async def run() -> None:
        await engine.warmup()
        result = await engine.synthesize(
            ["مرحبا"],
            "ar",
            1.0,
            "server:silma:default",
        )
        assert result.audio_wav.startswith(b"RIFF")
        assert result.sample_rate == 24_000
        assert result.timing_source in {"aligned", "estimated"}

    asyncio.run(run())


def test_chatterbox_adapters_use_injected_local_models() -> None:
    nano = ChatterboxNanoEngine(
        model_factory=lambda *_: FakeChatterbox(),
        snapshot_provider=lambda _: Path("/pinned/nano"),
    )
    multilingual = ChatterboxMultilingualEngine(
        model_factory=lambda *_: FakeChatterbox(),
        snapshot_provider=lambda _: Path("/pinned/multilingual"),
    )

    async def run() -> None:
        await nano.warmup()
        en_result = await nano.synthesize(
            ["hello"],
            "en",
            1.0,
            "server:chatterbox_nano:default",
        )
        await multilingual.warmup()
        ar_result = await multilingual.synthesize(
            ["مرحبا"],
            "ar",
            1.0,
            "server:chatterbox_ml:default",
        )
        assert en_result.audio_wav.startswith(b"RIFF")
        assert ar_result.audio_wav.startswith(b"RIFF")
        assert en_result.timing_source in {"aligned", "estimated"}
        assert ar_result.timing_source in {"aligned", "estimated"}

    asyncio.run(run())


def test_word_alignment_maps_spans_and_rejects_low_confidence() -> None:
    spans = [
        {"start": 0, "end": 5, "score": 0.8},
        {"start": 5, "end": 10, "score": 0.9},
    ]

    timings = word_spans_to_timings(spans, ["one", "two"], 500, 10)

    assert timings == [
        {"wordIndex": 0, "startMs": 0.0, "endMs": 250.0},
        {"wordIndex": 1, "startMs": 250.0, "endMs": 500.0},
    ]
    assert (
        word_spans_to_timings(
            [{**spans[0], "score": 0.01}, spans[1]],
            ["one", "two"],
            500,
            10,
        )
        is None
    )


def test_model_engine_voices_do_not_require_the_old_opt_in_flag(monkeypatch) -> None:
    monkeypatch.delenv("OPEN_SPEECHY_ALLOW_UNVERIFIED_MODELS", raising=False)
    registry = EngineRegistry(
        [
            KokoroEngine(
                pipeline_factory=FakeKokoroPipeline,
                snapshot_provider=lambda _: Path("/pinned/kokoro"),
            )
        ]
    )
    assert registry.voices()


def test_mms_transcript_keeps_one_aligner_token_per_word() -> None:
    assert mms_transcript(["Reading,", "2024", "don't", "—"], "en") == [
        "reading",
        "*",
        "don't",
        "*",
    ]


def test_kokoro_voices_have_readable_names() -> None:
    voices = KokoroEngine(pipeline_factory=FakeKokoroPipeline).voices()
    heart = next(voice for voice in voices if voice["id"] == "server:kokoro:af_heart")
    george = next(
        voice for voice in voices if voice["id"] == "server:kokoro:bm_george"
    )
    assert heart["name"] == "Heart"
    assert heart["description"] == "American · female · Kokoro"
    assert george["description"] == "British · male · Kokoro"


class TimedToken:
    def __init__(self, text: str, start: float | None, end: float | None) -> None:
        self.text = text
        self.start_ts = start
        self.end_ts = end


class TimedResult:
    """Kokoro's pipeline result: unpacks to (graphemes, phonemes, audio)."""

    def __init__(self, audio: list[float], tokens: list[TimedToken]) -> None:
        self.audio = audio
        self.tokens = tokens

    def __iter__(self):
        return iter(("", "", self.audio))


class TimedKokoroPipeline:
    def __init__(self, **kwargs: object) -> None:
        pass

    def __call__(self, text: str, voice: str, speed: float):
        # Two parts, each timed from its own start; 24 samples = 1 ms.
        return [
            TimedResult(
                [0.0] * 24_000,
                [TimedToken("Hello", 0.1, 0.4), TimedToken(",", None, None)],
            ),
            TimedResult(
                [0.0] * 24_000,
                [TimedToken("there", 0.2, 0.7), TimedToken(".", None, None)],
            ),
        ]


def test_kokoro_times_words_itself() -> None:
    engine = KokoroEngine(
        pipeline_factory=TimedKokoroPipeline,
        snapshot_provider=lambda _: Path("/pinned/kokoro"),
    )

    async def run():
        await engine.warmup()
        return await engine.synthesize(
            ["Hello,", "there."], "en", 1.0, "server:kokoro:af_heart"
        )

    result = asyncio.run(run())
    assert result.timing_source == "model"
    assert result.timings == [
        {"wordIndex": 0, "startMs": 100.0, "endMs": 400.0},
        {"wordIndex": 1, "startMs": 1_200.0, "endMs": 1_700.0},
    ]
    assert engine.aligns_words is False


def test_token_timings_fill_unmatched_words_and_give_up_when_most_miss() -> None:
    tokens = [("one", 0.0, 0.2), ("three", 0.5, 0.8)]
    assert token_word_timings(["one", "two", "three"], tokens) == [
        {"wordIndex": 0, "startMs": 0.0, "endMs": 200.0},
        {"wordIndex": 1, "startMs": 200.0, "endMs": 500.0},
        {"wordIndex": 2, "startMs": 500.0, "endMs": 800.0},
    ]
    assert token_word_timings(["one", "two", "three"], [("zzz", 0, 1)]) is None
