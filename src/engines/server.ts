import { estimateWordTimings } from "./timings";
import type {
  Lang,
  SynthesisRequest,
  SynthesisResult,
  TtsEngine,
  VoiceInfo,
  WordTiming,
} from "./types";

export interface ServerEngineStatus {
  id: string;
  loaded: boolean;
  langs: Lang[];
}

export interface ServerHealth {
  ok: true;
  version: string;
  device: "mps" | "cuda" | "cpu";
  engines: ServerEngineStatus[];
}

export type ServerModelState =
  | "missing"
  | "downloaded"
  | "downloading"
  | "loading"
  | "loaded"
  | "error";

/** A model the server downloads on first use, or the shared word aligner. */
export interface ServerModel {
  id: string;
  name: string;
  kind: "voice" | "aligner";
  langs: Lang[];
  bytes: number;
  downloadedBytes: number;
  state: ServerModelState;
  // While downloading: every file the preparation needs, aligner included.
  progress?: { downloaded: number; total: number };
  error?: string;
}

export interface PrepareProgress {
  stage: "downloading" | "loading";
  loaded: number;
  total: number;
}

const PREPARE_POLL_MS = 500;
// Preparation that reports no change for this long has stalled.
const PREPARE_STALL_MS = 5 * 60_000;

export class ServerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ServerRequestError";
  }
}

interface ServerSynthesisResponse {
  sampleRate: number;
  audioWavBase64: string;
  timings: WordTiming[];
  timingSource: "model" | "estimated" | "aligned";
}

interface FetchOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  makeRequestId?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class ServerEngine implements TtsEngine {
  readonly id = "server" as const;
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #makeRequestId: () => string;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  #ready = false;
  #healthCache: { health: ServerHealth | null; expiresAt: number } | null =
    null;

  constructor(
    baseUrl: string,
    token: string,
    options: FetchOptions = {},
  ) {
    this.#baseUrl = normalizeServerUrl(baseUrl);
    this.#token = token;
    this.#fetch = options.fetcher ?? fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#makeRequestId =
      options.makeRequestId ??
      (() => `os-${this.#now()}-${Math.random().toString(36).slice(2, 10)}`);
    this.#sleep = options.sleep ?? sleep;
  }

  isReady(): boolean {
    return this.#ready;
  }

  async init(): Promise<void> {
    const health = await this.health(true);
    if (!health) throw new Error("The local speech server is unavailable.");
    this.#ready = true;
  }

  async health(refresh = false): Promise<ServerHealth | null> {
    if (
      !refresh &&
      this.#healthCache &&
      this.#healthCache.expiresAt > this.#now()
    ) {
      return this.#healthCache.health;
    }
    try {
      const response = await this.#fetchWithTimeout(
        "/health",
        { headers: this.#headers() },
        8_000,
      );
      if (!response.ok) {
        this.#cacheHealth(null);
        return null;
      }
      const parsed = parseHealth(await response.json());
      this.#cacheHealth(parsed);
      this.#ready = parsed !== null;
      return parsed;
    } catch {
      this.#cacheHealth(null);
      this.#ready = false;
      return null;
    }
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const response = await this.#fetchWithTimeout(
      "/voices",
      { headers: this.#headers() },
      5_000,
    );
    if (!response.ok) throw await responseError(response);
    const parsed: unknown = await response.json();
    if (!Array.isArray(parsed)) throw new Error("Invalid server voice response.");
    return parsed.flatMap((value) => {
      const voice = parseVoice(value);
      return voice ? [voice] : [];
    });
  }

