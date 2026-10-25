import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { createRoot } from "react-dom/client";
import type { Lang, VoiceInfo } from "../../engines/types";
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  type AppSettings,
  type SettingsPatch,
} from "../../settings/store";
import {
  normalizeServerUrl,
  serverUpdateAvailable,
  type ServerModel,
} from "../../engines/server";
import type { ServerState } from "../../engines/server-connection";
import { voiceGender, type VoiceGender } from "../../engines/voice-catalog";
import { MODEL_CATALOG, MODEL_DESCRIPTORS } from "../../models/catalog";
import { ModelManager, type ModelProgress } from "../../models/manager";
import type { RuntimeMessage } from "../../messaging/protocol";
import type { SessionState } from "../../playback/session";
import { formatSpeed } from "../../ui/speed";
import { setDocumentLanguage, t } from "../../i18n";
import "./options.css";

interface VoiceListResponse {
  ok?: boolean;
  voices?: VoiceInfo[];
  // The voice "Automatic" picks for each language.
  automatic?: Partial<Record<Lang, string>>;
  error?: string;
}

interface ServerStateResponse {
  ok?: boolean;
  state?: ServerState;
  error?: string;
}

interface ServerModelsResponse {
  ok?: boolean;
  models?: ServerModel[] | null;
  freedBytes?: number;
  error?: string;
}

interface AuditionStatus {
  voiceId: string;
  // First-use download progress from 0 to 1, or null when not downloading.
  progress: number | null;
  state: SessionState | null;
}

const settingsStore = new SettingsStore();
const modelManager = new ModelManager(MODEL_DESCRIPTORS);

interface ModelViewState {
  phase: "idle" | "checking" | "downloading" | "ready" | "error";
  loaded: number;
  total: number;
  error?: string;
}

const SYSTEM_VOICE_PREVIEW = 6;

const QUALITY_RANK: Record<VoiceInfo["quality"], number> = {
  premium: 0,
  enhanced: 1,
  standard: 2,
  compact: 3,
};

type GenderFilter = "all" | VoiceGender;

// Voices whose gender is unknown are listed only under "All".
function matchesGender(voice: VoiceInfo, filter: GenderFilter): boolean {
  return filter === "all" || voiceGender(voice) === filter;
}

function auditionGroups(voices: VoiceInfo[], lang: Lang, gender: GenderFilter) {
  const forLang = voices.filter(
    (voice) => voice.lang === lang && matchesGender(voice, gender),
  );
  return [
    {
      id: "local",
      title: t("groupOnDevice", "On-device models"),
      hint: t(
        "groupOnDeviceHint",
        "Natural voices that run in the browser. Each downloads once.",
      ),
      voices: forLang.filter(
        (voice) => voice.engineId === "kokoro" || voice.engineId === "piper",
      ),
    },
    {
      id: "server",
      title: t("voiceLocalServer", "Local server"),
      hint: t(
        "groupServerHint",
        "Larger models served by the companion app on this Mac.",
      ),
      voices: forLang.filter((voice) => voice.engineId === "server"),
    },
    {
      id: "system",
      title: t("groupSystemVoices", "System voices"),
      hint: t(
        "groupSystemHint",
        "Built into your operating system. Instant, with exact word timing.",
      ),
      voices: forLang
        .filter((voice) => voice.engineId === "system")
        .sort(
          (a, b) =>
            QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality] ||
            a.name.localeCompare(b.name),
        ),
    },
  ].filter((group) => group.voices.length > 0);
}

function voiceSource(voice: VoiceInfo): string {
  if (voice.engineId === "system") return t("sourceSystem", "System voice");
  if (voice.engineId === "server") return t("voiceLocalServer", "Local server");
  return t("sourceBrowser", "In this browser");
}

function voiceDetail(voice: VoiceInfo): string {
  if (voice.description) return voice.description;
  if (voice.engineId === "server") return t("voiceLocalServer", "Local server");
  return voice.supportsWordTimings
    ? t("wordEvents", "word events")
    : t("systemVoice", "System voice");
}

function auditionLabel(voice: VoiceInfo, status: AuditionStatus | null): string {
  if (status?.voiceId === voice.id && status.progress !== null) {
    return t("auditionDownloading", `Downloading ${Math.round(status.progress * 100)}%`, [
      String(Math.round(status.progress * 100)),
    ]);
  }
  if (voice.engineId === "system" || status?.state === "playing") {
    return t("auditionPlaying", "Playing");
  }
  return t("auditionPreparing", "Preparing...");
}

interface ModelRowProps {
  title: string;
  details: string[];
  phase: "checking" | "missing" | "downloading" | "preparing" | "ready" | "error";
  // Shown in the badge for a ready model: "Ready", "Loaded" or "Downloaded".
  readyLabel?: string;
  loaded?: number;
  total?: number;
  error?: string;
  onDownload(): void;
  onRemove(): void;
}

