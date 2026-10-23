export interface HighlightColors {
  word: string;
  sentence: string;
}

export interface PageHighlightColors extends HighlightColors {
  // Highlighted text is redrawn in this color so it reads on the fill.
  text: string;
}

// Speechify's palette for dark pages. Light pages use the saved colors, which
// default to Speechify's light palette.
const DARK_COLORS: PageHighlightColors = {
  word: "#5666f0",
  sentence: "#444766",
  text: "#ffffff",
};
const LIGHT_TEXT = "#000000";

export function isDarkPage(document: Document, root: Element | null): boolean {
  let element: Element | null = root;
  while (element) {
    const color = document.defaultView?.getComputedStyle(element).backgroundColor;
    const rgb = color?.match(/rgba?\(([^)]+)\)/iu)?.[1];
    if (rgb) {
      const [red, green, blue, alpha = 1] = rgb
        .split(/[,\s/]+/u)
        .filter(Boolean)
        .map(Number);
      if (
        Number.isFinite(red) &&
        Number.isFinite(green) &&
        Number.isFinite(blue) &&
        Number.isFinite(alpha) &&
        alpha > 0.5
      ) {
        return luminance(red, green, blue) < 0.36;
      }
    }
    element = element.parentElement;
  }
  return false;
}

export function highlightColors(
  document: Document,
  root: Element | null,
  preferences: HighlightColors,
): PageHighlightColors {
  return isDarkPage(document, root)
    ? DARK_COLORS
    : { word: preferences.word, sentence: preferences.sentence, text: LIGHT_TEXT };
}

function luminance(red: number, green: number, blue: number): number {
  const linear = [red, green, blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * linear[0] +
    0.7152 * linear[1] +
    0.0722 * linear[2]
  );
}