  async warmup(engineIds: string[]): Promise<void> {
    const response = await this.#fetchWithTimeout(
      "/warmup",
      {
        method: "POST",
        headers: this.#headers(true),
        body: JSON.stringify({ engines: engineIds }),
      },
      5 * 60_000,
    );
    if (!response.ok && response.status !== 204) {
      throw await responseError(response);
    }
  }

  /** The server's models, or null for a server too old to report them. */
  async models(): Promise<ServerModel[] | null> {
    const response = await this.#fetchWithTimeout(
      "/models",
      { headers: this.#headers() },
      15_000,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await responseError(response);
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.models)) {
      throw new Error("Invalid server model response.");
    }
    return body.models.flatMap((value) => {
      const model = parseModel(value);
      return model ? [model] : [];
    });
  }

  /** Starts a download and load on the server. models() reports progress. */
  async prepareModel(modelId: string): Promise<void> {
    const response = await this.#fetchWithTimeout(
      `/models/${encodeURIComponent(modelId)}/prepare`,
      { method: "POST", headers: this.#headers() },
      15_000,
    );
    if (!response.ok) throw await responseError(response);
  }

  /** Deletes a model's files from the server. Returns the bytes freed. */
  async removeModel(modelId: string): Promise<number> {
    const response = await this.#fetchWithTimeout(
      `/models/${encodeURIComponent(modelId)}`,
      { method: "DELETE", headers: this.#headers() },
      60_000,
    );
    if (!response.ok) throw await responseError(response);
    const body: unknown = await response.json();
    return isRecord(body) && typeof body.freedBytes === "number"
      ? body.freedBytes
      : 0;
  }

  /**
   * Downloads and loads the model behind a voice before its first sentence.
   * A first download can take minutes, longer than one synthesis request may.
   */
  async prepareVoice(
    voiceId: string,
    onProgress: (progress: PrepareProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const engineId = voiceId.split(":")[1] ?? "";
    let model = (await this.models())?.find((entry) => entry.id === engineId);
    if (!model || model.state === "loaded") return;
    await this.prepareModel(engineId);
    let lastChange = this.#now();
    let lastSeen = "";
    for (;;) {
      await this.#sleep(PREPARE_POLL_MS, signal);
      model = (await this.models())?.find((entry) => entry.id === engineId);
      if (!model || model.state === "loaded") return;
      if (model.state === "error") {
        throw new Error(model.error ?? `The server could not prepare ${model.name}.`);
      }
      if (model.state === "missing" || model.state === "downloaded") {
        // Nothing is preparing it any more, so the server restarted.
        throw new Error(`The server stopped preparing ${model.name}.`);
      }
      const loaded = model.progress?.downloaded ?? 0;
      const total = model.progress?.total ?? 0;
      onProgress({
        stage: model.state === "downloading" ? "downloading" : "loading",
        loaded,
        total,
      });
      const seen = `${model.state}:${loaded}`;
      if (seen !== lastSeen) {
        lastSeen = seen;
        lastChange = this.#now();
      } else if (this.#now() - lastChange > PREPARE_STALL_MS) {
        throw new Error(`Preparing ${model.name} on the server stalled.`);
      }
    }
  }

  async synthesize(
    request: SynthesisRequest,
    signal: AbortSignal,
  ): Promise<SynthesisResult> {
    if (signal.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const requestId = this.#makeRequestId();
    const controller = new AbortController();
    const onAbort = () => {
      controller.abort(signal.reason);
      void this.#cancel(requestId);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      controller.abort(new Error("Server synthesis timed out."));
      void this.#cancel(requestId);
    }, 45_000);

    try {
      const response = await this.#fetch(
        `${this.#baseUrl}/synthesize`,
        {
          method: "POST",
          headers: {
            ...this.#headers(true),
            "X-Request-Id": requestId,
          },
          body: JSON.stringify({
            voiceId: request.voiceId,
            lang: request.lang,
            words: request.words,
            speed: request.speed,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw await responseError(response);
      const body = parseSynthesisResponse(await response.json());
      const decoded = decodeWav(body.audioWavBase64);
      const timings = mapTimings(
        body.timings,
        request.wordIndices,
        request.words,
      );
      return {
        audio: decoded.audio,
        sampleRate: decoded.sampleRate || body.sampleRate,
        timings:
          timings.length > 0
            ? timings
            : estimateWordTimings(
                request.words.map((text, index) => ({
                  text,
                  wordIndex: request.wordIndices[index] ?? index,
                })),
                decoded.audio,
                decoded.sampleRate || body.sampleRate,
                request.lang,
              ),
        timingSource: timings.length > 0 ? body.timingSource : "estimated",
      };
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }

  async dispose(): Promise<void> {
    this.#ready = false;
  }

  #headers(json = false): HeadersInit {
    return {
      Authorization: `Bearer ${this.#token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  async #fetchWithTimeout(
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  #cacheHealth(health: ServerHealth | null): void {
    // A failure is retried soon: the server may have been starting up.
    this.#healthCache = {
      health,
      expiresAt: this.#now() + (health ? 30_000 : 2_000),
    };
  }

  async #cancel(requestId: string): Promise<void> {
    try {
      await this.#fetch(
        `${this.#baseUrl}/synthesize/${encodeURIComponent(requestId)}`,
        {
          method: "DELETE",
          headers: this.#headers(),
        },
      );
    } catch {
      // The server may already have completed or stopped.
    }
  }
}

export function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid local server URL.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    (url.port && url.port !== "5123") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Open Speechy only sends text to http://127.0.0.1:5123.");
  }
  return "http://127.0.0.1:5123";
}

function parseHealth(value: unknown): ServerHealth | null {
  if (!isRecord(value) || value.ok !== true || typeof value.version !== "string") {
    return null;
  }
  const device = value.device;
  if (device !== "mps" && device !== "cuda" && device !== "cpu") return null;
  const engines = Array.isArray(value.engines)
    ? value.engines.flatMap((engine) => {
        if (
          !isRecord(engine) ||
          typeof engine.id !== "string" ||
          typeof engine.loaded !== "boolean" ||
          !Array.isArray(engine.langs)
        ) {
          return [];
        }
        const langs = engine.langs.filter(
          (lang): lang is Lang => lang === "en" || lang === "ar",
        );
        return [{ id: engine.id, loaded: engine.loaded, langs }];
      })
    : [];
  return { ok: true, version: value.version, device, engines };
}

function parseVoice(value: unknown): VoiceInfo | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.engineId !== "server" ||
    (value.lang !== "en" && value.lang !== "ar") ||
    typeof value.name !== "string" ||
    !isQuality(value.quality) ||
    typeof value.local !== "boolean" ||
    typeof value.supportsWordTimings !== "boolean" ||
    typeof value.installed !== "boolean"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    engineId: "server",
    lang: value.lang,
    name: value.name,
    description:
      typeof value.description === "string" ? value.description : undefined,
    quality: value.quality,
    local: value.local,
    supportsWordTimings: value.supportsWordTimings,
    sizeBytes:
      typeof value.sizeBytes === "number" ? value.sizeBytes : undefined,
    installed: value.installed,
  };
}

