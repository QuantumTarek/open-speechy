// Renders the extension icons in public/icon/ from the SVG sources in
// tools/icons/. The toolbar sizes have their own pixel-aligned drawings;
// 48 and 128 scale the main one, and 128 keeps the 16 px transparent margin
// the Chrome Web Store asks for.
import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";

const source = async (name) =>
  `data:image/svg+xml;base64,${(await readFile(`tools/icons/${name}`)).toString("base64")}`;
const sizes = [
  { size: 16, file: "icon-16.svg", art: 16 },
  { size: 32, file: "icon-32.svg", art: 32 },
  { size: 48, file: "icon.svg", art: 48 },
  // The main drawing's square spans 120 of its 128 units; 96 px of art.
  { size: 128, file: "icon.svg", art: 102.4 },
];

await mkdir("public/icon", { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const { size, file, art } of sizes) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>body{margin:0;display:grid;place-items:center;width:${size}px;height:${size}px}</style>` +
      `<img src="${await source(file)}" width="${art}" height="${art}">`,
  );
  await page.locator("img").evaluate((image) => image.decode());
  await page.screenshot({ path: `public/icon/${size}.png`, omitBackground: true });
}
await browser.close();
console.log("Wrote public/icon/16.png, 32.png, 48.png and 128.png.");
