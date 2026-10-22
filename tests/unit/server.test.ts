import { describe, expect, it, vi } from "vitest";
import { FakeEngine } from "../../src/engines/fake";
import { ServerFallbackEngine } from "../../src/engines/fallback";
import {
  normalizeServerUrl,
  ServerEngine,
  type ServerHealth,
} from "../../src/engines/server";
import type { SynthesisRequest } from "../../src/engines/types";

const REQUEST: SynthesisRequest = {
  sentenceId: "s0",
  lang: "en",
  voiceId: "server:kokoro:af_heart",
  wordIndices: [20, 21],
  words: ["hello", "world"],
  text: "hello world",
  speed: 1,
};

function wav16(samples: number[]): string {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) =>
    view.setInt16(44 + index * 2, sample, true),
  );
  return Buffer.from(buffer).toString("base64");
}

function synthesisResponse() {
  return {
    sampleRate: 24_000,
    audioWavBase64: wav16([8_192, -8_192]),
    timings: [
      { wordIndex: 0, startMs: 0, endMs: 25 },
      { wordIndex: 1, startMs: 25, endMs: 50 },
    ],
    timingSource: "estimated",
  };
}

describe("local server engine", () => {
  it("rejects non-loopback server URLs", () => {
    expect(normalizeServerUrl("http://127.0.0.1:5123")).toBe(
      "http://127.0.0.1:5123",
    );
    expect(() => normalizeServerUrl("https://example.com")).toThrow(
      "only sends text to http://127.0.0.1:5123",
    );
    expect(() => normalizeServerUrl("http://localhost:5123")).toThrow();
  });

  it("sends auth and request IDs, decodes WAV, and maps timings to session words", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify(synthesisResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const engine = new ServerEngine("http://127.0.0.1:5123", "secret", {
      fetcher,
      makeRequestId: () => "request-1",
    });

    const result = await engine.synthesize(REQUEST, new AbortController().signal);

    expect(result.sampleRate).toBe(24_000);
    expect(result.audio).toHaveLength(2);
    expect(result.audio[0]).toBeCloseTo(0.25, 2);
    expect(result.timings.map((timing) => timing.wordIndex)).toEqual([20, 21]);
    expect(requests[0].url).toBe("http://127.0.0.1:5123/synthesize");
    expect(requests[0].init?.headers).toMatchObject({
      Authorization: "Bearer secret",
      "X-Request-Id": "request-1",
    });
    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({
      voiceId: REQUEST.voiceId,
      words: REQUEST.words,
      speed: 1,
    });
  });

  it("caches server health for 30 seconds and refreshes on demand", async () => {
    let now = 10_000;
    const health: ServerHealth = {
      ok: true,
      version: "0.1.0",
      device: "cpu",
      engines: [],
    };
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify(health), { status: 200 }),
    );
    const engine = new ServerEngine("http://127.0.0.1:5123", "secret", {
      fetcher,
      now: () => now,
    });

    expect(await engine.health()).toEqual(health);
    expect(await engine.health()).toEqual(health);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 30_001;
    await engine.health();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await engine.health(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("falls back once when the server fails and avoids retrying it each sentence", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ detail: "engine unavailable" }), {
        status: 503,
      }),
    );
    const server = new ServerEngine("http://127.0.0.1:5123", "secret", {
      fetcher,
    });
    const notices: string[] = [];
    const engine = new ServerFallbackEngine(
      server,
      new FakeEngine(),
      "kokoro:af_heart",
      (message) => notices.push(message),
    );

    const first = await engine.synthesize(REQUEST, new AbortController().signal);
    const second = await engine.synthesize(REQUEST, new AbortController().signal);

    expect(first.audio.length).toBeGreaterThan(0);
    expect(second.audio.length).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([
      "Local server unavailable. Switching to the in-browser voice.",
    ]);
  });
});
