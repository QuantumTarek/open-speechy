# Open Speechy

A Chrome extension that reads web pages, selections, PDFs and Google Docs aloud,
highlighting each word as it is spoken. It supports English and Arabic, and
speech is generated on your computer: page text is never sent to a cloud
service. Voice models download from Hugging Face the first time they are
used.

- In-browser voices (Kokoro for English, Piper for Arabic) that download once
- Your system's Premium and Enhanced voices
- An optional local server with larger voices (Kokoro, SILMA, Chatterbox)

## Setup

You need [Node.js](https://nodejs.org) 20+, [pnpm](https://pnpm.io) 9+ and
Chrome 116+.

1. Build the extension:

   ```sh
   pnpm install
   pnpm build
   ```

2. Open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked** and choose `.output/chrome-mv3`.
3. On any page, click the Open Speechy icon and choose **Read article**,
   press `Alt+Shift+R`, or right-click and choose **Read this page**.

Voices and other settings are in the extension's **Options** page.

## Local server (optional)

The server runs better voices on your machine, at `127.0.0.1:5123` only.

1. Install it. The first run downloads about 2 GB of Python packages.

   ```sh
   ./server/install.sh          # macOS and Linux
   ```

   On Windows, install [uv](https://docs.astral.sh/uv/) and run
   `server\install.ps1`.

2. Reload the extension in `chrome://extensions`. It connects to the server
   on its own; **Options → Local server** shows its status and can start or
   stop it.

A server voice downloads its model the first time you use it (355 MB to
3.2 GB). **Options → Models on this device** shows the download progress and
can remove any model. To uninstall, run `./server/uninstall.sh` (or
`server\uninstall.ps1` on Windows).

In a browser the installer did not set up, open
`http://127.0.0.1:5123/pair` and enter the code under
**Options → Local server → Pair with a code**.

## Development

```sh
pnpm dev          # extension with live reload
pnpm test         # unit tests
pnpm test:e2e     # browser tests (Playwright)
pnpm typecheck
pnpm lint
pnpm zip          # Chrome Web Store package
pnpm icons        # rerender public/icon/ from tools/icons/*.svg
```

Server tests:

```sh
cd server
uv sync --python 3.11 --extra dev
uv run pytest
```

The extension ID is fixed by the `key` in `wxt.config.ts`, and the server
only answers that ID. To allow another build, such as a store build, install
the server with `OPEN_SPEECHY_EXTENSION_IDS=<id>`.

More detail: [docs/privacy-policy.md](docs/privacy-policy.md),
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## License

GPL-3.0-or-later, because the bundled eSpeak-NG phonemizer is GPL-3.0. See
[LICENSE](LICENSE).
