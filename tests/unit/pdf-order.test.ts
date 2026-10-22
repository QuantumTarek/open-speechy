import { describe, expect, it } from "vitest";
import {
  boilerplateCounts,
  isBoilerplateLine,
  itemsToLines,
  linesToBlocks,
  pageIsRtl,
  splitColumns,
  type PdfPageText,
  type PdfTextItem,
} from "../../src/pdf/order";

function item(
  str: string,
  x: number,
  y: number,
  height = 10,
  width?: number,
): PdfTextItem {
  return { str, x, y, height, width: width ?? str.length * 6 };
}

function page(
  items: PdfTextItem[],
  pageIndex = 0,
  pageWidth = 612,
  pageHeight = 792,
): PdfPageText {
  return { pageIndex, pageWidth, pageHeight, items };
}

describe("itemsToLines", () => {
  it("groups items on the same baseline and orders top-to-bottom", () => {
    const lines = itemsToLines([
      item("world", 85, 102, 10, 30),
      item("Hello", 50, 100),
      item("next line", 50, 120),
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      "Hello world",
      "next line",
    ]);
    expect(lines[0].items.map((i) => i.x)).toEqual([50, 85]);
  });

  it("inserts spaces for wide gaps between items", () => {
    const lines = itemsToLines([
      { str: "alpha", x: 50, y: 100, width: 30, height: 10 },
      { str: "beta", x: 90, y: 100, width: 25, height: 10 },
    ]);
    expect(lines[0].text).toBe("alpha beta");
  });
});

describe("splitColumns", () => {
  it("separates two columns and returns left before right", () => {
    const lines = itemsToLines([
      item("left one", 50, 100),
      item("left two", 50, 114),
      item("left three", 50, 128),
      item("right one", 330, 100),
      item("right two", 330, 114),
      item("right three", 330, 128),
    ]);
    const columns = splitColumns(lines);
    expect(columns.map((column) => column.map((line) => line.text))).toEqual([
      ["left one", "left two", "left three"],
      ["right one", "right two", "right three"],
    ]);
  });

  it("returns right column first for rtl pages", () => {
    const lines = itemsToLines([
      item("a1", 50, 100),
      item("a2", 50, 114),
      item("a3", 50, 128),
      item("b1", 330, 100),
      item("b2", 330, 114),
      item("b3", 330, 128),
    ]);
    const columns = splitColumns(lines, true);
    expect(columns[0][0].text).toBe("b1");
  });

  it("does not split when lines span the gutter", () => {
    const lines = itemsToLines([
      item("short", 50, 100, 10, 30),
      item("short", 330, 100, 10, 30),
      { str: "a long spanning line across the page", x: 50, y: 120, width: 480, height: 10 },
      { str: "another spanning line across the page", x: 50, y: 134, width: 480, height: 10 },
      { str: "more spanning text across the page", x: 50, y: 148, width: 480, height: 10 },
      { str: "final spanning text across the page", x: 50, y: 162, width: 480, height: 10 },
    ]);
    const columns = splitColumns(lines);
    expect(columns.length).toBe(1);
  });
});

describe("linesToBlocks", () => {
  it("splits paragraphs on gaps larger than 1.5 line heights", () => {
    const lines = itemsToLines([
      item("one", 50, 100),
      item("two", 50, 112),
      item("three", 50, 140),
      item("four", 50, 152),
    ]);
    const blocks = linesToBlocks(lines);
    expect(blocks.map((block) => block.lines.map((l) => l.text))).toEqual([
      ["one", "two"],
      ["three", "four"],
    ]);
  });

  it("marks hyphenated line joins only for lowercase continuations", () => {
    const lines = itemsToLines([
      item("names its sub-", 50, 100),
      item("ject onward.", 50, 112),
      item("a hyphen-", 50, 140),
      item("Next word.", 50, 152),
    ]);
    const blocks = linesToBlocks(lines);
    expect(blocks[0].lines[0].hyphenated).toBe(true);
    expect(blocks[0].lines[1].hyphenated).toBe(false);
    expect(blocks[1].lines[0].hyphenated).toBe(false);
  });
});

describe("boilerplate filtering", () => {
  const pages = [0, 1, 2].map((index) =>
    page(
      [
        item("Journal of Tests", 50, 30),
        item("body text", 50, 400),
        item(String(index + 1), 300, 770, 10, 6),
      ],
      index,
    ),
  );
  const counts = boilerplateCounts(pages);

  it("drops running headers repeated across pages", () => {
    const lines = itemsToLines(pages[0].items);
    expect(
      isBoilerplateLine(lines[0], pages[0], counts, pages.length),
    ).toBe(true);
    expect(
      isBoilerplateLine(lines[1], pages[0], counts, pages.length),
    ).toBe(false);
  });

  it("drops bare page numbers in the bottom band", () => {
    const lines = itemsToLines(pages[0].items);
    const numberLine = lines.find((line) => line.text === "1")!;
    expect(
      isBoilerplateLine(numberLine, pages[0], counts, pages.length),
    ).toBe(true);
  });

  it("keeps page-number-like lines in the body", () => {
    const body = page([item("42", 50, 400, 10, 12)]);
    const line = itemsToLines(body.items)[0];
    expect(isBoilerplateLine(line, body, counts, pages.length)).toBe(false);
  });
});

describe("pageIsRtl", () => {
  it("detects majority Arabic text", () => {
    expect(pageIsRtl([item("مرحبا بالعالم", 0, 0)])).toBe(true);
    expect(pageIsRtl([item("hello world", 0, 0)])).toBe(false);
  });
});
