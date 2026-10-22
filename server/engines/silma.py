from __future__ import annotations

from .unavailable import UnavailableEngine


class SilmaEngine(UnavailableEngine):
    def __init__(self) -> None:
        super().__init__(
            "silma",
            ("ar", "en"),
            "SILMA is not enabled until the M0 model and quality checks are complete.",
        )
