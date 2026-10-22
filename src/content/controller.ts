import type { Lang, SentencePlan, VoiceInfo } from "../engines/types";
import { Highlighter } from "../highlight/highlighter";
import {
  isRuntimeMessage,
  type RuntimeMessage,
  type SessionEvent,
} from "../messaging/protocol";
import { PlaybackClock } from "../playback/clock";
import type { PlayableSentence, SessionState } from "../playback/session";
import {
  extractSelectionBlocks,
  extractTextBlocks,
  findArticleRoot,
  type TextBlock,
} from "../text/extract";
import { detectLanguage } from "../text/lang";
import { segmentBlocks } from "../text/segment";
import { mountPlayer, type MountedPlayer } from "../ui/mount-player";
import type { PlayerBarProps } from "../ui/PlayerBar";

type ReadSource = "article" | "selection";

export class ContentController {
  #sentences: SentencePlan[] = [];
  #state: SessionState = "idle";
  #error: string | undefined;
  #notice: string | undefined;
  #currentWordIndex: number | null = null;
  #driftMs = 0;
  #speed = 1;
  #title = "";
  #voiceId = "kokoro:af_heart";
  #voices: VoiceInfo[] = [];
  #noticeTimer: ReturnType<typeof setTimeout> | null = null;
  #highlighter: Highlighter | null = null;
  #clock: PlaybackClock | null = null;
  #player: MountedPlayer | null = null;
  #listener: (message: unknown) => void;

  constructor(
    private readonly document: Document,
    private readonly window: Window,
  ) {
    this.#listener = (message) => {
      if (!isRuntimeMessage(message)) return;
      this.#handleRuntimeMessage(message);
    };
    chrome.runtime.onMessage.addListener(this.#listener);

    if (
      typeof __OPEN_SPEECHY_FAKE_ENGINE__ !== "undefined" &&
      __OPEN_SPEECHY_FAKE_ENGINE__
    ) {
      this.window.__OPEN_SPEECHY_TEST__ = true;
      this.window.__OPEN_SPEECHY_TEST_HOOK__ = {
        startRead: () => this.readPage(),
      };
      this.document.addEventListener(
        "open-speechy-test-start",
        () => void this.readPage(),
        { once: true },
      );
    }
  }

  async readPage(): Promise<void> {
    const root = findArticleRoot(this.document);
    const blocks = extractTextBlocks(root);
    await this.#start(blocks, "article");
  }

  async readSelection(): Promise<void> {
    const selection = this.window.getSelection();
    const blocks = selection ? extractSelectionBlocks(selection) : [];
    await this.#start(blocks, "selection");
  }

