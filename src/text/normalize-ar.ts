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

const MONTHS = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
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

  // "2024-03-06": day, month name, year.
  const date = normalized.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u);
  const month = date ? Number(date[2]) : 0;
  const day = date ? Number(date[3]) : 0;
  if (date && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
    return [
      ...speakInteger(day).split(/\s+/u),
      MONTHS[month - 1],
      ...speakInteger(Number(date[1])).split(/\s+/u),
    ];
  }

  // Numbers joined by dashes: a range reads with "إلى", and longer runs or
  // groups with leading zeros (phone numbers) read digit by digit.
  if (/^\d[\d,.]*(?:[-–]\d[\d,.]*)+$/u.test(normalized)) {
    const groups = normalized.split(/[-–]/u);
    if (groups.length === 2 && groups.every((group) => !/^0\d/u.test(group))) {
      return [...numberParts(groups[0]), "إلى", ...numberParts(groups[1])];
    }
    return groups.flatMap((group) =>
      Array.from(group.replace(/\D/gu, ""), (digit) => DIGIT_WORDS[Number(digit)]),
    );
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
