import { ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Lang, VoiceInfo } from "../../engines/types";
import { setDocumentLanguage, t } from "../../i18n";
import { DEFAULT_SETTINGS, SettingsStore } from "../../settings/store";
import "./popup.css";

type PopupAction =
  | "popup/read-page"
  | "popup/read-selection"
  | "popup/read-pdf"
  | "popup/read-document";

const PDF_URL = /^(?:https?|file|ftp):[^?#]*\.pdf(?:[?#]|$)/iu;
const GOOGLE_DOC_URL = /^https:\/\/docs\.google\.com\/document\/d\/[\w-]+/u;

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

const settingsStore = new SettingsStore();

const VOICE_LANGS: { lang: Lang; label: () => string }[] = [
  { lang: "en", label: () => t("languageEnglish", "English") },
  { lang: "ar", label: () => t("languageArabic", "Arabic") },
];

function groupLabel(voice: VoiceInfo): string {
  if (voice.engineId === "server") return t("voiceLocalServer", "Local server");
  if (voice.engineId === "system") return t("groupSystemVoices", "System voices");
  return t("voiceOnDevice", "On this device");
}

function VoicePicker(props: {
  lang: Lang;
  label: string;
  voices: VoiceInfo[];
  value: string;
  onChange: (voiceId: string) => void;
}) {
  const groups = new Map<string, VoiceInfo[]>();
  for (const voice of props.voices) {
    if (voice.lang !== props.lang) continue;
    const group = groupLabel(voice);
    groups.set(group, [...(groups.get(group) ?? []), voice]);
  }
  // Keep a saved voice selectable even if its source is offline right now.
  const known = props.value === "auto" || props.voices.some((v) => v.id === props.value);
  return (
    <label className="popup__voice">
      <span>{props.label}</span>
      <select
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <option value="auto">{t("automatic", "Automatic")}</option>
        {!known && <option value={props.value}>{props.value}</option>}
        {[...groups].map(([group, voices]) => (
          <optgroup key={group} label={group}>
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function PopupPage() {
  const [busy, setBusy] = useState<PopupAction | null>(null);
  const [notice, setNotice] = useState("");
  const [pdfTab, setPdfTab] = useState(false);
  const [docTab, setDocTab] = useState(false);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voicePrefs, setVoicePrefs] = useState(DEFAULT_SETTINGS.voice);

  useEffect(() => {
    void settingsStore.load().then((loaded) => setVoicePrefs(loaded.voice));
    void (
      chrome.runtime.sendMessage({ type: "voices/list" }) as Promise<{
        ok?: boolean;
        voices?: VoiceInfo[];
      }>
    )
      .then((response) => {
        if (response?.ok && response.voices) setVoices(response.voices);
      })
      .catch(() => undefined);
  }, []);

  async function selectVoice(lang: Lang, voiceId: string): Promise<void> {
    setVoicePrefs((current) => ({ ...current, [lang]: voiceId }));
    const updated = await settingsStore.update({ voice: { [lang]: voiceId } });
    setVoicePrefs(updated.voice);
  }

  useEffect(() => {
    void chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then(([tab]) => {
        setPdfTab(tabIsPdf(tab?.url));
        setDocTab(GOOGLE_DOC_URL.test(tab?.url ?? ""));
      });
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
        <img className="popup__mark" src="/icon/icon.svg" alt="" />
        <div>
          <p className="popup__eyebrow">{t("optionsKicker", "OPEN SPEECHY")}</p>
          <h1>{t("popupHeadline", "Read this page.")}</h1>
        </div>
      </header>
      <div className="popup__voices">
        {VOICE_LANGS.map(({ lang, label }) => (
          <VoicePicker
            key={lang}
            lang={lang}
            label={label()}
            voices={voices}
            value={voicePrefs[lang]}
            onChange={(voiceId) => void selectVoice(lang, voiceId)}
          />
        ))}
      </div>
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
      {docTab && (
        <button
          className="popup__secondary"
          type="button"
          disabled={busy !== null}
          onClick={() => void read("popup/read-document")}
        >
          {t("readThisDocument", "Read this document")}
        </button>
      )}
      <button
        className="popup__settings"
        type="button"
        onClick={() => void chrome.runtime.openOptionsPage()}
      >
        {t("voicesAndSettings", "Voices and settings")}{" "}
        <ArrowUpRight size={14} aria-hidden="true" />
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