const MODEL_STATES = new Set<ServerModelState>([
  "missing",
  "downloaded",
  "downloading",
  "loading",
  "loaded",
  "error",
]);

function parseModel(value: unknown): ServerModel | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.bytes !== "number" ||
    typeof value.downloadedBytes !== "number" ||
    !MODEL_STATES.has(value.state as ServerModelState)
  ) {
    return undefined;
  }
  const progress =
    isRecord(value.progress) &&
    typeof value.progress.downloaded === "number" &&
    typeof value.progress.total === "number"
      ? { downloaded: value.progress.downloaded, total: value.progress.total }
      : undefined;
  return {
    id: value.id,
    name: value.name,
    kind: value.kind === "aligner" ? "aligner" : "voice",
    langs: Array.isArray(value.langs)
      ? value.langs.filter((lang): lang is Lang => lang === "en" || lang === "ar")
      : [],
    bytes: value.bytes,
    downloadedBytes: value.downloadedBytes,
    state: value.state as ServerModelState,
    progress,
    error: typeof value.error === "string" ? value.error : undefined,
  };
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseSynthesisResponse(value: unknown): ServerSynthesisResponse {
  if (
    !isRecord(value) ||
    typeof value.sampleRate !== "number" ||
    value.sampleRate <= 0 ||
    typeof value.audioWavBase64 !== "string" ||
    !Array.isArray(value.timings)
  ) {
    throw new Error("Invalid synthesis response from the local server.");
  }
  const timingSource =
    value.timingSource === "model" ||
    value.timingSource === "aligned" ||
    value.timingSource === "estimated"
      ? value.timingSource
      : "estimated";
  return {
    sampleRate: value.sampleRate,
    audioWavBase64: value.audioWavBase64,
    timings: value.timings.flatMap((timing) => {
      if (
        !isRecord(timing) ||
        typeof timing.wordIndex !== "number" ||
        !Number.isSafeInteger(timing.wordIndex) ||
        timing.wordIndex < 0 ||
        typeof timing.startMs !== "number" ||
        typeof timing.endMs !== "number" ||
        timing.startMs < 0 ||
        timing.endMs < timing.startMs
      ) {
        return [];
      }
      return [
        {
          wordIndex: timing.wordIndex,
          startMs: timing.startMs,
          endMs: timing.endMs,
        },
      ];
    }),
    timingSource,
  };
}

