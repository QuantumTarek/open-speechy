import type { SentencePlan, TextPiece } from "../engines/types";

interface WordRange {
  wordIndex: number;
  sentenceId: string;
  pieces: TextPiece[];
}

interface NodeWordRange {
  start: number;
  end: number;
  wordIndex: number;
}

export interface HighlighterOptions {
  enabled?: boolean;
  autoScroll?: boolean;
  reducedMotion?: boolean;
  wordColor?: string;
  sentenceColor?: string;
  textColor?: string;
  onJumpVisibilityChange?: (visible: boolean) => void;
}

const DEFAULT_WORD_COLOR = "#abb3fe";
const DEFAULT_SENTENCE_COLOR = "#e0e3ff";

function styleText(
  wordColor: string,
  sentenceColor: string,
  textColor: string,
): string {
  return `
  ::highlight(os-sentence) {
    background-color: ${sentenceColor};
    color: ${textColor};
  }
  ::highlight(os-word) {
    background-color: ${wordColor};
    color: ${textColor};
  }
`;
}

function isReducedMotion(document: Document): boolean {
  return Boolean(
    document.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
}

export class Highlighter {
  readonly #document: Document;
  readonly #words = new Map<number, WordRange>();
  readonly #sentences = new Map<string, number[]>();
  #nodeWordRanges = new WeakMap<Text, NodeWordRange[]>();
  readonly #onSeek: (wordIndex: number) => void;
  readonly #onJumpVisibilityChange: (visible: boolean) => void;
  #styleSheet: CSSStyleSheet | null = null;
  #styleElement: HTMLStyleElement | null = null;
  #clickable = false;
  #currentWord: number | null = null;
  #currentSentence: string | null = null;
  #enabled: boolean;
  #autoScroll: boolean;
  #reducedMotion: boolean;
  #wordColor: string;
  #sentenceColor: string;
  #textColor: string;
  #manualScrollUntil = 0;
  #programmaticScrollUntil = 0;
  #manualScrollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    document: Document,
    onSeek: (wordIndex: number) => void,
    options: HighlighterOptions = {},
  ) {
    this.#document = document;
    this.#onSeek = onSeek;
    this.#enabled = options.enabled ?? true;
    this.#autoScroll = options.autoScroll ?? true;
    this.#reducedMotion = options.reducedMotion ?? isReducedMotion(document);
    this.#wordColor = options.wordColor ?? DEFAULT_WORD_COLOR;
    this.#sentenceColor = options.sentenceColor ?? DEFAULT_SENTENCE_COLOR;
    this.#textColor = options.textColor ?? "inherit";
    this.#onJumpVisibilityChange = options.onJumpVisibilityChange ?? (() => {});
    this.#installStyle();
    this.#document.addEventListener("pointerup", this.#handlePointerUp, true);
    const view = this.#document.defaultView;
    view?.addEventListener("scroll", this.#handleScroll, { passive: true });
    view?.addEventListener("wheel", this.#handleManualScroll, {
      passive: true,
    });
    view?.addEventListener("touchstart", this.#handleManualScroll, {
      passive: true,
    });
    view?.addEventListener("keydown", this.#handleKeyboardScroll, true);
  }

  setSentences(sentences: SentencePlan[]): void {
    this.#words.clear();
    this.#sentences.clear();
    this.#nodeWordRanges = new WeakMap();
    this.#currentWord = null;
    this.#currentSentence = null;
    for (const sentence of sentences) {
      const indices: number[] = [];
      for (const word of sentence.words) {
        indices.push(word.index);
        this.#words.set(word.index, {
          wordIndex: word.index,
          sentenceId: sentence.id,
          pieces: word.pieces,
        });
        for (const piece of word.pieces) {
          const ranges = this.#nodeWordRanges.get(piece.node) ?? [];
          ranges.push({
            start: piece.start,
            end: piece.end,
            wordIndex: word.index,
          });
          ranges.sort((left, right) => left.start - right.start);
          this.#nodeWordRanges.set(piece.node, ranges);
        }
      }
      this.#sentences.set(sentence.id, indices);
    }
  }

  setClickable(enabled: boolean): void {
    this.#clickable = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.updateOptions({ enabled });
  }

  updateOptions(options: Partial<HighlighterOptions>): void {
    const currentWord = this.#currentWord;
    const currentSentence = this.#currentSentence;
    if (options.enabled !== undefined) this.#enabled = options.enabled;
    if (options.autoScroll !== undefined) {
      this.#autoScroll = options.autoScroll;
      if (!options.autoScroll) {
        this.#manualScrollUntil = 0;
        if (this.#manualScrollTimer) clearTimeout(this.#manualScrollTimer);
        this.#manualScrollTimer = null;
        this.#onJumpVisibilityChange(false);
      }
    }
    if (options.reducedMotion !== undefined) {
      this.#reducedMotion = options.reducedMotion;
    }
    if (options.wordColor) this.#wordColor = options.wordColor;
    if (options.sentenceColor) this.#sentenceColor = options.sentenceColor;
    if (options.textColor) this.#textColor = options.textColor;
    this.#replaceStyle();
    this.#currentWord = null;
    this.#currentSentence = null;
    if (currentWord !== null) {
      this.highlightWord(currentWord, currentSentence ?? undefined);
    }
  }

  jumpToCurrent(): void {
    if (this.#currentWord === null) return;
    this.#manualScrollUntil = 0;
    this.#onJumpVisibilityChange(false);
    this.#scrollToWord(this.#currentWord, true);
  }

  highlightWord(wordIndex: number | null, sentenceId?: string): void {
    if (
      this.#currentWord === wordIndex &&
      this.#currentSentence === sentenceId
    ) {
      return;
    }
    this.#currentWord = wordIndex;
    this.#currentSentence = sentenceId ?? null;
    const registry = this.#registry();
    if (!registry) return;

    registry.delete("os-word");
    registry.delete("os-sentence");
    if (wordIndex === null) return;

    const current = this.#words.get(wordIndex);
    if (!current) return;
    if (!this.#enabled) {
      this.#scrollToWord(wordIndex);
      return;
    }
    const sentence = this.#sentences.get(sentenceId ?? current.sentenceId);
    const sentenceRanges = this.#rangesForSentence(sentence ?? []);
    const wordRanges = this.#rangesForWord(wordIndex);
    if (sentenceRanges.length > 0) {
      registry.set("os-sentence", new Highlight(...sentenceRanges));
    }
    if (wordRanges.length > 0) {
      registry.set("os-word", new Highlight(...wordRanges));
    }
    this.#scrollToWord(wordIndex);
  }

  clear(): void {
    this.highlightWord(null);
    this.#registry()?.delete("os-sentence");
    this.#words.clear();
    this.#sentences.clear();
    if (this.#styleSheet) {
      this.#document.adoptedStyleSheets =
        this.#document.adoptedStyleSheets.filter(
          (sheet) => sheet !== this.#styleSheet,
        );
    }
    this.#styleElement?.remove();
    this.#styleElement = null;
    this.#onJumpVisibilityChange(false);
  }

  dispose(): void {
    this.clear();
    this.#document.removeEventListener(
      "pointerup",
      this.#handlePointerUp,
      true,
    );
    const view = this.#document.defaultView;
    view?.removeEventListener("scroll", this.#handleScroll);
    view?.removeEventListener("wheel", this.#handleManualScroll);
    view?.removeEventListener("touchstart", this.#handleManualScroll);
    view?.removeEventListener("keydown", this.#handleKeyboardScroll, true);
    if (this.#manualScrollTimer) clearTimeout(this.#manualScrollTimer);
  }

  #rangesForWord(wordIndex: number): Range[] {
    const word = this.#words.get(wordIndex);
    if (!word) return [];
    return word.pieces.flatMap((piece) => {
      if (!piece.node.isConnected) return [];
      try {
        const range = this.#document.createRange();
        range.setStart(piece.node, piece.start);
        range.setEnd(piece.node, piece.end);
        return [range];
      } catch {
        return [];
      }
    });
  }

  // One band per text node, from the sentence's first word in it to its last,
  // so the spaces between words are filled as well.
  #rangesForSentence(wordIndices: number[]): Range[] {
    const spans = new Map<Text, { start: number; end: number }>();
    for (const index of wordIndices) {
      for (const piece of this.#words.get(index)?.pieces ?? []) {
        const span = spans.get(piece.node);
        spans.set(piece.node, {
          start: Math.min(span?.start ?? piece.start, piece.start),
          end: Math.max(span?.end ?? piece.end, piece.end),
        });
      }
    }
    return [...spans].flatMap(([node, span]) => {
      if (!node.isConnected) return [];
      try {
        const range = this.#document.createRange();
        range.setStart(node, span.start);
        range.setEnd(node, span.end);
        return [range];
      } catch {
        return [];
      }
    });
  }

  #registry(): HighlightRegistry | null {
    return typeof CSS !== "undefined" && "highlights" in CSS
      ? CSS.highlights
      : null;
  }

  #installStyle(): void {
    const text = styleText(
      this.#wordColor,
      this.#sentenceColor,
      this.#textColor,
    );
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      this.#document.adoptedStyleSheets = [
        ...this.#document.adoptedStyleSheets,
        sheet,
      ];
      this.#styleSheet = sheet;
    } catch {
      const style = this.#document.createElement("style");
      style.dataset.openSpeechy = "highlights";
      style.textContent = text;
      this.#document.head.append(style);
      this.#styleElement = style;
    }
  }

  #replaceStyle(): void {
    const text = styleText(
      this.#wordColor,
      this.#sentenceColor,
      this.#textColor,
    );
    if (this.#styleSheet) {
      this.#styleSheet.replaceSync(text);
    } else if (this.#styleElement) {
      this.#styleElement.textContent = text;
    }
  }

  #handlePointerUp = (event: PointerEvent): void => {
    if (!this.#clickable && !event.altKey) return;
    const position = this.#caretPosition(event.clientX, event.clientY);
    if (!position || !(position.node instanceof Text)) return;
    const wordIndex = this.#wordAt(position.node, position.offset);
    if (wordIndex !== undefined) this.#onSeek(wordIndex);
  };

  #caretPosition(x: number, y: number): { node: Node; offset: number } | null {
    const view = this.#document.defaultView;
    const withCaret = this.#document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = withCaret.caretPositionFromPoint?.(x, y);
    if (position) return { node: position.offsetNode, offset: position.offset };
    const range = withCaret.caretRangeFromPoint?.(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
    if (!view) return null;
    return null;
  }

  #wordAt(node: Text, offset: number): number | undefined {
    const ranges = this.#nodeWordRanges.get(node) ?? [];
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const range = ranges[middle];
      if (offset < range.start) high = middle - 1;
      else if (offset > range.end) low = middle + 1;
      else return range.wordIndex;
    }
    return undefined;
  }

  #scrollToWord(wordIndex: number, force = false): void {
    if (!this.#autoScroll || (!force && performance.now() < this.#manualScrollUntil)) {
      return;
    }
    const view = this.#document.defaultView;
    const range = this.#rangesForWord(wordIndex)[0];
    if (!view || !range) return;
    const rect = range.getBoundingClientRect();
    // Many sites scroll the article inside an element, not the window.
    const container = this.#scrollContainer(range.startContainer);
    const frame = container?.getBoundingClientRect();
    const top = Math.max(0, frame?.top ?? 0);
    const bottom = Math.min(view.innerHeight, frame?.bottom ?? view.innerHeight);
    const height = bottom - top;
    if (rect.top >= top + height * 0.2 && rect.bottom <= top + height * 0.8) {
      return;
    }

    this.#programmaticScrollUntil = performance.now() + 2_500;
    (container ?? view).scrollBy({
      top: rect.top + rect.height / 2 - (top + height / 2),
      behavior: this.#reducedMotion ? "auto" : "smooth",
    });
  }

  // The nearest ancestor that scrolls the node, or null for the page itself.
  #scrollContainer(node: Node): Element | null {
    const view = this.#document.defaultView;
    const root = this.#document.scrollingElement;
    let element = node.parentElement;
    while (view && element && element !== root && element !== this.#document.body) {
      const overflow = view.getComputedStyle(element).overflowY;
      if (
        /auto|scroll|overlay/u.test(overflow) &&
        element.scrollHeight > element.clientHeight + 1
      ) {
        return element;
      }
      element = element.parentElement;
    }
    return null;
  }

  #handleManualScroll = (): void => {
    if (!this.#autoScroll) return;
    this.#manualScrollUntil = performance.now() + 5_000;
    this.#onJumpVisibilityChange(true);
    if (this.#manualScrollTimer) clearTimeout(this.#manualScrollTimer);
    this.#manualScrollTimer = setTimeout(() => {
      this.#manualScrollTimer = null;
      if (performance.now() >= this.#manualScrollUntil) {
        this.#onJumpVisibilityChange(false);
      }
    }, 5_050);
  };

  #handleScroll = (): void => {
    if (performance.now() >= this.#programmaticScrollUntil) {
      this.#handleManualScroll();
    }
  };

  #handleKeyboardScroll = (event: KeyboardEvent): void => {
    if (["PageUp", "PageDown", "Home", "End"].includes(event.key)) {
      this.#handleManualScroll();
    }
  };
}
