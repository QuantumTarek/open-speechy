import { mapSystemVoice, SystemTtsEngine } from "../engines/system";
import { selectVoice } from "../engines/router";
import { ServerEngine } from "../engines/server";
import type { Lang, VoiceInfo } from "../engines/types";
import { browserVoiceCatalog } from "../engines/voice-catalog";
import { SettingsStore } from "../settings/store";
import { SystemSpeechSession } from "../playback/system-session";
import type { PlayableSentence, SessionState } from "../playback/session";
import { isRuntimeMessage, type RuntimeMessage } from "../messaging/protocol";
import { defineBackground } from "wxt/utils/define-background";

let activeTabId: number | null = null;
let activeSystemSession: SystemSpeechSession | null = null;
let idleUnloadTimer: ReturnType<typeof setTimeout> | null = null;
let cachedServerEngine:
  | { url: string; token: string; engine: ServerEngine }
  | null = null;
let activeSession:
  | {
      tabId: number;
      sentences: PlayableSentence[];
      voiceId: string;
      voiceIds: Record<Lang, string>;
      lang: Lang;
      speed: number;
      currentWordIndex: number | null;
    }
  | null = null;

const PDF_RULE_ID = 4100;

function pdfViewerUrl(fileUrl: string): string {
  return `${chrome.runtime.getURL("pdf-viewer.html")}?file=${encodeURIComponent(fileUrl)}`;
}

async function updatePdfInterceptRule(): Promise<void> {
  const settings = await new SettingsStore().load();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [PDF_RULE_ID],
    addRules: settings.pdf.intercept
      ? [
          {
            id: PDF_RULE_ID,
            priority: 1,
            action: {
              type: "redirect",
              redirect: {
                regexSubstitution: `${chrome.runtime.getURL("pdf-viewer.html")}?file=\\0`,
              },
            },
            condition: {
              regexFilter: "^[^?#]+\\.pdf([?#].*)?$",
              resourceTypes: ["main_frame"],
            },
          },
        ]
      : [],
  });
}

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "open-speechy-read-page",
        title: "Read this page",
        contexts: ["page"],
      });
      chrome.contextMenus.create({
        id: "open-speechy-read-selection",
        title: "Read selection",
        contexts: ["selection"],
      });
    });
    void updatePdfInterceptRule();
  });

  chrome.runtime.onStartup.addListener(() => {
    void updatePdfInterceptRule();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync" && changes.pdf) void updatePdfInterceptRule();
  });

  chrome.action.onClicked.addListener((tab) => {
    if (tab?.id !== undefined)
      void sendToTab(tab.id, { type: "content/read-page" });
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (tab?.id === undefined) return;
    const message =
      info.menuItemId === "open-speechy-read-selection"
        ? { type: "content/read-selection" as const }
        : { type: "content/read-page" as const };
    void sendToTab(tab.id, message);
  });

  chrome.commands.onCommand.addListener((command) => {
    void (async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (tab?.id === undefined) return;

      if (command === "read-selection") {
        await sendToTab(tab.id, { type: "content/read-selection" });
      } else if (command === "toggle-read" && activeTabId === tab.id) {
        await sendToTab(tab.id, {
          type: "session/control",
          action: "toggle",
        });
      } else if (command === "toggle-read") {
        await sendToTab(tab.id, { type: "content/read-page" });
      }
    })();
  });

  chrome.runtime.onMessage.addListener(
    (value: unknown, sender, sendResponse) => {
      if (!isRuntimeMessage(value)) return false;

      if (value.type === "session/start") {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
          sendResponse({ ok: false, error: "Start reading from a web page." });
          return false;
        }
        void startSession(tabId, value)
          .then((result) => sendResponse({ ok: true, ...result }))
          .catch((error: unknown) =>
            sendResponse({
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Could not start playback.",
            }),
          );
        return true;
      }

      if (value.type === "voices/list") {
        void listAvailableVoices()
          .then((voices) => sendResponse({ ok: true, voices }))
          .catch((error: unknown) =>
            sendResponse({
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Could not list available voices.",
            }),
          );
        return true;
      }

      if (value.type === "voice/audition") {
        void auditionVoice(value.voiceId)
          .then(() => sendResponse({ ok: true }))
          .catch((error: unknown) =>
            sendResponse({
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Could not audition this voice.",
            }),
          );
        return true;
      }

      if (
        value.type === "session/control" ||
        value.type === "session/set-speed" ||
        value.type === "session/set-voice"
      ) {
        const tabId = sender.tab?.id;
        if (
          tabId !== undefined &&
          activeTabId !== null &&
          tabId !== activeTabId
        ) {
          return false;
        }
        void handleSessionCommand(tabId, value);
        sendResponse({ ok: true });
        return false;
      }

      if (value.type === "offscreen/session-event") {
        void forwardSessionEvent(value);
        return false;
      }

      if (value.type === "reader/ready") {
        void chrome.storage.session.set({
          [`openSpeechyReader:${value.key}`]: {
            html: value.html,
            text: value.text ?? "",
          },
        });
        sendResponse({ ok: true });
        return false;
      }

      if (
        value.type === "popup/read-page" ||
        value.type === "popup/read-selection"
      ) {
        void openPopupAction(value, sendResponse);
        return true;
      }

      if (value.type === "popup/read-pdf") {
        void openPdfForActiveTab()
          .then((result) => sendResponse(result))
          .catch((error: unknown) =>
            sendResponse({
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Could not open the PDF viewer.",
            }),
          );
        return true;
      }

      if (value.type === "pdf/open") {
        void chrome.tabs.create({ url: pdfViewerUrl(value.url) });
        sendResponse({ ok: true });
        return false;
      }

      return false;
    },
  );
});

