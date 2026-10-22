import "./pdf-viewer.css";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFPageProxy, PageViewport } from "pdfjs-dist";
import { ContentController } from "../../content/controller";
import { setDocumentLanguage, t } from "../../i18n";
import { isRuntimeMessage } from "../../messaging/protocol";
import { normalizePdfArabic } from "../../pdf/arabic";
import { buildBandCounts, buildPageLayout } from "../../pdf/document";
import type { PdfPageText, PdfTextItem } from "../../pdf/order";
import type { TextBlock } from "../../text/extract";

const SCALE = 1.5;

// pdf.js v5 needs Promise.withResolvers (Chrome 119+); keep a small
// polyfill so the viewer still works on Chrome 116–118.
const ResolversPromise = Promise as PromiseConstructor & {
  withResolvers?<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
};
if (typeof ResolversPromise.withResolvers !== "function") {
  ResolversPromise.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

setDocumentLanguage(document);

const statusElement = document.getElementById("pdf-status")!;
const titleElement = document.getElementById("pdf-title")!;
const readButton = document.getElementById("pdf-read")!;
const openInput = document.getElementById(
  "pdf-open-input",
) as HTMLInputElement;
const content = document.getElementById("pdf-content")!;

const controller = new ContentController(document, window);
let blocks: TextBlock[] = [];
let documentTitle = "PDF";

readButton.textContent = t("pdfRead", "Read");

function setStatus(message: string): void {
  statusElement.textContent = message;
}

async function ownTabId(): Promise<number | undefined> {
  try {
    return (await chrome.tabs.getCurrent())?.id;
  } catch {
    return undefined;
  }
}

void ownTabId().then((tabId) => {
  chrome.runtime.onMessage.addListener((message) => {
    if (
      isRuntimeMessage(message) &&
      "targetTabId" in message &&
      message.targetTabId === tabId &&
      (message.type === "session/event" ||
        message.type === "content/session-state")
    ) {
      controller.handleRuntimeMessage(message);
    }
  });
});

readButton.addEventListener("click", () => {
  if (blocks.length === 0) {
    setStatus(t("pdfNothingToRead", "Load a PDF first."));
    return;
  }
  void controller.readExtracted(blocks, documentTitle);
});

openInput.addEventListener("change", () => {
  const file = openInput.files?.[0];
  if (file) void loadFromData(file.arrayBuffer(), file.name);
});

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) void loadFromData(file.arrayBuffer(), file.name);
});

interface PageRender {
  section: HTMLElement;
  page: PDFPageProxy;
  viewport: PageViewport;
}

async function renderDocument(
  source: { url: string } | { data: ArrayBuffer },
  title: string,
): Promise<void> {
  setStatus(t("pdfLoading", "Loading PDF…"));
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const document_ = await pdfjs.getDocument(source).promise;
  documentTitle = title;
  titleElement.textContent = title;
  document.title = `${title} — Open Speechy`;
  content.querySelector("#pdf-empty")?.remove();
  content
    .querySelectorAll(".pdf-page")
    .forEach((element) => element.remove());

  const pageTexts: PdfPageText[] = [];
  const pageViews: { page: PDFPageProxy; viewport: PageViewport }[] = [];
  for (let index = 1; index <= document_.numPages; index += 1) {
    const page = await document_.getPage(index);
    const viewport = page.getViewport({ scale: SCALE });
    const text = await page.getTextContent();
    const items: PdfTextItem[] = [];
    for (const item of text.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const transform = pdfjs.Util.transform(
        viewport.transform,
        item.transform,
      );
      const height = Math.max(4, Math.hypot(transform[2], transform[3]));
      items.push({
        str: normalizePdfArabic(item.str),
        x: transform[4],
        y: transform[5] - height,
        width: item.width * viewport.scale,
        height,
      });
    }
    pageTexts.push({
      pageIndex: index - 1,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
      items,
    });
    pageViews.push({ page, viewport });
  }

  const bandCounts = buildBandCounts(pageTexts);
  const renders: PageRender[] = [];
  blocks = [];
  pageTexts.forEach((pageText, index) => {
    const { section, blocks: pageBlocks } = buildPageLayout(
      pageText,
      content,
      bandCounts,
      pageTexts.length,
    );
    renders.push({
      section,
      page: pageViews[index].page,
      viewport: pageViews[index].viewport,
    });
    blocks.push(...pageBlocks);
  });

  observePages(renders);
  setStatus("");

  if (
    typeof __OPEN_SPEECHY_FAKE_ENGINE__ !== "undefined" &&
    __OPEN_SPEECHY_FAKE_ENGINE__ &&
    window.__OPEN_SPEECHY_TEST_HOOK__
  ) {
    window.__OPEN_SPEECHY_TEST_HOOK__.startRead = () =>
      controller.readExtracted(blocks, documentTitle);
  }
}

function observePages(renders: PageRender[]): void {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = Number(
          (entry.target as HTMLElement).dataset.renderIndex,
        );
        observer.unobserve(entry.target);
        void renderPage(renders[index]);
      }
    },
    { rootMargin: "600px" },
  );
  renders.forEach((render, index) => {
    render.section.dataset.renderIndex = String(index);
    observer.observe(render.section);
  });
}

async function renderPage(render: PageRender): Promise<void> {
  const { section, page, viewport } = render;
  const pixelRatio = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width * pixelRatio);
  canvas.height = Math.round(viewport.height * pixelRatio);
  section.prepend(canvas);
  await page.render({
    canvas,
    viewport: page.getViewport({ scale: SCALE * pixelRatio }),
  }).promise;
}

async function loadFromData(
  data: Promise<ArrayBuffer> | ArrayBuffer,
  title: string,
): Promise<void> {
  try {
    await renderDocument({ data: await data }, title);
  } catch (error) {
    setStatus(
      error instanceof Error
        ? error.message
        : t("pdfLoadFailure", "Could not read this PDF."),
    );
  }
}

const fileParam = document.location.search
  .slice(1)
  .split("&")
  .find((part) => part.startsWith("file="));
if (fileParam) {
  const url = decodeURIComponent(fileParam.slice(5));
  const name = url.split("/").pop()?.split(/[?#]/u)[0] ?? url;
  renderDocument({ url }, name).catch((error: unknown) => {
    setStatus(
      url.startsWith("file:")
        ? t(
            "pdfFileAccessHint",
            "Could not open the file. Enable “Allow access to file URLs” for Open Speechy in chrome://extensions, then reload this tab.",
          )
        : error instanceof Error
          ? error.message
          : t("pdfLoadFailure", "Could not read this PDF."),
    );
  });
} else {
  setStatus(t("pdfNoSource", "No PDF was provided."));
}