  dispose(): void {
    chrome.runtime.onMessage.removeListener(this.#listener);
    this.#clock?.stop();
    this.#highlighter?.dispose();
    this.#player?.unmount();
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
  }

  async #start(blocks: TextBlock[], source: ReadSource): Promise<void> {
    const sentences = segmentBlocks(blocks, (block) =>
      this.#languageForBlock(block),
    );
    if (sentences.length === 0) {
      this.#error =
        source === "selection"
          ? "Select some readable text first."
          : "No readable article text was found.";
      this.#state = "error";
      this.#showPlayer([]);
      this.#render();
      return;
    }

    this.#sentences = sentences;
    this.#title =
      source === "selection"
        ? "Selected text"
        : this.document.title || "Current article";
    this.#state = "loading";
    this.#error = undefined;
    this.#setNotice(undefined);
    this.#currentWordIndex = null;
    this.#showPlayer(sentences);
    this.#highlighter?.setSentences(sentences);
    this.#highlighter?.setClickable(true);
    this.#render();

    const message: RuntimeMessage = {
      type: "session/start",
      sentences: sentences.map(toPlayableSentence),
      speed: this.#speed,
    };
    try {
      const response = (await chrome.runtime.sendMessage(message)) as
        | {
            ok?: boolean;
            error?: string;
            voiceId?: string;
            voices?: VoiceInfo[];
            warning?: string;
          }
        | undefined;
      if (response?.ok === false) {
        this.#setState(
          "error",
          response.error ?? "Could not start the reader.",
        );
      } else if (response) {
        this.#voiceId = response.voiceId ?? this.#voiceId;
        this.#voices = response.voices ?? this.#voices;
        if (response.warning) this.#setNotice(response.warning);
        this.#render();
      }
    } catch (error) {
      this.#setState(
        "error",
        error instanceof Error ? error.message : "Could not start the reader.",
      );
    }
  }

  #showPlayer(sentences: SentencePlan[]): void {
    if (!this.#highlighter) {
      this.#highlighter = new Highlighter(this.document, (wordIndex) => {
        void this.#send({ type: "session/control", action: "seek", wordIndex });
      });
    }
    this.#clock?.stop();
    this.#clock = new PlaybackClock(this.#highlighter, (tick) => {
      this.#currentWordIndex = tick.wordIndex;
      this.#driftMs = tick.driftMs;
      this.#render();
    });
    this.#highlighter.setSentences(sentences);
    this.#player ??= mountPlayer(this.document, this.#playerProps());
    this.#render();
  }

  #handleRuntimeMessage(message: RuntimeMessage): void {
    if (message.type === "content/read-page") {
      void this.readPage();
    } else if (message.type === "content/read-selection") {
      void this.readSelection();
    } else if (message.type === "content/session-state") {
      this.#setState(message.state, message.error);
    } else if (message.type === "session/event") {
      this.#handleSessionEvent(message.event);
    }
  }

  #handleSessionEvent(event: SessionEvent): void {
    if (event.type === "session/notice" && event.message) {
      this.#setNotice(event.message);
      this.#render();
    } else if (event.type === "session/state" && event.state) {
      this.#setState(event.state, event.error);
      this.#clock?.setPaused(event.state === "paused");
      if (event.state === "idle" || event.state === "ended") {
        this.#clock?.setPaused(false);
      }
    } else if (
      event.type === "session/word" &&
      event.sentenceId &&
      event.wordIndex !== undefined
    ) {
      this.#currentWordIndex = event.wordIndex;
      this.#highlighter?.highlightWord(event.wordIndex, event.sentenceId);
      this.#render();
    } else if (
      event.type === "session/sentence-start" &&
      event.sentenceId &&
      event.timings &&
      event.durationMs !== undefined &&
      event.rate !== undefined &&
      event.startedAtPerf !== undefined
    ) {
      this.#clock?.addSegment({
        sentenceId: event.sentenceId,
        timings: event.timings,
        durationMs: event.durationMs,
        rate: event.rate,
        startedAtPerf: event.startedAtPerf,
      });
    }
  }

  #languageForBlock(block: TextBlock): Lang {
    const element = block.element;
    const declared =
      element?.closest("[lang]")?.getAttribute("lang") ??
      this.document.documentElement.lang;
    return detectLanguage(block.text, declared);
  }

  #setState(state: SessionState, error?: string): void {
    this.#state = state;
    this.#error = error;
    this.#render();
  }

  #setNotice(message: string | undefined): void {
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#notice = message;
    this.#noticeTimer = message
      ? setTimeout(() => {
          this.#notice = undefined;
          this.#noticeTimer = null;
          this.#render();
        }, 5_000)
      : null;
  }

  async #control(
    action: "toggle" | "previous" | "next" | "stop",
  ): Promise<void> {
    if (action === "stop") {
      await this.#send({ type: "session/control", action });
      this.#clock?.stop();
      this.#highlighter?.dispose();
      this.#player?.unmount();
      this.#player = null;
      this.#highlighter = null;
      this.#clock = null;
      this.#sentences = [];
      this.#state = "idle";
      return;
    }
    await this.#send({ type: "session/control", action });
  }

  async #send(message: RuntimeMessage): Promise<void> {
    try {
      await chrome.runtime.sendMessage(message);
    } catch (error) {
      this.#setState(
        "error",
        error instanceof Error
          ? error.message
          : "The reader could not reach the extension.",
      );
    }
  }

  #render(): void {
    this.#player?.update(this.#playerProps());
  }

  #playerProps(): PlayerBarProps {
    const totalWords = this.#sentences.reduce(
      (total, sentence) => total + sentence.words.length,
      0,
    );
    return {
      status: this.#state,
      error: this.#error,
      notice: this.#notice,
      totalWords,
      currentWordIndex: this.#currentWordIndex,
      driftMs: this.#driftMs,
      speed: this.#speed,
      title: this.#title,
      voices: this.#voices,
      voiceId: this.#voiceId,
      lang: this.#languageForWord(this.#currentWordIndex),
      onControl: (action) => {
        if (action === "play" || action === "pause") {
          void this.#send({ type: "session/control", action });
        } else if (action !== "seek") {
          void this.#control(action);
        }
      },
      onSpeed: (speed) => {
        this.#speed = speed;
        this.#render();
        void this.#send({ type: "session/set-speed", speed });
      },
      onVoice: (voiceId) => {
        this.#voiceId = voiceId;
        this.#render();
        void this.#send({
          type: "session/set-voice",
          voiceId,
          lang: this.#languageForWord(this.#currentWordIndex),
        });
      },
      onClose: () => {
        void this.#control("stop");
      },
    };
  }

  #languageForWord(wordIndex: number | null): Lang {
    if (wordIndex !== null) {
      const current = this.#sentences.find((sentence) =>
        sentence.words.some((word) => word.index === wordIndex),
      );
      if (current) return current.lang;
    }
    return this.#sentences[0]?.lang ?? "en";
  }
}

function toPlayableSentence(sentence: SentencePlan): PlayableSentence {
  return {
    id: sentence.id,
    index: sentence.index,
    paragraphIndex: sentence.paragraphIndex,
    lang: sentence.lang,
    text: sentence.text,
    words: sentence.words.map(({ index, display, spoken }) => ({
      index,
      display,
      spoken,
    })),
  };
}