async function startSession(
  tabId: number,
  message: Extract<RuntimeMessage, { type: "session/start" }>,
): Promise<{
  voices: VoiceInfo[];
  voiceId: string;
  voiceIds: Record<Lang, string>;
  warning?: string;
}> {
  if (activeTabId !== null && activeTabId !== tabId) {
    await sendToTab(activeTabId, {
      type: "content/session-state",
      state: "idle",
      error: "Reading moved to another tab.",
    });
    await stopActiveOutput();
  }
  activeTabId = tabId;
  await chrome.storage.session.set({ openSpeechyActiveTab: tabId });
  clearIdleUnloadTimer();
  await stopActiveOutput();

  const lang = message.sentences[0]?.lang ?? "en";
  const store = new SettingsStore();
  const settings = await store.load();
  const discovered = await discoverVoices(true);
  const langs = [...new Set(message.sentences.map((sentence) => sentence.lang))];
  const selectedVoices = new Map<Lang, VoiceInfo>();
  const voiceIds: Record<Lang, string> = {
    en: "kokoro:af_heart",
    ar: "piper:ar_JO-kareem-medium",
  };
  let overrideUnavailable = false;
  let systemVoiceSkippedForMixed = false;
  for (const targetLang of langs) {
    const override =
      message.voiceIds?.[targetLang] ??
      (message.voiceLang === targetLang ||
      (message.voiceLang === undefined && langs.length === 1)
        ? message.voiceId ?? settings.voice[targetLang]
        : settings.voice[targetLang]);
    const selection = selectVoice(targetLang, {
      override,
      systemVoices: discovered.system,
      serverVoices: discovered.serverVoices,
      serverPaired: discovered.serverPaired,
      serverHealthy: discovered.serverHealthy,
      localVoices: discovered.local,
    });
    overrideUnavailable ||= selection.overrideUnavailable;
    let voice = selection.voice;
    if (langs.length > 1 && voice.engineId === "system") {
      voice = selectVoice(targetLang, {
        override: "auto",
        systemVoices: [],
        serverVoices: discovered.serverVoices,
        serverPaired: discovered.serverPaired,
        serverHealthy: discovered.serverHealthy,
        localVoices: discovered.local,
      }).voice;
      systemVoiceSkippedForMixed = true;
    }
    selectedVoices.set(targetLang, voice);
    voiceIds[targetLang] = voice.id;
  }
  const selection = selectedVoices.get(lang);
  if (!selection) throw new Error("No voice was selected for this session.");
  const speed = clampSpeed(message.speed ?? settings.speed);
  const useSystemVoice =
    langs.length === 1 && selection.engineId === "system";

  activeSession = {
    tabId,
    sentences: message.sentences,
    voiceId: selection.id,
    voiceIds,
    lang,
    speed,
    currentWordIndex:
      message.startWordIndex ??
      message.sentences[0]?.words[0]?.index ??
      null,
  };

  const overrideLang = message.voiceLang ?? lang;
  if (message.voiceId && message.voiceId !== "auto") {
    await store.update({ voice: { [overrideLang]: message.voiceId } });
  }

  if (
    Object.values(voiceIds).some((voiceId) => voiceId.startsWith("server:")) &&
    cachedServerEngine?.engine.isReady()
  ) {
    const engineIds = [
      ...new Set(
        Object.values(voiceIds)
          .filter((voiceId) => voiceId.startsWith("server:"))
          .map((voiceId) => voiceId.split(":")[1])
          .filter((engineId): engineId is string => Boolean(engineId)),
      ),
    ];
    await cachedServerEngine.engine.warmup(engineIds).catch(() => {});
  }

  if (useSystemVoice) {
    const session = new SystemSpeechSession(
      new SystemTtsEngine(selection),
      {
        onState(state, error) {
          void sendSessionEvent(tabId, { type: "session/state", state, error });
        },
        onWord(sentenceId, wordIndex) {
          if (activeSession?.tabId === tabId) {
            activeSession.currentWordIndex = wordIndex;
          }
          void sendSessionEvent(tabId, {
            type: "session/word",
            sentenceId,
            wordIndex,
          });
        },
      },
    );
    activeSystemSession = session;
    session.start(message.sentences, {
      startWordIndex: message.startWordIndex,
      speed,
    });
  } else {
    activeSystemSession = null;
    await ensureOffscreen();
    await sendToOffscreen({
      type: "offscreen/session-start",
      sentences: message.sentences,
      startWordIndex: message.startWordIndex,
      voiceId: selection.id,
      voiceIds,
      speed,
    });
  }

  return {
    voices: discovered.list,
    voiceId: selection.id,
    voiceIds,
    warning: systemVoiceSkippedForMixed
      ? "Mixed-language reading uses local or server voices to switch languages smoothly."
      : overrideUnavailable
        ? "The saved voice is unavailable. Using the best available voice."
        : undefined,
  };
}

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK", "WORKERS"],
    justification:
      "Keep local speech synthesis and audio playback outside the page.",
  });
}

