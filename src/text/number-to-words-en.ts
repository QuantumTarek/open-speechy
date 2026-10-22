const SMALL = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

function underThousand(value: number): string {
  const words: string[] = [];
  if (value >= 100) {
    words.push(SMALL[Math.floor(value / 100)], 'hundred');
    value %= 100;
  }
  if (value < 20 && value > 0) {
    words.push(SMALL[value]);
  } else if (value >= 20) {
    const ten = Math.floor(value / 10);
    const unit = value % 10;
    words.push(unit ? `${TENS[ten]}-${SMALL[unit]}` : TENS[ten]);
  }
  return words.join(' ');
}

export function numberToEnglish(value: number): string {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return String(value);
  }
  if (value < 0) return `minus ${numberToEnglish(Math.abs(value))}`;
  if (value === 0) return 'zero';
  if (value > 999_999_999) return String(value);

  const parts: string[] = [];
  const millions = Math.floor(value / 1_000_000);
  const thousands = Math.floor((value % 1_000_000) / 1_000);
  const remainder = value % 1_000;
  if (millions) parts.push(`${underThousand(millions)} million`);
  if (thousands) parts.push(`${underThousand(thousands)} thousand`);
  if (remainder) parts.push(underThousand(remainder));
  return parts.join(' ');
}
