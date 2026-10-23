import { KokoroTTS, env as kokoroEnv } from "kokoro-js";
import { env as transformersEnv } from "@huggingface/transformers";
import {
  ModelManager,
  ModelUnavailableError,
} from "../models/manager";
import { MODEL_DESCRIPTORS } from "../models/catalog";
import {
  KOKORO_VOICES,
  kokoroVoiceDescription,
  kokoroVoiceName,
} from "./voice-catalog";
import { packagedUrl } from "./packaged-url";
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
  readonly #models = new ModelManager(MODEL_DESCRIPTORS);
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
    const installed = (modelId: string) =>
      this.#models.isInstalled(modelId).catch(() => false);
    const baseInstalled = await installed(MODEL_ID);
    const installedVoices = await Promise.all(
      KOKORO_VOICES.map((voice) =>
        installed(voiceModelId(voice)),
      ),
    );
    return KOKORO_VOICES.map((voice, index) => ({
      id: `kokoro:${voice}`,
      engineId: "kokoro",
      lang: "en",
      name: kokoroVoiceName(voice),
      description: kokoroVoiceDescription(voice),
      quality: "standard",
      local: true,
      supportsWordTimings: false,
      sizeBytes: voice === "af_heart" ? 90_000_000 : undefined,
      installed: baseInstalled && installedVoices[index],
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
    await this.#ensureVoice(voice, signal);
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
        "the pinned revision and SHA-256 manifest are not available",
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

    kokoroEnv.wasmPaths = packagedUrl("ort-transformers/");
    const model = this.#models.get(MODEL_ID);
    if (!model?.revision) {
      throw new ModelUnavailableError(MODEL_ID, "the revision is not pinned");
    }
    // transformers.js rejects a config with both sources off. The verified cache
    // is still read first, and remote fetches are pinned and SHA-checked on put.
    transformersEnv.allowRemoteModels = true;
    transformersEnv.allowLocalModels = false;
    transformersEnv.useFS = false;
    transformersEnv.useFSCache = false;
    transformersEnv.useBrowserCache = false;
    transformersEnv.useCustomCache = true;
    transformersEnv.remotePathTemplate = `{model}/resolve/${model.revision}/`;
    transformersEnv.customCache = this.#models.createTransformersCache();
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

  async #ensureVoice(voice: string, signal: AbortSignal): Promise<void> {
    if (!(KOKORO_VOICES as readonly string[]).includes(voice)) {
      throw new ModelUnavailableError(voice, "the Kokoro voice is not listed");
    }
    const modelId = voiceModelId(voice);
    if (!this.#models.canDownload(modelId)) {
      throw new ModelUnavailableError(modelId, "the pinned voice file is not listed");
    }
    if (signal.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (!(await this.#models.isInstalled(modelId))) {
      await this.#models.download(modelId);
    }
    await this.#seedKokoroVoiceCache(voice, modelId);
  }

  // kokoro-js always fetches voices from the unpinned `main` branch through its
  // own cache. Seed that cache with the verified pinned file so it never does.
  async #seedKokoroVoiceCache(voice: string, modelId: string): Promise<void> {
    const cache = await caches.open(KOKORO_JS_VOICE_CACHE);
    const url = `https://huggingface.co/${MODEL_REPO}/resolve/main/voices/${voice}.bin`;
    if (await cache.match(url)) return;
    const file = this.#models.get(modelId)?.files[0];
    if (!file) return;
    const bytes = await this.#models.readFile(modelId, file.url);
    await cache.put(url, new Response(bytes));
  }
}

const KOKORO_JS_VOICE_CACHE = "kokoro-voices";

function voiceModelId(voice: string): string {
  return `kokoro-voice-${voice}`;
}
