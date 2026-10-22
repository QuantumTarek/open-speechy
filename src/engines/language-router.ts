import { fallbackVoiceId } from "./fallback";
import { KokoroEngine } from "./kokoro";
import { PiperEngine } from "./piper";
import type {
  Lang,
  SynthesisRequest,
  SynthesisResult,
  TtsEngine,
  VoiceInfo,
} from "./types";

export interface LanguageRouterOptions {
  voiceIds: Partial<Record<Lang, string>>;
  server?: TtsEngine;
  diacritizeArabic?: boolean;
  onFallback?: (message: string) => void;
  createKokoro?: () => TtsEngine;
  createPiper?: () => TtsEngine;
}

export class LanguageRouterEngine implements TtsEngine {
  readonly id = "server" as const;
  readonly #voiceIds: Partial<Record<Lang, string>>;
  readonly #server?: TtsEngine;
  readonly #local: Record<Lang, TtsEngine>;
  readonly #onFallback: (message: string) => void;
  #serverUnavailable = false;
  #fallbackNoticeShown = false;

  constructor(options: LanguageRouterOptions) {
    this.#voiceIds = options.voiceIds;
    this.#server = options.server;
    this.#local = {
      en: options.createKokoro?.() ?? new KokoroEngine(),
      ar:
        options.createPiper?.() ??
        new PiperEngine(options.diacritizeArabic ?? false),
    };
    this.#onFallback = options.onFallback ?? (() => {});
  }

  async init(): Promise<void> {}

  isReady(): boolean {
    return Object.values(this.#local).some((engine) => engine.isReady());
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const local = await Promise.all(
      Object.values(this.#local).map((engine) => engine.listVoices()),
    );
    const server = await this.#server?.listVoices().catch(() => []) ?? [];
    return [...server, ...local.flat()];
  }

  async synthesize(
    request: SynthesisRequest,
    signal: AbortSignal,
  ): Promise<SynthesisResult> {
    const selectedVoiceId =
      this.#voiceIds[request.lang] ?? request.voiceId ?? fallbackVoiceId(request.lang);
    if (
      selectedVoiceId.startsWith("server:") &&
      this.#server &&
      !this.#serverUnavailable
    ) {
      try {
        return await this.#server.synthesize(
          { ...request, voiceId: selectedVoiceId },
          signal,
        );
      } catch {
        if (signal.aborted) {
          throw signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        this.#serverUnavailable = true;
        if (!this.#fallbackNoticeShown) {
          this.#fallbackNoticeShown = true;
          this.#onFallback(
            "Local server unavailable. Switching to in-browser voices.",
          );
        }
      }
    }

    const engine = this.#local[request.lang];
    const enginePrefix = `${engine.id}:`;
    const localVoiceId = selectedVoiceId.startsWith(enginePrefix)
      ? selectedVoiceId
      : fallbackVoiceId(request.lang);
    return engine.synthesize(
      { ...request, voiceId: localVoiceId },
      signal,
    );
  }

  async dispose(): Promise<void> {
    await Promise.all([
      ...Object.values(this.#local).map((engine) => engine.dispose()),
      this.#server?.dispose(),
    ]);
  }
}