function mapTimings(
  timings: WordTiming[],
  wordIndices: number[],
  words: string[],
): WordTiming[] {
  if (timings.length !== words.length) return [];
  const seen = new Set<number>();
  let priorEnd = 0;
  let priorWordIndex = -1;
  for (const timing of timings) {
    if (
      timing.wordIndex >= wordIndices.length ||
      seen.has(timing.wordIndex) ||
      timing.startMs < priorEnd ||
      timing.wordIndex <= priorWordIndex
    ) {
      return [];
    }
    seen.add(timing.wordIndex);
    priorEnd = timing.endMs;
    priorWordIndex = timing.wordIndex;
  }
  return timings.map((timing) => ({
    ...timing,
    wordIndex: wordIndices[timing.wordIndex] ?? timing.wordIndex,
  }));
}

function decodeWav(base64: string): {
  audio: Float32Array;
  sampleRate: number;
} {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 44 ||
    readFourCC(view, 0) !== "RIFF" ||
    readFourCC(view, 8) !== "WAVE"
  ) {
    throw new Error("The local server returned an invalid WAV file.");
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const name = readFourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const contents = offset + 8;
    if (contents + size > view.byteLength) break;
    if (name === "fmt " && size >= 16) {
      format = view.getUint16(contents, true);
      channels = view.getUint16(contents + 2, true);
      sampleRate = view.getUint32(contents + 4, true);
      bitsPerSample = view.getUint16(contents + 14, true);
    } else if (name === "data") {
      dataOffset = contents;
      dataLength = size;
    }
    offset = contents + size + (size % 2);
  }

  if (
    dataOffset < 0 ||
    channels < 1 ||
    sampleRate < 1 ||
    ![1, 3].includes(format) ||
    ![8, 16, 24, 32].includes(bitsPerSample) ||
    (format === 3 && bitsPerSample !== 32)
  ) {
    throw new Error("The local server returned an unsupported WAV format.");
  }
  const bytesPerSample = bitsPerSample / 8;
  const frameSize = bytesPerSample * channels;
  const frameCount = Math.floor(dataLength / frameSize);
  const audio = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sample = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = dataOffset + frame * frameSize + channel * bytesPerSample;
      let value: number;
      if (format === 3) value = view.getFloat32(offset, true);
      else if (bitsPerSample === 8) value = (view.getUint8(offset) - 128) / 128;
      else if (bitsPerSample === 16) {
        value = view.getInt16(offset, true) / 32768;
      } else if (bitsPerSample === 24) {
        let integer =
          view.getUint8(offset) |
          (view.getUint8(offset + 1) << 8) |
          (view.getUint8(offset + 2) << 16);
        if (integer & 0x800000) integer |= 0xff000000;
        value = integer / 8_388_608;
      } else value = view.getInt32(offset, true) / 2_147_483_648;
      sample += value;
    }
    audio[frame] = sample / channels;
  }
  return { audio, sampleRate };
}

function readFourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

async function responseError(response: Response): Promise<ServerRequestError> {
  let message = `Local server request failed with HTTP ${response.status}.`;
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.detail === "string") message = body.detail;
  } catch {
    // Keep the generic status message when the response is not JSON.
  }
  return new ServerRequestError(message, response.status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isQuality(
  value: unknown,
): value is VoiceInfo["quality"] {
  return (
    value === "premium" ||
    value === "enhanced" ||
    value === "standard" ||
    value === "compact"
  );
}

/** The server version this extension build expects. */
export const EXPECTED_SERVER_VERSION = "0.2.0";

/** True when the paired server reports a version older than expected. */
export function serverUpdateAvailable(version: string): boolean {
  const parse = (value: string) =>
    value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [haveMajor, haveMinor, havePatch] = parse(version);
  const [wantMajor, wantMinor, wantPatch] = parse(EXPECTED_SERVER_VERSION);
  if (haveMajor !== wantMajor) return haveMajor < wantMajor;
  if (haveMinor !== wantMinor) return haveMinor < wantMinor;
  return havePatch < wantPatch;
}
