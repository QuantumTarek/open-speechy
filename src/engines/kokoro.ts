import { KokoroTTS, env as kokoroEnv } from "kokoro-js";
import modelManifest from "../models/models.json";
import {
  ModelManager,
  ModelUnavailableError,
  type ModelDescriptor,
} from "../models/manager";
import { KOKORO_VOICES } from "./voice-catalog";
import { estimateWordTimings } from "./timings";
import type {
  SynthesisRequest,
  SynthesisResult,
  TtsEngine,
  VoiceInfo,
} from "./types";

const MODEL_ID = "kokoro-en-q8";
const MODEL_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";

export class KokoroEngine implements TtsEngine {
  readonly id = "kokoro" as const;
  readonly #models = new ModelManager(
    modelManifest.models as ModelDescriptor[],
  );
  #tts: KokoroTTS | null = null;
  #loading: Promise<void> | null = null;

  async init(
    onProgress?: (progress: {
      loaded: number;
      total: number;
      stage: string;
    }) => void,
  ): Promise<void> {
    if (this.#tts) return;
    if (this.#loading) return this.#loading;
    this.#loading = this.#load(onProgress);
    try {
      await this.#loading;
    } finally {
      this.#loading = null;
    }
  }

  isReady(): boolean {
    return this.#tts !== null;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return KOKORO_VOICES.map((voice) => ({
      id: `kokoro:${voice}`,
      engineId: "kokoro",
      lang: "en",
      name: voice,
      quality: "standard",
      local: true,
      supportsWordTimings: false,
      installed: this.isReady(),
    }));
  }

  async synthesize(
    request: SynthesisRequest,
    signal: AbortSignal,
  ): Promise<SynthesisResult> {
    if (!this.#tts) await this.init();
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const voice = request.voiceId.split(":").at(-1) ?? "af_heart";
    const result = await this.#tts!.generate(request.text, {
      voice: voice as (typeof KOKORO_VOICES)[number],
      speed: request.speed,
    });
    if (signal.aborted)
      throw signal.reason ?? new DOMException("Aborted", "AbortError");

    return {
      audio: result.audio,
      sampleRate: result.sampling_rate,
      timings: estimateWordTimings(
        request.words.map((text, index) => ({
          wordIndex: request.wordIndices[index] ?? index,
          text,
        })),
        result.audio,
        result.sampling_rate,
        request.lang,
      ),
      timingSource: "estimated",
    };
  }

  async dispose(): Promise<void> {
    this.#tts = null;
  }

  async #load(
    onProgress?: (progress: {
      loaded: number;
      total: number;
      stage: string;
    }) => void,
  ): Promise<void> {
    if (!this.#models.canDownload(MODEL_ID)) {
      throw new ModelUnavailableError(
        MODEL_ID,
        "the M0 benchmark and pinned SHA-256 manifest are not available yet",
      );
    }
    if (!(await this.#models.isInstalled(MODEL_ID))) {
      await this.#models.download(MODEL_ID, (progress) => {
        onProgress?.({
          loaded: progress.loaded,
          total: progress.total,
          stage: progress.stage,
        });
      });
    }

    kokoroEnv.wasmPaths = chrome.runtime.getURL("ort/");
    this.#tts = await KokoroTTS.from_pretrained(MODEL_REPO, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (progress) => {
        if ("loaded" in progress && "total" in progress) {
          onProgress?.({
            loaded: progress.loaded,
            total: progress.total,
            stage: progress.status,
          });
        }
      },
    });
    if (this.#tts) onProgress?.({ loaded: 1, total: 1, stage: "ready" });
  }
}
