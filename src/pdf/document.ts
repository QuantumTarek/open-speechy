import type { TextBlock } from "../text/extract";
import type { TextPiece } from "../engines/types";
import {
  boilerplateCounts,
  isBoilerplateLine,
  itemsToLines,
  linesToBlocks,
  pageIsRtl,
  splitColumns,
  type PdfLine,
  type PdfPageText,
} from "./order";

const HYPHEN_END = /[-\u2010\u2011]\s*$/u;

export interface BuiltPdfPage {
  /** Section element appended to the container, in page order. */
  element: HTMLElement;
  pageIndex: number;
}

/**
 * Build the text-layer DOM for one page inside `container` and return the
 * readable blocks (with `pieces` pointing at the created text nodes). The
 * spans are absolutely positioned over the page area so the shared
 * highlighter can light up ranges without touching page markup.
 */
export function buildPageLayout(
  page: PdfPageText,
  container: HTMLElement,
  bandCounts: Map<string, number>,
  totalPages: number,
): { section: HTMLElement; blocks: TextBlock[] } {
  const document = container.ownerDocument;
  const section = document.createElement("section");
  section.className = "pdf-page";
  section.dataset.page = String(page.pageIndex + 1);
  section.style.width = `${page.pageWidth}px`;
  section.style.height = `${page.pageHeight}px`;
  section.dir = pageIsRtl(page.items) ? "rtl" : "ltr";
  container.append(section);

  const textLayer = document.createElement("div");
  textLayer.className = "pdf-text-layer";
  section.append(textLayer);

  const columns = splitColumns(itemsToLines(page.items), section.dir === "rtl");
  const blocks: TextBlock[] = [];
  for (const column of columns) {
    for (const block of linesToBlocks(column)) {
      const kept = block.lines.filter(
        (line) =>
          !isBoilerplateLine(line, page, bandCounts, totalPages),
      );
      if (!kept.length) continue;
      const paragraph = document.createElement("p");
      paragraph.className = "pdf-block";
      const textBlock = blockToTextBlock(kept, paragraph);
      if (textBlock.text.trim()) {
        paragraph.dir = "auto";
        textLayer.append(paragraph);
        blocks.push(textBlock);
      }
    }
  }
  return { section, blocks };
}

export function buildBandCounts(pages: PdfPageText[]): Map<string, number> {
  return boilerplateCounts(pages);
}

function blockToTextBlock(lines: PdfLine[], paragraph: HTMLElement): TextBlock {
  const document = paragraph.ownerDocument;
  let text = "";
  const pieces: TextPiece[] = [];
  lines.forEach((line, lineIndex) => {
    const span = document.createElement("span");
    span.className = "pdf-line";
    span.textContent = line.text;
    span.style.left = `${line.x}px`;
    span.style.top = `${line.y}px`;
    span.style.fontSize = `${Math.max(4, line.height)}px`;
    span.style.height = `${line.height}px`;
    paragraph.append(span);
    const node = span.firstChild as Text | null;
    if (!node) return;

    if (lineIndex > 0 && !lines[lineIndex - 1].hyphenated) {
      text += " ";
    }
    const trimmed = line.text.trimEnd();
    const covered = line.hyphenated
      ? trimmed.search(HYPHEN_END)
      : trimmed.length;
    if (covered > 0) {
      pieces.push({ node, start: 0, end: covered, offset: text.length });
      text += trimmed.slice(0, covered);
    }
  });
  return { text, pieces, element: paragraph };
}
