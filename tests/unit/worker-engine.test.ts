import { describe, expect, it } from "vitest";
import type { SynthesisRequest } from "../../src/engines/types";
import {
  LocalEngineWorker,
  WorkerEngine,
  type LocalEngineCall,
  type LocalEngineReply,
} from "../../src/engines/worker-engine";

const REQUEST: SynthesisRequest = {
  sentenceId: "s0",
  lang: "en",
  voiceId: "kokoro:af_heart",
  wordIndices: [0],
  words: ["hello"],
  text: "hello",
  speed: 1,
};

class FakeWorker {
  readonly posted: LocalEngineCall[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<LocalEngineReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: LocalEngineCall): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(message: LocalEngineReply): void {
    this.onmessage?.({ data: message } as MessageEvent<LocalEngineReply>);
  }

  crash(message: string): void {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const host = new LocalEngineWorker(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  return { host, workers };
}

describe("worker engine", () => {
  it("forwards download progress and becomes ready after init", async () => {
    const { host, workers } = setup();
    const engine = new WorkerEngine("piper", host, true);
    const progress: number[] = [];

    const init = engine.init(({ loaded }) => progress.push(loaded));
    const call = workers[0].posted[0];
    expect(call).toMatchObject({
      type: "init",
      engine: "piper",
      diacritizeArabic: true,
    });
    workers[0].reply({
      type: "progress",
      id: call.id,
      progress: { loaded: 5, total: 10, stage: "downloading" },
    });
    workers[0].reply({ type: "result", id: call.id, value: undefined });
    await init;

    expect(progress).toEqual([5]);
    expect(engine.isReady()).toBe(true);
  });

  it("rejects an aborted synthesis at once and tells the worker", async () => {
    const { host, workers } = setup();
    const engine = new WorkerEngine("kokoro", host);
    const controller = new AbortController();

    const synthesis = engine.synthesize(REQUEST, controller.signal);
    const call = workers[0].posted[0];
    controller.abort();

    await expect(synthesis).rejects.toThrow();
    expect(workers[0].posted.at(-1)).toEqual({ type: "abort", id: call.id });
    // A late result for the cancelled call is ignored.
    workers[0].reply({ type: "result", id: call.id, value: {} });
  });

  it("passes engine errors through with their name", async () => {
    const { host, workers } = setup();
    const engine = new WorkerEngine("kokoro", host);

    const synthesis = engine.synthesize(REQUEST, new AbortController().signal);
    workers[0].reply({
      type: "error",
      id: workers[0].posted[0].id,
      name: "ModelUnavailableError",
      message: "Model missing.",
    });

    await expect(synthesis).rejects.toMatchObject({
      name: "ModelUnavailableError",
      message: "Model missing.",
    });
  });

  it("fails pending calls when the worker crashes and starts a new one", async () => {
    const { host, workers } = setup();
    const engine = new WorkerEngine("kokoro", host);

    const synthesis = engine.synthesize(REQUEST, new AbortController().signal);
    workers[0].crash("Out of memory");
    await expect(synthesis).rejects.toThrow("Out of memory");
    expect(workers[0].terminated).toBe(true);

    void engine.listVoices();
    expect(workers).toHaveLength(2);
  });
});
