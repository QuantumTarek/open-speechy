import "./reader.css";
import DOMPurify from "dompurify";
import { ContentController } from "../../content/controller";
import { setDocumentLanguage, t } from "../../i18n";
import { isRuntimeMessage } from "../../messaging/protocol";
import { extractTextBlocks, type TextBlock } from "../../text/extract";

setDocumentLanguage(document);

const statusElement = document.getElementById("reader-status")!;
const titleElement = document.getElementById("reader-title")!;
const readButton = document.getElementById("reader-read")!;
const pasteButton = document.getElementById("reader-paste-read")!;
const pasteArea = document.getElementById(
  "reader-paste",
) as HTMLTextAreaElement;
const content = document.getElementById("reader-content")!;

const controller = new ContentController(document, window);
let blocks: TextBlock[] = [];
let documentTitle = t("readerTitle", "Reader");

readButton.textContent = t("pdfRead", "Read");
pasteButton.textContent = t("readerPasteRead", "Read pasted text");
pasteArea.placeholder = t("readerPasteHint", "Paste text here…");

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
    setStatus(t("readerNothing", "Nothing to read yet."));
    return;
  }
  void controller.readExtracted(blocks, documentTitle);
});

pasteButton.addEventListener("click", () => {
  const text = pasteArea.value.trim();
  if (!text) return;
  loadText(text, t("readerPasted", "Pasted text"));
});

function setParagraphDirection(element: HTMLElement): void {
  element
    .querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote")
    .forEach((block) => {
      if (!block.getAttribute("dir")) block.setAttribute("dir", "auto");
    });
}

function loadHtml(html: string, title: string): void {
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "style",
      "script",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "iframe",
      "object",
      "embed",
      "link",
      "meta",
      "svg",
      "canvas",
      "img",
      "video",
      "audio",
    ],
    FORBID_ATTR: ["style", "class", "id", "onclick", "onerror"],
  });
  const article = document.createElement("article");
  article.innerHTML = clean;
  setParagraphDirection(article);
  content.querySelector("#reader-empty")?.remove();
  content.append(article);
  finishLoad(title);
}

function loadText(text: string, title: string): void {
  const article = document.createElement("article");
  for (const part of text.split(/\n{2,}/u)) {
    const paragraph = document.createElement("p");
    paragraph.dir = "auto";
    paragraph.textContent = part.trim();
    if (paragraph.textContent) article.append(paragraph);
  }
  if (!article.childElementCount) return;
  content.querySelector("#reader-empty")?.remove();
  content.append(article);
  finishLoad(title);
}

function finishLoad(title: string): void {
  documentTitle = title;
  titleElement.textContent = title;
  document.title = `${title} — Open Speechy`;
  blocks = extractTextBlocks(content, {});
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

const key = new URL(document.location.href).searchParams.get("key");
if (key) {
  void chrome.storage.session
    .get(`openSpeechyReader:${key}`)
    .then((stored) => {
      const entry = stored[`openSpeechyReader:${key}`] as
        | { html?: string; text?: string; title?: string; error?: string }
        | undefined;
      if (entry?.html) {
        loadHtml(entry.html, entry.title ?? documentTitle);
      } else if (entry?.text) {
        loadText(entry.text, entry.title ?? documentTitle);
      } else {
        setStatus(
          entry?.error ??
            t(
              "readerDocFallback",
              "This document could not be exported. Copy its text and paste it here to read it.",
            ),
        );
      }
    });
} else {
  setStatus(t("readerPastePrompt", "Paste text to read it aloud."));
}