function ModelRow(props: ModelRowProps) {
  const { phase } = props;
  const percentage =
    props.total && props.total > 0
      ? Math.min(100, Math.floor(((props.loaded ?? 0) / props.total) * 100))
      : 0;
  const badge =
    phase === "ready"
      ? props.readyLabel ?? t("modelReady", "Ready")
      : phase === "downloading"
        ? `${percentage}%`
        : phase === "preparing"
          ? t("modelPreparing", "Preparing")
          : phase === "error"
            ? t("error", "Error")
            : phase === "checking"
              ? t("modelChecking", "Checking")
              : t("modelNotDownloaded", "Not downloaded");
  const busy = phase === "downloading" || phase === "preparing";
  return (
    <article className="model-row">
      <div className="model-row__copy">
        <div className="model-row__title">
          <strong>{props.title}</strong>
          <span
            className={`model-state model-state--${busy ? "downloading" : phase}`}
          >
            {badge}
          </span>
        </div>
        {props.details.map((detail) => (
          <p key={detail}>{detail}</p>
        ))}
        {props.error && <p className="model-error">{props.error}</p>}
        {phase === "downloading" && (
          <progress max={props.total} value={props.loaded} />
        )}
      </div>
      <button
        type="button"
        className={phase === "ready" ? "button-quiet" : undefined}
        disabled={busy || phase === "checking"}
        onClick={phase === "ready" ? props.onRemove : props.onDownload}
      >
        {phase === "downloading"
          ? t("downloading", "Downloading...")
          : phase === "preparing"
            ? t("preparing", "Preparing...")
            : phase === "ready"
              ? t("remove", "Remove")
              : phase === "error"
                ? t("retry", "Retry")
                : t("download", "Download")}
      </button>
    </article>
  );
}

function serverModelTitle(model: ServerModel): string {
  if (model.kind === "aligner") return t("alignerModel", "Word timing aligner");
  return model.name;
}

function serverModelPhase(model: ServerModel): ModelRowProps["phase"] {
  if (model.state === "loaded" || model.state === "downloaded") return "ready";
  if (model.state === "downloading") return "downloading";
  if (model.state === "loading") return "preparing";
  return model.state;
}

