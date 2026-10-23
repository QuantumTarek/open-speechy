import { afterEach, describe, expect, it, vi } from "vitest";
import { highlightColors, isDarkPage } from "../../src/highlight/colors";
import { Highlighter } from "../../src/highlight/highlighter";

describe("page highlight palette", () => {
  it("detects a dark article background", () => {
    const article = document.createElement("article");
    article.style.backgroundColor = "rgb(18, 20, 22)";
    document.body.append(article);

    expect(isDarkPage(document, article)).toBe(true);
    expect(highlightColors(document, article, {
      word: "rgba(1, 2, 3, 0.6)",
      sentence: "rgba(4, 5, 6, 0.2)",
    })).toEqual({
      word: "#5666f0",
      sentence: "#444766",
      text: "#ffffff",
    });
    article.remove();
  });

  it("keeps user colors on a light page, with black text", () => {
    const article = document.createElement("article");
    article.style.backgroundColor = "rgb(255, 255, 255)";
    document.body.append(article);
    const preferred = {
      word: "rgba(10, 20, 30, 0.7)",
      sentence: "rgba(40, 50, 60, 0.2)",
    };

    expect(isDarkPage(document, article)).toBe(false);
    expect(highlightColors(document, article, preferred)).toEqual({
      ...preferred,
      text: "#000000",
    });
    article.remove();
  });
});

describe("sentence highlight", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("covers the spaces between a sentence's words, like Speechify", () => {
    const highlights = new Map<string, { ranges: Range[] }>();
    vi.stubGlobal("CSS", { highlights });
    vi.stubGlobal(
      "Highlight",
      class {
        readonly ranges: Range[];
        constructor(...ranges: Range[]) {
          this.ranges = ranges;
        }
      },
    );
    const paragraph = document.createElement("p");
    paragraph.append("Hello brave world. ", document.createElement("b"), "Next one.");
    paragraph.querySelector("b")!.append("Bold");
    document.body.append(paragraph);
    const [first, bold, last] = [...paragraph.childNodes].map((node) =>
      node.nodeName === "B" ? node.firstChild : node,
    ) as Text[];
    const word = (index: number, node: Text, start: number, end: number) => ({
      index,
      display: node.data.slice(start, end),
      spoken: [node.data.slice(start, end)],
      pieces: [{ node, start, end, offset: 0 }],
    });
    const highlighter = new Highlighter(document, () => {}, { autoScroll: false });
    highlighter.setSentences([
      {
        id: "s0",
        index: 0,
        paragraphIndex: 0,
        lang: "en",
        text: "Hello brave world.",
        words: [word(0, first, 0, 5), word(1, first, 6, 11), word(2, first, 12, 18)],
      },
      {
        id: "s1",
        index: 1,
        paragraphIndex: 0,
        lang: "en",
        text: "Bold Next one.",
        words: [word(3, bold, 0, 4), word(4, last, 0, 4), word(5, last, 5, 9)],
      },
    ] as never);

    highlighter.highlightWord(1, "s0");
    expect(highlights.get("os-sentence")?.ranges.map(String)).toEqual([
      "Hello brave world.",
    ]);
    expect(highlights.get("os-word")?.ranges.map(String)).toEqual(["brave"]);

    highlighter.highlightWord(4, "s1");
    expect(highlights.get("os-sentence")?.ranges.map(String)).toEqual([
      "Bold",
      "Next one.",
    ]);
    highlighter.dispose();
  });
});
