import type { Lang, WordTiming } from "../engines/types";
import type { PlayableSentence, SessionState } from "../playback/session";

export type SessionControlAction =
  "toggle" | "play" | "pause" | "next" | "previous" | "seek" | "stop";

export interface SessionEvent {
  type:
    | "session/state"
    | "session/sentence-start"
    | "session/word"
    | "session/notice"
    | "session/progress";
  state?: SessionState;
  error?: string;
  sentenceId?: string;
  sentenceIndex?: number;
  wordIndex?: number;
  message?: string;
  // Model download progress from 0 to 1 for "session/progress".
  progress?: number;
  timings?: WordTiming[];
  timingSource?: "model" | "estimated" | "aligned";
  durationMs?: number;
  rate?: number;
  // Wall-clock start (epoch ms). performance.now() differs per document.
  startedAtMs?: number;
  // Seek count for "session/sentence-start". Segments from older ones are stale.
  generation?: number;
}

export type RuntimeMessage =
  | {
      type: "session/start";
      sentences: PlayableSentence[];
      startWordIndex?: number;
      voiceId?: string;
      voiceLang?: Lang;
      voiceIds?: Partial<Record<Lang, string>>;
      speed?: number;
    }
  | {
      type: "session/control";
      action: SessionControlAction;
      wordIndex?: number;
      speed?: number;
    }
  | { type: "session/set-speed"; speed: number }
  | {
      type: "session/set-voice";
      voiceId: string;
      lang?: Lang;
      // The word the page is highlighting. The service worker only sees
      // sentences as they are buffered, which can be well ahead of playback.
      wordIndex?: number;
    }
  | { type: "voices/list" }
  | { type: "server/state" }
  | { type: "server/start" }
  | { type: "server/stop" }
  | { type: "server/models" }
  | { type: "server/model-prepare"; modelId: string }
  | { type: "server/model-remove"; modelId: string }
  | { type: "voice/audition"; voiceId: string }
  // Sent to extension pages while a voice sample downloads, prepares or plays.
  | {
      type: "voice/audition-status";
      voiceId: string;
      // Model download progress from 0 to 1. Absent once it is done.
      progress?: number;
      state?: SessionState;
    }
  | {
      type: "offscreen/session-start";
      sentences: PlayableSentence[];
      startWordIndex?: number;
      voiceId?: string;
      voiceIds?: Partial<Record<Lang, string>>;
      speed?: number;
      // Offscreen documents cannot read chrome.storage, so the service worker
      // passes the settings the engines need.
      server?: { url: string; token: string };
      diacritizeArabic?: boolean;
      kokoroGpu?: boolean;
    }
  | {
      type: "offscreen/session-control";
      action: SessionControlAction;
      wordIndex?: number;
      speed?: number;
    }
  | { type: "offscreen/session-speed"; speed: number }
  | { type: "offscreen/session-voice"; voiceId: string }
  | { type: "offscreen/session-event"; event: SessionEvent }
  | {
      type: "session/event";
      event: SessionEvent;
      // Set when broadcast to an extension page (pdf-viewer, reader) that
      // tabs.sendMessage cannot address directly.
      targetTabId?: number;
    }
  | { type: "content/read-page" }
  | { type: "content/read-selection" }
  | {
      type: "content/session-state";
      state: SessionState;
      error?: string;
      targetTabId?: number;
    }
  | { type: "popup/get-active-state" }
  | { type: "popup/read-page" }
  | { type: "popup/read-selection" }
  | { type: "popup/read-pdf" }
  | { type: "popup/read-document" }
  | { type: "content/read-document"; key: string }
  | { type: "pdf/open"; url: string }
  | { type: "reader/open"; key: string }
  | {
      type: "reader/ready";
      key: string;
      html?: string;
      text?: string;
      title?: string;
      error?: string;
    }
  | {
      type: "session/ready";
      sentenceCount: number;
      wordCount: number;
      lang: Lang;
    };

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}
