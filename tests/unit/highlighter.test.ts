import { describe, expect, it } from "vitest";
import { highlightColors, isDarkPage } from "../../src/highlight/colors";

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
      word: "rgba(255, 213, 110, 0.72)",
      sentence: "rgba(95, 184, 170, 0.28)",
    });
    article.remove();
  });

  it("keeps user colors on a light page", () => {
    const article = document.createElement("article");
    article.style.backgroundColor = "rgb(255, 255, 255)";
    document.body.append(article);
    const preferred = {
      word: "rgba(10, 20, 30, 0.7)",
      sentence: "rgba(40, 50, 60, 0.2)",
    };

    expect(isDarkPage(document, article)).toBe(false);
    expect(highlightColors(document, article, preferred)).toEqual(preferred);
    article.remove();
  });
});
