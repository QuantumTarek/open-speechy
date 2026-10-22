import { Readability } from "@mozilla/readability";
import type { TextPiece } from "../engines/types";

export interface TextBlock {
  text: string;
  pieces: TextPiece[];
  element: Element | null;
}

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "NAV",
  "ASIDE",
  "FOOTER",
  "FIGURE",
  "BUTTON",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "SVG",
  "CANVAS",
]);

const BLOCK_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "BLOCKQUOTE",
  "TD",
  "TH",
  "DIV",
  "SECTION",
  "ARTICLE",
  "BR",
  "PRE",
]);

export function findArticleRoot(document: Document): Element {
  const clone = document.cloneNode(true) as Document;
  let articleText = "";
  try {
    articleText = new Readability(clone).parse()?.textContent?.trim() ?? "";
  } catch {
    articleText = "";
  }

  const candidates = Array.from(
    document.querySelectorAll('article, main, [role="main"], section, div'),
  ).slice(0, 1500);
  const articleWords = new Set(
    articleText.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  );
  let best: Element | null = null;
  let bestScore = 0;

  if (articleWords.size > 0) {
    for (const candidate of candidates) {
      const text = candidate.textContent?.trim() ?? "";
      if (text.length < 100) continue;
      const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
      if (words.length < 20) continue;
      const overlap = new Set(
        words.filter((word) => articleWords.has(word)).slice(0, 1000),
      ).size;
      const score =
        (overlap / Math.max(1, Math.min(articleWords.size, 1000))) *
        Math.log1p(text.length);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
  }

  if (best) return best;
  const semanticRoot = document.querySelector('article, main, [role="main"]');
  if (semanticRoot) return semanticRoot;

  return candidates.reduce<Element>(
    (largest, candidate) =>
      (candidate.textContent?.length ?? 0) > (largest.textContent?.length ?? 0)
        ? candidate
        : largest,
    document.body ?? document.documentElement,
  );
}

function shouldSkip(
  node: Text,
  readCodeBlocks: boolean,
  hiddenCache: WeakMap<Element, boolean>,
): boolean {
  let element = node.parentElement;
  while (element) {
    if (
      SKIP_TAGS.has(element.tagName) ||
      element.hidden ||
      element.getAttribute("aria-hidden") === "true" ||
      element.getAttribute("role") === "navigation" ||
      element.getAttribute("role") === "complementary" ||
      (!readCodeBlocks &&
        (element.tagName === "CODE" || element.tagName === "PRE"))
    ) {
      return true;
    }
    let hidden = hiddenCache.get(element);
    if (hidden === undefined) {
      const style =
        element.ownerDocument.defaultView?.getComputedStyle(element);
      hidden =
        element.style.display === "none" ||
        element.style.visibility === "hidden" ||
        style?.display === "none" ||
        style?.visibility === "hidden" ||
        false;
      hiddenCache.set(element, hidden);
    }
    if (hidden) return true;
    element = element.parentElement;
  }
  return false;
}

function nearestBlock(node: Text, root: Element): Element {
  let element = node.parentElement;
  while (element && element !== root) {
    if (BLOCK_TAGS.has(element.tagName)) return element;
    element = element.parentElement;
  }
  return root;
}

export function extractTextBlocks(
  root: Element,
  options: { readCodeBlocks?: boolean } = {},
): TextBlock[] {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  const blocks: TextBlock[] = [];
  const hiddenCache = new WeakMap<Element, boolean>();
  let currentElement: Element | null = null;
  let currentText = "";
  let currentPieces: TextPiece[] = [];
  let node = walker.nextNode() as Text | null;

  const flush = () => {
    const normalized = currentText.replace(/\s+/gu, " ").trim();
    if (normalized) {
      blocks.push({
        text: currentText,
        pieces: currentPieces,
        element: currentElement,
      });
    }
    currentText = "";
    currentPieces = [];
  };

  while (node) {
    if (!shouldSkip(node, options.readCodeBlocks ?? false, hiddenCache)) {
      const block = nearestBlock(node, root);
      if (currentElement && currentElement !== block) flush();
      currentElement = block;
      const value = node.nodeValue ?? "";
      if (value.trim()) {
        currentPieces.push({
          node,
          start: 0,
          end: value.length,
          offset: currentText.length,
        });
        currentText += value;
      }
    }
    node = walker.nextNode() as Text | null;
  }
  flush();
  return blocks;
}

export function extractSelectionBlocks(selection: Selection): TextBlock[] {
  const blocks: TextBlock[] = [];
  const hiddenCache = new WeakMap<Element, boolean>();
  for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
    const range = selection.getRangeAt(rangeIndex);
    const root = range.commonAncestorContainer;
    const ownerDocument = root.ownerDocument ?? document;
    const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = "";
    const pieces: TextPiece[] = [];
    let node =
      walker.currentNode instanceof Text
        ? (walker.currentNode as Text)
        : (walker.nextNode() as Text | null);

    while (node) {
      if (range.intersectsNode(node) && !shouldSkip(node, false, hiddenCache)) {
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : node.length;
        if (end > start) {
          pieces.push({ node, start, end, offset: text.length });
          text += node.data.slice(start, end);
        }
      }
      node = walker.nextNode() as Text | null;
    }
    if (text.trim()) blocks.push({ text, pieces, element: null });
  }
  return blocks;
}

export function mapTextOffsets(
  pieces: TextPiece[],
  start: number,
  end: number,
): TextPiece[] {
  return pieces.flatMap((piece) => {
    const pieceStart = piece.offset;
    const pieceEnd = piece.offset + (piece.end - piece.start);
    const overlapStart = Math.max(start, pieceStart);
    const overlapEnd = Math.min(end, pieceEnd);
    if (overlapEnd <= overlapStart) return [];
    return [
      {
        node: piece.node,
        start: piece.start + overlapStart - pieceStart,
        end: piece.start + overlapEnd - pieceStart,
        offset: overlapStart,
      },
    ];
  });
}
