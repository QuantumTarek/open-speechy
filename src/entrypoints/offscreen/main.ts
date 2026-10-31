import { FakeEngine, isTestEngineEnabled } from "../../engines/fake";
import { LanguageRouterEngine } from "../../engines/language-router";
import { ServerEngine } from "../../engines/server";
import type { TtsEngine } from "../../engines/types";
import {
  LocalEngineWorker,
  WorkerEngine,
} from "../../engines/worker-engine";
import type { SessionEvent } from "../../messaging/protocol";
import { FakeAudioPlayer, WebAudioPlayer } from "../../playback/audio-player";
import { SessionQueue, type PlayableSentence } from "../../playback/session";
import {
  isRuntimeMessage,
  type RuntimeMessage,
} from "../../messaging/protocol";

let queue: SessionQueue | null = null;
let lastProgressPercent = -1;
const localEngines = new LocalEngineWorker(
  () =>
    new Worker(
      new URL("../../engines/local-engine.worker.ts", import.meta.url),
      { type: "module", name: "open-speechy-engines" },
    ),
);

chrome.runtime.onMessage.addListener(
  (value: unknown, _sender, sendResponse) => {
    if (!isRuntimeMessage(value)) return false;

    if (value.type === "offscreen/session-start") {
      void startSession(value)
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => {
          void emit({
            type: "session/state",
            state: "error",
            error:
              error instanceof Error
                ? error.message
                : "Speech could not start.",
          });
          sendResponse({ ok: false });
        });
      return true;
    }

    if (value.type === "offscreen/session-control") {
      void handleControl(value);
      sendResponse({ ok: true });
      return false;
    }

    if (value.type === "offscreen/session-speed") {
      void queue?.setSpeed(value.speed);
      sendResponse({ ok: true });
      return false;
    }

    if (value.type === "offscreen/session-voice") {
      sendResponse({
        ok: false,
        error: "Voice switching is not available yet.",
      });
      return false;
    }

    return false;
  },
);

async function startSession(
  message: Extract<RuntimeMessage, { type: "offscreen/session-start" }>,
): Promise<void> {
  await queue?.dispose();
  lastProgressPercent = -1;
  let engine: TtsEngine;
  if (isTestEngineEnabled()) {
    engine = new FakeEngine();
  } else {
    const lang = message.sentences[0]?.lang ?? "en";
    const voiceIds = { ...message.voiceIds };
    if (!voiceIds[lang] && message.voiceId) voiceIds[lang] = message.voiceId;
    engine = new LanguageRouterEngine({
      voiceIds,
      server: message.server
        ? new ServerEngine(message.server.url, message.server.token)
        : undefined,
      createKokoro: () =>
        new WorkerEngine("kokoro", localEngines, false, message.kokoroGpu),
      createPiper: () =>
        new WorkerEngine(
          "piper",
          localEngines,
          message.diacritizeArabic ?? false,
        ),
      onFallback: (notice) => void emit({ type: "session/notice", message: notice }),
      onDownloadProgress: (fraction) => {
        const percent = Math.floor(fraction * 100);
        if (percent === lastProgressPercent) return;
        lastProgressPercent = percent;
        void emit({ type: "session/progress", progress: fraction });
      },
    });
  }
  const audio = isTestEngineEnabled()
    ? new FakeAudioPlayer()
    : new WebAudioPlayer();
  const nextQueue = new SessionQueue(engine, audio, {
    onState(state, error) {
      void emit({ type: "session/state", state, error });
    },
    onSentenceStart({ startedAtPerf, ...event }) {
      void emit({
        type: "session/sentence-start",
        ...event,
        startedAtMs: performance.timeOrigin + startedAtPerf,
      });
    },
  });
  queue = nextQueue;
  // start() reports its own failures through onState. Not awaiting it lets the
  // service worker answer the tab (voices, selection) before synthesis ends.
  void nextQueue.start(message.sentences as PlayableSentence[], {
    startWordIndex: message.startWordIndex,
    voiceId: message.voiceId,
    speed: message.speed,
  });
}

async function handleControl(
  message: Extract<RuntimeMessage, { type: "offscreen/session-control" }>,
): Promise<void> {
  if (!queue) return;
  if (message.action === "toggle") await queue.toggle();
  else if (message.action === "play") await queue.resume();
  else if (message.action === "pause") await queue.pause();
  else if (message.action === "next") await queue.next();
  else if (message.action === "previous") await queue.previous();
  else if (message.action === "seek" && message.wordIndex !== undefined) {
    await queue.seek(message.wordIndex);
  } else if (message.action === "stop") {
    await queue.stop();
  }
}

async function emit(event: SessionEvent): Promise<void> {
  const message: RuntimeMessage = {
    type: "offscreen/session-event",
    event,
  };
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // The service worker may be waking up after the offscreen page.
  }
}
