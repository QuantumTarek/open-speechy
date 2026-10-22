from __future__ import annotations

from .unavailable import UnavailableEngine


class ChatterboxNanoEngine(UnavailableEngine):
    def __init__(self) -> None:
        super().__init__(
            "chatterbox_nano",
            ("en",),
            "Chatterbox-Nano is not enabled until its model and alignment checks are complete.",
        )
