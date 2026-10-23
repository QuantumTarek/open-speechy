# Open Speechy — Implementation Plan

A Chrome extension (Manifest V3) that reads web articles, selected text, PDFs and Google Docs aloud using **local, open TTS models**, with **word-by-word highlighting**, for **English and Arabic**. Think of it as an open, private, offline Speechify.

This document is the full spec for the implementer. Read it top to bottom before writing code. Items marked **[SPIKE]** are assumptions that must be verified first (Milestone 0). If a spike fails, use the stated fallback and do not invent a different design.

---

## 1. Goals and non-goals

### Goals
- Read the **main article** of any web page, the **current selection**, **PDFs**, and **Google Docs**.
- **Word-by-word highlighting** synchronized with audio, plus a softer highlight of the current sentence. Auto-scroll keeps the current word visible.
- **English and Arabic**, including pages that mix both. Arabic must be read right-to-left correctly and pronounced with proper vowels (diacritization).
- **All TTS runs locally.** No text leaves the machine. Models are downloaded once from Hugging Face, then everything works offline.
- **Prefer Apple's built-in macOS voices** when a high-quality one is installed for the language. In that case no model is downloaded.
- Ship a **local companion server** (Python, localhost only) as a required part of v1. It runs larger, higher-quality models (SILMA-TTS for Arabic, Kokoro and Chatterbox-Nano for English) than the browser can. The in-browser engines remain the fallback when the server isn't running.
- Fast: audio starts **< 1 s** after pressing Play (warm), with no gaps between sentences.
- Player controls: play/pause, previous/next sentence, speed 0.5×–3×, voice selection, click a word to start reading from it.

### Non-goals (v1)
- Cloud TTS, accounts, sync, payments.
- Voice cloning.
- Languages other than EN/AR. The architecture must not block adding them later.
- Highlighting inside the Google Docs canvas itself (we read Docs in our own Reader view, see §8.4).
- Firefox/Safari.

---

## 2. Model and engine decisions

There are three engine types behind one interface (§5). Engines are chosen **per language**, automatically, with a manual override in settings.

### 2.1 Engine priority (auto mode)

For each language:

1. **System voice (Apple/macOS via `chrome.tts`)**, but only if a **Premium** or **Enhanced** voice for that language is installed, is local (`remote === false`), and supports `word` events. No download is needed.
2. **Local companion server** (§2.5, required component), if it is running and healthy. Arabic → **SILMA-TTS**. English → **Kokoro-82M** by default, with **Chatterbox-Nano** as a selectable "expressive" voice.
3. **In-browser ONNX model** (fallback when the server is not running): English → **Kokoro-82M**, Arabic → **Piper `ar_JO-kareem-medium`** (+ diacritizer). This is downloaded lazily, the first time that language is actually needed and the server is unavailable.

If the server goes down mid-reading, the router switches to tier 3 at the next sentence and shows a toast ("Local server unavailable — using in-browser voice").

"Compact" (low-quality default) Apple voices are **not** auto-selected, but they appear in the voice list so the user can choose them manually. The options page has an **"Audition voices"** panel that plays the same sample sentence with each available engine/voice, so the user can compare and pin a choice per language.

### 2.2 English: Kokoro-82M
- Package: `kokoro-js` (built on `@huggingface/transformers`, ONNX Runtime Web).
- Model: `onnx-community/Kokoro-82M-v1.0-ONNX`, using the **q8** quantization (~90 MB) on WASM and **fp32/fp16** on WebGPU (benchmark both in M0 and pick the faster one that sounds clean).
- License: Apache-2.0.
- Default voice: `af_heart`. Expose all English voices (`af_*`, `am_*`, `bf_*`, `bm_*`).
- **Word timings [SPIKE]:** `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped` is an export that also outputs **predicted durations per phoneme token**. Verify:
  - (a) what output tensor holds the durations, and its units (frames; Kokoro runs at 24 kHz with hop 600 → 1 frame = 25 ms, to be verified);
  - (b) whether `kokoro-js` exposes it. If it doesn't, call the model directly with `onnxruntime-web`, using kokoro-js only for phonemization and voice embeddings, or fork kokoro-js;
  - (c) how to map phoneme tokens back to words (phonemize **word by word** and track token index ranges per word, inserting the same separators kokoro-js uses).
  - **Fallback:** estimated timings (§6.4).

