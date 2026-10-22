# Open Speechy

Open Speechy is a Manifest V3 Chrome extension for reading web text aloud with local speech engines. It targets English and Arabic, keeps text on-device, and uses a companion server on `127.0.0.1` for higher-quality voices when paired.

## Development

Requirements:

- Node.js 20 or newer
- pnpm 9 or newer
- Python 3.11 for the companion server
- Chrome 116 or newer

Install JavaScript dependencies and start the extension dev server:

```sh
pnpm install --store-dir ./.pnpm-store
pnpm dev
```

Build the unpacked extension:

```sh
pnpm build
```

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `.output/chrome-mv3`. Use **Reload** on that extension after rebuilding.

Run checks:

```sh
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm lint
```

## Companion server

The server runs only on `127.0.0.1:5123`. On macOS or Linux, install it with:

```sh
./server/install.sh
```

The installer creates a Python 3.11+ environment with `uv`, installs the
authenticated API, generates a private bearer token, and registers a macOS
LaunchAgent. Open `http://127.0.0.1:5123/pair`, then enter its one-time code in
the extension's Local server settings. `./server/uninstall.sh` removes the
LaunchAgent but leaves the local token and files in place.

The server loads Kokoro, SILMA, Chatterbox-Nano, and Chatterbox-Multilingual
through pinned Hugging Face revisions in `server/models.json`. Model weights
download on first use, not during installation. Approximate upstream file
sizes range from 330 MB for Kokoro to several GB for SILMA and Chatterbox.
The first warm-up can take several minutes and needs enough free disk space.

SILMA is the automatic Arabic server voice. Kokoro is the automatic English
server voice. Chatterbox-Nano is an optional English voice, and
Chatterbox-Multilingual remains an experimental manual choice. The server uses
MMS_FA forced alignment where it can; if alignment is unavailable or has low
confidence, it uses estimated word timings. M0 did not measure synthesis speed,
alignment drift, or native-speaker pronunciation ratings, so this repo does
not claim those targets are met.

Run the server API and adapter tests with:

```sh
cd server
uv sync --python 3.11 --extra dev
uv run pytest
```

Check [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) before redistributing
model weights; the Piper voice card does not state its dataset license.

## Privacy and permissions

Speech synthesis runs in the browser or in the paired local server. Page text is not sent to a cloud service. Model weights are downloaded from the pinned Hugging Face files in `src/models/models.json`, then SHA-256 checked before use.

The extension requests access to page content for article extraction and highlighting, storage for settings, offscreen audio playback, TTS voices, context menus and keyboard commands. It contacts Hugging Face only to download the explicitly listed model files, Google Docs only after a user asks to read a document, and the configured local server when paired.

See [docs/STATUS.md](docs/STATUS.md) for milestone status and [docs/qa.md](docs/qa.md) for checks that still need a person.

## Current status

The English article flow, sentence queue, CSS Custom Highlight integration,
system voice discovery, auto-routing, voice selection, and audition screen are
in place. The toolbar popup starts article and selection reading, and a
selection chip appears beside long selections. Arabic number normalization,
offset-preserving word mapping, and mixed English/Arabic word runs are also
covered by unit tests. Mixed sentences route by language to the selected local
or server engine. The PDF.js viewer renders pages with a transparent text
layer, rebuilds reading order through column detection and paragraph joining,
drops running headers/footers and page numbers, de-hyphenates line ends, and
repairs visual-order Arabic text (presentation forms reversed to logical
order). PDF navigations ending in `.pdf` redirect into the viewer while the
PDF interception setting is on; the popup also offers "Read this PDF" and the
viewer accepts drag-and-drop and file-open for local documents. Run
`pnpm test:e2e` to exercise article, mixed-script, selection, and PDF reading
in Playwright's bundled Chromium.

Kokoro, Piper Kareem, and libtashkeel have pinned revisions and SHA-256
manifests in `src/models/models.json`; each downloads only when selected.
Piper uses a bundled eSpeak-NG WebAssembly phonemizer and ONNX Runtime Web.
The libtashkeel predictor is available behind the Arabic diacritization
setting, which stays off until its speed and accuracy are measured.

System voice routing still requires a local Premium/Enhanced voice with
runtime `word` events. The M0 spike did not measure model timing drift,
system-voice `charIndex` accuracy, or Arabic pronunciation. See
[docs/spikes.md](docs/spikes.md); no timing or pronunciation target is claimed
yet.
