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

The M0 model checks did not verify server model revisions, checksums, speed, or
quality. The server therefore does not advertise a speech voice by default.
Kokoro can be enabled for local testing with
`OPEN_SPEECHY_ALLOW_UNVERIFIED_MODELS=1`, but it is not a verified release
configuration. SILMA and Chatterbox remain disabled until their adapters and
measurements are verified.

## Privacy and permissions

Speech synthesis runs in the browser or in the paired local server. Page text is not sent to a cloud service. Model weights are downloaded from the pinned Hugging Face files in `src/models/models.json`, then SHA-256 checked before use.

The extension requests access to page content for article extraction and highlighting, storage for settings, offscreen audio playback, TTS voices, context menus and keyboard commands. It contacts Hugging Face only to download the explicitly listed model files, Google Docs only after a user asks to read a document, and the configured local server when paired.

See [docs/STATUS.md](docs/STATUS.md) for milestone status and [docs/qa.md](docs/qa.md) for checks that still need a person.

## Current status

The English article flow, sentence queue, CSS Custom Highlight integration,
system voice discovery, auto-routing, voice selection, and audition screen are
in place. Arabic number normalization, offset-preserving word mapping, and
mixed English/Arabic word runs are also covered by unit tests. Run
`pnpm test:e2e` to exercise the article flow in Playwright's bundled Chromium.

Real Kokoro downloads remain disabled until a pinned model revision and audited
SHA-256 manifest are available. The M0 spike did not measure model timings,
system-voice word events, Arabic pronunciation, or the companion-server engines.
System voice routing requires a local Premium/Enhanced voice with the required
word events. The voice list still shows compact and standard voices for manual
selection. Browser Arabic diacritization stays off without a verified local
predictor. See [docs/spikes.md](docs/spikes.md); no timing or pronunciation
target is claimed yet.
