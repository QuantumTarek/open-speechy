import { describe, expect, it } from "vitest";
import { LanguageRouterEngine } from "../../src/engines/language-router";
import type {
  SynthesisRequest,
  SynthesisResult,
  TtsEngine,
  VoiceInfo,
} from "../../src/engines/types";

const REQUEST: SynthesisRequest = {
  sentenceId: "s0",
  lang: "en",
  voiceId: "kokoro:af_heart",
  wordIndices: [0],
  words: ["hello"],
  text: "hello",
  speed: 1,
};

class FakeEngine implements TtsEngine {
  readonly requests: SynthesisRequest[] = [];

  constructor(
    readonly id: TtsEngine["id"],
    private readonly fail = false,
  ) {}

  async init(): Promise<void> {}

  isReady(): boolean {
    return true;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return [];
  }

  async synthesize(
    request: SynthesisRequest,
    signal: AbortSignal,
  ): Promise<SynthesisResult> {
    this.requests.push(request);
    if (this.fail) throw new Error("Server down");
    if (signal.aborted) throw signal.reason;
    return {
      audio: new Float32Array([0.1]),
      sampleRate: 24_000,
      timings: [{ wordIndex: request.wordIndices[0], startMs: 0, endMs: 1 }],
      timingSource: "estimated",
    };
  }

  async dispose(): Promise<void> {}
}

describe("per-language engine routing", () => {
  it("uses the configured browser engine and voice for each language", async () => {
    const kokoro = new FakeEngine("kokoro");
    const piper = new FakeEngine("piper");
    const router = new LanguageRouterEngine({
      voiceIds: {
        en: "kokoro:am_adam",
        ar: "piper:ar_JO-kareem-medium",
      },
      createKokoro: () => kokoro,
      createPiper: () => piper,
    });

    await router.synthesize(REQUEST, new AbortController().signal);
    await router.synthesize(
      { ...REQUEST, lang: "ar", voiceId: "server:silma:default" },
      new AbortController().signal,
    );

    expect(kokoro.requests[0].voiceId).toBe("kokoro:am_adam");
    expect(piper.requests[0].voiceId).toBe("piper:ar_JO-kareem-medium");
  });

  it("falls back from a failed server voice once, then routes locally", async () => {
    const server = new FakeEngine("server", true);
    const kokoro = new FakeEngine("kokoro");
    const notices: string[] = [];
    const router = new LanguageRouterEngine({
      voiceIds: { en: "server:kokoro:af_heart" },
      server,
      createKokoro: () => kokoro,
      createPiper: () => new FakeEngine("piper"),
      onFallback: (message) => notices.push(message),
    });

    await router.synthesize(REQUEST, new AbortController().signal);
    await router.synthesize(REQUEST, new AbortController().signal);

    expect(server.requests).toHaveLength(1);
    expect(kokoro.requests).toHaveLength(2);
    expect(notices).toHaveLength(1);
  });
});
