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
import { splitWordsForSynthesis } from "./text-chunks";
import { estimateWordTimings } from "./timings";
import type {
  SynthesisRequest,
  SynthesisResult,
  TtsEngine,
  VoiceInfo,
  WordTiming,
} from "./types";

const MODEL_ID = "kokoro-en-q8";
// WebGPU needs the full-precision model; the quantized one runs on the CPU.
const GPU_MODEL_ID = "kokoro-en-fp32";
const MODEL_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";

export class KokoroEngine implements TtsEngine {
  readonly id = "kokoro" as const;
  readonly #models = new ModelManager(MODEL_DESCRIPTORS);
  #tts: KokoroTTS | null = null;
  #loading: Promise<void> | null = null;
  readonly #gpu: boolean;
  #gpuAvailable: Promise<boolean> | null = null;

  constructor(gpu = false) {
    this.#gpu = gpu;
  }

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
    const modelId = await this.#modelId();
    const baseInstalled = await installed(modelId);
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
      sizeBytes:
        voice === "af_heart"
          ? modelId === GPU_MODEL_ID
            ? 330_000_000
            : 90_000_000
          : undefined,
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
    // Longer text is read in parts and joined; kokoro-js would cut it short.
    const parts: Float32Array[] = [];
    const timings: WordTiming[] = [];
    let sampleRate = 24_000;
    let offsetMs = 0;
    for (const [start, end] of splitWordsForSynthesis(request.words)) {
      const words = request.words.slice(start, end);
      const result = await this.#tts!.generate(words.join(" "), {
        voice: voice as (typeof KOKORO_VOICES)[number],
        speed: request.speed,
      });
      if (signal.aborted)
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      sampleRate = result.sampling_rate;
      for (const timing of estimateWordTimings(
        words.map((text, index) => ({
          wordIndex: request.wordIndices[start + index] ?? start + index,
          text,
        })),
        result.audio,
        sampleRate,
        request.lang,
      )) {
        timings.push({
          ...timing,
          startMs: timing.startMs + offsetMs,
          endMs: timing.endMs + offsetMs,
        });
      }
      parts.push(result.audio);
      offsetMs += (result.audio.length / sampleRate) * 1_000;
    }
    const audio = new Float32Array(
      parts.reduce((total, part) => total + part.length, 0),
    );
    let position = 0;
    for (const part of parts) {
      audio.set(part, position);
      position += part.length;
    }

    return { audio, sampleRate, timings, timingSource: "estimated" };
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
    const modelId = await this.#modelId();
    const gpu = modelId === GPU_MODEL_ID;
    if (!this.#models.canDownload(modelId)) {
      throw new ModelUnavailableError(
        modelId,
        "the pinned revision and SHA-256 manifest are not available",
      );
    }
    if (!(await this.#models.isInstalled(modelId))) {
      await this.#models.download(modelId, (progress) => {
        onProgress?.({
          loaded: progress.loaded,
          total: progress.total,
          stage: progress.stage,
        });
      });
    }

    kokoroEnv.wasmPaths = packagedUrl("ort-transformers/");
    const model = this.#models.get(modelId);
    if (!model?.revision) {
      throw new ModelUnavailableError(modelId, "the revision is not pinned");
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
      dtype: gpu ? "fp32" : "q8",
      device: gpu ? "webgpu" : "wasm",
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

  // The GPU model is used only when it was asked for and the worker has a
  // WebGPU adapter. Otherwise Kokoro falls back to the CPU.
  async #modelId(): Promise<string> {
    if (!this.#gpu) return MODEL_ID;
    this.#gpuAvailable ??= hasWebGpu();
    return (await this.#gpuAvailable) ? GPU_MODEL_ID : MODEL_ID;
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

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & {
    gpu?: { requestAdapter(): Promise<unknown> };
  }).gpu;
  try {
    return Boolean(await gpu?.requestAdapter());
  } catch {
    return false;
  }
}
