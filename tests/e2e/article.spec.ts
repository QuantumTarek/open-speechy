import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  expect,
  test,
  chromium,
  type BrowserContext,
} from "@playwright/test";

const extensionPath = resolve(process.cwd(), ".output/chrome-mv3-test");

test("reads an article with deterministic highlights and leaves its DOM intact", async () => {
  test.skip(!existsSync(extensionPath), "Build the test extension first.");

  const userDataDir = await mkdtemp(join(tmpdir(), "open-speechy-e2e-"));
  let context: BrowserContext | null = null;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const page = await context.newPage();
    await page.goto("/en-article.html");
    const article = page.locator("#article");
    const before = await article.innerHTML();

    await page.evaluate(() =>
      document.dispatchEvent(new Event("open-speechy-test-start")),
    );
    await expect(page.locator("#open-speechy-player")).toHaveCount(1);
    try {
      await page.waitForFunction(
        () => Boolean(CSS.highlights?.get("os-word")),
        undefined,
        { timeout: 10_000 },
      );
    } catch {
      const status = await page
        .locator("#open-speechy-player")
        .evaluate((host) => host.shadowRoot?.textContent ?? "");
      throw new Error(`No word highlight appeared. Player: ${status}`);
    }
    expect(await article.innerHTML()).toBe(before);

    const player = page.locator("#open-speechy-player");
    const firstWord = await page.evaluate(getCurrentWordText);
    expect(firstWord.length).toBeGreaterThan(0);

    await page.waitForFunction(
      (previousWord) => {
        let currentWord = "";
        CSS.highlights.get("os-word")?.forEach((range) => {
          if (!currentWord) currentWord = range.toString();
        });
        return currentWord.length > 0 && currentWord !== previousWord;
      },
      firstWord,
    );
    const targetWord = "page";
    const targetPoint = await page.evaluate((word) => {
      const article = document.querySelector("#article");
      if (!article) return null;
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode() as Text | null;
      while (node) {
        const start = node.data.indexOf(word);
        if (start >= 0) {
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + word.length);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        node = walker.nextNode() as Text | null;
      }
      return null;
    }, targetWord);
    expect(targetPoint).not.toBeNull();
    await page.mouse.click(targetPoint!.x, targetPoint!.y);
    await page.waitForFunction((word) => {
      let currentWord = "";
      CSS.highlights.get("os-word")?.forEach((range) => {
        if (!currentWord) currentWord = range.toString();
      });
      return currentWord === word;
    }, targetWord);
    await player.evaluate((host) => {
      host.shadowRoot
        ?.querySelector<HTMLButtonElement>('button[aria-label="Pause"]')
        ?.click();
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#open-speechy-player")
        ?.shadowRoot?.querySelector('button[aria-label="Play"]'),
    );
    const pausedWord = await page.evaluate(getCurrentWordText);
    await page.waitForTimeout(350);
    const stillPausedWord = await page.evaluate(getCurrentWordText);
    expect(stillPausedWord).toBe(pausedWord);
    expect(await article.innerHTML()).toBe(before);
  } finally {
    await context?.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

function getCurrentWordText(): string {
  let text = "";
  CSS.highlights.get("os-word")?.forEach((range) => {
    if (!text) text = range.toString();
  });
  return text;
}
