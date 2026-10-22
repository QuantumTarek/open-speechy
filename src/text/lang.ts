import type { Lang } from "../engines/types";

const ARABIC_SCRIPT =
  /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/u;
const ARABIC_LETTER =
  /[\u0621-\u064a\u066e-\u06d3\u06fa-\u06fc\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufefc]/u;
const LETTER = /\p{L}/u;

export function detectLanguage(text: string, ancestorLang = ""): Lang {
  let arabic = 0;
  let letters = 0;

  for (const char of text) {
    if (!LETTER.test(char)) continue;
    letters += 1;
    if (ARABIC_SCRIPT.test(char)) arabic += 1;
  }

  if (letters > 0) return arabic / letters >= 0.5 ? "ar" : "en";
  const declared = ancestorLang.toLowerCase();
  if (declared.startsWith("ar")) return "ar";
  if (declared.startsWith("en")) return "en";
  return "en";
}

export function splitMixedScriptRuns<T extends { text: string; lang: Lang }>(
  words: T[],
  mainLanguage?: Lang,
): T[][] {
  if (words.length === 0) return [];
  const defaultLanguage =
    mainLanguage ?? detectLanguage(words.map((word) => word.text).join(" "));
  const scripts = words.map((word) =>
    ARABIC_SCRIPT.test(word.text) ? "ar" : "en",
  );
  const runs: T[][] = [];
  const languages: Lang[] = [];

  for (let start = 0; start < words.length;) {
    let end = start + 1;
    while (end < words.length && scripts[end] === scripts[start]) end += 1;
    const scriptLanguage = scripts[start];
    const language =
      scriptLanguage !== defaultLanguage && end - start < 2
        ? defaultLanguage
        : scriptLanguage;
    const priorIndex = languages.length - 1;
    if (priorIndex >= 0 && languages[priorIndex] === language) {
      runs[priorIndex].push(...words.slice(start, end));
    } else {
      runs.push(words.slice(start, end));
      languages.push(language);
    }
    start = end;
  }

  return runs.map((run, index) =>
    run.map((word) => ({ ...word, lang: languages[index] })),
  );
}

export function isArabicScript(text: string): boolean {
  return ARABIC_SCRIPT.test(text);
}

export function isArabicLetter(char: string): boolean {
  return ARABIC_LETTER.test(char);
}
