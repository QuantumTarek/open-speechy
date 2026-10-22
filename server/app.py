from __future__ import annotations

import asyncio
import os
import re
import uuid
from base64 import b64encode
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field, field_validator

from .auth import AuthManager, PairingManager
from .engines.base import EngineUnavailable, Synthesis
from .engines.registry import EngineRegistry
from .synthesis_queue import DuplicateRequestError, SynthesisQueue

HOST = "127.0.0.1"
PORT = 5123
VERSION = os.environ.get("OPEN_SPEECHY_VERSION", "0.1.0")
REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


class PairRequest(BaseModel):
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")


class WarmupRequest(BaseModel):
    engines: list[str] = Field(default_factory=list, max_length=8)


class SynthesizeRequest(BaseModel):
    voiceId: str = Field(min_length=1, max_length=180)
    lang: Literal["en", "ar"]
    words: list[str] = Field(min_length=1, max_length=300)
    speed: float = Field(ge=0.5, le=3.0, allow_inf_nan=False)

    @field_validator("words")
    @classmethod
    def bound_word_lengths(cls, words: list[str]) -> list[str]:
        if any(len(word) > 300 for word in words) or sum(map(len, words)) > 16_384:
            raise ValueError("Speech text exceeds the per-sentence size limit.")
        return words


def create_app(
    auth: AuthManager | None = None,
    pairing: PairingManager | None = None,
    engines: EngineRegistry | None = None,
    jobs: SynthesisQueue | None = None,
    version: str = VERSION,
) -> FastAPI:
    auth_manager = auth or AuthManager()
    pairing_manager = pairing or PairingManager(auth_manager)
    registry = engines or EngineRegistry()
    queue = jobs or SynthesisQueue()
    extension_origin = auth_manager.extension_origin

    app = FastAPI(
        title="Open Speechy Local Server",
        version=version,
        docs_url=None,
        redoc_url=None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[extension_origin] if extension_origin else [],
        allow_origin_regex=(
            None if extension_origin else r"^chrome-extension://[a-p]{32}$"
        ),
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-Id"],
        max_age=600,
    )

    @app.middleware("http")
    async def protect_local_host(request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                body_size = int(content_length)
            except ValueError:
                return Response("Invalid content length.", status_code=400)
            if body_size < 0:
                return Response("Invalid content length.", status_code=400)
            if body_size > 200_000:
                return Response("Request body is too large.", status_code=413)
        host = request.headers.get("host", "").split(":", maxsplit=1)[0]
        if host not in {"127.0.0.1", "localhost"}:
            return Response("Local server accepts loopback hosts only.", status_code=400)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path == "/pair":
            response.headers["Content-Security-Policy"] = (
                "default-src 'none'; style-src 'unsafe-inline'"
            )
        return response

    def require_extension_origin(request: Request) -> None:
        if (
            auth_manager.extension_origin is None
            or request.headers.get("origin") != auth_manager.extension_origin
        ):
            raise HTTPException(status_code=403, detail="Extension origin required.")

    def require_auth(request: Request) -> None:
        require_extension_origin(request)
        if not auth_manager.accepts(request.headers.get("authorization")):
            raise HTTPException(status_code=401, detail="Bearer token required.")

    @app.get("/health")
    async def health(_: None = Depends(require_auth)):
        return {
            "ok": True,
            "version": version,
            "device": detect_device(),
            "engines": registry.health(),
        }

    @app.get("/voices")
    async def voices(_: None = Depends(require_auth)):
        return registry.voices()

    @app.post("/warmup", status_code=204)
    async def warmup(
        body: WarmupRequest,
        _: None = Depends(require_auth),
    ) -> Response:
        try:
            await registry.warmup(body.engines)
        except EngineUnavailable as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return Response(status_code=204)

    @app.post("/synthesize")
    async def synthesize(
        body: SynthesizeRequest,
        _: None = Depends(require_auth),
        request_id: str | None = Header(default=None, alias="X-Request-Id"),
    ):
        identifier = request_id or uuid.uuid4().hex
        if not REQUEST_ID.fullmatch(identifier):
            raise HTTPException(status_code=400, detail="Invalid request ID.")
        parts = body.voiceId.split(":")
        if len(parts) < 3 or parts[0] != "server":
            raise HTTPException(status_code=400, detail="Invalid server voice ID.")
        engine_id = parts[1]

        async def run_synthesis() -> Synthesis:
            return await registry.synthesize(
                body.voiceId,
                body.lang,
                body.words,
                body.speed,
            )

        try:
            result = await queue.run(engine_id, identifier, run_synthesis)
        except DuplicateRequestError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except EngineUnavailable as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except asyncio.CancelledError as error:
            raise HTTPException(status_code=499, detail="Synthesis cancelled.") from error
        except Exception as error:
            raise HTTPException(
                status_code=500,
                detail="Speech synthesis failed. Check the local server log.",
            ) from error

        return {
            "sampleRate": result.sample_rate,
            "audioWavBase64": b64encode(result.audio_wav).decode("ascii"),
            "timings": result.timings,
            "timingSource": result.timing_source,
        }

    @app.delete("/synthesize/{request_id}", status_code=204)
    async def cancel_synthesis(
        request_id: str,
        _: None = Depends(require_auth),
    ) -> Response:
        if not REQUEST_ID.fullmatch(request_id):
            raise HTTPException(status_code=400, detail="Invalid request ID.")
        if not queue.cancel(request_id):
            raise HTTPException(status_code=404, detail="Synthesis job not found.")
        return Response(status_code=204)

    @app.get("/pair", response_class=HTMLResponse)
    async def pair_page():
        code = pairing_manager.current_code()
        return f"""<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pair Open Speechy</title>
  <body style="font: 16px system-ui; max-width: 32rem; margin: 12vh auto; padding: 0 1rem">
    <p>OPEN SPEECHY / LOCAL SERVER</p>
    <h1>Pair this browser</h1>
    <p>Enter this one-time code in the extension settings. It expires in five minutes.</p>
    <p style="font: 700 3rem ui-monospace; letter-spacing: .2em">{code}</p>
  </body>
</html>"""

    @app.post("/pair")
    async def exchange_pairing_code(
        body: PairRequest,
        request: Request,
    ):
        origin = request.headers.get("origin")
        if not auth_manager.can_pair_origin(origin):
            raise HTTPException(status_code=403, detail="Extension origin required.")
        token = pairing_manager.exchange(body.code)
        if token is None:
            raise HTTPException(status_code=400, detail="Pairing code expired or invalid.")
        if not auth_manager.bind_extension_origin(origin or ""):
            raise HTTPException(status_code=403, detail="Could not bind extension ID.")
        return {"token": token}

    return app


def detect_device() -> str:
    try:
        import torch
    except ImportError:
        return "cpu"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def run_server(host: str = HOST, port: int = PORT) -> None:
    if host != HOST:
        raise ValueError("Open Speechy server must bind to 127.0.0.1.")
    import uvicorn

    uvicorn.run(create_app(), host=HOST, port=port, access_log=True)


app = create_app()


if __name__ == "__main__":
    run_server()
