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

const STYLE_TEXT = `
  ::highlight(os-sentence) {
    background-color: var(--os-sentence-bg, rgba(255, 213, 79, 0.25));
  }
  ::highlight(os-word) {
    background-color: var(--os-word-bg, rgba(255, 179, 0, 0.6));
    color: inherit;
  }
`;

export class Highlighter {
  readonly #document: Document;
  readonly #words = new Map<number, WordRange>();
  readonly #sentences = new Map<string, number[]>();
  #nodeWordRanges = new WeakMap<Text, NodeWordRange[]>();
  readonly #onSeek: (wordIndex: number) => void;
  readonly #styleSheet: CSSStyleSheet | null;
  #styleElement: HTMLStyleElement | null = null;
  #clickable = false;
  #currentWord: number | null = null;
  #currentSentence: string | null = null;

  constructor(document: Document, onSeek: (wordIndex: number) => void) {
    this.#document = document;
    this.#onSeek = onSeek;
    this.#styleSheet = this.#installStyle();
    this.#document.addEventListener("pointerup", this.#handlePointerUp, true);
  }

  setSentences(sentences: SentencePlan[]): void {
    this.#words.clear();
    this.#sentences.clear();
    this.#nodeWordRanges = new WeakMap();
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
    const sentence = this.#sentences.get(sentenceId ?? current.sentenceId);
    const sentenceRanges = (sentence ?? []).flatMap((index) =>
      this.#rangesForWord(index),
    );
    const wordRanges = this.#rangesForWord(wordIndex);
    if (sentenceRanges.length > 0) {
      registry.set("os-sentence", new Highlight(...sentenceRanges));
    }
    if (wordRanges.length > 0) {
      registry.set("os-word", new Highlight(...wordRanges));
    }
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
  }

  dispose(): void {
    this.clear();
    this.#document.removeEventListener(
      "pointerup",
      this.#handlePointerUp,
      true,
    );
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

  #registry(): HighlightRegistry | null {
    return typeof CSS !== "undefined" && "highlights" in CSS
      ? CSS.highlights
      : null;
  }

  #installStyle(): CSSStyleSheet | null {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE_TEXT);
      this.#document.adoptedStyleSheets = [
        ...this.#document.adoptedStyleSheets,
        sheet,
      ];
      return sheet;
    } catch {
      const style = this.#document.createElement("style");
      style.dataset.openSpeechy = "highlights";
      style.textContent = STYLE_TEXT;
      this.#document.head.append(style);
      this.#styleElement = style;
      return null;
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
}
