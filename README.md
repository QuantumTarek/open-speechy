# Open Speechy

Open Speechy is a Manifest V3 Chrome extension for reading web text aloud with local speech engines. It targets English and Arabic, keeps text on-device, and uses a companion server on `127.0.0.1` for higher-quality voices when it is installed.

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
LaunchAgent. It also registers a native messaging helper with each installed
Chromium-based browser (Chrome, Chromium, Brave, Edge, Vivaldi, Arc). Through
the helper the extension connects to the server on its own, with no pairing
code, and Options → Local server can start and stop it. A server stopped there
stays off, also across logins, until it is started again. On Linux the helper
starts the server as a background process; on Windows it runs the installer's
scheduled task.

In a browser without the helper, open `http://127.0.0.1:5123/pair` and enter
its one-time code under Options → Local server → Pair with a code.
`./server/uninstall.sh` removes the LaunchAgent and the helper but leaves the
local token and files in place.

The extension has a fixed ID, `bomfkndoodmcdkcemfdncddboldmlcna`, set by the
`key` in `wxt.config.ts`; the helper only answers that ID. To allow another
build, such as a Chrome Web Store one, run the installer with
`OPEN_SPEECHY_EXTENSION_IDS=<id>[,<id>...]`.

The installer lives in `server/`: run `./server/install.sh` from the repository
root, or `./install.sh` from inside `server/`. The first run installs `uv` if
needed and then about 2 GB of Python
packages, so expect several minutes. Dependencies are locked in
`server/uv.lock`. Server logs go to `~/.open-speechy/server.log` and
`~/.open-speechy/server-error.log`.

The server loads Kokoro, SILMA, Chatterbox-Nano, and Chatterbox-Multilingual
through pinned Hugging Face revisions in `server/models.json`, which also
records each snapshot's size: 355 MB for Kokoro, 2.7 GB for SILMA with its
vocoder, 1.9 GB for Chatterbox-Nano and 3.2 GB for Chatterbox-Multilingual.
Model weights download the first time a voice is used, not during
installation, into the Hugging Face cache (`OPEN_SPEECHY_MODEL_CACHE` moves
it). The server downloads a voice's model while it prepares the voice, before
the first sentence, and the player and Options show the download percentage.
Options → Models on this device lists the browser and server models;
**Remove** deletes a model's files, and it downloads again the next time a
voice needs it. Once loaded, Kokoro answers in well under a second.

Kokoro times each word from its own duration predictions. SILMA and Chatterbox
cannot, so their highlights use estimated timings unless the optional word
aligner (torchaudio MMS_FA, 1.26 GB in `~/.cache/torch/hub`) is downloaded
from Options. Nothing downloads it on its own.

SILMA is the automatic Arabic server voice. Kokoro is the automatic English
server voice. Chatterbox-Nano is an optional English voice, and
Chatterbox-Multilingual remains an experimental manual choice. The server uses
MMS_FA forced alignment for SILMA and Chatterbox when the aligner is
downloaded; if it is not, or alignment has low confidence, it uses estimated
word timings. M0 did not measure synthesis speed,
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

The extension requests access to page content for article extraction and highlighting, storage for settings, offscreen audio playback, TTS voices, context menus, keyboard commands, and native messaging (only to the Open Speechy server helper). It contacts Hugging Face only to download the explicitly listed model files, Google Docs only after a user asks to read a document, and the configured local server when paired.

See [docs/STATUS.md](docs/STATUS.md) for milestone status and [docs/qa.md](docs/qa.md) for checks that still need a person.

## Current status

Highlights use Speechify's palette: a light blue sentence (`#e0e3ff`) with
the current word in a deeper blue (`#abb3fe`) on light pages, and `#444766`
and `#5666f0` with white text on dark pages. The light colors can be changed
in Options.

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

Only Premium and Enhanced system voices are listed; the compact defaults and
novelty voices are hidden. Other platforms do not label voices this way, so
they list no system voices. System voice routing still requires a local
Premium/Enhanced voice with runtime `word` events. The M0 spike did not measure model timing drift,
system-voice `charIndex` accuracy, or Arabic pronunciation. See
[docs/spikes.md](docs/spikes.md); no timing or pronunciation target is claimed
yet.

## Packaging and install

- **Unpacked:** `pnpm build` writes `.output/chrome-mv3`; load it via
  chrome://extensions → Developer mode → Load unpacked.
- **Zip:** `pnpm zip` produces `.output/open-speechy-<version>-chrome.zip`
  for Chrome Web Store upload.
- **Companion server:** `./server/install.sh` (macOS/Linux) or
  `server/install.ps1` (Windows) sets up the loopback API and the helper the
  extension uses to connect and to start or stop the server.
  Release a server update by tagging `server-vX.Y.Z`; the extension shows
  "Server update available" when `/health.version` is older than the
  version this build expects (`EXPECTED_SERVER_VERSION`).
- Store screenshots live in `store/screenshots` (regenerate with
  `node tools/store-screenshots.mjs` after a production build).
- Privacy policy for the store listing: [docs/privacy-policy.md](docs/privacy-policy.md).
