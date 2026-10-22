// PDF reading order heuristics (PLAN.md §8.3).
//
// PDF.js yields text items in content-stream order, which is arbitrary. These
// functions rebuild a sensible reading sequence: group items into lines,
// split lines into columns, join lines into paragraph blocks, drop repeated
// headers/footers and page numbers, and de-hyphenate line ends.

export interface PdfTextItem {
  /** Text after Arabic normalization. */
  str: string;
  /** Left edge, viewport units (y grows downward). */
  x: number;
  /** Top edge, viewport units. */
  y: number;
  width: number;
  height: number;
}

export interface PdfPageText {
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  items: PdfTextItem[];
}

export interface PdfLine {
  items: PdfTextItem[];
  x: number;
  y: number;
  height: number;
  /** Joined line text. */
  text: string;
  /** True when a trailing hyphen joins this line's last word to the next line. */
  hyphenated: boolean;
}

export interface PdfBlock {
  /** Lines in reading order. */
  lines: PdfLine[];
}

const ARABIC_LETTER = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u;
const HYPHEN_END = /[-\u2010\u2011]\s*$/u;
const LOWERCASE_START = /^\s*\p{Ll}/u;
const PAGE_NUMBER = /^[\divxlcdm]+$/iu;

/** Group a page's items into lines sorted top to bottom, left to right. */
export function itemsToLines(items: PdfTextItem[]): PdfLine[] {
  const sorted = items
    .filter((item) => item.str.trim())
    .slice()
    .sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
  const grouped: PdfTextItem[][] = [];
  for (const item of sorted) {
    const center = item.y + item.height / 2;
    const line = grouped[grouped.length - 1];
    const last = line?.[line.length - 1];
    const tolerance = Math.max(2, item.height * 0.45);
    if (
      line &&
      last &&
      Math.abs(center - (last.y + last.height / 2)) <= tolerance
    ) {
      line.push(item);
    } else {
      grouped.push([item]);
    }
  }
  return grouped.flatMap((lineItems) => {
    lineItems.sort((a, b) => a.x - b.x);
    // A huge internal x-gap means the baseline crosses a column gutter;
    // split the fragments so column detection can separate them.
    const fragments: PdfTextItem[][] = [[lineItems[0]]];
    for (let index = 1; index < lineItems.length; index += 1) {
      const previous = lineItems[index - 1];
      const current = lineItems[index];
      const gap = current.x - (previous.x + previous.width);
      if (gap > Math.max(24, current.height * 2)) {
        fragments.push([current]);
      } else {
        fragments[fragments.length - 1].push(current);
      }
    }
    return fragments.map((fragment) => ({
      items: fragment,
      x: Math.min(...fragment.map((item) => item.x)),
      y: Math.min(...fragment.map((item) => item.y)),
      height: Math.max(...fragment.map((item) => item.height)),
      text: joinLineText(fragment),
      hyphenated: false,
    }));
  });
}

function joinLineText(items: PdfTextItem[]): string {
  let text = "";
  let previous: PdfTextItem | null = null;
  for (const item of items) {
    if (
      previous &&
      text &&
      !text.endsWith(" ") &&
      !item.str.startsWith(" ") &&
      item.x - (previous.x + previous.width) > previous.height * 0.28
    ) {
      text += " ";
    }
    text += item.str;
    previous = item;
  }
  return text;
}

function lineEndX(line: PdfLine): number {
  return Math.max(...line.items.map((item) => item.x + item.width));
}

/**
 * Split lines into columns. Finds the widest vertical gap (in the central
 * 80% of the line x-extent) that no more than 10% of lines cross; splits
 * there and repeats up to three columns. Returns groups in reading order —
 * left-to-right for LTR pages, right-to-left for Arabic-majority pages.
 */
export function splitColumns(lines: PdfLine[], rtl = false): PdfLine[][] {
  const columns = splitRecursive(lines, 0);
  return rtl ? columns.reverse() : columns;
}

