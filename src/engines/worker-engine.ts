import type {
  SynthesisRequest,
  SynthesisResult,
  TtsEngine,
  VoiceInfo,
} from "./types";

// ONNX inference blocks the thread it runs on for seconds per sentence. The
// in-browser engines run in a worker so the offscreen page still handles
// pause and skip immediately, and audio callbacks fire on time.

export type LocalEngineId = "kokoro" | "piper";

export interface InitProgress {
  loaded: number;
  total: number;
  stage: string;
}

interface EngineTarget {
  engine: LocalEngineId;
  diacritizeArabic: boolean;
}

export type LocalEngineCall =
  | ({ type: "init"; id: number } & EngineTarget)
  | ({ type: "list-voices"; id: number } & EngineTarget)
  | ({ type: "synthesize"; id: number; request: SynthesisRequest } & EngineTarget)
  | { type: "abort"; id: number };

export type LocalEngineReply =
  | { type: "progress"; id: number; progress: InitProgress }
  | { type: "result"; id: number; value: unknown }
  | { type: "error"; id: number; name: string; message: string };

type CallBody =
  | ({ type: "init" } & EngineTarget)
  | ({ type: "list-voices" } & EngineTarget)
  | ({ type: "synthesize"; request: SynthesisRequest } & EngineTarget);

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  onProgress?: (progress: InitProgress) => void;
}

export class LocalEngineWorker {
  readonly #create: () => Worker;
  readonly #pending = new Map<number, PendingCall>();
  #worker: Worker | null = null;
  #nextId = 0;

  constructor(create: () => Worker) {
    this.#create = create;
  }

  call<T>(
    body: CallBody,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: InitProgress) => void;
    } = {},
  ): Promise<T> {
    const { signal, onProgress } = options;
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    }
    const worker = this.#ensureWorker();
    const id = (this.#nextId += 1);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.#pending.delete(id);
        worker.postMessage({ type: "abort", id } satisfies LocalEngineCall);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        onProgress,
      });
      worker.postMessage({ ...body, id } as LocalEngineCall);
    });
  }

  terminate(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#failAll(new Error("The speech worker was stopped."));
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = this.#create();
    worker.onmessage = (event: MessageEvent<LocalEngineReply>) => {
      const reply = event.data;
      const pending = this.#pending.get(reply.id);
      if (!pending) return;
      if (reply.type === "progress") {
        pending.onProgress?.(reply.progress);
        return;
      }
      this.#pending.delete(reply.id);
      if (reply.type === "result") pending.resolve(reply.value);
      else {
        const error = new Error(reply.message);
        error.name = reply.name;
        pending.reject(error);
      }
    };
    // A crashed worker (for example out of memory) is replaced on next use.
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.#worker === worker) this.#worker = null;
      worker.terminate();
      this.#failAll(new Error(event.message || "The speech worker crashed."));
    };
    this.#worker = worker;
    return worker;
  }

  #failAll(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const call of pending) call.reject(error);
  }
}

export class WorkerEngine implements TtsEngine {
  readonly id: LocalEngineId;
  readonly #host: LocalEngineWorker;
  readonly #target: EngineTarget;
  #ready = false;

  constructor(
    id: LocalEngineId,
    host: LocalEngineWorker,
    diacritizeArabic = false,
  ) {
    this.id = id;
    this.#host = host;
    this.#target = { engine: id, diacritizeArabic };
  }

  async init(onProgress?: (progress: InitProgress) => void): Promise<void> {
    await this.#host.call({ type: "init", ...this.#target }, { onProgress });
    this.#ready = true;
  }

  isReady(): boolean {
    return this.#ready;
  }

  listVoices(): Promise<VoiceInfo[]> {
    return this.#host.call({ type: "list-voices", ...this.#target });
  }

  synthesize(
    request: SynthesisRequest,
    signal: AbortSignal,
  ): Promise<SynthesisResult> {
    return this.#host.call(
      { type: "synthesize", request, ...this.#target },
      { signal },
    );
  }

  // The worker keeps the model loaded so the next session starts quickly. It
  // is freed when the offscreen document closes.
  async dispose(): Promise<void> {
    this.#ready = false;
  }
}
