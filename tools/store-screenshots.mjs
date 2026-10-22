import { chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ext = resolve(process.cwd(), ".output/chrome-mv3");
const dir = await mkdtemp(join(tmpdir(), "os-shots-"));
const ctx = await chromium.launchPersistentContext(dir, {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let w = ctx.serviceWorkers()[0];
if (!w) w = await ctx.waitForEvent("serviceworker");
const id = new URL(w.url()).host;
const shot = async (url, name, w2 = 1280, h2 = 800) => {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: w2, height: h2 });
  await p.goto(url);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `store/screenshots/${name}.png` });
  await p.close();
};
await shot(`chrome-extension://${id}/options.html`, "options");
await shot(`chrome-extension://${id}/reader.html`, "reader");
await shot(`chrome-extension://${id}/pdf-viewer.html?file=${encodeURIComponent("http://127.0.0.1:4173/sample-en.pdf")}`, "pdf-viewer");
await shot("http://127.0.0.1:4173/en-article.html", "article");
await ctx.close(); await rm(dir, { recursive: true, force: true });
console.log("done");
