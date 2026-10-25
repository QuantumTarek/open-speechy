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
    // A language switch that stalls takes seconds. A word before a period is
    // held a little longer for the pause, and the page is polled every 40 ms.
    expect(Math.max(...gaps)).toBeLessThan(400);
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

test("stops reading when its tab is reloaded or closed", async () => {
  test.skip(!existsSync(extensionPath), "Build the test extension first.");

  const userDataDir = await mkdtemp(join(tmpdir(), "open-speechy-leave-"));
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
    const worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    // Record what the offscreen session reports to the service worker.
    await worker.evaluate(() => {
      const scope = self as unknown as {
        sessionLog: Array<{ at: number; kind: string }>;
      };
      scope.sessionLog = [];
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type !== "offscreen/session-event") return;
        const { event } = message;
        scope.sessionLog.push({
          at: Date.now(),
          kind: event.type === "session/state" ? event.state : event.type,
        });
      });
    });
    const logSince = (since: number) =>
      worker.evaluate(
        (start) =>
          (
            self as unknown as { sessionLog: Array<{ at: number; kind: string }> }
          ).sessionLog
            .filter((entry) => entry.at >= start)
            .map((entry) => entry.kind),
        since,
      );

    for (const leave of ["reload", "close"] as const) {
      const page = await context.newPage();
      await page.goto("/en-article.html");
      await page.evaluate(() =>
        document.dispatchEvent(new Event("open-speechy-test-start")),
      );
      await expect
        .poll(() => page.evaluate(getCurrentWordText), { timeout: 10_000 })
        .not.toBe("");

      const left = await worker.evaluate(() => Date.now());
      if (leave === "reload") await page.reload();
      else await page.close();

      await expect
        .poll(() => logSince(left), { timeout: 5_000 })
        .toContain("idle");
      const stoppedAt = await worker.evaluate(() => Date.now());
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await logSince(stoppedAt)).not.toContain("session/sentence-start");
      if (leave === "reload") await page.close();
    }
  } finally {
    await context?.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("jumps back to the current word on a page that scrolls inside an element", async () => {
  test.skip(!existsSync(extensionPath), "Build the test extension first.");

  const userDataDir = await mkdtemp(join(tmpdir(), "open-speechy-jump-"));
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      viewport: { width: 1000, height: 700 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const page = await context.newPage();
    await page.goto("/scroll-container.html");
    await page.evaluate(() =>
      document.dispatchEvent(new Event("open-speechy-test-start")),
    );
    await expect
      .poll(() => page.evaluate(getCurrentWordText), { timeout: 10_000 })
      .not.toBe("");

    const wordTop = () =>
      page.evaluate(() => {
        let top = Number.NaN;
        CSS.highlights.get("os-word")?.forEach((range) => {
          if (Number.isNaN(top)) top = (range as Range).getBoundingClientRect().top;
        });
        return top;
      });
    await page.mouse.move(500, 400);
    await page.mouse.wheel(0, 2_000);
    await expect.poll(wordTop).toBeLessThan(0);

    const jump = page.locator("#open-speechy-player .player__jump");
    await expect(jump).toBeVisible();
    await jump.click();
    await expect.poll(wordTop, { timeout: 5_000 }).toBeGreaterThanOrEqual(0);
    expect(await wordTop()).toBeLessThan(700);
  } finally {
    await context?.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
