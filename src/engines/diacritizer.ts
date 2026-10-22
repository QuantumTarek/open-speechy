const ARABIC_MARK = /[\u064b-\u065f\u0670]/u;
const ARABIC_BASE = /[\u0621-\u064a\u066e-\u06d3\u06fa-\u06fc]/u;

export type DiacritizerPredictor = (text: string) => Promise<string>;

export function isMostlyDiacritized(text: string): boolean {
  let letters = 0;
  let markedLetters = 0;
  const chars = Array.from(text);
  for (let index = 0; index < chars.length; index += 1) {
    if (!ARABIC_BASE.test(chars[index])) continue;
    letters += 1;
    if (ARABIC_MARK.test(chars[index + 1] ?? "")) markedLetters += 1;
  }
  return letters > 0 && markedLetters / letters > 0.3;
}

export function preserveWordOffsets(
  originalWords: string[],
  predictedText: string,
): string[] {
  const predictedWords = predictedText.trim().split(/\s+/u).filter(Boolean);
  return predictedWords.length === originalWords.length
    ? predictedWords
    : originalWords;
}

export class ArabicDiacritizer {
  readonly #enabled: boolean;
  readonly #predictor?: DiacritizerPredictor;

  constructor(enabled = false, predictor?: DiacritizerPredictor) {
    this.#enabled = enabled;
    this.#predictor = predictor;
  }

  async apply(words: string[]): Promise<string[]> {
    if (
      !this.#enabled ||
      !this.#predictor ||
      isMostlyDiacritized(words.join(" "))
    ) {
      return words;
    }
    try {
      return preserveWordOffsets(
        words,
        await this.#predictor(words.join(" ")),
      );
    } catch {
      return words;
    }
  }
}
