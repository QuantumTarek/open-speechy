import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { setDocumentLanguage, t } from "../../i18n";
import "./popup.css";

type PopupAction = "popup/read-page" | "popup/read-selection" | "popup/read-pdf";

const PDF_URL = /^(?:https?|file|ftp):[^?#]*\.pdf(?:[?#]|$)/iu;

function tabIsPdf(url: string | undefined): boolean {
  if (!url) return false;
  if (PDF_URL.test(url)) return true;
  if (url.startsWith("chrome-extension://")) {
    try {
      const source = new URL(url).searchParams.get("src");
      return Boolean(source && PDF_URL.test(source));
    } catch {
      return false;
    }
  }
  return false;
}

function PopupPage() {
  const [busy, setBusy] = useState<PopupAction | null>(null);
  const [notice, setNotice] = useState("");
  const [pdfTab, setPdfTab] = useState(false);

  useEffect(() => {
    void chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then(([tab]) => setPdfTab(tabIsPdf(tab?.url)));
  }, []);

  async function read(action: PopupAction): Promise<void> {
    setBusy(action);
    setNotice("");
    try {
      const response = (await chrome.runtime.sendMessage({
        type: action,
      })) as { ok?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(
          response.error ?? t("readerStartError", "The reader could not start."),
        );
      }
      window.close();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : t("restrictedPageError", "Open Speechy could not read this page."),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="popup">
      <header className="popup__header">
        <span className="popup__mark" aria-hidden="true">
          OS
        </span>
        <div>
          <p className="popup__eyebrow">{t("optionsKicker", "OPEN SPEECHY")}</p>
          <h1>{t("popupHeadline", "Read this page.")}</h1>
        </div>
      </header>
      <button
        className="popup__primary"
        type="button"
        disabled={busy !== null}
        onClick={() => void read("popup/read-page")}
      >
        {busy === "popup/read-page"
          ? t("preparingReader", "Preparing reader...")
          : t("readArticle", "Read article")}
      </button>
      <button
        className="popup__secondary"
        type="button"
        disabled={busy !== null}
        onClick={() => void read("popup/read-selection")}
      >
        {t("readSelectedText", "Read selected text")}
      </button>
      {pdfTab && (
        <button
          className="popup__secondary"
          type="button"
          disabled={busy !== null}
          onClick={() => void read("popup/read-pdf")}
        >
          {t("readThisPdf", "Read this PDF")}
        </button>
      )}
      <button
        className="popup__settings"
        type="button"
        onClick={() => void chrome.runtime.openOptionsPage()}
      >
        {t("voicesAndSettings", "Voices and settings")}{" "}
        <span aria-hidden="true">↗</span>
      </button>
      <p className="popup__notice" role="status" aria-live="polite">
        {notice}
      </p>
      <footer>{t("localPrivacy", "Page text stays on this device.")}</footer>
    </main>
  );
}

setDocumentLanguage(document);
createRoot(document.getElementById("root")!).render(<PopupPage />);
