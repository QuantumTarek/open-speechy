import { numberToEnglish } from "./number-to-words-en";

export type UrlSpeechPolicy = "domain" | "skip" | "full";

const CURRENCY: Record<string, string> = {
  $: "dollars",
  "€": "euros",
  "£": "pounds",
};

// "St." and "Ft." stay as written: each has two common readings.
const ABBREVIATIONS: Record<string, string[]> = {
  "dr.": ["doctor"],
  "mr.": ["mister"],
  "mrs.": ["misses"],
  "ms.": ["miss"],
  "prof.": ["professor"],
  "jr.": ["junior"],
  "sr.": ["senior"],
  "mt.": ["mount"],
  "gen.": ["general"],
  "col.": ["colonel"],
  "lt.": ["lieutenant"],
  "sgt.": ["sergeant"],
  "capt.": ["captain"],
  "gov.": ["governor"],
  "sen.": ["senator"],
  "rep.": ["representative"],
  "rev.": ["reverend"],
  "hon.": ["honorable"],
  "vs.": ["versus"],
  "e.g.": ["for", "example"],
  "i.e.": ["that", "is"],
  "etc.": ["et", "cetera"],
  // Only reached before a number: "No. 5", "Jan. 5".
  "no.": ["number"],
  "nos.": ["numbers"],
  "jan.": ["January"],
  "feb.": ["February"],
  "mar.": ["March"],
  "apr.": ["April"],
  "jun.": ["June"],
  "jul.": ["July"],
  "aug.": ["August"],
  "sep.": ["September"],
  "sept.": ["September"],
  "oct.": ["October"],
  "nov.": ["November"],
  "dec.": ["December"],
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

// Top-level domains read as domains when written without "www." or a scheme.
// Kept short so words joined by a period ("Node.js") are not taken for one.
export const DOMAIN_TLDS =
  "com|org|net|io|ai|dev|app|co|me|info|biz|edu|gov|xyz|tech|site|online|store|blog|cloud|news|us|uk|ca|au|de|fr|es|it|nl|se|ch|at|be|ie|nz|za|in|jp|kr|cn|br|mx|ru|tr|eg|sa|ae|qa|kw|jo|ma|gg|ly|sh|tv|fm|so|to";
const BARE_DOMAIN = new RegExp(
  String.raw`^((?:[\p{L}\p{N}-]+\.)+(?:${DOMAIN_TLDS}))(?:\/\S*)?$`,
  "iu",
);

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Two-letter domain endings people spell out ("dot I O"); these few are said
// as words.
const SPOKEN_TLDS = new Set(["co", "me", "to", "so"]);

function words(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean);
}

function yearWords(year: number): string[] {
  return words(
    year >= 1_000 && year <= 2_099 ? yearToEnglish(year) : numberToEnglish(year),
  );
}

// "March sixth, twenty twenty-four". Null for a month or day out of range.
function speakDate(year: number, month: number, day: number): string[] | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return [MONTHS[month - 1], `${ordinalToEnglish(day)},`, ...yearWords(year)];
}

// Whether this browser writes the month first in a numeric date (US style).
function monthFirst(): boolean {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(new Date(2000, 10, 22));
    return parts.find((part) => part.type !== "literal")?.type === "month";
  } catch {
    return true;
  }
}

function urlDomain(word: string): string | null {
  if (/^(?:https?:\/\/|www\.)/iu.test(word)) {
    try {
      const parsed = new URL(word.startsWith("www.") ? `https://${word}` : word);
      return parsed.hostname.replace(/^www\./iu, "");
    } catch {
      return null;
    }
  }
  // A bare domain such as "goldapi.io", optionally with a path.
  return word.match(BARE_DOMAIN)?.[1] ?? null;
}

function speakDomain(domain: string): string[] {
  const parts = domain.split(".").filter(Boolean);
  return parts.flatMap((part, index) => {
    const ending =
      index === parts.length - 1 &&
      index > 0 &&
      part.length === 2 &&
      !SPOKEN_TLDS.has(part.toLowerCase());
    const spoken = ending ? part.toUpperCase() : part;
    return index === 0 ? [spoken] : ["dot", spoken];
  });
}

