import type { Lang, WordTiming } from "../engines/types";
import type { PlayableSentence, SessionState } from "../playback/session";

export type SessionControlAction =
  "toggle" | "play" | "pause" | "next" | "previous" | "seek" | "stop";

export interface SessionEvent {
  type:
    | "session/state"
    | "session/sentence-start"
    | "session/word"
    | "session/notice";
  state?: SessionState;
  error?: string;
  sentenceId?: string;
  sentenceIndex?: number;
  wordIndex?: number;
  message?: string;
  timings?: WordTiming[];
  timingSource?: "model" | "estimated" | "aligned";
  durationMs?: number;
  rate?: number;
  startedAtPerf?: number;
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
  | { type: "session/set-voice"; voiceId: string; lang?: Lang }
  | { type: "voices/list" }
  | { type: "voice/audition"; voiceId: string }
  | {
      type: "offscreen/session-start";
      sentences: PlayableSentence[];
      startWordIndex?: number;
      voiceId?: string;
      voiceIds?: Partial<Record<Lang, string>>;
      speed?: number;
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