function ServerStatus(props: {
  state: ServerState | null;
  action: "start" | "stop" | null;
  voiceCount: number;
  onStart(): void;
  onStop(): void;
}) {
  const { state, action } = props;
  let tone: "off" | "on" | "warn" = "off";
  let title: string;
  let detail: string;
  if (action) {
    title =
      action === "start"
        ? t("serverStarting", "Starting the server...")
        : t("serverStopping", "Stopping the server...");
    detail = t("serverWait", "This can take a few seconds.");
  } else if (!state) {
    title = t("serverChecking", "Checking the local server...");
    detail = "";
  } else if (state.running) {
    title = state.version
      ? t("serverRunningVersion", `Running · version ${state.version}`, [
          state.version,
        ])
      : t("serverRunning", "Running");
    if (state.connected) {
      tone = "on";
      detail = t("serverConnected", `Connected · ${props.voiceCount} voices`, [
        String(props.voiceCount),
      ]);
    } else {
      tone = "warn";
      detail = !state.enabled
        ? t("serverOffSetting", "Turn on “Use the local server” to use its voices.")
        : state.helper
          ? t(
              "serverConnectFailed",
              "The extension could not connect. Run the installer again.",
            )
          : t("serverNeedsPairing", "Pair it with a code below to use its voices.");
    }
    if (state.version && serverUpdateAvailable(state.version)) {
      detail = `${detail} ${t(
        "serverUpdate",
        "Server update available. Run the latest installer to update.",
      )}`;
    }
  } else if (state.helper) {
    title = t("serverStopped", "Stopped");
    detail = state.canManage
      ? t(
          "serverStoppedDetail",
          "Start it to use server voices. It stays off until you start it.",
        )
      : t(
          "serverServiceMissing",
          "The server service is missing. Run the installer again.",
        );
  } else {
    title = t("serverNotFound", "Not installed");
    detail = t(
      "serverNotFoundDetail",
      "Run ./server/install.sh from the Open Speechy folder, then come back to this page.",
    );
  }
  if (state?.error && !action) detail = state.error;

  return (
    <div className="server-status" data-tone={tone} aria-live="polite">
      <span className="server-light" aria-hidden="true" />
      <div className="server-status__text">
        <strong>{title}</strong>
        {detail && <p>{detail}</p>}
      </div>
      {state?.helper && state.canManage && (
        <div className="server-status__actions">
          {state.running ? (
            <button
              type="button"
              className="button-quiet"
              disabled={action !== null}
              onClick={props.onStop}
            >
              {t("stopServer", "Stop")}
            </button>
          ) : (
            <button
              type="button"
              disabled={action !== null}
              onClick={props.onStart}
            >
              {t("startServer", "Start")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function OptionsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [automatic, setAutomatic] = useState<Partial<Record<Lang, string>>>({});
  const [notice, setNotice] = useState("");
  const [modelNotice, setModelNotice] = useState("");
  const [auditioning, setAuditioning] = useState<string | null>(null);
  const [auditionLang, setAuditionLang] = useState<Lang>("en");
  const [genderFilter, setGenderFilter] = useState<GenderFilter>("all");
  const [showAllSystemVoices, setShowAllSystemVoices] = useState(false);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SETTINGS.server.url);
  const [pairCode, setPairCode] = useState("");
  const [serverBusy, setServerBusy] = useState(false);
  const [serverState, setServerState] = useState<ServerState | null>(null);
  const [serverAction, setServerAction] = useState<"start" | "stop" | null>(
    null,
  );
  const [modelStates, setModelStates] = useState<Record<string, ModelViewState>>(
    {},
  );
  const [auditionStatus, setAuditionStatus] = useState<AuditionStatus | null>(
    null,
  );
  // Null until known, or when the server is too old to list its models.
  const [serverModels, setServerModels] = useState<ServerModel[] | null>(null);

  async function refreshModels(): Promise<void> {
    const states = await Promise.all(
      MODEL_CATALOG.map(async (model) => {
        try {
          const installed = await modelManager.isInstalled(model.id);
          return [
            model.id,
            {
              phase: installed ? "ready" : "idle",
              loaded: installed ? model.bytes : 0,
              total: model.bytes,
            },
          ] as const;
        } catch {
          return [
            model.id,
            {
              phase: "idle",
              loaded: 0,
              total: model.bytes,
            },
          ] as const;
        }
      }),
    );
    setModelStates(Object.fromEntries(states));
  }

  async function downloadModel(modelId: string): Promise<void> {
    setModelStates((current) => ({
      ...current,
      [modelId]: {
        phase: "downloading",
        loaded: 0,
        total: MODEL_CATALOG.find((model) => model.id === modelId)?.bytes ?? 0,
      },
    }));
    try {
      await modelManager.download(modelId, (progress: ModelProgress) => {
        setModelStates((current) => ({
          ...current,
          [modelId]: {
            phase: "downloading",
            loaded: progress.loaded,
            total: progress.total,
          },
        }));
      });
      await refreshModels();
      setModelNotice(t("modelVerified", "Model verified and ready."));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Model download failed.";
      setModelStates((current) => ({
        ...current,
        [modelId]: {
          phase: "error",
          loaded: 0,
          total: current[modelId]?.total ?? 0,
          error: message,
        },
      }));
      setModelNotice(message);
    }
  }

  async function deleteModel(modelId: string): Promise<void> {
    const modelIds =
      modelId === "kokoro-en-q8"
        ? MODEL_DESCRIPTORS.filter(
            (model) =>
              model.id === modelId || model.id.startsWith("kokoro-voice-"),
          ).map((model) => model.id)
        : [modelId];
    await Promise.all(modelIds.map((id) => modelManager.remove(id)));
    await refreshModels();
    setModelNotice(t("modelRemoved", "Model files removed from this device."));
  }

  async function refreshServerModels(): Promise<void> {
    const response = (await chrome.runtime.sendMessage({
      type: "server/models",
    } satisfies RuntimeMessage)) as ServerModelsResponse;
    if (!response.ok) throw new Error(response.error);
    setServerModels(response.models ?? null);
  }

  async function manageServerModel(
    model: ServerModel,
    action: "prepare" | "remove",
  ): Promise<void> {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: action === "prepare" ? "server/model-prepare" : "server/model-remove",
        modelId: model.id,
      } satisfies RuntimeMessage)) as ServerModelsResponse;
      if (!response.ok) {
        throw new Error(
          response.error ?? t("serverModelFailure", "The server could not do that."),
        );
      }
      setServerModels(response.models ?? null);
      if (action === "remove") {
        setModelNotice(
          t("serverModelRemoved", `${serverModelTitle(model)} removed.`, [
            serverModelTitle(model),
            formatBytes(response.freedBytes ?? 0),
          ]),
        );
        // Removing a voice model changes which voices are ready to play.
        void refreshVoices().catch(() => {});
      }
    } catch (error) {
      setModelNotice(
        error instanceof Error
          ? error.message
          : t("serverModelFailure", "The server could not do that."),
      );
    }
  }

  useEffect(() => {
    setDocumentLanguage(document);
    void Promise.all([
      settingsStore.load(),
      chrome.runtime.sendMessage({ type: "voices/list" }) as Promise<
        VoiceListResponse
      >,
    ])
      .then(([loaded, response]) => {
        setSettings(loaded);
        setServerUrl(loaded.server.url);
        if (response.ok && response.voices) applyVoiceList(response);
        else setNotice(response.error ?? t("voiceDiscoveryFailed", "Voice discovery failed."));
        void refreshModels();
      })
      .catch((error: unknown) => {
        setNotice(
          error instanceof Error
            ? error.message
            : t("settingsLoadFailure", "Settings could not load."),
        );
      });
    // The installer may run while this page is open, and the service worker
    // saves the token when it connects on its own.
    const onFocus = () => void refreshServerState();
    onFocus();
    const onStorage = (_changes: unknown, area: string) => {
      if (area === "local" || area === "sync") {
        void settingsStore.load().then(setSettings);
      }
    };
    const onMessage = (value: unknown) => {
      const message = value as RuntimeMessage;
      if (message?.type !== "voice/audition-status") return;
      setAuditionStatus((current) => ({
        voiceId: message.voiceId,
        progress: message.progress ?? null,
        state: message.state ?? current?.state ?? null,
      }));
    };
    window.addEventListener("focus", onFocus);
    chrome.storage.onChanged.addListener(onStorage);
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      window.removeEventListener("focus", onFocus);
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  function applyVoiceList(response: VoiceListResponse): void {
    setVoices(response.voices ?? []);
    setAutomatic(response.automatic ?? {});
  }

  async function selectVoice(lang: Lang, voiceId: string): Promise<void> {
    const updated = await settingsStore.update({ voice: { [lang]: voiceId } });
    setSettings(updated);
    setNotice(t("voiceSaved", "Voice preference saved."));
  }

  async function audition(voice: VoiceInfo): Promise<void> {
    setAuditioning(voice.id);
    setAuditionStatus(null);
    setNotice("");
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "voice/audition",
        voiceId: voice.id,
      })) as { ok?: boolean; error?: string };
      setNotice(
        response.ok
          ? t("sampleFinished", "$1 sample finished.", [voice.name])
          : response.error ?? t("auditionFailure", "Voice audition failed."),
      );
      if (response.ok && !voice.installed) {
        const refreshed = (await chrome.runtime.sendMessage({
          type: "voices/list",
        })) as VoiceListResponse;
        if (refreshed.ok && refreshed.voices) applyVoiceList(refreshed);
        void refreshModels();
      }
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : t("auditionFailure", "Voice audition failed."),
      );
    } finally {
      setAuditioning(null);
      setAuditionStatus(null);
      if (voice.engineId === "server") void refreshServerModels().catch(() => {});
    }
  }

  async function pairServer(): Promise<void> {
    setServerBusy(true);
    setNotice(t("serverPairing", "Connecting to the loopback server..."));
    try {
      const url = normalizeServerUrl(serverUrl);
      const response = await fetch(`${url}/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairCode.trim() }),
      });
      const result = (await response.json()) as {
        token?: string;
        detail?: string;
      };
      if (!response.ok || !result.token) {
        throw new Error(result.detail ?? "Pairing failed. Check the code.");
      }
      const updated = await settingsStore.update({
        server: { enabled: true, url, token: result.token },
      });
      setSettings(updated);
      setPairCode("");
      await refreshServerState();
      setNotice(t("serverPaired", "Paired on this device."));
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : t("pairFailure", "Could not pair the server."),
      );
    } finally {
      setServerBusy(false);
    }
  }

  async function refreshServerState(): Promise<void> {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "server/state",
      })) as ServerStateResponse;
      if (!response.ok || !response.state) {
        throw new Error(
          response.error ??
            t("serverStateFailure", "Could not check the local server."),
        );
      }
      setServerState(response.state);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : t("serverStateFailure", "Could not check the local server."),
      );
    }
  }

  async function controlServer(action: "start" | "stop"): Promise<void> {
    setServerAction(action);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: action === "start" ? "server/start" : "server/stop",
      })) as ServerStateResponse;
      if (!response.ok || !response.state) {
        throw new Error(
          response.error ??
            t("serverStateFailure", "Could not check the local server."),
        );
      }
      setServerState(response.state);
      if (action === "start" && !response.state.running) {
        setNotice(
          t(
            "serverStartSlow",
            "The server has not answered yet. It may still be starting.",
          ),
        );
      }
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : t("serverStateFailure", "Could not check the local server."),
      );
    } finally {
      setServerAction(null);
    }
  }

  // Server voices and models come and go with the connection.
  const serverConnected = serverState?.connected ?? null;
  useEffect(() => {
    if (serverConnected === null) return;
    void refreshVoices().catch(() => {});
    if (serverConnected) void refreshServerModels().catch(() => {});
    else setServerModels(null);
  }, [serverConnected]);

  // Follow a server download until it finishes.
  const serverModelBusy = Boolean(
    serverModels?.some(
      (model) => model.state === "downloading" || model.state === "loading",
    ),
  );
  useEffect(() => {
    if (!serverModelBusy) return;
    const timer = setInterval(() => {
      void refreshServerModels().catch(() => {});
    }, 1_000);
    return () => clearInterval(timer);
  }, [serverModelBusy]);

  async function refreshVoices(): Promise<void> {
    const response = (await chrome.runtime.sendMessage({
      type: "voices/list",
    })) as VoiceListResponse;
    if (response.ok && response.voices) {
      setVoices(response.voices);
      setAutomatic(response.automatic ?? {});
    } else {
      throw new Error(
        response.error ?? t("refreshVoicesFailure", "Could not refresh voices."),
      );
    }
  }

  async function saveSettings(patch: SettingsPatch): Promise<void> {
    const updated = await settingsStore.update(patch);
    setSettings(updated);
      setNotice(t("preferencesSaved", "Preferences saved."));
  }

  return (
    <main className="options">
      <header className="masthead">
        <div>
          <p className="kicker">
            {t("optionsKicker", "OPEN SPEECHY / LOCAL AUDIO")}
          </p>
          <h1>{t("optionsTitle", "Voices, tuned to you.")}</h1>
          <p className="lede">
            {t(
              "optionsLede",
              "Choose a voice for each language. Page text stays in this browser; system voices and installed models do the talking.",
            )}
          </p>
        </div>
        <img className="seal" src="/icon/icon.svg" alt="" />
      </header>

      <section className="section" aria-labelledby="voice-heading">
        <div className="section__heading">
          <span className="section__number">01</span>
          <div>
            <h2 id="voice-heading">
              {t("voicePreference", "Voice preference")}
            </h2>
            <p>
              {t(
                "autoVoiceHelp",
                "Automatic picks the best voice you have: a Premium or Enhanced system voice first, then the local server, then a voice that runs in this browser.",
              )}
            </p>
          </div>
        </div>

        <div className="language-grid">
          {(["en", "ar"] as const).map((lang) => {
            const automaticVoice = voices.find(
              (voice) => voice.id === automatic[lang],
            );
            return (
              <label className="language-card" key={lang}>
                <span className="language-card__lang">
                  {lang === "en"
                    ? t("languageEnglish", "English")
                    : t("languageArabic", "Arabic")}
                </span>
                <select
                  value={settings.voice[lang]}
                  aria-label={`${lang === "en" ? t("languageEnglish", "English") : t("languageArabic", "Arabic")} ${t("voice", "voice")}`}
                  onChange={(event) =>
                    void selectVoice(lang, event.currentTarget.value)
                  }
                >
                  <option value="auto">
                    {t("automatic", "Automatic")}
                    {automaticVoice ? ` · ${automaticVoice.name}` : ""}
                  </option>
                  {voices
                    .filter((voice) => voice.lang === lang)
                    .map((voice) => (
                      <option value={voice.id} key={voice.id}>
                        {voice.name} · {voiceDetail(voice)}
                        {!voice.installed
                          ? ` · ${t("modelNotInstalled", "downloads on first use")}`
                          : ""}
                      </option>
                    ))}
                </select>
                {settings.voice[lang] === "auto" && automaticVoice && (
                  <small className="language-card__auto">
                    {t(
                      "automaticUsing",
                      `Automatic is using ${automaticVoice.name} · ${voiceSource(automaticVoice)}`,
                      [automaticVoice.name, voiceSource(automaticVoice)],
                    )}
                  </small>
                )}
              </label>
            );
          })}
        </div>

        <aside className="help-note">
          <strong>{t("macOS", "On macOS")}</strong>
          <p>
            {t(
              "macVoiceHelp",
              "For a higher-quality system voice, open System Settings → Accessibility → Spoken Content → System Voice → Manage Voices. Download a Premium English voice or an Enhanced Arabic voice, then restart Chrome. Siri voices are not exposed to Chrome.",
            )}
          </p>
        </aside>
      </section>

      <section className="section" aria-labelledby="audition-heading">
        <div className="section__heading">
          <span className="section__number">02</span>
          <div>
            <h2 id="audition-heading">
              {t("auditionVoices", "Audition voices")}
            </h2>
            <p>
              {t(
                "auditionHelp",
                "Play a short sample of any voice. On-device voices download the first time you play them.",
              )}
            </p>
          </div>
        </div>

        <div className="audition-filters">
          <div
            className="segmented"
            role="tablist"
            aria-label={t("auditionLanguage", "Voice language")}
          >
            {(["en", "ar"] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                role="tab"
                aria-selected={auditionLang === lang}
                onClick={() => setAuditionLang(lang)}
              >
                {lang === "en"
                  ? t("languageEnglish", "English")
                  : t("languageArabic", "Arabic")}
                <span className="segmented__count">
                  {
                    voices.filter(
                      (voice) =>
                        voice.lang === lang && matchesGender(voice, genderFilter),
                    ).length
                  }
                </span>
              </button>
            ))}
          </div>
          <div
            className="segmented"
            role="group"
            aria-label={t("auditionGender", "Voice gender")}
          >
            {(
              [
                ["all", t("genderAll", "All")],
                ["female", t("genderFemale", "Female")],
                ["male", t("genderMale", "Male")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={genderFilter === value}
                onClick={() => setGenderFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {auditionGroups(voices, auditionLang, genderFilter).map((group) => {
          const limited =
            group.id === "system" && !showAllSystemVoices
              ? group.voices.slice(0, SYSTEM_VOICE_PREVIEW)
              : group.voices;
          return (
            <div className="voice-group" key={group.id}>
              <div className="voice-group__heading">
                <h3>{group.title}</h3>
                <span>{group.hint}</span>
              </div>
              <div className="voice-grid">
                {limited.map((voice) => {
                  const active = auditioning === voice.id;
                  const progress =
                    active && auditionStatus?.voiceId === voice.id
                      ? auditionStatus.progress
                      : null;
                  return (
                    <article
                      className="voice-card"
                      key={voice.id}
                      data-active={active}
                    >
                      <div className="voice-card__copy">
                        <div className="voice-card__title">
                          <strong>{voice.name}</strong>
                          {voice.quality !== "standard" && (
                            <span className={`badge badge--${voice.quality}`}>
                              {voice.quality}
                            </span>
                          )}
                        </div>
                        <p aria-live={active ? "polite" : undefined}>
                          {active
                            ? auditionLabel(voice, auditionStatus)
                            : voiceDetail(voice)}
                        </p>
                      </div>
                      {progress !== null && (
                        <span
                          className="voice-card__progress"
                          style={{ width: `${progress * 100}%` }}
                          aria-hidden="true"
                        />
                      )}
                      <button
                        type="button"
                        className="voice-card__play"
                        aria-label={`${t("playSample", "Play sample")}: ${voice.name}`}
                        title={
                          voice.engineId !== "system" && !voice.installed
                            ? t("downloadAndPlay", "Download and play sample") +
                              (voice.sizeBytes
                                ? ` (${formatBytes(voice.sizeBytes)})`
                                : "")
                            : t("playSample", "Play sample")
                        }
                        disabled={auditioning !== null}
                        data-playing={auditioning === voice.id}
                        onClick={() => void audition(voice)}
                      >
                        <Play fill="currentColor" aria-hidden="true" />
                      </button>
                    </article>
                  );
                })}
              </div>
              {group.id === "system" &&
                group.voices.length > SYSTEM_VOICE_PREVIEW && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setShowAllSystemVoices((value) => !value)}
                  >
                    {showAllSystemVoices
                      ? t("showFewerVoices", "Show fewer")
                      : t("showAllVoices", "Show all $1", [
                          String(group.voices.length),
                        ])}
                  </button>
                )}
            </div>
          );
        })}
        {voices.length === 0 ? (
          <p className="empty-state">
            {t("noVoices", "No voices were reported by Chrome.")}
          </p>
        ) : (
          auditionGroups(voices, auditionLang, genderFilter).length === 0 && (
            <p className="empty-state">
              {t("noFilteredVoices", "No voices match this filter.")}
            </p>
          )
        )}
        <p className="notice" role="status" aria-live="polite">
          {notice}
        </p>
      </section>

      <section className="section" aria-labelledby="server-heading">
        <div className="section__heading">
          <span className="section__number">03</span>
          <div>
            <h2 id="server-heading">
              {t("serverHeading", "Local companion server")}
            </h2>
            <p>
              {t(
                "serverDescription",
                "Optional voice processing stays on 127.0.0.1.",
              )}
            </p>
          </div>
        </div>

        <div className="server-panel">
          <label className="setting-row setting-row--compact">
            <span>
              <strong>{t("serverUse", "Use the local server")}</strong>
              <small>
                {t(
                  "serverUseHelp",
                  "Disable this to use only browser and system voices.",
                )}
              </small>
            </span>
            <input
              type="checkbox"
              checked={settings.server.enabled}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                void saveSettings({ server: { enabled } }).then(() =>
                  refreshServerState(),
                );
              }}
            />
          </label>

          <ServerStatus
            state={serverState}
            action={serverAction}
            voiceCount={
              voices.filter((voice) => voice.engineId === "server").length
            }
            onStart={() => void controlServer("start")}
            onStop={() => void controlServer("stop")}
          />

          {serverState && !serverState.helper && (
            <details className="server-manual" open={serverState.running}>
              <summary>{t("pairManually", "Pair with a code")}</summary>
              <p className="server-footnote">
                {t(
                  "pairCodeHelp",
                  "Open the local pairing page, then enter its one-time code.",
                )}
              </p>
              <label className="server-field">
                <span>{t("serverAddress", "Server address")}</span>
                <input
                  value={serverUrl}
                  spellCheck={false}
                  onChange={(event) => setServerUrl(event.currentTarget.value)}
                />
              </label>
              <div className="pair-row">
                <a
                  href="http://127.0.0.1:5123/pair"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("openPairing", "Open pairing page")}
                </a>
                <label className="server-field">
                  <span>{t("oneTimeCode", "One-time code")}</span>
                  <input
                    inputMode="numeric"
                    maxLength={6}
                    value={pairCode}
                    onChange={(event) => setPairCode(event.currentTarget.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={serverBusy || pairCode.trim().length !== 6}
                  onClick={() => void pairServer()}
                >
                  {serverBusy
                    ? t("connecting", "Connecting...")
                    : t("pairServer", "Pair server")}
                </button>
              </div>
            </details>
          )}

          <p className="server-footnote">
            {t(
              "serverFootnote",
              "The server listens only on 127.0.0.1 and answers this extension. Models download from pinned revisions on first use.",
            )}
          </p>
        </div>
      </section>

      <section className="section" aria-labelledby="reading-heading">
        <div className="section__heading">
          <span className="section__number">04</span>
          <div>
            <h2 id="reading-heading">
              {t("readingHeading", "Reading behavior")}
            </h2>
            <p>
              {t(
                "readingHelp",
                "Set how the reader handles page text, motion, and local models.",
              )}
            </p>
          </div>
        </div>

        <div className="settings-grid">
          <label className="setting-row">
            <span>
              <strong>{t("autoScroll", "Auto-scroll")}</strong>
              <small>{t("autoScrollHelp", "Keep the current word in view while reading.")}</small>
            </span>
            <input
              type="checkbox"
              checked={settings.autoScroll}
              onChange={(event) =>
                void saveSettings({ autoScroll: event.currentTarget.checked })
              }
            />
          </label>
          <label className="setting-row">
            <span>
              <strong>{t("selectionChip", "Selection chip")}</strong>
              <small>
                {t(
                  "selectionChipHelp",
                  "Show a read button next to selections over 20 characters.",
                )}
              </small>
            </span>
            <input
              type="checkbox"
              checked={settings.selectionChip}
              onChange={(event) =>
                void saveSettings({ selectionChip: event.currentTarget.checked })
              }
            />
          </label>
          <label className="setting-row">
            <span>
              <strong>
                {t("selectionChipIconOnly", "Selection button shows only the icon")}
              </strong>
              <small>
                {t(
                  "selectionChipIconOnlyHelp",
                  "Hide the “Read selection” label next to the icon.",
                )}
              </small>
            </span>
            <input
              type="checkbox"
              checked={settings.selectionChipIconOnly}
              disabled={!settings.selectionChip}
              onChange={(event) =>
                void saveSettings({
                  selectionChipIconOnly: event.currentTarget.checked,
                })
              }
            />
          </label>
          <label className="setting-row">
            <span>
              <strong>{t("readCodeBlocks", "Read code blocks")}</strong>
              <small>
                {t(
                  "readCodeBlocksHelp",
                  "Include preformatted code in article extraction.",
                )}
              </small>
            </span>
            <input
              type="checkbox"
              checked={settings.readCodeBlocks}
              onChange={(event) =>
                void saveSettings({ readCodeBlocks: event.currentTarget.checked })
              }
            />
          </label>
          <label className="setting-row">
            <span>
              <strong>{t("arabicDiacritization", "Arabic diacritization")}</strong>
              <small>
                {t(
                  "arabicDiacritizationHelp",
                  "Experimental local model; disabled until benchmarked.",
                )}
              </small>
            </span>
            <input
              type="checkbox"
              checked={settings.arabic.diacritize}
              onChange={(event) =>
                void saveSettings({
                  arabic: { diacritize: event.currentTarget.checked },
                })
              }
            />
          </label>
          <label className="setting-control">
            <span>{t("urlReading", "URL reading")}</span>
            <select
              value={settings.urls}
              onChange={(event) =>
                void saveSettings({
                  urls: event.currentTarget.value as AppSettings["urls"],
                })
              }
            >
              <option value="skip">{t("skipUrls", "Skip URLs")}</option>
              <option value="domain">{t("domainOnly", "Read domain only")}</option>
              <option value="full">{t("fullUrl", "Read full URL")}</option>
            </select>
          </label>
          <label className="setting-control">
            <span>{t("speed", "Speed")}</span>
            <div className="range-setting">
              <input
                type="range"
                min="0.5"
                max="3"
                step="0.05"
                value={settings.speed}
                onChange={(event) =>
                  void saveSettings({ speed: Number(event.currentTarget.value) })
                }
              />
              <output>{formatSpeed(settings.speed)}</output>
            </div>
          </label>
          <label className="setting-control">
            <span>{t("queuedSentences", "Queued sentences")}</span>
            <select
              value={settings.lookahead}
              onChange={(event) =>
                void saveSettings({ lookahead: Number(event.currentTarget.value) })
              }
            >
              {[1, 2, 3, 4].map((count) => (
                <option value={count} key={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          <label className="setting-control">
            <span>{t("unloadEngine", "Unload idle audio engine")}</span>
            <div className="range-setting">
              <input
                type="range"
                min="1"
                max="30"
                step="1"
                value={settings.idleUnloadMinutes}
                onChange={(event) =>
                  void saveSettings({
                    idleUnloadMinutes: Number(event.currentTarget.value),
                  })
                }
              />
              <output>{settings.idleUnloadMinutes} min</output>
            </div>
          </label>
          <label className="setting-row">
            <span>
              <strong>{t("pdfInterception", "PDF interception")}</strong>
              <small>
                {t(
                  "pdfHelp",
                  "Open PDF links in the local reader when supported.",
                )}
              </small>
            </span>
            <input
              type="checkbox"
              checked={settings.pdf.intercept}
              onChange={(event) =>
                void saveSettings({
                  pdf: { intercept: event.currentTarget.checked },
                })
              }
            />
          </label>
          <label className="setting-row">
            <span>
              <strong>
                {t("highlightEnabled", "Word and sentence highlights")}
              </strong>
              <small>
                {t(
                  "highlightEnabledHelp",
                  "Keep timing colors visible while the page is read.",
                )}
              </small>
            </span>
            <input
              type="checkbox"
              checked={settings.highlight.enabled}
              onChange={(event) =>
                void saveSettings({
                  highlight: { enabled: event.currentTarget.checked },
                })
              }
            />
          </label>
          <label className="setting-control">
            <span>{t("wordHighlightColor", "Word highlight color")}</span>
            <input
              type="color"
              value={colorToHex(
                settings.highlight.word,
                DEFAULT_SETTINGS.highlight.word,
              )}
              onChange={(event) =>
                void saveSettings({
                  highlight: { word: event.currentTarget.value },
                })
              }
            />
          </label>
          <label className="setting-control">
            <span>
              {t("sentenceHighlightColor", "Sentence highlight color")}
            </span>
            <input
              type="color"
              value={colorToHex(
                settings.highlight.sentence,
                DEFAULT_SETTINGS.highlight.sentence,
              )}
              onChange={(event) =>
                void saveSettings({
                  highlight: { sentence: event.currentTarget.value },
                })
              }
            />
          </label>
        </div>
      </section>

      <section className="section" aria-labelledby="models-heading">
        <div className="section__heading">
          <span className="section__number">05</span>
          <div>
            <h2 id="models-heading">
              {t("modelsHeading", "Models on this device")}
            </h2>
            <p>
              {t(
                "modelsHelp",
                "Remove a model to free space. It downloads again the next time a voice needs it.",
              )}
            </p>
          </div>
        </div>
        <div className="voice-group__heading">
          <h3>{t("modelsBrowserHeading", "In this browser")}</h3>
          <span>
            {t(
              "modelsBrowserHint",
              "Stored in this browser and checked before use.",
            )}
          </span>
        </div>
        <div className="model-list">
          {MODEL_CATALOG.map((model) => {
            const state = modelStates[model.id] ?? {
              phase: "checking" as const,
              loaded: 0,
              total: model.bytes,
            };
            const title =
              model.id === "kokoro-en-q8"
                ? t("kokoroModel", "Kokoro English (q8)")
                : model.id === "piper-ar-kareem-medium"
                  ? t("piperModel", "Piper Kareem, Arabic")
                  : t("diacritizerModel", "libtashkeel Arabic diacritizer");
            return (
              <ModelRow
                key={model.id}
                title={title}
                details={[
                  `${formatBytes(model.bytes)} · ${model.license}`,
                  ...(model.id === "kokoro-en-q8"
                    ? [
                        t(
                          "kokoroVoiceEmbeddings",
                          "Voice embeddings download when a voice is first used.",
                        ),
                      ]
                    : []),
                ]}
                phase={state.phase === "idle" ? "missing" : state.phase}
                loaded={state.loaded}
                total={state.total}
                error={state.error}
                onDownload={() => void downloadModel(model.id)}
                onRemove={() => void deleteModel(model.id)}
              />
            );
          })}
        </div>

        {serverModels && serverModels.length > 0 && (
          <>
            <div className="voice-group__heading model-group">
              <h3>{t("modelsServerHeading", "On the local server")}</h3>
              <span>
                {t(
                  "modelsServerHint",
                  "Downloaded by the companion server when a voice is first used.",
                )}
              </span>
            </div>
            <div className="model-list">
              {serverModels.map((model) => (
                <ModelRow
                  key={model.id}
                  title={serverModelTitle(model)}
                  details={[
                    model.kind === "aligner"
                      ? `${formatBytes(model.bytes)} · ${t(
                          "alignerModelHelp",
                          "Optional. Exact word highlights for SILMA and Chatterbox; Kokoro times its words without it.",
                        )}`
                      : `${formatBytes(model.bytes)} · ${model.langs
                          .map((lang) =>
                            lang === "en"
                              ? t("languageEnglish", "English")
                              : t("languageArabic", "Arabic"),
                          )
                          .join(", ")}`,
                  ]}
                  phase={serverModelPhase(model)}
                  readyLabel={
                    model.state === "loaded"
                      ? t("modelLoaded", "Loaded")
                      : t("modelDownloaded", "Downloaded")
                  }
                  loaded={model.progress?.downloaded}
                  total={model.progress?.total}
                  error={model.error}
                  onDownload={() => void manageServerModel(model, "prepare")}
                  onRemove={() => void manageServerModel(model, "remove")}
                />
              ))}
            </div>
          </>
        )}
        {serverState?.connected && serverModels === null && (
          <p className="server-footnote">
            {t(
              "serverModelsUpdate",
              "Run the latest server installer to manage server models here.",
            )}
          </p>
        )}
        <p className="notice" role="status" aria-live="polite">
          {modelNotice}
        </p>
      </section>

      <footer className="footer">
        <span>{t("speechLocal", "Speech stays local.")}</span>
        <span>{t("buildLabel", "Build 0.1.0 / local-first speech")}</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<OptionsPage />);

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function colorToHex(value: string, fallback: string): string {
  if (/^#[\da-f]{6}$/iu.test(value)) return value;
  const channels = value.match(/[\d.]+/gu)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) return fallback;
  return `#${channels
    .map((channel) =>
      Math.min(255, Math.max(0, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
