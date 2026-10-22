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

test("reads mixed Arabic and English runs without changing the article", async () => {
  test.skip(!existsSync(extensionPath), "Build the test extension first.");

  const userDataDir = await mkdtemp(join(tmpdir(), "open-speechy-mixed-"));
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
    await page.goto("/mixed.html");
    const article = page.locator("#article");
    const before = await article.innerHTML();
    await page.evaluate(() =>
      document.dispatchEvent(new Event("open-speechy-test-start")),
    );
    await expect(page.locator("#open-speechy-player")).toHaveCount(1);

    const observed = new Set<string>();
    const expected = ["تطبيق", "Open", "Speechy", "مرحبًا", "keeps"];
    const changeTimes: number[] = [];
    let previousWord = "";
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !expected.every((word) => observed.has(word))) {
      const current = await page.evaluate(getCurrentWordText);
      if (current) {
        observed.add(current);
        if (current !== previousWord) {
          previousWord = current;
          changeTimes.push(Date.now());
        }
      }
      await page.waitForTimeout(40);
    }

    expect(expected.every((word) => observed.has(word))).toBe(true);
    const gaps = changeTimes.slice(1).map((time, index) => time - changeTimes[index]);
    expect(Math.max(...gaps)).toBeLessThan(300);
    expect(await article.innerHTML()).toBe(before);
  } finally {
    await context?.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("offers a selection chip for long selections and starts reading it", async () => {
  test.skip(!existsSync(extensionPath), "Build the test extension first.");

  const userDataDir = await mkdtemp(join(tmpdir(), "open-speechy-selection-"));
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
    await page.evaluate(() => {
      const paragraph = document.querySelector("#article p");
      if (!paragraph) throw new Error("Fixture paragraph not found.");
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const chip = page.locator("[data-open-speechy-selection-chip]");
    await expect(chip).toHaveCount(1);
    await page.evaluate(() => {
      document
        .querySelector("[data-open-speechy-selection-chip]")
        ?.shadowRoot?.querySelector("button")
        ?.click();
    });
    await expect(page.locator("#open-speechy-player")).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(getCurrentWordText), { timeout: 5_000 })
      .not.toBe("");
    expect(await article.innerHTML()).toBe(before);
  } finally {
    await context?.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("reads a long selection from its floating chip", async () => {
  test.skip(!existsSync(extensionPath), "Build the test extension first.");

  const userDataDir = await mkdtemp(join(tmpdir(), "open-speechy-selection-"));
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
    await page.evaluate(() => {
      const paragraph = document.querySelector("#article p");
      if (!paragraph) throw new Error("Fixture paragraph not found.");
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await expect(
      page.locator("[data-open-speechy-selection-chip]"),
    ).toHaveCount(1);
    await page.evaluate(() => {
      document
        .querySelector("[data-open-speechy-selection-chip]")
        ?.shadowRoot?.querySelector("button")
        ?.click();
    });
    await expect(page.locator("#open-speechy-player")).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(getCurrentWordText), { timeout: 5_000 })
      .not.toBe("");
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
