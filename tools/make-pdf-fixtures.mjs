// Generates tests/fixtures/sample-en.pdf and sample-ar.pdf.
// Hand-written minimal PDFs: no external dependencies.
//   node tools/make-pdf-fixtures.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outDir = resolve(process.cwd(), "tests/fixtures");

function escapeText(text) {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

// Renders one PDF buffer.
//   pages: array of content-stream strings
//   extraResources: additional /Resources dictionary body
function makePdf(pageStreams, fontBody, mediaBox = "[0 0 612 792]") {
  const objects = [];
  const pageIds = pageStreams.map((_, index) => index * 2 + 3);
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageStreams.length} >>`,
  );
  pageStreams.forEach((stream, index) => {
    const pageId = index * 2 + 3;
    const contentId = pageId + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} ` +
        `/Resources << /Font << /F1 ${pageIds.length * 2 + 3} 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>`,
    );
    objects.push(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  objects.push(fontBody);

  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

function textLine(x, y, text, fontSize = 11) {
  return `BT /F1 ${fontSize} Tf ${x} ${y} Td (${escapeText(text)}) Tj ET`;
}

// --- sample-en.pdf: two pages, two columns, running header, page numbers,
// a hyphenated word split across lines.

const headerY = 750;
const footerY = 28;
const leftX = 54;
const rightX = 330;

const page1 = [
  textLine(leftX, headerY, "Journal of Reading Tests", 12),
  textLine(leftX, 700, "The first column opens the story with"),
  textLine(leftX, 685, "a clear sentence that names its sub-"),
  textLine(leftX, 670, "ject before it continues further."),
  textLine(leftX, 645, "Another paragraph starts on the left"),
  textLine(leftX, 630, "and keeps the left column reading."),
  textLine(rightX, 700, "The second column carries the rest."),
  textLine(rightX, 685, "It finishes the argument cleanly."),
  textLine(306, footerY, "1", 10),
].join("\n");

const page2 = [
  textLine(leftX, headerY, "Journal of Reading Tests", 12),
  textLine(leftX, 700, "The second page resumes the story on"),
  textLine(leftX, 685, "the left where the first page ended."),
  textLine(rightX, 700, "The last column closes the document."),
  textLine(306, footerY, "2", 10),
].join("\n");

const simpleFont =
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

await mkdir(outDir, { recursive: true });
await writeFile(
  resolve(outDir, "sample-en.pdf"),
  makePdf([page1, page2], simpleFont),
);

// --- sample-ar.pdf: one page, Arabic stored in visual order with
// presentation-form glyph names (uniFExx) mapped through an Encoding
// Differences table. Logical text: "مرحبا بالعالم من ملف اختبار".

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

// Logical order string, shaped with presentation forms.
const logical =
  V.meemIni + V.rehFin + V.hahMed + V.behMed + V.alefFin +
  " " +
  V.behIni + V.alefFin + V.lamIni + V.ainMed + V.alefFin + V.lamIni + V.meemFin +
  " " +
  V.meemIni + V.noonFin +
  " " +
  V.meemIni + V.lamMed + V.fehFin +
  " " +
  V.alefIso + V.khahIni + V.tehMed + V.behMed + V.alefFin + V.rehIso;

// Visual order = full mirror of the logical codepoint sequence.
const visual = [...logical].reverse().join("");

// Encode every used presentation-form codepoint as bytes >= 0xA0 and map them
// through /Encoding /Differences with uniXXXX glyph names.
const usedChars = [...new Set([...visual])];
const byteFor = new Map(usedChars.map((char, index) => [char, 0xa0 + index]));
const encoded = [...visual]
  .map((char) => String.fromCharCode(byteFor.get(char)))
  .join("");
const names = usedChars
  .map((char) => `/uni${char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`)
  .join(" ");
const differenceTable = `[${0xa0} ${names}]`;

const arabicFont =
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica " +
  `/Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences ${differenceTable} >> >>`;

const arabicPage = [textLine(80, 700, encoded, 14)].join("\n");

await writeFile(
  resolve(outDir, "sample-ar.pdf"),
  makePdf([arabicPage], arabicFont),
);

console.log("Wrote sample-en.pdf and sample-ar.pdf to tests/fixtures");
