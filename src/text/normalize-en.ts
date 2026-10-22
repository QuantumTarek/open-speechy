import { numberToEnglish } from "./number-to-words-en";

export type UrlSpeechPolicy = "domain" | "skip" | "full";

const CURRENCY: Record<string, string> = {
  $: "dollars",
  "€": "euros",
  "£": "pounds",
};

const ABBREVIATIONS: Record<string, string[]> = {
  "dr.": ["doctor"],
  "mr.": ["mister"],
  "mrs.": ["misses"],
  "ms.": ["miss"],
  "e.g.": ["for", "example"],
  "i.e.": ["that", "is"],
  "etc.": ["et", "cetera"],
};

const ORDINALS: Record<number, string> = {
  0: "zeroth",
  1: "first",
  2: "second",
  3: "third",
  4: "fourth",
  5: "fifth",
  6: "sixth",
  7: "seventh",
  8: "eighth",
  9: "ninth",
  10: "tenth",
  11: "eleventh",
  12: "twelfth",
  13: "thirteenth",
  14: "fourteenth",
  15: "fifteenth",
  16: "sixteenth",
  17: "seventeenth",
  18: "eighteenth",
  19: "nineteenth",
  20: "twentieth",
  30: "thirtieth",
  40: "fortieth",
  50: "fiftieth",
  60: "sixtieth",
  70: "seventieth",
  80: "eightieth",
  90: "ninetieth",
};

function ordinalUnderThousand(value: number): string {
  if (value < 20) return ORDINALS[value];
  if (value < 100) {
    const tens = Math.floor(value / 10) * 10;
    const units = value % 10;
    return units
      ? `${numberToEnglish(tens)}-${ordinalUnderThousand(units)}`
      : ORDINALS[tens];
  }

  const hundreds = Math.floor(value / 100);
  const remainder = value % 100;
  const prefix = `${numberToEnglish(hundreds)} hundred`;
  return remainder
    ? `${prefix} ${ordinalUnderThousand(remainder)}`
    : `${prefix}th`;
}

function ordinalToEnglish(value: number): string {
  if (value <= 999) return ordinalUnderThousand(value);
  for (const [scale, name] of [
    [1_000_000, "million"],
    [1_000, "thousand"],
  ] as const) {
    const group = Math.floor(value / scale);
    if (group === 0) continue;
    const remainder = value % scale;
    const prefix = `${numberToEnglish(group)} ${name}`;
    return remainder
      ? `${prefix} ${ordinalToEnglish(remainder)}`
      : `${prefix}th`;
  }
  return numberToEnglish(value);
}

function yearToEnglish(value: number): string {
  if (value >= 1_000 && value <= 1_999) {
    if (value === 1_000) return "one thousand";
    if (value < 1_100) {
      return `one thousand ${numberToEnglish(value - 1_000)}`;
    }
    const century = Math.floor(value / 100);
    const remainder = value % 100;
    if (remainder === 0) return `${numberToEnglish(century)} hundred`;
    if (remainder < 10) {
      return `${numberToEnglish(century)} oh ${numberToEnglish(remainder)}`;
    }
    return `${numberToEnglish(century)} ${numberToEnglish(remainder)}`;
  }
  if (value === 2_000) return "two thousand";
  if (value < 2_010) return `two thousand ${numberToEnglish(value - 2_000)}`;
  return `twenty ${numberToEnglish(value - 2_000)}`;
}

function urlDomain(word: string): string | null {
  const email = word.match(/^[^@\s]+@([^@\s]+)$/u);
  if (email) return email[1];
  if (!/^(?:https?:\/\/|www\.)/iu.test(word)) return null;

  try {
    const parsed = new URL(word.startsWith("www.") ? `https://${word}` : word);
    return parsed.hostname.replace(/^www\./iu, "");
  } catch {
    return null;
  }
}

function speakDomain(domain: string): string[] {
  return domain
    .split(".")
    .filter(Boolean)
    .flatMap((part, index) => (index === 0 ? [part] : ["dot", part]));
}

export function normalizeEnglishWord(
  word: string,
  urlPolicy: UrlSpeechPolicy = "domain",
): string[] {
  const trimmed = word.trim();
  if (!trimmed) return [];

  const domain = urlDomain(trimmed);
  if (domain) {
    if (urlPolicy === "skip") return [];
    if (urlPolicy === "domain") return speakDomain(domain);
    return [trimmed];
  }

  const currency = trimmed.match(/^([$€£])\s?(-?[\d,]+)(?:\.(\d{1,2}))?$/u);
  if (currency) {
    const amount = Number(currency[2].replaceAll(",", ""));
    const cents = currency[3] ? Number(currency[3]) : 0;
    const result = [numberToEnglish(amount), CURRENCY[currency[1]]];
    if (cents) result.push("and", numberToEnglish(cents), "cents");
    return result.flatMap((part) => part.split(/\s+/u));
  }

  const ordinal = trimmed.match(/^(\d[\d,]*)(st|nd|rd|th)$/iu);
  if (ordinal) {
    const value = Number(ordinal[1].replaceAll(",", ""));
    if (value <= 999_999_999) return ordinalToEnglish(value).split(/\s+/u);
  }

  const numeric = trimmed.match(/^-?\d[\d,]*(?:\.\d+)?%?$/u);
  if (numeric) {
    const value = numeric[0].replaceAll(",", "");
    if (value.endsWith("%")) {
      const percentValue = value.slice(0, -1);
      const spoken = percentValue.includes(".")
        ? normalizeEnglishWord(percentValue)
        : numberToEnglish(Number(percentValue)).split(/\s+/u);
      return [...spoken, "percent"];
    }
    if (value.includes(".")) {
      const [whole, fraction] = value.split(".");
      return [
        ...numberToEnglish(Number(whole)).split(/\s+/u),
        "point",
        ...fraction.split("").map((digit) => numberToEnglish(Number(digit))),
      ];
    }
    const integer = Number(value);
    const spoken =
      integer >= 1_000 && integer <= 2_099
        ? yearToEnglish(integer)
        : numberToEnglish(integer);
    return spoken.split(/\s+/u);
  }

  const abbreviation = trimmed.toLowerCase();
  return (
    ABBREVIATIONS[abbreviation] ?? [trimmed.replace(/[^\p{L}\p{N}'-]/gu, "")]
  );
}

export function normalizeEnglishText(words: string[]): string[] {
  return words.flatMap((word) => normalizeEnglishWord(word)).filter(Boolean);
}
