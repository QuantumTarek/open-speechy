import type {
  SynthesisRequest,
  SynthesisResult,
  TtsEngine,
  VoiceInfo,
} from "./types";
import { estimateWordTimings } from "./timings";

export class FakeEngine implements TtsEngine {
  readonly id = "kokoro" as const;
  #ready = false;

  async init(): Promise<void> {
    this.#ready = true;
  }

  isReady(): boolean {
    return this.#ready;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return [
      {
        id: "kokoro:af_heart",
        engineId: "kokoro",
        lang: "en",
        name: "Test voice",
        quality: "standard",
        local: true,
        supportsWordTimings: false,
        installed: true,
      },
    ];
  }

  async synthesize(
    request: SynthesisRequest,
    signal: AbortSignal,
  ): Promise<SynthesisResult> {
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const sampleRate = 24_000;
    const durationMs = Math.max(
      240,
      (request.words.length * 120) / request.speed,
    );
    const audio = new Float32Array(
      Math.ceil((sampleRate * durationMs) / 1_000),
    );
    const words = request.words.map((text, index) => ({
      wordIndex: request.wordIndices[index] ?? index,
      text,
    }));

    return {
      audio,
      sampleRate,
      timings: estimateWordTimings(words, audio, sampleRate, request.lang),
      timingSource: "estimated",
    };
  }

  async dispose(): Promise<void> {
    this.#ready = false;
  }
}

export function isTestEngineEnabled(): boolean {
  return typeof __OPEN_SPEECHY_FAKE_ENGINE__ !== "undefined"
    ? __OPEN_SPEECHY_FAKE_ENGINE__
    : false;
}
