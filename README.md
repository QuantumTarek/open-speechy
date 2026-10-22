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
cd server
./install.sh
```

The installer creates a Python 3.11 environment with `uv`, installs the server, downloads models as configured, creates a bearer token, and prints setup instructions. Paste the token into the extension's Local server settings. Use `./uninstall.sh` to remove the environment and launch-at-login entry.

## Privacy and permissions

Speech synthesis runs in the browser or in the paired local server. Page text is not sent to a cloud service. Model weights are downloaded from the pinned Hugging Face files in `src/models/models.json`, then SHA-256 checked before use.

The extension requests access to page content for article extraction and highlighting, storage for settings, offscreen audio playback, TTS voices, context menus and keyboard commands. It contacts Hugging Face only to download the explicitly listed model files, Google Docs only after a user asks to read a document, and the configured local server when paired.

See [docs/STATUS.md](docs/STATUS.md) for milestone status and [docs/qa.md](docs/qa.md) for checks that still need a person.
