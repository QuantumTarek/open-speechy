import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";

type PopupAction = "popup/read-page" | "popup/read-selection";

function PopupPage() {
  const [busy, setBusy] = useState<PopupAction | null>(null);
  const [notice, setNotice] = useState("");

  async function read(action: PopupAction): Promise<void> {
    setBusy(action);
    setNotice("");
    try {
      const response = (await chrome.runtime.sendMessage({
        type: action,
      })) as { ok?: boolean; error?: string };
      if (!response.ok) throw new Error(response.error ?? "The reader could not start.");
      window.close();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Open Speechy could not read this page.",
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
          <p className="popup__eyebrow">OPEN SPEECHY</p>
          <h1>Read this page.</h1>
        </div>
      </header>
      <button
        className="popup__primary"
        type="button"
        disabled={busy !== null}
        onClick={() => void read("popup/read-page")}
      >
        {busy === "popup/read-page" ? "Preparing reader..." : "Read article"}
      </button>
      <button
        className="popup__secondary"
        type="button"
        disabled={busy !== null}
        onClick={() => void read("popup/read-selection")}
      >
        Read selected text
      </button>
      <button
        className="popup__settings"
        type="button"
        onClick={() => void chrome.runtime.openOptionsPage()}
      >
        Voices and settings <span aria-hidden="true">↗</span>
      </button>
      <p className="popup__notice" role="status" aria-live="polite">
        {notice}
      </p>
      <footer>Page text stays on this device.</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<PopupPage />);
