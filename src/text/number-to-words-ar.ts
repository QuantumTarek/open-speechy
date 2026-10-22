const UNITS = [
  "",
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

const TEENS = [
  "عشرة",
  "أحد عشر",
  "اثنا عشر",
  "ثلاثة عشر",
  "أربعة عشر",
  "خمسة عشر",
  "ستة عشر",
  "سبعة عشر",
  "ثمانية عشر",
  "تسعة عشر",
];

const TENS = [
  "",
  "",
  "عشرون",
  "ثلاثون",
  "أربعون",
  "خمسون",
  "ستون",
  "سبعون",
  "ثمانون",
  "تسعون",
];

const HUNDREDS = [
  "",
  "مئة",
  "مئتان",
  "ثلاثمئة",
  "أربعمئة",
  "خمسمئة",
  "ستمئة",
  "سبعمئة",
  "ثمانمئة",
  "تسعمئة",
];

function underHundred(value: number): string {
  if (value < 10) return UNITS[value];
  if (value < 20) return TEENS[value - 10];
  const tens = Math.floor(value / 10);
  const units = value % 10;
  return units ? `${UNITS[units]} و${TENS[tens]}` : TENS[tens];
}

function underThousand(value: number): string {
  if (value < 100) return underHundred(value);
  const hundreds = Math.floor(value / 100);
  const remainder = value % 100;
  const head = HUNDREDS[hundreds];
  return remainder ? `${head} و${underHundred(remainder)}` : head;
}

function scaleGroup(
  value: number,
  singular: string,
  dual: string,
  plural: string,
  counted: string,
): string {
  if (value === 1) return singular;
  if (value === 2) return dual;
  if (value <= 10) return `${underThousand(value)} ${plural}`;
  return `${underThousand(value)} ${counted}`;
}

export function numberToArabicWords(value: number): string {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 999_999_999) {
    throw new RangeError("Arabic number expansion supports integers up to 999,999,999.");
  }
  if (value < 0) return `سالب ${numberToArabicWords(Math.abs(value))}`;
  if (value === 0) return "صفر";

  const parts: string[] = [];
  const millions = Math.floor(value / 1_000_000);
  const thousands = Math.floor((value % 1_000_000) / 1_000);
  const remainder = value % 1_000;

  if (millions) {
    parts.push(
      scaleGroup(millions, "مليون", "مليونان", "ملايين", "مليونًا"),
    );
  }
  if (thousands) {
    parts.push(scaleGroup(thousands, "ألف", "ألفان", "آلاف", "ألفًا"));
  }
  if (remainder) parts.push(underThousand(remainder));
  return parts.join(" و");
}
