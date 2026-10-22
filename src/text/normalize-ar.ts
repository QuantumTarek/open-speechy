import { numberToArabicWords } from "./number-to-words-ar";

const DIGIT_MAP: Record<string, string> = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
  "۰": "0",
  "۱": "1",
  "۲": "2",
  "۳": "3",
  "۴": "4",
  "۵": "5",
  "۶": "6",
  "۷": "7",
  "۸": "8",
  "۹": "9",
  "٫": ".",
  "٬": ",",
};

const CURRENCY: Record<string, { major: string; minor: string }> = {
  $: { major: "دولار", minor: "سنت" },
  "€": { major: "يورو", minor: "سنت" },
  "£": { major: "جنيه", minor: "بنس" },
};

const DIGIT_WORDS = [
  "صفر",
  "واحد",
  "اثنان",
  "ثلاثة",
  "أربعة",
  "خمسة",
  "ستة",
  "سبعة",
  "ثمانية",
  "تسعة",
];

function latinizeDigits(value: string): string {
  return Array.from(value, (char) => DIGIT_MAP[char] ?? char).join("");
}

function numberParts(value: string): string[] {
  const normalized = value.replaceAll(",", "");
  const [whole, fraction] = normalized.split(".");
  const result = speakInteger(Number(whole));
  if (!fraction) return result.split(/\s+/u);
  return [
    ...result.split(/\s+/u),
    "فاصلة",
    ...fraction.split("").map((digit) => DIGIT_WORDS[Number(digit)]),
  ];
}

function speakInteger(value: number): string {
  try {
    return numberToArabicWords(value);
  } catch {
    return String(value);
  }
}

export function normalizeArabicWord(word: string): string[] {
  const normalized = latinizeDigits(word.trim().replaceAll("ـ", ""));
  if (!normalized) return [];

  const currency = normalized.match(/^([$€£])\s?(-?[\d,]+)(?:\.(\d{1,2}))?$/u);
  if (currency) {
    const units = CURRENCY[currency[1]];
    const amount = speakInteger(
      Number(currency[2].replaceAll(",", "")),
    );
    const spoken = [...amount.split(/\s+/u), units.major];
    if (currency[3] && Number(currency[3]) > 0) {
      spoken.push(
        "و",
        ...speakInteger(Number(currency[3])).split(/\s+/u),
        units.minor,
      );
    }
    return spoken;
  }

  const numeric = normalized.match(/^-?\d[\d,]*(?:\.\d+)?[%٪]?$/u);
  if (numeric) {
    const percentage = /[%٪]$/u.test(normalized);
    const value = percentage ? normalized.slice(0, -1) : normalized;
    const spoken = numberParts(value);
    return percentage ? [...spoken, "بالمئة"] : spoken;
  }

  return [normalized];
}

export function normalizeArabicWords(words: string[]): string[] {
  return words.flatMap(normalizeArabicWord).filter(Boolean);
}
