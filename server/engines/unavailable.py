from __future__ import annotations

from .base import EngineUnavailable, Synthesis


class UnavailableEngine:
    def __init__(
        self,
        engine_id: str,
        langs: tuple[str, ...],
        reason: str,
    ) -> None:
        self.id = engine_id
        self.langs = langs
        self.reason = reason
        self.loaded = False
        self.available = False

    def voices(self) -> list[dict[str, object]]:
        return []

    async def warmup(self) -> None:
        raise EngineUnavailable(self.reason)

    async def synthesize(
        self,
        words: list[str],
        lang: str,
        speed: float,
        voice_id: str,
    ) -> Synthesis:
        del words, lang, speed, voice_id
        raise EngineUnavailable(self.reason)
