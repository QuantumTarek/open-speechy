import { FakeEngine, isTestEngineEnabled } from "../../engines/fake";
import { LanguageRouterEngine } from "../../engines/language-router";
import { ServerEngine } from "../../engines/server";
import type { TtsEngine } from "../../engines/types";
import type { SessionEvent } from "../../messaging/protocol";
import { SettingsStore } from "../../settings/store";
import { FakeAudioPlayer, WebAudioPlayer } from "../../playback/audio-player";
import { SessionQueue, type PlayableSentence } from "../../playback/session";
import {
  isRuntimeMessage,
  type RuntimeMessage,
} from "../../messaging/protocol";

let queue: SessionQueue | null = null;

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
  let engine: TtsEngine;
  if (isTestEngineEnabled()) {
    engine = new FakeEngine();
  } else {
    const settings = await new SettingsStore().load();
    const lang = message.sentences[0]?.lang ?? "en";
    const voiceIds = { ...message.voiceIds };
    if (!voiceIds[lang] && message.voiceId) voiceIds[lang] = message.voiceId;
    engine = new LanguageRouterEngine({
      voiceIds,
      server:
        settings.server.enabled && settings.server.token
          ? new ServerEngine(settings.server.url, settings.server.token)
          : undefined,
      diacritizeArabic: settings.arabic.diacritize,
      onFallback: (notice) => void emit({ type: "session/notice", message: notice }),
    });
  }
  const audio = isTestEngineEnabled()
    ? new FakeAudioPlayer()
    : new WebAudioPlayer();
  const nextQueue = new SessionQueue(engine, audio, {
    onState(state, error) {
      void emit({ type: "session/state", state, error });
    },
    onSentenceStart(event) {
      void emit({
        type: "session/sentence-start",
        ...event,
      });
    },
  });
  queue = nextQueue;
  await nextQueue.start(message.sentences as PlayableSentence[], {
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
