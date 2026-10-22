import type {
  Lang,
  SynthesisRequest,
  SynthesisResult,
  TtsEngine,
  VoiceInfo,
} from "./types";
import { ServerEngine } from "./server";

export class ServerFallbackEngine implements TtsEngine {
  readonly id = "server" as const;
  readonly #server: ServerEngine;
  readonly #fallback: TtsEngine;
  readonly #fallbackVoiceId: string;
  readonly #onFallback: (message: string) => void;
  #notified = false;
  #serverUnavailable = false;

  constructor(
    server: ServerEngine,
    fallback: TtsEngine,
    fallbackVoiceId: string,
    onFallback: (message: string) => void,
  ) {
    this.#server = server;
    this.#fallback = fallback;
    this.#fallbackVoiceId = fallbackVoiceId;
    this.#onFallback = onFallback;
  }

  async init(): Promise<void> {}

  isReady(): boolean {
    return this.#fallback.isReady();
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const [serverVoices, fallbackVoices] = await Promise.all([
      this.#server.listVoices().catch(() => []),
      this.#fallback.listVoices(),
    ]);
    return [...serverVoices, ...fallbackVoices];
  }

  async synthesize(
    request: SynthesisRequest,
    signal: AbortSignal,
  ): Promise<SynthesisResult> {
    if (
      request.voiceId.startsWith("server:") &&
      !this.#serverUnavailable
    ) {
      try {
        return await this.#server.synthesize(request, signal);
      } catch {
        if (signal.aborted) {
          throw signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        this.#serverUnavailable = true;
        if (!this.#notified) {
          this.#notified = true;
          this.#onFallback(
            "Local server unavailable. Switching to the in-browser voice.",
          );
        }
      }
    }

    const fallbackRequest = {
      ...request,
      voiceId: this.#fallbackVoiceId,
    };
    return this.#fallback.synthesize(fallbackRequest, signal);
  }

  async dispose(): Promise<void> {
    await Promise.all([this.#server.dispose(), this.#fallback.dispose()]);
  }
}

export function fallbackVoiceId(lang: Lang): string {
  return lang === "ar" ? "piper:ar_JO-kareem-medium" : "kokoro:af_heart";
}