function splitRecursive(lines: PdfLine[], depth: number): PdfLine[][] {
  if (lines.length < 3 || depth >= 2) return [lines];
  const minX = Math.min(...lines.map((line) => line.x));
  const maxX = Math.max(...lines.map(lineEndX));
  const span = maxX - minX;
  if (span <= 0) return [lines];

  const medianHeight = median(lines.map((line) => line.height));
  const minGap = Math.max(12, medianHeight * 1.5);
  const edges = lines
    .flatMap((line) => [line.x, lineEndX(line)])
    .sort((a, b) => a - b);
  const cuts: number[] = [];
  for (let index = 1; index < edges.length; index += 1) {
    if (edges[index] - edges[index - 1] >= minGap) {
      cuts.push((edges[index] + edges[index - 1]) / 2);
    }
  }

  let best: { cut: number; crossings: number } | null = null;
  for (const cut of cuts) {
    const position = (cut - minX) / span;
    if (position < 0.1 || position > 0.9) continue;
    const crossings = lines.filter(
      (line) => line.x < cut && lineEndX(line) > cut,
    ).length;
    if (!best || crossings < best.crossings) best = { cut, crossings };
  }
  if (!best || best.crossings > lines.length * 0.1) return [lines];

  const cut = best.cut;
  const left = lines.filter(
    (line) => lineEndX(line) <= cut || (line.x < cut && cut - line.x >= lineEndX(line) - cut),
  );
  const right = lines.filter(
    (line) => line.x >= cut || (line.x < cut && cut - line.x < lineEndX(line) - cut),
  );
  if (!left.length || !right.length) return [lines];
  return [
    ...splitRecursive(left, depth + 1),
    ...splitRecursive(right, depth + 1),
  ];
}

/** Group a column's lines into paragraph blocks by vertical gap. */
export function linesToBlocks(lines: PdfLine[]): PdfBlock[] {
  const sorted = lines.slice().sort((a, b) => a.y - b.y);
  const blocks: PdfBlock[] = [];
  let current: PdfLine[] = [];
  const medianHeight = median(sorted.map((line) => line.height)) || 12;
  for (const line of sorted) {
    const previous = current[current.length - 1];
    const gap = previous ? line.y - (previous.y + previous.height) : 0;
    if (previous && gap > medianHeight * 1.5) {
      blocks.push({ lines: current });
      current = [];
    }
    current.push(line);
  }
  if (current.length) blocks.push({ lines: current });
  for (const block of blocks) {
    block.lines.forEach((line, index) => {
      const next = block.lines[index + 1];
      line.hyphenated = Boolean(
        next && HYPHEN_END.test(line.text) && LOWERCASE_START.test(next.text),
      );
    });
  }
  return blocks;
}

/**
 * Drop lines that repeat in the top/bottom 8% band of at least half the
 * pages (running headers/footers) and bare page numbers in the outer 10%.
 */
export function isBoilerplateLine(
  line: PdfLine,
  page: PdfPageText,
  bandCounts: Map<string, number>,
  totalPages: number,
): boolean {
  const normalized = line.text.trim().toLowerCase();
  if (!normalized) return true;
  if (
    line.y <= page.pageHeight * 0.08 ||
    line.y >= page.pageHeight * 0.92
  ) {
    if ((bandCounts.get(normalized) ?? 0) >= Math.max(2, totalPages * 0.5)) {
      return true;
    }
  }
  if (
    (line.y <= page.pageHeight * 0.1 || line.y >= page.pageHeight * 0.9) &&
    PAGE_NUMBER.test(normalized)
  ) {
    return true;
  }
  return false;
}

/** Count on how many pages each top/bottom-band line text appears. */
export function boilerplateCounts(pages: PdfPageText[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const line of itemsToLines(page.items)) {
      if (
        line.y <= page.pageHeight * 0.08 ||
        line.y >= page.pageHeight * 0.92
      ) {
        seen.add(line.text.trim().toLowerCase());
      }
    }
    for (const text of seen) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

/** Whether a page's text is majority Arabic (drives column direction). */
export function pageIsRtl(items: PdfTextItem[]): boolean {
  const text = items.map((item) => item.str).join(" ");
  let arabic = 0;
  let latin = 0;
  for (const char of text) {
    if (ARABIC_LETTER.test(char)) arabic += 1;
    else if (/[a-z]/iu.test(char)) latin += 1;
  }
  return arabic > latin;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}
