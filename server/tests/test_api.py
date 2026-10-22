from __future__ import annotations

from fastapi.testclient import TestClient
from server.app import create_app, run_server
from server.auth import AuthManager, PairingManager
from server.engines.base import Synthesis
from server.engines.registry import EngineRegistry
from server.synthesis_queue import SynthesisQueue

EXTENSION_ID = "a" * 32
ORIGIN = f"chrome-extension://{EXTENSION_ID}"
HEADERS = {
    "Authorization": "Bearer test-secret",
    "Origin": ORIGIN,
}


class FakeEngine:
    id = "fake"
    langs = ("en",)
    loaded = True
    available = True

    def voices(self) -> list[dict[str, object]]:
        return [
            {
                "id": "server:fake:voice",
                "engineId": "server",
                "lang": "en",
                "name": "Test voice",
                "quality": "standard",
                "local": True,
                "supportsWordTimings": True,
                "installed": True,
            }
        ]

    async def warmup(self) -> None:
        return None

    async def synthesize(
        self,
        words: list[str],
        lang: str,
        speed: float,
        voice_id: str,
    ) -> Synthesis:
        assert lang == "en"
        assert speed == 1.0
        assert voice_id == "server:fake:voice"
        assert words == ["hello"]
        return Synthesis(
            audio_wav=b"RIFF",
            sample_rate=24_000,
            timings=[{"wordIndex": 0, "startMs": 0, "endMs": 250}],
        )


def make_client() -> tuple[TestClient, PairingManager]:
    auth = AuthManager(
        token="test-secret",
        extension_id=EXTENSION_ID,
    )
    pairing = PairingManager(auth)
    app = create_app(
        auth=auth,
        pairing=pairing,
        engines=EngineRegistry([FakeEngine()]),
        jobs=SynthesisQueue(),
        version="test-version",
    )
    return TestClient(app, base_url="http://127.0.0.1:5123"), pairing


def test_server_requires_extension_origin_and_bearer_token() -> None:
    client, _ = make_client()

    assert client.get("/health", headers={"Origin": ORIGIN}).status_code == 401
    assert (
        client.get(
            "/health",
            headers={
                "Authorization": "Bearer test-secret",
                "Origin": "https://example.com",
            },
        ).status_code
        == 403
    )
    response = client.get("/health", headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["version"] == "test-version"
    assert response.json()["engines"][0]["id"] == "fake"


def test_voices_and_synthesis_follow_the_api_contract() -> None:
    client, _ = make_client()

    voices = client.get("/voices", headers=HEADERS)
    assert voices.status_code == 200
    assert voices.json()[0]["id"] == "server:fake:voice"

    response = client.post(
        "/synthesize",
        headers={**HEADERS, "X-Request-Id": "request-1"},
        json={
            "voiceId": "server:fake:voice",
            "lang": "en",
            "words": ["hello"],
            "speed": 1,
        },
    )
    assert response.status_code == 200
    assert response.json()["sampleRate"] == 24_000
    assert response.json()["audioWavBase64"] == "UklGRg=="
    assert response.json()["timingSource"] == "estimated"


def test_pairing_code_is_one_time_and_requires_extension_origin() -> None:
    client, pairing = make_client()
    code = pairing.current_code()

    denied = client.post("/pair", json={"code": code})
    assert denied.status_code == 403

    response = client.post("/pair", headers={"Origin": ORIGIN}, json={"code": code})
    assert response.status_code == 200
    assert response.json()["token"] == "test-secret"
    assert (
        client.post("/pair", headers={"Origin": ORIGIN}, json={"code": code}).status_code
        == 400
    )


def test_first_pairing_binds_the_extension_for_later_authenticated_calls() -> None:
    auth = AuthManager(token="first-pair-secret")
    pairing = PairingManager(auth)
    app = create_app(
        auth=auth,
        pairing=pairing,
        engines=EngineRegistry([]),
        jobs=SynthesisQueue(),
    )
    client = TestClient(app, base_url="http://127.0.0.1:5123")
    extension_origin = f"chrome-extension://{'c' * 32}"
    code = pairing.current_code()

    preflight = client.options(
        "/pair",
        headers={
            "Origin": extension_origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert preflight.status_code == 200
    paired = client.post(
        "/pair",
        headers={"Origin": extension_origin},
        json={"code": code},
    )

    assert paired.status_code == 200
    assert auth.extension_origin == extension_origin
    assert (
        client.get(
            "/health",
            headers={
                "Origin": extension_origin,
                "Authorization": "Bearer first-pair-secret",
            },
        ).status_code
        == 200
    )


def test_server_refuses_non_loopback_bind_configuration() -> None:
    try:
        run_server(host="0.0.0.0")
    except ValueError as error:
        assert "must bind to 127.0.0.1" in str(error)
    else:
        raise AssertionError("A public bind address must be rejected.")
