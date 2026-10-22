import { describe, expect, it } from "vitest";
import { normalizePdfArabic } from "../../src/pdf/arabic";

const V = {
  alefIso: "\uFE8D",
  alefFin: "\uFE8E",
  behIni: "\uFE91",
  behMed: "\uFE92",
  hahMed: "\uFEA4",
  rehFin: "\uFEAE",
  rehIso: "\uFEAD",
  meemIni: "\uFEE3",
  meemFin: "\uFEE2",
  lamIni: "\uFEDF",
  lamMed: "\uFEE0",
  ainMed: "\uFECC",
  noonFin: "\uFEE6",
  fehFin: "\uFED2",
  khahIni: "\uFEA7",
  tehMed: "\uFE98",
};

// Logical-order presentation forms of "مرحبا بالعالم من ملف اختبار".
const LOGICAL =
  V.meemIni + V.rehFin + V.hahMed + V.behMed + V.alefFin +
  " " +
  V.behIni + V.alefFin + V.lamIni + V.ainMed + V.alefFin + V.lamIni + V.meemFin +
  " " +
  V.meemIni + V.noonFin +
  " " +
  V.meemIni + V.lamMed + V.fehFin +
  " " +
  V.alefIso + V.khahIni + V.tehMed + V.behMed + V.alefFin + V.rehIso;

const VISUAL = [...LOGICAL].reverse().join("");

describe("normalizePdfArabic", () => {
  it("folds presentation forms to plain letters", () => {
    expect(normalizePdfArabic(LOGICAL)).toBe(
      "مرحبا بالعالم من ملف اختبار",
    );
  });

  it("reverses visual-order runs stored as presentation forms", () => {
    expect(normalizePdfArabic(VISUAL)).toBe(
      "مرحبا بالعالم من ملف اختبار",
    );
  });

  it("leaves logical-order text untouched besides NFKC", () => {
    expect(normalizePdfArabic("مرحبا بالعالم")).toBe("مرحبا بالعالم");
  });

  it("keeps surrounding punctuation and latin text", () => {
    expect(normalizePdfArabic(`(${VISUAL}) 2024`)).toBe(
      "(مرحبا بالعالم من ملف اختبار) 2024",
    );
  });
});