### 2.3 Arabic: Piper VITS `ar_JO-kareem-medium`
- Voice files: `rhasspy/piper-voices` → `ar/ar_JO/kareem/medium/ar_JO-kareem-medium.onnx` + `.onnx.json` (~60 MB). Check the voice's `MODEL_CARD` for its license and record it in `THIRD_PARTY_LICENSES.md`.
- Runtime: `onnxruntime-web` (WASM is fine, since VITS-medium is faster than real time on CPU). Phonemization uses **espeak-ng compiled to WASM** (the `piper-phonemize` WASM build, e.g. as packaged in `@mintplex-labs/piper-tts-web` or `@diffusionstudio/vits-web`). Use that package if it works inside an extension offscreen document. Otherwise vendor its WASM phonemizer and write the inference call yourself (it's a single `session.run` with `input`, `input_lengths`, `scales`).
- **Diacritization (tashkeel) is mandatory** for good Arabic pronunciation, because most Arabic text online has no short vowels.
  - **[SPIKE]** Find a small ONNX Arabic diacritizer usable in the browser. Candidates in order: **libtashkeel** ONNX model (by mush42, the author of Piper's Arabic support), **CATT** (abjad.ai), **Shakkala**. Criteria: < 30 MB, < 50 ms per sentence on WASM, permissive license.
  - Run the diacritizer **before** phonemization. Keep an offset map (§6.3) so highlighting still points at the original, undiacritized page text.
  - If the text is already mostly diacritized (> 30% of Arabic letters are followed by a haraka), skip the diacritizer.
  - Fallback if no browser diacritizer is viable: ship without it behind a setting, and recommend the Apple Arabic voice, which diacritizes internally.
- **Word timings [SPIKE]:** VITS has a duration predictor. The stock Piper ONNX export outputs only audio.
  - Preferred: **re-export** the `ar_JO-kareem-medium` checkpoint (from `rhasspy/piper-checkpoints` on Hugging Face) with an extra output `durations` (the `w_ceil` tensor inside `infer`, in frames; frame = `hop_length` 256 samples at 22050 Hz). Commit the export script to `tools/export_piper_with_durations.py` and host the resulting `.onnx` in a Hugging Face repo we control (or in the release assets).
  - Map phoneme durations to words by phonemizing word by word (same approach as Kokoro).
  - Fallback: estimated timings (§6.4).

### 2.4 System voices (Apple macOS, Windows, ChromeOS) via `chrome.tts`
- Use `chrome.tts.getVoices()` from the service worker. A voice is "high quality" if `voiceName` contains `(Premium)` or `(Enhanced)` (macOS naming), `remote === false`, and `eventTypes` includes `'word'`, `'end'`, `'interrupted'`.
- Speak with `chrome.tts.speak(text, { voiceName, lang, rate, onEvent })`. `word` events give `charIndex` into the spoken text → map to the word index (§6.3). `chrome.tts.pause()`/`resume()`/`stop()` handle playback.
- Speak **one sentence per `speak` call**, chained with `enqueue: true` and a queue of at most 2, so that skip, seek and speed changes stay responsive.
- Speed: map the UI speed to `rate` (1.0 = normal; clamp to [0.5, 3]).
- The options page shows a help note: *"For best quality on macOS, download a Premium voice: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices… (e.g. English 'Zoe (Premium)', Arabic 'Majed (Enhanced)'). Then restart Chrome."* Siri voices are not available to Chrome; don't try.
- **[SPIKE]** Confirm that Chrome on macOS fires `word` events with correct `charIndex` for Premium/Enhanced English and Arabic voices. If Arabic `charIndex` is unreliable, mark that voice as "no word events" and use estimated timing driven by `start`/`end` events, or demote it.

### 2.5 Local companion server (required, Milestone 3)
A Python service in `server/` (FastAPI + Uvicorn) that the extension talks to at `http://127.0.0.1:5123` using the API in §5.3. It runs on **Apple Silicon (PyTorch MPS)**, **NVIDIA (CUDA)**, or **CPU**, choosing the device automatically.

**Engines:**
| Engine | Lang | Model | Why | Word timings |
|---|---|---|---|---|
| `silma` | **ar** (default), en | `silma-ai/silma-tts` (~150M, F5-TTS architecture, Apache-2.0 weights / MIT code) | Purpose-built for Arabic (MSA) and English. It has built-in diacritization via **CATT** (so no separate tashkeel step) and supports voice cloning from < 8 s of reference audio. | Forced alignment (below) |
| `kokoro` | **en** (default) | `hexgrad/Kokoro-82M` (Python `kokoro` package, Apache-2.0) | Fastest, very clean. Returns per-token timestamps natively. | Model (native) |
| `chatterbox_nano` | en | `ResembleAI/chatterbox-nano` (110M, MIT, ~3× real time on 8 CPU cores) | More expressive and natural prosody than Kokoro. Offered as an "expressive" English voice. **English only.** | Forced alignment |
| `chatterbox_ml` | ar (experimental) | `ResembleAI/chatterbox-multilingual` (~500M, MIT, 23 languages) | Only included as an A/B candidate for Arabic in the M0 spike. Ship it only if it beats SILMA on quality without being too slow. | Forced alignment |

**Word timings for models without durations:** run **CTC forced alignment** with `torchaudio.pipelines.MMS_FA` on the generated audio and the known word list. Romanize Arabic with `uroman` first, as MMS_FA expects. This adds roughly 30–80 ms per sentence. Validate it against Kokoro's native timestamps on English (target ≤ 60 ms mean error).

**Install and run** (must be simple; a user shouldn't need to know Python):
- `server/install.sh` (macOS/Linux) uses **`uv`** to create the env and install deps, downloads the default models (SILMA + Kokoro, ~1 GB total, with progress), generates the auth token, and prints it.
- On macOS it registers a **LaunchAgent** (`~/Library/LaunchAgents/dev.openspeechy.server.plist`) so the server starts at login. `server/uninstall.sh` removes everything.
- Windows: `install.ps1` + a Scheduled Task (best effort in v1).
- **Pairing:** the options page has a "Connect local server" flow. The user pastes the token, or the server shows a one-time 6-digit pairing code at `http://127.0.0.1:5123/pair` that the extension exchanges for the token.
- Models load lazily per engine and are unloaded after `idle_unload_minutes` (default 10). `/health` reports which ones are loaded.
- **Warm-up:** when the extension starts a session, it calls `POST /warmup {engines}` so the first sentence doesn't pay the model-load cost.

**[SPIKE]** Measure SILMA's real-time factor on an M1/M2/M3 Mac (MPS) and on CPU with 16 and 32 flow-matching steps. The target is RTF < 0.5 on Apple Silicon. If it isn't met, lower the step count (quality check by a native speaker), and if it's still too slow, use in-browser Piper for Arabic on that machine and keep SILMA as an opt-in "high quality" voice.

### 2.6 Model choices: why these
- **Kokoro-82M: English only for us.** It supports en, es, fr, hi, it, pt, ja and zh, but **not Arabic**. It's the best English option for speed plus quality, runs in both the browser and the server, and gives word timestamps natively. That makes it the English default in every tier.
- **Chatterbox-Nano: English only.** It is 110M and CPU-friendly, but the model card lists only English. Arabic exists only in the larger **Chatterbox-Multilingual** (~500M). Nano is included as an alternative English voice with more natural prosody. It is autoregressive and gives no durations, so it needs forced alignment, and its time to first audio is higher than Kokoro's.
- **SILMA-TTS: the Arabic default on the server.** It is the only small (~150M) open model I found that is purpose-built for Arabic, permissively licensed, and handles undiacritized text itself (CATT). Chatterbox-Multilingual is 3× larger and Arabic is one of 23 languages for it. It is tested against SILMA in M0 and is the documented fallback if SILMA disappoints.
- **Piper Kareem: the in-browser Arabic fallback only.** It is tiny and fast but sounds noticeably robotic. It exists so Arabic still works with no server.
- **Not used:** XTTS-v2 (non-commercial license, heavy) and F5-TTS Arabic community fine-tunes (larger and less maintained than SILMA, which uses the same architecture).

---

## 3. Tech stack

- **TypeScript** (strict), **WXT** (MV3 framework, Vite-based), **React 18** for the UI surfaces, **Zustand** for UI state.
- `onnxruntime-web` (WebGPU + WASM), `kokoro-js`, the Piper WASM phonemizer, `@mozilla/readability`, `pdfjs-dist`.
- Testing: **Vitest** (unit), **Playwright** (e2e with the unpacked extension loaded).
- Lint/format: ESLint + Prettier. Package manager: pnpm.
- **Companion server:** Python 3.11+, FastAPI, Uvicorn, PyTorch (MPS/CUDA/CPU), torchaudio (MMS_FA), `uroman`, `kokoro`, `silma-tts` (per its repo), `chatterbox-tts`; env managed with `uv`; tested with pytest; lint with ruff.
- Minimum Chrome: **116**+ (offscreen API reasons and the CSS Custom Highlight API are both stable there). Set `minimum_chrome_version` in the manifest.

### Licensing note
espeak-ng (used by both the Kokoro and Piper phonemizers) is **GPL-3.0**. Because we bundle it, license the project **GPL-3.0-or-later** and keep `THIRD_PARTY_LICENSES.md` listing every model and library with its license.

---

## 4. Architecture

```
┌────────────────────────── Tab ──────────────────────────┐
│ Content script (isolated world)                          │
│  • Text extraction (Readability / selection)             │
│  • Segmentation + DOM Range map                          │
│  • Highlighter (CSS Custom Highlight API)                │
│  • Player bar UI (React in Shadow DOM)                   │
│  • Local playback clock (rAF) for highlight timing       │
└──────────────▲───────────────────────────────────────────┘
               │ chrome.runtime port ("session")
┌──────────────┴────────── Service worker ────────────────┐
│ • Session manager (one active reading session at a time) │
│ • Engine router (auto selection per language)            │
│ • SystemTtsEngine (chrome.tts) lives HERE                │
│ • Creates/closes the offscreen document                  │
│ • Context menus, commands (shortcuts), PDF redirect      │
└──────────────▲───────────────────────────────────────────┘
               │ chrome.runtime messages
┌──────────────┴──────── Offscreen document ──────────────┐
│ reason: AUDIO_PLAYBACK (+ WORKERS)                       │
│ • AudioPlayer (Web Audio / HTMLAudioElement)             │
│ • Model cache manager (downloads, Cache Storage)         │
│ • Inference Web Worker:                                  │
│     KokoroEngine, PiperEngine, Diacritizer (ORT web)     │
│ • ServerEngine client (fetch to 127.0.0.1)               │
└──────────────────────────────────────────────────────────┘

Extension pages: popup, options (settings + model manager + voice audition),
pdf-viewer.html (PDF.js), reader.html (Reader view for Google Docs & fallback).
Extension pages use the same player bar and highlighter as the content script.
```

### Key decisions
- **Inference runs in a Web Worker inside the offscreen document**, so long ORT calls never block audio scheduling. Service workers can't use WebGPU reliably and get killed when idle, so no inference happens there.
- **The offscreen document owns audio** for the ONNX/server engines. `chrome.tts` owns audio for system voices.
- **The content script owns highlighting.** At the start of each sentence it receives the sentence's word timing table (`[{wordIndex, startMs, endMs}]`) and runs its own `requestAnimationFrame` clock. The offscreen document re-syncs it on `play`, `pause`, `seek` and `rate` events and every 1 s (`{sentenceId, positionMs, rate, perfNow}`). Don't send a message per word or per frame.
- The offscreen document closes after **5 min idle** to free memory (models reload from cache in ~1–3 s).
- **Only one reading session at a time** across all tabs. Starting a new one stops the old one.

### Manifest essentials
```jsonc
{
  "manifest_version": 3,
  "minimum_chrome_version": "116",
  "permissions": ["offscreen", "tts", "storage", "unlimitedStorage", "contextMenus",
                  "activeTab", "scripting", "declarativeNetRequest"],
  "host_permissions": ["<all_urls>"],          // PDFs + Google Docs export + model download
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },
  "commands": {
    "toggle-read": { "suggested_key": { "default": "Alt+Shift+R" }, "description": "Read / pause" },
    "read-selection": { "suggested_key": { "default": "Alt+Shift+S" }, "description": "Read selection" }
  },
  "web_accessible_resources": [{ "resources": ["pdf-viewer.html", "reader.html", "assets/*"], "matches": ["<all_urls>"] }]
}
```
- **All JS and WASM (ORT runtime `.wasm` files, espeak-ng WASM) must be bundled in the extension.** The Web Store forbids remote code. Configure ORT with `ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/')`, and the same for transformers.js (`env.backends.onnx.wasm.wasmPaths`, `env.allowLocalModels`, etc.).
- **Model weights are data**, so they may be downloaded at runtime from Hugging Face. Pin each model to a **specific revision hash** and verify a **SHA-256** after download.

---

## 5. Engine interface

### 5.1 TypeScript contract (`src/engines/types.ts`)
```ts
export type Lang = 'en' | 'ar';

export interface VoiceInfo {
  id: string;               // globally unique: `${engineId}:${voiceKey}`
  engineId: EngineId;
  lang: Lang;
  name: string;             // display name
  quality: 'premium' | 'enhanced' | 'standard' | 'compact';
  local: boolean;
  supportsWordTimings: boolean;
  sizeBytes?: number;       // download size if not yet installed
  installed: boolean;
}

export type EngineId = 'system' | 'kokoro' | 'piper' | 'server';

export interface WordTiming { wordIndex: number; startMs: number; endMs: number; }

export interface SynthesisResult {
  audio: Float32Array;      // mono PCM
  sampleRate: number;
  timings: WordTiming[];    // one per word in the request, in order
  timingSource: 'model' | 'estimated' | 'aligned';
}

export interface SynthesisRequest {
  sentenceId: string;
  lang: Lang;
  voiceId: string;
  words: string[];          // normalized words to speak (see §6)
  text: string;             // words joined with the language's separator
  speed: number;            // engines that support native speed use it; else 1.0
}

export interface TtsEngine {
  id: EngineId;
  init(onProgress?: (p: { loaded: number; total: number; stage: string }) => void): Promise<void>;
  isReady(): boolean;
  listVoices(): Promise<VoiceInfo[]>;
  synthesize(req: SynthesisRequest, signal: AbortSignal): Promise<SynthesisResult>;
  dispose(): Promise<void>;
}
```
`SystemTtsEngine` doesn't produce PCM, so it implements a separate `StreamingSpeechEngine` interface (`speak(req, handlers)`, `pause`, `resume`, `stop`). Its `word` events are converted into the same `WordTiming` ticks, so the highlighter doesn't care which engine is running.

### 5.2 Auto selection (`src/engines/router.ts`)
```
selectVoice(lang):
  if settings.voiceOverride[lang] → use it (if available; else fall through + toast)
  systemVoices = chrome.tts voices where lang matches, !remote, quality ∈ {premium, enhanced}, has word events
  if systemVoices.length → pick the best (premium > enhanced; English prefers en-US)
  else if server paired & healthy (cached /health, refreshed every 30 s and on session start)
       → server default voice for lang (ar: silma, en: kokoro)
  else → in-browser kokoro (en) / piper (ar)   // triggers lazy download with progress UI
```
Language matching: `en*` → en, `ar*` → ar.

### 5.3 Local server HTTP API
- `GET /health` → `{ ok: true, version, device: "mps"|"cuda"|"cpu", engines: [{ id, loaded, langs }] }`
- `GET /voices` → `VoiceInfo[]` (with `engineId: "server"`; `voiceId` like `server:silma:default`, `server:kokoro:af_heart`, `server:chatterbox_nano:default`)
- `POST /warmup` body `{ engines: string[] }` → `204` once loaded
- `POST /synthesize` body `{ voiceId, lang, words: string[], speed }` → `{ sampleRate, audioWavBase64, timings: WordTiming[], timingSource }`. Words are sent as an array so the server can return one timing per word without re-tokenizing. The server does Arabic normalization/diacritization itself for SILMA, so the extension sends the normalized but **undiacritized** words for that engine.
- `POST /voices/clone` (SILMA only) multipart `{ name, audio (≤ 15 s wav/mp3), transcript? }` → `VoiceInfo`. Cloned voices are stored in `~/.open-speechy/voices/`.
- `GET /pair` (HTML page showing a one-time code) and `POST /pair { code }` → `{ token }`.
- Concurrency: one synthesis at a time per engine (a queue); requests carry `X-Request-Id`, and `DELETE /synthesize/<id>` cancels a queued or running job (the extension calls it on skip/stop).
- Bind to `127.0.0.1` only. Require a random token, generated by the server on first run and pasted into the extension options, as the `Authorization: Bearer` header. CORS: allow only `chrome-extension://<id>`.

---

## 6. Text pipeline

Module `src/text/`. Pure functions with full unit tests.

### 6.1 Extraction
- **Article:** clone the document and run `@mozilla/readability`. Use the result to **identify the main content root in the live DOM**. Don't render Readability's HTML: we highlight the real page. Approach: run Readability with `keepClasses`/`serializer` hooks, or match its top-candidate element by text fingerprint against live elements. If matching fails, fall back to the largest `<article>`/`<main>`/densest-text block.
- Collect **text nodes** under the root in document order with a `TreeWalker`. Skip `script, style, noscript, nav, aside, footer, figure figcaption?, button, input, textarea, select, [aria-hidden=true], [hidden], display:none / visibility:hidden` (check computed style once per element), code blocks (setting: read code? default off), and elements with `role=navigation|complementary`.
- Block boundaries (`p, h1–h6, li, blockquote, td, br, div` with block display) produce paragraph breaks. Headings get a short pause.
- **Selection:** use `window.getSelection().getRangeAt(i)` and collect text nodes clipped to the range(s).
- **Start from here:** clicking a word while the player is open (or the "Read from here" context-menu item) starts at that word's index.

### 6.2 Segmentation
- **Paragraph → sentences → words** using `Intl.Segmenter` (`granularity: 'sentence'` and `'word'`, locale `en` or `ar`), which handles Arabic.
- Keep only word segments with `isWordLike`, plus numbers. Punctuation attaches to the preceding word for display but isn't spoken.
- Split very long sentences (> 300 chars) at commas/semicolons (`،` `؛` for Arabic) to keep time-to-first-audio low.
- Each word gets a stable `wordIndex` (global within the session) and a **source mapping**: an array of `{ node: Text, start: number, end: number }` pieces, because a word can span nodes such as `<b>wo</b>rd`.

### 6.3 Normalization and offset mapping
- Normalization runs per word and produces the **spoken form**, while the source mapping stays attached to the original word. Then we never have to map character offsets back across the whole sentence.
- English: expand numbers ("1,234" → "one thousand two hundred thirty-four"), years, ordinals, currency ($, €, £), %, common abbreviations (Dr., Mr., e.g., i.e., etc.), and URLs/emails (speak domain only or skip; setting). A single source word can expand into several spoken tokens. Timings for all of them collapse into the one source word.
- Arabic: remove tatweel `ـ` (U+0640); normalize Arabic-Indic digits `٠-٩` and Persian digits `۰-۹` to Latin for number expansion; expand numbers to Arabic words (implement a small `numberToArabicWords` for 0–999,999,999 with masculine default); keep existing harakat.
- **Diacritization** runs on the whole sentence (context matters) **after** normalization. The output is split back into words by whitespace. Diacritics are combining marks, so the word count must match; if it doesn't, discard diacritization for that sentence.
- For **system voices** we send `text = spokenWords.join(' ')` and keep a `charStart` table so a `charIndex` from a `word` event maps to a `wordIndex` by binary search.

### 6.4 Estimated timings (fallback)
When an engine gives no durations: distribute the sentence's audio duration (after trimming leading/trailing silence, detected with an RMS threshold of −40 dBFS) over the words, weighted by `max(1, letterCount)` (Arabic: count letters, excluding harakat) plus a fixed weight for trailing punctuation pauses (`,` = 2, `.?!` = 4 letter-equivalents). In testing this looks acceptable. Model durations look better, so prefer them.

### 6.5 Language detection
- Per **paragraph**: share of Arabic-script letters (U+0600–06FF, U+0750–077F, U+08A0–08FF, U+FB50–FDFF, U+FE70–FEFF) among all letters. ≥ 0.5 → `ar`, else `en`. Use the `lang` attribute on ancestors as a tie-breaker.
- If a sentence mixes scripts (e.g. an English brand name inside Arabic), split it into **runs** by script when a run is ≥ 2 words. Each run is synthesized with the right engine but scheduled back to back as one sentence. Single foreign words stay in the main language.

---

## 7. Playback and highlighting

### 7.1 Scheduling (offscreen `AudioPlayer` + `SessionQueue`)
- Keep a **look-ahead of 2 sentences** synthesized ahead of playback (configurable 1–4). Synthesis runs one at a time in the worker, ordered by sentence index. Cancel with `AbortController` when the user skips.
- Play each sentence's PCM through Web Audio: convert to an `AudioBuffer` and use `AudioBufferSourceNode`, starting the next buffer at the exact end time of the previous one for gapless playback. Add a 120 ms gap between paragraphs and 250 ms after headings.
- **Speed:**
  - Kokoro: pass the native `speed` param (keeps quality), and re-synthesize queued-ahead sentences on change.
  - Piper: native `length_scale = 1/speed`.
  - Server: `speed` param.
  - Changing speed applies from the **next** sentence, and the current sentence is also restarted from its current word if it has > 3 s left. No time-stretching DSP in v1.
- **Pause/resume:** `AudioContext.suspend()/resume()`.
- **Seek to word:** stop current audio. If the word is in a sentence that is already synthesized and its timings are known, start that buffer at `timing.startMs` offset; otherwise synthesize starting from that word (treat the remainder of the sentence as a new sentence).
- **Prev/next sentence** behaves like seeking to the first word of that sentence. "Prev" within the first 1.5 s of a sentence goes to the previous one, otherwise it restarts the current one.

### 7.2 Highlighting (content script `Highlighter`)
- Use the **CSS Custom Highlight API**: `CSS.highlights.set('os-sentence', new Highlight(...ranges))` and `CSS.highlights.set('os-word', new Highlight(range))`. Style with `::highlight(os-word) { background-color: var(--os-word-bg); color: inherit; }` injected via a `<style>` in the page (the highlight pseudo-element must be in the document's stylesheet, not the shadow root).
- Default colors: sentence `rgba(255, 213, 79, 0.25)`, word `rgba(255, 179, 0, 0.6)`. Configurable, plus a dark-page detection that switches to lighter tints.
- The **page DOM is never modified** (no `<span>` wrapping), so it works on React/Vue pages without breaking them.
- **Auto-scroll:** if the current word's `range.getBoundingClientRect()` is outside the middle 60% of the viewport, `window.scrollTo({ behavior: 'smooth' })` to center it. Pause auto-scroll for 5 s after the user scrolls manually, and show a "Jump to current" pill.
- **DOM mutation:** a `MutationObserver` on the root detects removed text nodes. If a word's node is detached, re-run extraction and re-match by word text plus neighbors; if that fails, keep the audio playing and hide the highlight.
- Clicking a highlighted-capable word (with the player open, or Alt+click anytime) seeks there. Use `document.caretPositionFromPoint`/`caretRangeFromPoint` to find node+offset, then binary search the word map.

### 7.3 Player UI (content script, React in Shadow DOM)
- A floating bar fixed at the bottom-center. It can be dragged and remembers its position per origin.
- Controls: Play/Pause, Prev, Next, Speed (popover 0.5–3.0, step 0.1, with presets 1, 1.25, 1.5, 2), Voice (grouped by language and engine, with quality badges), Close. It also shows progress (word X of Y and estimated time left) and a loading state with model download progress (MB and %).
- **RTL:** the bar uses `dir="auto"`. When the current sentence is Arabic, show Arabic voice labels, but **do not mirror transport controls** (play-direction icons stay the same, matching common media players).
- Keyboard while the bar has focus: Space play/pause, ←/→ prev/next sentence, ↑/↓ speed ±0.1, Esc close. Global commands come from the manifest.
- All UI strings live in `_locales/en` and `_locales/ar` (extension UI follows the browser language).
- Accessibility: proper `aria-label`s, focus ring, and a reduced-motion setting that disables smooth scroll.

---

## 8. Sources

### 8.1 Web articles
Use the toolbar button (opens the popup with "Read this page"), the context menu "Read page", or Alt+Shift+R. Extraction follows §6.1.

### 8.2 Selected text
Use the context menu "Read selection", Alt+Shift+S, or the small floating "▶ Read" chip that appears near a selection longer than 20 chars (setting, default on).

### 8.3 PDFs
- Chrome's built-in PDF viewer can't be scripted, so we ship our own **PDF.js viewer** at `pdf-viewer.html?file=<encoded URL>`.
- Entry points:
  - (1) a setting "Open PDFs in Open Speechy" (default **on**) using a `declarativeNetRequest` dynamic rule that redirects top-level `main_frame` requests whose **response** `Content-Type` is `application/pdf`. This uses `responseHeaders` matching (Chrome 128+). **[SPIKE]** confirm it works; if it doesn't, use the `.pdf` URL-suffix rule plus option (2).
  - (2) the popup's "Read this PDF" button when the active tab URL ends in `.pdf` or the tab is Chrome's PDF viewer.
  - (3) drag-and-drop or "Open file…" in the viewer for local files. Tell the user that `file://` URLs need "Allow access to file URLs" enabled on the extension page.
- Render pages with the PDF.js **text layer**. Build the word map from text-layer `<span>` text nodes (here we own the DOM, so the same highlighter works).
- Reading order: PDF.js item order, plus these heuristics:
  - de-hyphenate line-end `-` in English;
  - join lines within a paragraph when the vertical gap is less than 1.5× line height;
  - drop repeated header/footer lines (identical text in the top/bottom 8% of ≥ 50% of pages);
  - drop page numbers.
- Auto-scroll across pages. Lazy-render pages near the viewport, but extract text for all pages up front (text extraction is cheap).
- **Arabic PDFs [SPIKE]:** PDF.js sometimes returns Arabic in visual (reversed) order or as presentation-form glyphs (U+FE70–FEFF). Normalize presentation forms with NFKC, and detect reversed runs (a high ratio of final-form letters at word starts) and reverse them. Test with at least 3 real Arabic PDFs (news article, academic paper, book).

### 8.4 Google Docs
- Docs renders to canvas, so the page DOM holds no readable text. On `docs.google.com/document/d/<id>/...`:
  - The popup/player shows "Read this document". Clicking it makes the content script `fetch('/document/d/<id>/export?format=html', { credentials: 'include' })` (same-origin, so it uses the user's session; it works for any doc the user can view).
  - Open the **Reader view** (§8.5) as a full-page overlay over the doc (iframe of `reader.html` injected by the content script), populated with the sanitized HTML (headings, paragraphs, lists only; strip styles and scripts with DOMPurify).
  - If export is forbidden (download disabled by the owner), show a message suggesting the user select the text, which doesn't work on canvas either, so the realistic fallback is "Copy the text and use the Reader view's Paste box".
- v1 does not highlight inside the Docs canvas.

### 8.5 Reader view (`reader.html`)
A clean typographic page (max-width 720px, comfortable line height, `dir="auto"` per paragraph, good Arabic font stack: `"Noto Naskh Arabic", "Geeza Pro", serif`). It is used for Google Docs, a "Paste text to read" box, and an optional "Reader mode" for any page (popup toggle). It reuses the same extraction, highlighter and player.

---

## 9. Model management

- **Options → Models** lists each model with its size, status (Not downloaded / Downloading x% / Ready / Update available), and Download/Delete buttons. The total disk usage is shown.
- Downloads are lazy and automatic the first time a language needs an ONNX engine, with progress in the player bar ("Downloading Arabic voice — 23/61 MB"). Downloads resume on failure (HTTP Range) and retry 3× with backoff.
- Storage: Cache Storage under a cache named `os-models-v1`, keyed by URL with a pinned revision. `unlimitedStorage` is granted. Verify SHA-256 after download, and on mismatch delete it and show an error.
- `models.json` is bundled in the extension: `{ id, engine, lang, files: [{ url, sha256, bytes }], revision, license }`. Updating models requires an extension update (no remote manifest).
- **WebGPU:** detect it with `navigator.gpu?.requestAdapter()` in the offscreen worker. Use it for Kokoro if available and benchmarked faster, otherwise WASM with `numThreads = min(4, hardwareConcurrency)`. This requires cross-origin isolation for threads: set the offscreen document's response headers via the manifest's `cross_origin_embedder_policy`/`cross_origin_opener_policy`. **[SPIKE]** verify whether `SharedArrayBuffer` is available in the offscreen document. If not, use single-threaded WASM and measure the real-time factor.

---

## 10. Settings (`chrome.storage.sync`; models/caches stay local)

| Key | Default | Notes |
|---|---|---|
| `voice.en`, `voice.ar` | `auto` | or a specific `voiceId` |
| `speed` | 1.0 | 0.5–3.0 |
| `highlight.word`, `highlight.sentence` | colors above | |
| `highlight.enabled` | true | |
| `autoScroll` | true | |
| `lookahead` | 2 | 1–4 sentences |
| `readCodeBlocks` | false | |
| `urls` | `domain` | `skip` / `domain` / `full` |
| `selectionChip` | true | |
| `pdf.intercept` | true | |
| `arabic.diacritize` | true | |
| `server.enabled`, `server.url`, `server.token` | true, `http://127.0.0.1:5123`, "" | `enabled` only matters once paired |
| `idleUnloadMinutes` | 5 | |

The options page has these sections: General, Voices (with **Audition**), Highlighting, Models, Local server, About/licenses.

---

## 11. Project structure

```
open-speechy/
├─ PLAN.md
├─ README.md                      # install, dev, build, architecture summary
├─ THIRD_PARTY_LICENSES.md
├─ LICENSE                        # GPL-3.0-or-later
├─ wxt.config.ts
├─ package.json
├─ public/
│  ├─ _locales/{en,ar}/messages.json
│  ├─ ort/                        # onnxruntime-web .wasm/.mjs copied at build
│  └─ icons/
├─ src/
│  ├─ entrypoints/
│  │  ├─ background.ts            # service worker
│  │  ├─ content/index.tsx        # content script entry
│  │  ├─ offscreen/index.html + main.ts
│  │  ├─ offscreen/inference.worker.ts
│  │  ├─ popup/
│  │  ├─ options/
│  │  ├─ pdf-viewer/
│  │  └─ reader/
│  ├─ engines/
│  │  ├─ types.ts
│  │  ├─ router.ts
│  │  ├─ system.ts                # chrome.tts
│  │  ├─ kokoro.ts
│  │  ├─ piper.ts
│  │  ├─ diacritizer.ts
│  │  ├─ server.ts
│  │  └─ timings.ts               # durations→words, estimated fallback
│  ├─ text/
│  │  ├─ extract.ts  segment.ts  lang.ts  normalize-en.ts  normalize-ar.ts
│  │  ├─ number-to-words-en.ts  number-to-words-ar.ts
│  │  └─ wordmap.ts               # word ↔ DOM ranges, caret→word lookup
│  ├─ playback/
│  │  ├─ session.ts               # queue, lookahead, seek, cancel
│  │  ├─ audio-player.ts          # Web Audio scheduling
│  │  └─ clock.ts                 # content-side rAF clock + resync
│  ├─ highlight/highlighter.ts
│  ├─ ui/                         # shared React components (PlayerBar, VoicePicker, SpeedPopover…)
│  ├─ models/{manager.ts, models.json}
│  ├─ messaging/{protocol.ts, bus.ts}   # typed message definitions (discriminated unions)
│  └─ settings/store.ts
├─ server/                        # local companion server (M3, required)
│  ├─ pyproject.toml  install.sh  uninstall.sh  install.ps1
│  ├─ app.py  auth.py  queue.py  align.py (MMS_FA + uroman)
│  ├─ engines/{base.py, silma.py, kokoro.py, chatterbox_nano.py, chatterbox_ml.py}
│  ├─ launchd/dev.openspeechy.server.plist
│  └─ tests/ (pytest: API contract, alignment accuracy, auth)
├─ tools/export_piper_with_durations.py
└─ tests/
   ├─ unit/ (vitest)
   ├─ e2e/  (playwright)
   └─ fixtures/ (en-article.html, ar-article.html, mixed.html, spa-article.html, sample-en.pdf, sample-ar.pdf)
```

### Messaging protocol (`src/messaging/protocol.ts`)
All messages are typed discriminated unions with a `type` field. Core ones:
- content → SW: `session/start {tabId, sentences, lang map, startWordIndex}`, `session/control {action: play|pause|next|prev|seek|stop, wordIndex?}`, `session/setSpeed`, `session/setVoice`
- SW → offscreen: `engine/synthesize`, `player/enqueue`, `player/control`, `models/download`
- offscreen/SW → content: `session/sentenceStart {sentenceId, timings, startedAtPerf}`, `session/sync {positionMs, rate, playing}`, `session/state {status, error?}`, `models/progress`
Use a long-lived `chrome.runtime.Port` per tab session, and reconnect if the SW restarts (MV3 SWs can die; the session state of record lives in the offscreen document while it's open, mirrored into `chrome.storage.session`).

---

## 12. Milestones and acceptance criteria

Each milestone ends with: passing unit + e2e tests, an updated README, and a short demo GIF/video in the PR.

### M0 — Spikes (do first; write findings to `docs/spikes.md`)
1. Kokoro in an offscreen worker: WebGPU vs WASM real-time factor on an M1/M2 Mac; time-to-first-audio for one 20-word sentence; whether timestamped durations are accessible and their units.
2. Piper ar_JO-kareem in an offscreen worker with the espeak WASM phonemizer; real-time factor; the durations re-export script works.
3. Browser Arabic diacritizer: pick one, measure size, speed, and accuracy on 20 test sentences.
4. `chrome.tts` on macOS: list voices; confirm `word` events and `charIndex` accuracy for an English Premium voice and an Arabic voice.
5. `SharedArrayBuffer`/threads in the offscreen document.
6. DNR `responseHeaders` PDF redirect.
7. PDF.js Arabic text extraction order.
8. **Server models on Apple Silicon (MPS) and CPU:** RTF and time-to-first-audio for SILMA (16/32 steps), Chatterbox-Nano, Chatterbox-Multilingual (Arabic), and Kokoro. Run a blind A/B of SILMA vs Chatterbox-Multilingual vs Piper on 20 Arabic sentences rated by a native speaker, and record the winner as the Arabic server default.
9. MMS_FA forced alignment accuracy: English vs Kokoro native timestamps, and Arabic by manual inspection of 10 sentences.

**Exit:** a decision recorded for each item, using the fallbacks above where needed.

### M1 — English article, Kokoro, highlighting
- WXT scaffold, messaging, offscreen document, model manager (Kokoro only), text pipeline (EN), session queue, Web Audio player, highlighter, player bar.
- **Accept:** on the `en-article.html` fixture and 3 real sites (e.g. a Wikipedia article, a Medium post, a news article), Play starts in < 1 s (model warm) and < 4 s (model cached, cold). The highlighted word is within ±150 ms of the audio (judge by ear plus a debug overlay that prints the drift). There are no audible gaps between sentences. Pause, resume, next, prev, seek-by-click and speed all work. The page DOM is unchanged (assert `innerHTML` before == after in e2e).

### M2 — System voices (Apple) and auto selection
- `SystemTtsEngine`, router with priority rules, voice picker with quality badges, Audition panel, macOS help note.
- **Accept:** with an English Premium voice installed, auto mode uses it and **no model download happens** (assert no network requests to huggingface.co). Word highlighting follows `word` events. Removing the voice falls back to Kokoro.

### M3 — Local companion server
- `server/`: FastAPI app, auth and pairing, job queue with cancel, engines (`kokoro`, `silma`, `chatterbox_nano`, plus `chatterbox_ml` if M0 says so), MMS_FA alignment, install/uninstall scripts, macOS LaunchAgent, pytest suite.
- Extension: `ServerEngine`, health polling, router tier 2, pairing UI in options, server voices in the voice picker (badge "Local server"), warm-up on session start, mid-session fallback to in-browser engines.
- **Accept:**
  - A fresh Mac goes from `./install.sh` to paired and reading in under 10 minutes, without touching Python manually.
  - Server voices appear in the picker. Highlighting stays within ±150 ms for Kokoro (native timings) and ±200 ms for aligned engines.
  - Killing the server mid-sentence falls back to in-browser at the next sentence with a toast.
  - The server rejects requests without the token and from non-extension origins.
  - The server is reachable only on 127.0.0.1 (test that binding to 0.0.0.0 is impossible via config).

### M4 — Arabic
- Server side: SILMA engine tuned (step count from M0) with Arabic normalization and number expansion done in the extension.
- In-browser fallback: Piper engine and diacritizer.
- Shared: per-paragraph language detection, mixed-script runs, RTL-safe highlighting.
- **Accept:**
  - `ar-article.html` and 3 real Arabic sites (e.g. Arabic Wikipedia, Al Jazeera, BBC Arabic) read in the correct direction, and highlights land on the right words.
  - A native speaker rates pronunciation on 20 sentences: SILMA ≥ 90% natural or acceptable; Piper + diacritizer ≥ 80%.
  - `mixed.html` switches engines per paragraph without gaps > 300 ms.

### M5 — Selection, polish, settings
- Read selection, selection chip, context menus, shortcuts, options page complete, i18n EN/AR, dark-page highlight colors, auto-scroll behavior, SPA mutation handling, idle unload, and error states (model download failure, offline, unsupported page like `chrome://`).
- **Accept:** the manual QA checklist (§13.3) passes.

### M6 — PDFs
- PDF.js viewer, interception, text-layer word map, reading-order heuristics, Arabic PDF normalization.
- **Accept:** `sample-en.pdf` (2-column paper) and `sample-ar.pdf` read in the correct order with highlighting. Headers, footers and page numbers are skipped. Local files work when file access is allowed.

### M7 — Google Docs and Reader view
- Reader view page, Docs export fetch, paste-to-read.
- **Accept:** a test Google Doc (EN and AR) the user can view reads fully in the Reader overlay with highlighting. A doc with download disabled shows the fallback message.

### M8 — Packaging
- Production build, zip for the Chrome Web Store, privacy policy (no data collected; text never leaves the device except to the paired localhost server), store screenshots, README install instructions (Load unpacked + server install).
- Server release: a tagged `server-vX.Y.Z` with a one-line installer (`curl -fsSL <release>/install.sh | bash`). The extension shows "Server update available" when `/health.version` is older than the version it expects.

---

## 13. Testing

### 13.1 Unit (Vitest)
- Segmentation: EN/AR sentences and words, abbreviations ("Dr. Smith"), decimals ("3.14"), Arabic punctuation `، ؛ ؟`.
- Word map: words spanning multiple text nodes; caret→word lookup.
- Normalization: number-to-words EN/AR (table-driven, ≥ 50 cases each), currency, URLs, tatweel, Arabic-Indic digits.
- Diacritization offset preservation: word count unchanged; fallback when changed.
- Timings: durations→word mapping; estimated timings sum to the audio length and are monotonic.
- Language detection and mixed runs.
- Router selection logic with mocked voice lists (premium present / compact only / none / server down).

### 13.2 E2E (Playwright, Chromium with `--load-extension`)
- Load fixtures from a local static server, trigger reading through the extension's test hook, and assert:
  - a session starts;
  - `CSS.highlights.get('os-word')` changes over time and points at the expected words in order;
  - pause stops progression;
  - clicking a word moves the highlight there;
  - the DOM is unchanged.
- Use a **`FakeEngine`** (enabled in test builds) that returns silent audio with deterministic timings, so CI doesn't need models. One separate, opt-in "real models" e2e job runs with the real Kokoro and Piper models.

### 13.3 Manual QA checklist
EN article, AR article, mixed page, very long article (> 10k words), SPA that re-renders, infinite-scroll page, page with iframes (read the top document only), dark-mode site, selection across paragraphs, PDF EN/AR/local, Google Doc EN/AR, offline after models are cached, browser restart mid-session, two tabs (starting the second stops the first), every keyboard shortcut, speed extremes 0.5×/3×, Apple Premium voice present/absent.

---

## 14. Performance budgets
- Time to first audio: **< 1 s** warm, **< 4 s** cold from cache, first-ever download excluded (it shows progress).
- Synthesis real-time factor: Kokoro **< 0.3** on WebGPU (M1+) and **< 0.8** on WASM. Piper **< 0.3** on WASM.
- Highlight drift: **≤ 150 ms** p95.
- Memory: offscreen document **< 600 MB** with both models loaded. Unload after idle.
- Content script bundle: **< 150 KB** gzipped (lazy-load the React player on first use). No measurable impact on page load: the content script does nothing until invoked except registering the selection chip listener.

## 15. Privacy and security
- No analytics, no remote logging. Text never leaves the device. The only text recipient is the paired companion server on `127.0.0.1`.
- Server: binds to 127.0.0.1 only; bearer token required; CORS restricted to the extension origin; logs never contain the synthesized text (only lengths and timings).
- Sanitize all imported HTML (Google Docs export, Reader paste) with DOMPurify.
- Network requests are limited to: Hugging Face model URLs listed in `models.json`, Google Docs export (same origin, on user action), the configured localhost server, and PDFs the user opens.
- Permissions are justified in the README and store listing.

## 16. Known risks and fallbacks (summary)
| Risk | Fallback |
|---|---|
| No model durations for Kokoro/Piper | Estimated timings (§6.4) |
| No good in-browser Arabic diacritizer | Disable it by default; recommend the Apple Arabic voice or the server engine |
| WebGPU unavailable / slow | WASM (multi-thread if SAB is available) |
| `chrome.tts` Arabic `word` events unreliable | Estimated timings from `start`/`end`, or demote the voice |
| DNR response-header PDF redirect unsupported | URL-suffix rule + popup button |
| Arabic PDF text in visual order | Reversal heuristic; document the limitation |
| Google Docs export disabled | Paste-to-read in the Reader view |
| Readability picks the wrong root | "Read selection" + Reader mode |
| SILMA too slow on the user's machine | Fewer flow steps; else in-browser Piper for Arabic with SILMA as an opt-in voice |
| SILMA Arabic quality below Chatterbox-Multilingual in M0 | Make `chatterbox_ml` the Arabic server default |
| Server not installed or not running | In-browser engines (tier 3); a "Set up local server for best quality" banner in the options |
| Forced alignment drifts on Arabic | Estimated timings (§6.4) for that sentence when alignment confidence is low |

## 17. Future (not v1)
More languages (Kokoro covers es/fr/hi/it/pt/ja/zh). An ONNX export of SILMA-TTS so it can also run in the browser. Arabic dialect voices (e.g. Habibi models). Kindle/EPUB. Side-panel reader. Saving audio to MP3. Highlighting inside the Google Docs canvas through Google's annotated-canvas mode, which needs Google to allowlist the extension.
