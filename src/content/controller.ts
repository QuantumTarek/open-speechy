import type { Lang, SentencePlan, VoiceInfo } from "../engines/types";
import { Highlighter } from "../highlight/highlighter";
import { highlightColors } from "../highlight/colors";
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
import { rebindSentencePieces } from "../text/rebind";
import { mountPlayer, type MountedPlayer } from "../ui/mount-player";
import { SelectionChip } from "../ui/selection-chip";
import type { PlayerBarProps } from "../ui/PlayerBar";
import { DEFAULT_SETTINGS, SettingsStore } from "../settings/store";
import type { AppSettings } from "../settings/store";

type ReadSource = "article" | "selection";

export class ContentController {
  #sentences: SentencePlan[] = [];
  #state: SessionState = "idle";
  #error: string | undefined;
  #notice: string | undefined;
  #downloadProgress: number | null = null;
  #currentWordIndex: number | null = null;
  #driftMs = 0;
  #speed = 1;
  #title = "";
  #voiceId = "kokoro:af_heart";
  #voiceIds: Record<Lang, string> = {
    en: "kokoro:af_heart",
    ar: "piper:ar_JO-kareem-medium",
  };
  #settings: AppSettings = DEFAULT_SETTINGS;
  #settingsReady: Promise<void> = Promise.resolve();
  #readRoot: Element | null = null;
  #mutationObserver: MutationObserver | null = null;
  #mutationTimer: ReturnType<typeof setTimeout> | null = null;
  #showJumpToCurrent = false;
  #voices: VoiceInfo[] = [];
  #noticeTimer: ReturnType<typeof setTimeout> | null = null;
  #highlighter: Highlighter | null = null;
  #clock: PlaybackClock | null = null;
  #player: MountedPlayer | null = null;
  #selectionChip: SelectionChip;
  #listener: (message: unknown) => void;
  #handleStorageChange = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string,
  ): void => {
    if (areaName !== "sync" || Object.keys(changes).length === 0) return;
    this.#settingsReady = new SettingsStore()
      .load()
      .then((settings) => {
        this.#settings = settings;
        this.#selectionChip.setEnabled(settings.selectionChip);
        this.#highlighter?.updateOptions(this.#highlighterOptions());
      })
      .catch(() => {});
  };

  constructor(
    private readonly document: Document,
    private readonly window: Window,
  ) {
    this.#listener = (message) => {
      if (!isRuntimeMessage(message) || "targetTabId" in message) return;
      this.handleRuntimeMessage(message);
    };
    chrome.runtime.onMessage.addListener(this.#listener);
    this.#selectionChip = new SelectionChip(
      this.document,
      this.window,
      () => void this.readSelection(),
      DEFAULT_SETTINGS.selectionChip,
    );
    this.#settingsReady = new SettingsStore()
      .load()
      .then((settings) => {
        this.#settings = settings;
        this.#selectionChip.setEnabled(settings.selectionChip);
      })
      .catch(() => {});
    chrome.storage.onChanged.addListener(this.#handleStorageChange);
    // Reloading or leaving the page ends its reading. Same-page URL changes
    // do not fire pagehide, and the service worker handles a closed tab.
    this.window.addEventListener("pagehide", () => {
      if (this.#player) void this.#send({ type: "session/control", action: "stop" });
    });

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
    await this.#settingsReady;
    const root = findArticleRoot(this.document);
    this.#readRoot = root;
    const blocks = extractTextBlocks(root, {
      readCodeBlocks: this.#settings.readCodeBlocks,
    });
    await this.#start(blocks, "article");
  }

  async readSelection(): Promise<void> {
    await this.#settingsReady;
    this.#selectionChip.hide();
    this.#readRoot = null;
    const selection = this.window.getSelection();
    const blocks = selection ? extractSelectionBlocks(selection) : [];
    await this.#start(blocks, "selection");
  }

  /**
   * Read blocks built by an extension page (pdf-viewer, reader) whose DOM
   * text is already in reading order with its own source pieces.
   */
  async readExtracted(blocks: TextBlock[], title: string): Promise<void> {
    await this.#settingsReady;
    this.#readRoot = null;
    await this.#start(blocks, "article");
    if (this.#sentences.length > 0) {
      this.#title = title;
      this.#render();
    }
  }

  /**
   * Export the open Google Doc as HTML and hand it to the Reader view.
   * The export uses the user's own session cookies; a failure (for example
   * when the owner disabled downloads) routes the user to paste-to-read.
   */
  async readDocument(key: string): Promise<void> {
    const docId = /\/document\/d\/([\w-]+)/u.exec(
      this.window.location.href,
    )?.[1];
    const fail = (error: string) =>
      chrome.runtime
        .sendMessage({ type: "reader/ready", key, error })
        .catch(() => {});
    if (!docId) {
      await fail("This page is not a Google Doc.");
      return;
    }
    try {
      const response = await this.window.fetch(
        `/document/d/${docId}/export?format=html`,
        { credentials: "include" },
      );
      if (!response.ok) {
        await fail(
          "This document could not be exported. Copy its text and paste it into the Reader view.",
        );
        return;
      }
      const html = await response.text();
      const title =
        this.document.title.replace(/\s+-\s+Google Docs\s*$/u, "") ||
        "Google Doc";
      await chrome.runtime.sendMessage({
        type: "reader/ready",
        key,
        html,
        title,
      });
    } catch {
      await fail("This document could not be exported.");
    }
  }

  dispose(): void {
    chrome.runtime.onMessage.removeListener(this.#listener);
    chrome.storage.onChanged.removeListener(this.#handleStorageChange);
    this.#selectionChip.dispose();
    this.#stopMutationObserver();
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
    this.#downloadProgress = null;
    this.#currentWordIndex = null;
    this.#showPlayer(sentences);
    if (source === "article" && this.#readRoot) {
      this.#observeRoot(this.#readRoot);
    } else {
      this.#stopMutationObserver();
    }
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
            voiceIds?: Partial<Record<Lang, string>>;
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
        this.#voiceIds = {
          ...this.#voiceIds,
          ...response.voiceIds,
        };
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
      }, {
        ...this.#highlighterOptions(),
        onJumpVisibilityChange: (visible) => {
          this.#showJumpToCurrent = visible;
          this.#render();
        },
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

  /**
   * Entry for messages the page did not receive through the constructor's
   * runtime listener — extension pages (pdf-viewer, reader) get broadcast
   * copies addressed by `targetTabId` and forward them here.
   */
  handleRuntimeMessage(message: RuntimeMessage): void {
    if (message.type === "content/read-page") {
      void this.readPage();
    } else if (message.type === "content/read-document") {
      void this.readDocument(message.key);
    } else if (message.type === "content/read-selection") {
      void this.readSelection();
    } else if (message.type === "content/session-state") {
      this.#setState(message.state, message.error);
    } else if (message.type === "session/event") {
      this.#handleSessionEvent(message.event);
    }
  }

  #highlighterOptions() {
    const colors = highlightColors(
      this.document,
      this.#readRoot,
      this.#settings.highlight,
    );
    return {
      enabled: this.#settings.highlight.enabled,
      autoScroll: this.#settings.autoScroll,
      wordColor: colors.word,
      sentenceColor: colors.sentence,
      textColor: colors.text,
    };
  }

  #observeRoot(root: Element): void {
    this.#stopMutationObserver();
    const target = root.parentElement ?? root;
    this.#mutationObserver = new MutationObserver(() => {
      if (this.#mutationTimer) clearTimeout(this.#mutationTimer);
      this.#mutationTimer = setTimeout(() => {
        this.#mutationTimer = null;
        void this.#refreshWordMap();
      }, 200);
    });
    this.#mutationObserver.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  }

  #stopMutationObserver(): void {
    this.#mutationObserver?.disconnect();
    this.#mutationObserver = null;
    if (this.#mutationTimer) clearTimeout(this.#mutationTimer);
    this.#mutationTimer = null;
  }

  #refreshWordMap(): void {
    let root = this.#readRoot;
    if (!root || this.#sentences.length === 0) return;
    if (!root.isConnected) {
      root = findArticleRoot(this.document);
      this.#readRoot = root;
      this.#observeRoot(root);
    }
    const refreshed = segmentBlocks(
      extractTextBlocks(root, {
        readCodeBlocks: this.#settings.readCodeBlocks,
      }),
      (block) => this.#languageForBlock(block),
    );
    this.#sentences = rebindSentencePieces(this.#sentences, refreshed);
    this.#highlighter?.setSentences(this.#sentences);
    this.#highlighter?.updateOptions(this.#highlighterOptions());
    if (this.#currentWordIndex !== null) {
      const sentence = this.#sentences.find((candidate) =>
        candidate.words.some((word) => word.index === this.#currentWordIndex),
      );
      this.#highlighter?.highlightWord(
        this.#currentWordIndex,
        sentence?.id,
      );
    }
  }

  #handleSessionEvent(event: SessionEvent): void {
    if (event.type === "session/notice" && event.message) {
      this.#setNotice(event.message);
      this.#render();
    } else if (event.type === "session/progress") {
      const progress = event.progress ?? 1;
      this.#downloadProgress = progress >= 1 ? null : progress;
      this.#render();
    } else if (event.type === "session/state" && event.state) {
      if (event.state === "error" || event.state === "idle") {
        this.#downloadProgress = null;
      }
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
      event.startedAtMs !== undefined
    ) {
      this.#clock?.addSegment({
        sentenceId: event.sentenceId,
        timings: event.timings,
        durationMs: event.durationMs,
        rate: event.rate,
        startedAtPerf: event.startedAtMs - performance.timeOrigin,
        generation: event.generation,
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
      this.#stopMutationObserver();
      this.#player?.unmount();
      this.#player = null;
      this.#highlighter = null;
      this.#clock = null;
      this.#sentences = [];
      this.#state = "idle";
      this.#showJumpToCurrent = false;
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
    const lang = this.#languageForWord(this.#currentWordIndex);
    const totalWords = this.#sentences.reduce(
      (total, sentence) => total + sentence.words.length,
      0,
    );
    return {
      status: this.#state,
      error: this.#error,
      notice: this.#notice,
      downloadProgress: this.#downloadProgress,
      totalWords,
      currentWordIndex: this.#currentWordIndex,
      driftMs: this.#driftMs,
      speed: this.#speed,
      title: this.#title,
      voices: this.#voices,
      voiceId: this.#voiceIds[lang] ?? this.#voiceId,
      lang,
      showJumpToCurrent: this.#showJumpToCurrent,
      onJumpToCurrent: () => this.#highlighter?.jumpToCurrent(),
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
        const voiceLang = this.#languageForWord(this.#currentWordIndex);
        this.#voiceIds = { ...this.#voiceIds, [voiceLang]: voiceId };
        this.#render();
        void this.#send({
          type: "session/set-voice",
          voiceId,
          lang: voiceLang,
          wordIndex: this.#currentWordIndex ?? undefined,
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
