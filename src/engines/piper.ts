import * as ort from "onnxruntime-web";
import createPiperPhonemize from "@diffusionstudio/piper-wasm/build/piper_phonemize.js";
import piperDataUrl from "@diffusionstudio/piper-wasm/build/piper_phonemize.data?url";
import piperWasmUrl from "@diffusionstudio/piper-wasm/build/piper_phonemize.wasm?url";
import { ArabicDiacritizer, createLibTashkeelPredictor } from "./diacritizer";
import { packagedUrl } from "./packaged-url";
import { parsePiperPhonemeOutput, piperScales } from "./piper-utils";
import { estimateWordTimings } from "./timings";
import type {
  SynthesisRequest,
  SynthesisResult,
  TtsEngine,
  VoiceInfo,
} from "./types";
import {
  ModelManager,
  ModelUnavailableError,
} from "../models/manager";
import { MODEL_DESCRIPTORS } from "../models/catalog";

const MODEL_ID = "piper-ar-kareem-medium";
const VOICE_ID = "piper:ar_JO-kareem-medium";

interface PiperModelConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: {
    noise_scale: number;
    length_scale: number;
    noise_w: number;
  };
  num_speakers: number;
  speaker_id_map: Record<string, number>;
}

interface PiperPhonemizeModule {
  callMain(args: string[]): void;
  print: (message: string) => void;
}

export class PiperEngine implements TtsEngine {
  readonly id = "piper" as const;
  readonly #models = new ModelManager(MODEL_DESCRIPTORS);
  #diacritizerPredictor: ReturnType<typeof createLibTashkeelPredictor> | null =
    null;
  readonly #diacritizer: ArabicDiacritizer;
  #session: ort.InferenceSession | null = null;
  #modelConfig: PiperModelConfig | null = null;
  #phonemizerModule: Promise<PiperPhonemizeModule> | null = null;
  #phonemizerOutput: string[] = [];
  #loading: Promise<void> | null = null;

  constructor(diacritize = false) {
    this.#diacritizer = new ArabicDiacritizer(
      diacritize,
      async (text) => {
        this.#diacritizerPredictor ??= createLibTashkeelPredictor(this.#models);
        return this.#diacritizerPredictor(text);
      },
    );
  }

  isReady(): boolean {
    return this.#session !== null;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    let installed = false;
    try {
      installed = await this.#models.isInstalled(MODEL_ID);
    } catch {
      installed = false;
    }
    return [
      {
        id: VOICE_ID,
        engineId: "piper",
        lang: "ar",
        name: "Kareem",
        description: "Jordanian Arabic · male",
        quality: "standard",
        local: true,
        supportsWordTimings: false,
        sizeBytes: 63_206_318,
        installed,
      },
    ];
  }

  async init(
    onProgress?: (progress: {
      loaded: number;
      total: number;
      stage: string;
    }) => void,
  ): Promise<void> {
    if (this.#session) return;
    if (this.#loading) return this.#loading;
    this.#loading = this.#load(onProgress);
    try {
      await this.#loading;
    } finally {
      this.#loading = null;
    }
  }

  async synthesize(
    request: SynthesisRequest,
    signal: AbortSignal,
  ): Promise<SynthesisResult> {
    if (request.lang !== "ar" || !request.words.length) {
      throw new Error("Piper Kareem supports Arabic text only.");
    }
    await this.init();
    if (signal.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const spokenWords = await this.#diacritizer.apply(request.words);
    const phonemeIds = await this.#phonemize(
      spokenWords.join(" "),
      this.#modelConfig!.espeak.voice,
    );
    if (signal.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const config = this.#modelConfig!;
    const feeds: Record<string, ort.Tensor> = {
      input: new ort.Tensor(
        "int64",
        BigInt64Array.from(phonemeIds, BigInt),
        [1, phonemeIds.length],
      ),
      input_lengths: new ort.Tensor(
        "int64",
        BigInt64Array.of(BigInt(phonemeIds.length)),
        [1],
      ),
      scales: new ort.Tensor(
        "float32",
        piperScales(config.inference, request.speed),
      ),
    };
    if (Object.keys(config.speaker_id_map).length > 0) {
      feeds.sid = new ort.Tensor("int64", BigInt64Array.of(0n), [1]);
    }
    const output = await this.#session!.run(feeds);
    const outputPcm = output.output?.data;
    if (!(outputPcm instanceof Float32Array) || outputPcm.length === 0) {
      throw new Error("Piper returned an invalid audio tensor.");
    }
    if (signal.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const wordTimings = estimateWordTimings(
      request.words.map((text, index) => ({
        wordIndex: request.wordIndices[index] ?? index,
        text,
      })),
      outputPcm,
      config.audio.sample_rate,
      request.lang,
    );
    return {
      audio: outputPcm,
      sampleRate: config.audio.sample_rate,
      timings: wordTimings,
      timingSource: "estimated",
    };
  }

  async dispose(): Promise<void> {
    await this.#session?.release();
    this.#session = null;
    this.#modelConfig = null;
    this.#phonemizerModule = null;
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
        "a pinned revision and verified SHA-256 manifest are required",
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

    const descriptor = this.#models.get(MODEL_ID)!;
    const modelFile = descriptor.files.find((file) => file.url.endsWith(".onnx"));
    const configFile = descriptor.files.find((file) =>
      file.url.endsWith(".onnx.json"),
    );
    if (!modelFile || !configFile) {
      throw new ModelUnavailableError(MODEL_ID, "the Piper manifest is incomplete");
    }
    const [modelBytes, configBytes] = await Promise.all([
      this.#models.readFile(MODEL_ID, modelFile.url),
      this.#models.readFile(MODEL_ID, configFile.url),
    ]);
    const config = JSON.parse(
      new TextDecoder().decode(configBytes),
    ) as PiperModelConfig;
    if (
      !Number.isSafeInteger(config.audio?.sample_rate) ||
      !config.espeak?.voice ||
      !config.inference
    ) {
      throw new Error("The downloaded Piper voice configuration is invalid.");
    }

    ort.env.wasm.wasmPaths = packagedUrl("ort/");
    this.#session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
    });
    this.#modelConfig = config;
  }

  async #phonemize(text: string, language: string): Promise<number[]> {
    this.#phonemizerModule ??= createPiperPhonemize({
      locateFile(path) {
        if (path.endsWith(".wasm")) return piperWasmUrl;
        if (path.endsWith(".data")) return piperDataUrl;
        return path;
      },
      // Emscripten reads print once at startup, so it must be passed here.
      print: (line) => this.#phonemizerOutput.push(line),
      printErr(message) {
        throw new Error(message);
      },
    });
    const module = await this.#phonemizerModule;
    const output: string[] = [];
    this.#phonemizerOutput = output;
    module.callMain([
      "-l",
      language,
      "--input",
      JSON.stringify([{ text: text.trim() }]),
      "--espeak_data",
      "/espeak-ng-data",
    ]);
    return parsePiperPhonemeOutput(output);
  }
}