async function sendToOffscreen(message: RuntimeMessage): Promise<void> {
  if (!(await chrome.offscreen.hasDocument())) await ensureOffscreen();
  await chrome.runtime.sendMessage(message);
}

async function sendToTab(
  tabId: number,
  message: RuntimeMessage,
): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    // Restricted pages such as chrome:// cannot host the content script.
    // Extension pages (pdf-viewer, reader) may also be unreachable through
    // tabs.sendMessage on some Chrome versions; broadcast a copy they can
    // pick up by tab id.
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url?.startsWith(chrome.runtime.getURL(""))) {
        await chrome.runtime.sendMessage({ ...message, targetTabId: tabId });
        return true;
      }
    } catch {
      // Fall through to undelivered.
    }
    return false;
  }
}

const PDF_URL = /^(?:https?|file|ftp):[^?#]*\.pdf(?:[?#]|$)/iu;

function pdfUrlForTab(tab: chrome.tabs.Tab | undefined): string | null {
  if (!tab?.url || tab.url.startsWith(chrome.runtime.getURL(""))) return null;
  if (PDF_URL.test(tab.url)) return tab.url;
  if (tab.url.startsWith("chrome-extension://")) {
    // Chrome's built-in PDF viewer keeps the source URL in ?src=
    try {
      const source = new URL(tab.url).searchParams.get("src");
      if (source && PDF_URL.test(source)) return source;
    } catch {
      // Not a parseable viewer URL.
    }
  }
  return null;
}

async function openPdfForActiveTab(): Promise<{ ok: boolean; error?: string }> {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const url = pdfUrlForTab(tab);
  if (!url) {
    return { ok: false, error: "The active tab is not a PDF." };
  }
  await chrome.tabs.create({ url: pdfViewerUrl(url) });
  return { ok: true };
}

async function forwardSessionEvent(
  message: Extract<RuntimeMessage, { type: "offscreen/session-event" }>,
): Promise<void> {
  if (activeTabId === null) {
    const stored = await chrome.storage.session.get("openSpeechyActiveTab");
    activeTabId =
      typeof stored.openSpeechyActiveTab === "number"
        ? stored.openSpeechyActiveTab
        : null;
  }
  if (
    message.event.type === "session/sentence-start" &&
    activeSession &&
    message.event.timings?.length
  ) {
    activeSession.currentWordIndex = message.event.timings[0].wordIndex;
  }
  if (
    message.event.type === "session/state" &&
    (message.event.state === "ended" ||
      message.event.state === "idle" ||
      message.event.state === "error")
  ) {
    void scheduleOffscreenUnload();
  }
  if (activeTabId !== null) {
    await sendToTab(activeTabId, {
      type: "session/event",
      event: message.event,
    });
  }
}

async function handleSessionCommand(
  tabId: number | undefined,
  message: Extract<
    RuntimeMessage,
    { type: "session/control" | "session/set-speed" | "session/set-voice" }
  >,
): Promise<void> {
  if (message.type === "session/set-voice") {
    if (!activeSession || tabId === undefined || activeSession.tabId !== tabId) {
      return;
    }
    const lang = message.lang ?? activeSession.lang;
    const startWordIndex = activeSession.currentWordIndex ?? undefined;
    await startSession(tabId, {
      type: "session/start",
      sentences: activeSession.sentences,
      startWordIndex,
      voiceId: message.voiceId,
      voiceLang: lang,
      speed: activeSession.speed,
    });
    await new SettingsStore().update({
      voice: { [lang]: message.voiceId },
    });
    return;
  }

  if (message.type === "session/set-speed") {
    if (activeSession) activeSession.speed = clampSpeed(message.speed);
    if (activeSystemSession) activeSystemSession.setSpeed(message.speed);
    else await sendToOffscreen(toOffscreenMessage(message));
    return;
  }

  if (
    !activeSystemSession &&
    activeSession &&
    !(await chrome.offscreen.hasDocument()) &&
    (message.action === "play" || message.action === "toggle")
  ) {
    const previous = activeSession;
    await startSession(previous.tabId, {
      type: "session/start",
      sentences: previous.sentences,
      startWordIndex: previous.sentences[0]?.words[0]?.index,
      voiceIds: previous.voiceIds,
      speed: previous.speed,
    });
    return;
  }

  if (activeSystemSession) {
    if (message.action === "toggle") activeSystemSession.toggle();
    else if (message.action === "play") activeSystemSession.resume();
    else if (message.action === "pause") activeSystemSession.pause();
    else if (message.action === "next") activeSystemSession.next();
    else if (message.action === "previous") activeSystemSession.previous();
    else if (
      message.action === "seek" &&
      message.wordIndex !== undefined
    ) {
      activeSystemSession.seek(message.wordIndex);
    } else if (message.action === "stop") {
      activeSystemSession.stop();
      activeSystemSession = null;
      activeSession = null;
    }
  } else {
    await sendToOffscreen(toOffscreenMessage(message));
    if (message.action === "stop") activeSession = null;
  }

  if (message.action === "stop") {
    activeTabId = null;
    await chrome.storage.session.remove("openSpeechyActiveTab");
  }
}

async function stopActiveOutput(): Promise<void> {
  clearIdleUnloadTimer();
  activeSystemSession?.stop();
  activeSystemSession = null;
  if (await chrome.offscreen.hasDocument()) {
    await sendToOffscreen({
      type: "offscreen/session-control",
      action: "stop",
    });
  }
  activeSession = null;
}

function clearIdleUnloadTimer(): void {
  if (idleUnloadTimer) clearTimeout(idleUnloadTimer);
  idleUnloadTimer = null;
}

async function scheduleOffscreenUnload(): Promise<void> {
  if (activeSystemSession || !(await chrome.offscreen.hasDocument())) return;
  clearIdleUnloadTimer();
  const settings = await new SettingsStore().load();
  idleUnloadTimer = setTimeout(() => {
    idleUnloadTimer = null;
    void chrome.offscreen
      .hasDocument()
      .then((exists) => (exists ? chrome.offscreen.closeDocument() : undefined))
      .catch(() => {});
  }, settings.idleUnloadMinutes * 60_000);
}

async function sendSessionEvent(
  tabId: number,
  event: {
    type: "session/state" | "session/word";
    state?: SessionState;
    error?: string;
    sentenceId?: string;
    wordIndex?: number;
  },
): Promise<void> {
  await sendToTab(tabId, { type: "session/event", event });
}

async function discoverVoices(
  refreshServer = false,
): Promise<{
  system: Array<{ voice: VoiceInfo; eventTypes: string[] }>;
  local: VoiceInfo[];
  list: VoiceInfo[];
  serverVoices: VoiceInfo[];
  serverPaired: boolean;
  serverHealthy: boolean;
}> {
  let chromeVoices: chrome.tts.TtsVoice[] = [];
  try {
    chromeVoices = await chrome.tts.getVoices();
  } catch {
    chromeVoices = [];
  }
  const system = chromeVoices.flatMap((raw) => {
    const voice = mapSystemVoice(raw);
    return voice ? [{ voice, eventTypes: raw.eventTypes ?? [] }] : [];
  });
  const local = browserVoiceCatalog();
  const settings = await new SettingsStore().load();
  let serverVoices: VoiceInfo[] = [];
  let serverHealthy = false;
  if (settings.server.enabled && settings.server.token) {
    try {
      if (
        !cachedServerEngine ||
        cachedServerEngine.url !== settings.server.url ||
        cachedServerEngine.token !== settings.server.token
      ) {
        cachedServerEngine = {
          url: settings.server.url,
          token: settings.server.token,
          engine: new ServerEngine(settings.server.url, settings.server.token),
        };
      }
      serverHealthy = Boolean(
        await cachedServerEngine.engine.health(refreshServer),
      );
      if (serverHealthy) {
        serverVoices = await cachedServerEngine.engine.listVoices();
      }
    } catch {
      serverVoices = [];
      serverHealthy = false;
    }
  }
  return {
    system,
    local,
    serverVoices,
    serverPaired: Boolean(settings.server.token),
    serverHealthy,
    list: [...system.map(({ voice }) => voice), ...serverVoices, ...local],
  };
}

async function listAvailableVoices(): Promise<VoiceInfo[]> {
  return (await discoverVoices()).list;
}

async function auditionVoice(voiceId: string): Promise<void> {
  const voice = (await listAvailableVoices()).find(
    (candidate) => candidate.id === voiceId,
  );
  if (!voice) throw new Error("That voice is no longer available.");
  if (voice.engineId !== "system") {
    throw new Error(
      "On-device model audition is unavailable until its verified model files are installed.",
    );
  }
  const sentence = voice.lang === "ar" ? "مرحبًا، هذا صوت محلي." : "This is a local voice sample.";
  const words = sentence.split(/\s+/u);
  const engine = new SystemTtsEngine(voice);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Voice audition timed out.")),
      30_000,
    );
    engine.speak(
      {
        sentenceId: "voice-audition",
        lang: voice.lang,
        voiceId: voice.id,
        wordIndices: words.map((_, index) => index),
        words,
        text: sentence,
        speed: 1,
      },
      {
        onStart: () => {},
        onWord: () => {},
        onEnd: () => {
          clearTimeout(timeout);
          resolve();
        },
        onError: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      },
    );
  });
}

function clampSpeed(speed: number): number {
  return Math.min(3, Math.max(0.5, speed));
}

function toOffscreenMessage(
  message: Extract<
    RuntimeMessage,
    { type: "session/control" | "session/set-speed" | "session/set-voice" }
  >,
): RuntimeMessage {
  if (message.type === "session/set-speed") {
    return { type: "offscreen/session-speed", speed: message.speed };
  }
  if (message.type === "session/set-voice") {
    return { type: "offscreen/session-voice", voiceId: message.voiceId };
  }
  return {
    type: "offscreen/session-control",
    action: message.action,
    wordIndex: message.wordIndex,
    speed: message.speed,
  };
}

async function openPopupAction(
  message: Extract<
    RuntimeMessage,
    { type: "popup/read-page" | "popup/read-selection" }
  >,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (tab.id === undefined) {
    sendResponse({ ok: false, error: "No active tab." });
    return;
  }
  const delivered = await sendToTab(
    tab.id,
    message.type === "popup/read-selection"
      ? { type: "content/read-selection" }
      : { type: "content/read-page" },
  );
  sendResponse(
    delivered
      ? { ok: true }
      : {
          ok: false,
          error: "This page does not allow Open Speechy to read its content.",
        },
  );
}
