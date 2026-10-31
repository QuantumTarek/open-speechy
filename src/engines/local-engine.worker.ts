import { KokoroEngine } from "./kokoro";
import { PiperEngine } from "./piper";
import type { TtsEngine } from "./types";
import type { LocalEngineCall, LocalEngineReply } from "./worker-engine";

const engines = new Map<string, TtsEngine>();
const controllers = new Map<number, AbortController>();
// Engines share one ONNX runtime, so calls run one at a time.
let queue: Promise<void> = Promise.resolve();

function engineFor(
  call: Exclude<LocalEngineCall, { type: "abort" }>,
): TtsEngine {
  const key =
    call.engine === "piper"
      ? `piper:${call.diacritizeArabic}`
      : `kokoro:${call.gpu}`;
  let engine = engines.get(key);
  if (!engine) {
    engine =
      call.engine === "piper"
        ? new PiperEngine(call.diacritizeArabic)
        : new KokoroEngine(call.gpu);
    engines.set(key, engine);
  }
  return engine;
}

function reply(message: LocalEngineReply): void {
  self.postMessage(message, transferables(message));
}

// Synthesized audio is moved to the page rather than copied.
function transferables(message: LocalEngineReply): Transferable[] {
  if (message.type !== "result") return [];
  const audio = (message.value as { audio?: unknown } | undefined)?.audio;
  if (
    audio instanceof Float32Array &&
    audio.buffer instanceof ArrayBuffer &&
    audio.byteOffset === 0 &&
    audio.byteLength === audio.buffer.byteLength
  ) {
    return [audio.buffer];
  }
  return [];
}

async function run(
  call: Exclude<LocalEngineCall, { type: "abort" }>,
  controller: AbortController,
): Promise<void> {
  try {
    // Let abort messages that arrived during the previous call land first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (controller.signal.aborted) return;
    const engine = engineFor(call);
    let value: unknown;
    if (call.type === "init") {
      await engine.init((progress) =>
        reply({ type: "progress", id: call.id, progress }),
      );
    } else if (call.type === "list-voices") {
      value = await engine.listVoices();
    } else {
      value = await engine.synthesize(call.request, controller.signal);
    }
    reply({ type: "result", id: call.id, value });
  } catch (error) {
    reply({
      type: "error",
      id: call.id,
      name: error instanceof Error ? error.name : "Error",
      message:
        error instanceof Error ? error.message : "Speech synthesis failed.",
    });
  } finally {
    controllers.delete(call.id);
  }
}

self.onmessage = (event: MessageEvent<LocalEngineCall>) => {
  const call = event.data;
  if (call.type === "abort") {
    controllers.get(call.id)?.abort();
    return;
  }
  // Registered now so an abort also reaches a call still waiting in the queue.
  const controller = new AbortController();
  controllers.set(call.id, controller);
  queue = queue.then(() => run(call, controller));
};
