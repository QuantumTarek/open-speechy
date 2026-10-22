import { isRuntimeMessage, type RuntimeMessage } from "../messaging/protocol";
import { defineBackground } from "wxt/utils/define-background";

let activeTabId: number | null = null;

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
          .then(() => sendResponse({ ok: true }))
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
        void sendToOffscreen(toOffscreenMessage(value));
        if (value.type === "session/control" && value.action === "stop") {
          activeTabId = null;
          void chrome.storage.session.remove("openSpeechyActiveTab");
        }
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

      return false;
    },
  );
});

async function startSession(
  tabId: number,
  message: Extract<RuntimeMessage, { type: "session/start" }>,
): Promise<void> {
  if (activeTabId !== null && activeTabId !== tabId) {
    await sendToTab(activeTabId, {
      type: "content/session-state",
      state: "idle",
      error: "Reading moved to another tab.",
    });
    await sendToOffscreen({
      type: "offscreen/session-control",
      action: "stop",
    });
  }
  activeTabId = tabId;
  await chrome.storage.session.set({ openSpeechyActiveTab: tabId });
  await ensureOffscreen();
  await sendToOffscreen({
    type: "offscreen/session-start",
    sentences: message.sentences,
    startWordIndex: message.startWordIndex,
    voiceId: message.voiceId,
    speed: message.speed,
  });
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
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Restricted pages such as chrome:// cannot host the content script.
  }
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
  if (activeTabId !== null) {
    await sendToTab(activeTabId, {
      type: "session/event",
      event: message.event,
    });
  }
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
  await sendToTab(
    tab.id,
    message.type === "popup/read-selection"
      ? { type: "content/read-selection" }
      : { type: "content/read-page" },
  );
  sendResponse({ ok: true });
}
