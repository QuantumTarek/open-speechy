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

  it("prepares a server voice once, reporting its download", async () => {
    class PreparingServer extends FakeEngine {
      prepared = 0;

      async prepareVoice(
        _voiceId: string,
        onProgress: (progress: {
          stage: "downloading" | "loading";
          loaded: number;
          total: number;
        }) => void,
      ): Promise<void> {
        this.prepared += 1;
        onProgress({ stage: "downloading", loaded: 50, total: 200 });
        onProgress({ stage: "downloading", loaded: 200, total: 200 });
        onProgress({ stage: "loading", loaded: 0, total: 0 });
      }
    }
    const server = new PreparingServer("server");
    const reported: number[] = [];
    const router = new LanguageRouterEngine({
      voiceIds: { en: "server:kokoro:af_heart" },
      server,
      createKokoro: () => new FakeEngine("kokoro"),
      createPiper: () => new FakeEngine("piper"),
      onDownloadProgress: (fraction) => reported.push(fraction),
    });

    await Promise.all([
      router.synthesize(REQUEST, new AbortController().signal),
      router.synthesize(REQUEST, new AbortController().signal),
    ]);

    expect(server.prepared).toBe(1);
    expect(server.requests).toHaveLength(2);
    expect(reported).toEqual([0.25, 1, 1]);
  });

  it("explains a failed server preparation and reads in the browser", async () => {
    class FailingServer extends FakeEngine {
      async prepareVoice(): Promise<void> {
        throw new Error("Could not download the word aligner.");
      }
    }
    const kokoro = new FakeEngine("kokoro");
    const notices: string[] = [];
    const router = new LanguageRouterEngine({
      voiceIds: { en: "server:kokoro:af_heart" },
      server: new FailingServer("server"),
      createKokoro: () => kokoro,
      createPiper: () => new FakeEngine("piper"),
      onFallback: (message) => notices.push(message),
    });

    await router.synthesize(REQUEST, new AbortController().signal);

    expect(kokoro.requests).toHaveLength(1);
    expect(notices).toEqual([
      "Could not download the word aligner. Switching to in-browser voices.",
    ]);
  });

  it("reports first-use downloads but not cache loads", async () => {
    class LoadingEngine extends FakeEngine {
      #ready = false;

      constructor(
        private readonly stages: Array<{ loaded: number; stage: string }>,
      ) {
        super("kokoro");
      }

      override isReady(): boolean {
        return this.#ready;
      }

      override async init(
        onProgress?: (progress: {
          loaded: number;
          total: number;
          stage: string;
        }) => void,
      ): Promise<void> {
        for (const { loaded, stage } of this.stages) {
          onProgress?.({ loaded, total: 100, stage });
        }
        this.#ready = true;
      }
    }

    const progressFor = async (
      stages: Array<{ loaded: number; stage: string }>,
    ) => {
      const reported: number[] = [];
      const router = new LanguageRouterEngine({
        voiceIds: { en: "kokoro:af_heart" },
        createKokoro: () => new LoadingEngine(stages),
        createPiper: () => new FakeEngine("piper"),
        onDownloadProgress: (fraction) => reported.push(fraction),
      });
      await router.synthesize(REQUEST, new AbortController().signal);
      await router.synthesize(REQUEST, new AbortController().signal);
      return reported;
    };

    expect(
      await progressFor([
        { loaded: 40, stage: "downloading" },
        { loaded: 100, stage: "verified" },
        { loaded: 100, stage: "progress" },
      ]),
    ).toEqual([0.4, 1, 1]);
    expect(await progressFor([{ loaded: 100, stage: "ready" }])).toEqual([]);
  });
});
