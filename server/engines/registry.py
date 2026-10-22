from __future__ import annotations

from .base import EngineUnavailable, SpeechEngine, Synthesis
from .chatterbox_nano import ChatterboxNanoEngine
from .kokoro import KokoroEngine
from .silma import SilmaEngine


class EngineRegistry:
    def __init__(self, engines: list[SpeechEngine] | None = None) -> None:
        configured = (
            engines
            if engines is not None
            else [KokoroEngine(), SilmaEngine(), ChatterboxNanoEngine()]
        )
        self._engines = {engine.id: engine for engine in configured}

    def health(self) -> list[dict[str, object]]:
        return [
            {
                "id": engine.id,
                "loaded": engine.loaded,
                "langs": list(engine.langs),
            }
            for engine in self._engines.values()
        ]

    def voices(self) -> list[dict[str, object]]:
        return [
            voice
            for engine in self._engines.values()
            if engine.available
            for voice in engine.voices()
        ]

    async def warmup(self, engine_ids: list[str]) -> None:
        for engine_id in dict.fromkeys(engine_ids):
            engine = self._engines.get(engine_id)
            if engine is None:
                raise EngineUnavailable(f"Unknown speech engine: {engine_id}")
            await engine.warmup()

    async def synthesize(
        self,
        voice_id: str,
        lang: str,
        words: list[str],
        speed: float,
    ) -> Synthesis:
        parts = voice_id.split(":")
        if len(parts) < 3 or parts[0] != "server":
            raise EngineUnavailable("Unknown server voice identifier.")
        engine = self._engines.get(parts[1])
        if engine is None or not engine.available:
            raise EngineUnavailable(
                f"Speech engine '{parts[1]}' is not installed or verified."
            )
        if lang not in engine.langs:
            raise EngineUnavailable(
                f"Speech engine '{parts[1]}' does not support {lang}."
            )
        return await engine.synthesize(words, lang, speed, voice_id)
