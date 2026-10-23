import { fallbackVoiceId } from "./fallback";
import type { PrepareProgress } from "./server";
import type {
  Lang,
  SynthesisRequest,
  SynthesisResult,
  TtsEngine,
  VoiceInfo,
} from "./types";

// ModelManager stages for network downloads. Cache hits report "ready", and
// Transformers.js reports its own cache reads with other stage names.
const DOWNLOAD_STAGES = new Set(["downloading", "verified"]);

// The server engine can download and load a voice's model ahead of synthesis.
export interface PreparableEngine extends TtsEngine {
  prepareVoice?(
    voiceId: string,
    onProgress: (progress: PrepareProgress) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface LanguageRouterOptions {
  voiceIds: Partial<Record<Lang, string>>;
  server?: PreparableEngine;
  onFallback?: (message: string) => void;
  // Reports first-use model download progress from 0 to 1.
  onDownloadProgress?: (fraction: number) => void;
  // The in-browser engines. The offscreen page runs them in a worker.
  createKokoro: () => TtsEngine;
  createPiper: () => TtsEngine;
}

export class LanguageRouterEngine implements TtsEngine {
  readonly id = "server" as const;
  readonly #voiceIds: Partial<Record<Lang, string>>;
  readonly #server?: PreparableEngine;
  // One preparation per server voice, shared by the sentences waiting on it.
  readonly #serverPreparations = new Map<string, Promise<void>>();
  readonly #local: Record<Lang, TtsEngine>;
  readonly #onFallback: (message: string) => void;
  readonly #onDownloadProgress: (fraction: number) => void;
  #serverUnavailable = false;
  #fallbackNoticeShown = false;

  constructor(options: LanguageRouterOptions) {
    this.#voiceIds = options.voiceIds;
    this.#server = options.server;
    this.#local = {
      en: options.createKokoro(),
      ar: options.createPiper(),
    };
    this.#onFallback = options.onFallback ?? (() => {});
    this.#onDownloadProgress = options.onDownloadProgress ?? (() => {});
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
        await this.#prepareServerVoice(selectedVoiceId, signal);
        return await this.#server.synthesize(
          { ...request, voiceId: selectedVoiceId },
          signal,
        );
      } catch (error) {
        if (signal.aborted) {
          throw signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        this.#serverUnavailable = true;
        if (!this.#fallbackNoticeShown) {
          this.#fallbackNoticeShown = true;
          this.#onFallback(
            error instanceof ServerPreparationError
              ? `${error.message} Switching to in-browser voices.`
              : "Local server unavailable. Switching to in-browser voices.",
          );
        }
      }
    }

    const engine = this.#local[request.lang];
    if (!engine.isReady()) {
      let downloaded = false;
      await engine.init(({ loaded, total, stage }) => {
        if (DOWNLOAD_STAGES.has(stage) && total > 0) {
          downloaded = true;
          this.#onDownloadProgress(Math.min(1, loaded / total));
        }
      });
      if (downloaded) this.#onDownloadProgress(1);
    }
    const enginePrefix = `${engine.id}:`;
    const localVoiceId = selectedVoiceId.startsWith(enginePrefix)
      ? selectedVoiceId
      : fallbackVoiceId(request.lang);
    return engine.synthesize(
      { ...request, voiceId: localVoiceId },
      signal,
    );
  }

  async #prepareServerVoice(
    voiceId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const server = this.#server;
    if (!server?.prepareVoice) return;
    let preparation = this.#serverPreparations.get(voiceId);
    if (!preparation) {
      let downloaded = false;
      // Not tied to one sentence: a seek must not cancel a shared download.
      preparation = server
        .prepareVoice(voiceId, ({ stage, loaded, total }) => {
          if (stage === "downloading" && total > 0) {
            downloaded = true;
            this.#onDownloadProgress(Math.min(1, loaded / total));
          } else if (stage === "loading" && downloaded) {
            downloaded = false;
            this.#onDownloadProgress(1);
          }
        })
        .catch((error: unknown) => {
          this.#serverPreparations.delete(voiceId);
          throw new ServerPreparationError(
            error instanceof Error ? error.message : "The server voice failed.",
          );
        })
        .finally(() => {
          if (downloaded) this.#onDownloadProgress(1);
        });
      this.#serverPreparations.set(voiceId, preparation);
    }
    await abortable(preparation, signal);
  }

  async dispose(): Promise<void> {
    await Promise.all([
      ...Object.values(this.#local).map((engine) => engine.dispose()),
      this.#server?.dispose(),
    ]);
  }
}

class ServerPreparationError extends Error {}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
