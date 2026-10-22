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
const fixtureBase = "http://127.0.0.1:4173";

async function launchContext(): Promise<{
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
}> {
  const userDataDir = await mkdtemp(join(tmpdir(), "open-speechy-reader-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  return {
    context,
    extensionId: new URL(worker.url()).host,
    userDataDir,
  };
}

function currentWordText(): string {
  let text = "";
  CSS.highlights.get("os-word")?.forEach((range) => {
    text += range.toString();
  });
  return text;
}

test("exports a Google Doc into the reader and reads it", async () => {
  test.skip(!existsSync(extensionPath), "Build the test extension first.");

  const { context, extensionId, userDataDir } = await launchContext();
  try {
    const docPage = await context.newPage();
    await docPage.goto(`${fixtureBase}/document/d/test-doc/edit`);

    const worker = context.serviceWorkers()[0];
    const readerTabPromise = context.waitForEvent("page");
    // The popup path forwards content/read-document to the tab; trigger it
    // the same way the background does.
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      return chrome.tabs.sendMessage(tab.id!, {
        type: "content/read-document",
        key: "e2e-doc",
      });
    });
    const readerTab = await readerTabPromise;
    await readerTab.waitForLoadState();
    expect(readerTab.url()).toContain(
      `chrome-extension://${extensionId}/reader.html`,
    );

    await expect(
      readerTab.locator(".reader-content article p").first(),
    ).toContainText("first exported paragraph");
    // Sanitized: no script or style content survives in the article.
    await expect(
      readerTab.locator(".reader-content article script"),
    ).toHaveCount(0);
    await expect(
      readerTab.locator(".reader-content article style"),
    ).toHaveCount(0);

    await readerTab.evaluate(() =>
      window.__OPEN_SPEECHY_TEST_HOOK__?.startRead(),
    );
    await expect(readerTab.locator("#open-speechy-player")).toHaveCount(1);
    const observed = new Set<string>();
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && observed.size < 18) {
      const word = await readerTab.evaluate(currentWordText);
      if (word) observed.add(word);
      await readerTab.waitForTimeout(40);
    }
    expect(
      ["exported", "paragraph", "second", "readable"].some((word) =>
        observed.has(word),
      ),
    ).toBe(true);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("reads pasted text in the reader", async () => {
  test.skip(!existsSync(extensionPath), "Build the test extension first.");

  const { context, extensionId, userDataDir } = await launchContext();
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/reader.html`);
    await page.fill("#reader-paste", "One two three. Four five six.");
    await page.click("#reader-paste-read");
    await expect(page.locator(".reader-content article p")).toHaveCount(1);
    await page.click("#reader-read");
    await expect(page.locator("#open-speechy-player")).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(currentWordText), { timeout: 8_000 })
      .not.toBe("");
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
