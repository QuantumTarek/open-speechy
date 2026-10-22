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
  const userDataDir = await mkdtemp(join(tmpdir(), "open-speechy-pdf-"));
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

async function collectHighlightedWords(
  page: import("@playwright/test").Page,
  count: number,
  timeoutMs = 12_000,
): Promise<string[]> {
  const observed: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && observed.length < count) {
    const word = await page.evaluate(currentWordText);
    if (word && observed[observed.length - 1] !== word) observed.push(word);
    await page.waitForTimeout(30);
  }
  return observed;
}

function currentWordText(): string {
  let text = "";
  CSS.highlights.get("os-word")?.forEach((range) => {
    text += range.toString();
  });
  return text;
}

test("opens a PDF in the viewer and reads it in column order", async () => {
  test.skip(!existsSync(extensionPath), "Build the test extension first.");

  const { context, extensionId, userDataDir } = await launchContext();
  try {
    const page = await context.newPage();
    const pdfUrl = `${fixtureBase}/sample-en.pdf`;
    await page.goto(
      `chrome-extension://${extensionId}/pdf-viewer.html?file=${encodeURIComponent(pdfUrl)}`,
    );
    await expect(page.locator(".pdf-page")).toHaveCount(2);
    await expect
      .poll(() => page.locator(".pdf-line").allTextContents())
      .toContainEqual(expect.stringContaining("first column"));

    // Running headers and page numbers are excluded from the readable DOM.
    const lineTexts = (await page.locator(".pdf-line").allTextContents()).join(
      "\n",
    );
    expect(lineTexts).not.toContain("Journal of Reading Tests");
    expect(lineTexts).not.toContain("\n1\n");

    // Line DOM order is the reading order: each page's left column comes
    // before its right column.
    const ordered = await page.locator(".pdf-line").allTextContents();
    const idx = (text: string) =>
      ordered.findIndex((line) => line.includes(text));
    expect(idx("the left where the first page ended.")).toBeGreaterThan(-1);
    expect(idx("The second column carries the rest.")).toBeGreaterThan(-1);
    expect(idx("the left where the first page ended.")).toBeLessThan(
      idx("The last column closes the document."),
    );
    expect(idx("and keeps the left column reading.")).toBeLessThan(
      idx("The second column carries the rest."),
    );

    await page.evaluate(() =>
      window.__OPEN_SPEECHY_TEST_HOOK__?.startRead(),
    );
    await expect(page.locator("#open-speechy-player")).toHaveCount(1);

    const observed = await collectHighlightedWords(page, 45, 20_000);
    // The hyphenated "sub-ject" is de-hyphenated into one spoken word whose
    // highlight ranges join to "subject". Early words may be missed when
    // sampling starts late, so check a mid-sequence word.
    expect(observed).toContain("subject");
    expect(observed.length).toBeGreaterThan(10);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("intercepts a .pdf navigation into the viewer", async () => {
  test.skip(!existsSync(extensionPath), "Build the test extension first.");

  const { context, extensionId, userDataDir } = await launchContext();
  try {
    // Wait for the declarativeNetRequest intercept rule to register.
    const worker = context.serviceWorkers()[0];
    await expect
      .poll(
        () =>
          worker.evaluate(() =>
            chrome.declarativeNetRequest
              .getDynamicRules()
              .then((rules) => rules.length),
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);

    const page = await context.newPage();
    await page.goto(`${fixtureBase}/sample-en.pdf`);
    await page.waitForURL(/pdf-viewer\.html/u, { timeout: 10_000 });
    expect(page.url()).toContain(`chrome-extension://${extensionId}`);
    await expect(page.locator(".pdf-page")).toHaveCount(2);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("normalizes visual-order Arabic PDF text", async () => {
  test.skip(!existsSync(extensionPath), "Build the test extension first.");

  const { context, extensionId, userDataDir } = await launchContext();
  try {
    const page = await context.newPage();
    const pdfUrl = `${fixtureBase}/sample-ar.pdf`;
    await page.goto(
      `chrome-extension://${extensionId}/pdf-viewer.html?file=${encodeURIComponent(pdfUrl)}`,
    );
    await expect(page.locator(".pdf-page")).toHaveCount(1);
    const lineTexts = (await page.locator(".pdf-line").allTextContents()).join(
      " ",
    );
    expect(lineTexts).toContain("مرحبا بالعالم");

    await page.evaluate(() =>
      window.__OPEN_SPEECHY_TEST_HOOK__?.startRead(),
    );
    await expect(page.locator("#open-speechy-player")).toHaveCount(1);

    const observed = await collectHighlightedWords(page, 5, 8_000);
    // Logical order after repair: مرحبا بالعالم من ملف اختبار.
    const expected = ["مرحبا", "بالعالم", "من", "ملف", "اختبار"];
    const order = expected.filter((word) => observed.includes(word));
    expect(order.length).toBeGreaterThanOrEqual(4);
    expect(observed[observed.length - 1]).toBe("اختبار");
    expect(
      expected.every(
        (word, index) =>
          index === 0 ||
          !observed.includes(word) ||
          observed.indexOf(word) >
            observed.indexOf(expected[index - 1]),
      ),
    ).toBe(true);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