function speakEmail(local: string, domain: string): string[] {
  const name = local
    .split(".")
    .filter(Boolean)
    .flatMap((part, index) => (index === 0 ? [part] : ["dot", part]));
  return [...name, "at", ...speakDomain(domain)];
}

function digitWords(digits: string): string[] {
  return digits.split("").map((digit) => numberToEnglish(Number(digit)));
}

export function normalizeEnglishWord(
  word: string,
  urlPolicy: UrlSpeechPolicy = "domain",
): string[] {
  const trimmed = word.trim();
  if (!trimmed) return [];

  const email = trimmed.match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/u);
  if (email) return speakEmail(email[1], email[2]);

  const isoDate = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u);
  if (isoDate) {
    const spoken = speakDate(
      Number(isoDate[1]),
      Number(isoDate[2]),
      Number(isoDate[3]),
    );
    if (spoken) return spoken;
  }

  const slashDate = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/u);
  if (slashDate) {
    const first = Number(slashDate[1]);
    const second = Number(slashDate[2]);
    const year =
      slashDate[3].length === 2 ? 2_000 + Number(slashDate[3]) : Number(slashDate[3]);
    // A value above 12 can only be the day; otherwise follow the locale.
    const dayFirst = first > 12 || (second <= 12 && !monthFirst());
    const spoken = dayFirst
      ? speakDate(year, second, first)
      : speakDate(year, first, second);
    if (spoken) return spoken;
  }

  const time = trimmed.match(/^(\d{1,2}):(\d{2})(?:\s?([ap])\.?m\.?)?$/iu);
  if (time && Number(time[1]) <= 24 && Number(time[2]) <= 59) {
    const minutes = Number(time[2]);
    const spoken = [
      ...words(numberToEnglish(Number(time[1]))),
      ...(minutes === 0
        ? time[3]
          ? []
          : ["o'clock"]
        : minutes < 10
          ? ["oh", numberToEnglish(minutes)]
          : words(numberToEnglish(minutes))),
    ];
    return time[3] ? [...spoken, `${time[3].toUpperCase()}M`] : spoken;
  }

  // Numbers joined by dashes: a range ("10-20", "2020-2024") reads with "to";
  // longer runs or groups with leading zeros (phone numbers) read digit by
  // digit, never as negative numbers.
  const run = trimmed.match(/^(\d[\d,.]*(?:[-–]\d[\d,.]*)+)(%?)$/u);
  if (run?.[2]) return [...normalizeEnglishWord(run[1]), "percent"];
  if (run) {
    const groups = trimmed.split(/[-–]/u);
    if (groups.length === 2 && groups.every((group) => !/^0\d/u.test(group))) {
      return [
        ...normalizeEnglishWord(groups[0]),
        "to",
        ...normalizeEnglishWord(groups[1]),
      ];
    }
    return groups.flatMap((group, index) => {
      const digits = digitWords(group.replace(/\D/gu, ""));
      if (index < groups.length - 1 && digits.length > 0) {
        digits[digits.length - 1] = `${digits.at(-1)},`;
      }
      return digits;
    });
  }

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

  const abbreviation = ABBREVIATIONS[trimmed.toLowerCase()];
  if (abbreviation) return abbreviation;
  // Names like "Node.js" are said with "dot"; "U.S" (single letters) is not.
  if (/^[\p{L}\p{N}]{2,}(?:\.[\p{L}\p{N}]{2,})+$/u.test(trimmed)) {
    return trimmed
      .split(".")
      .flatMap((part, index) => (index === 0 ? [part] : ["dot", part]));
  }
  return [trimmed.replace(/[^\p{L}\p{N}'-]/gu, "")];
}

export function normalizeEnglishText(words: string[]): string[] {
  return words.flatMap((word) => normalizeEnglishWord(word)).filter(Boolean);
}
