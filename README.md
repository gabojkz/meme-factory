# MemeFactory

Local comic-style meme library for **Windows**, **macOS**, and **Linux**.

Import memes, OCR the text, and search instantly — everything stays on your machine.

![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg)

## Features

- Multi-select import for PNG / JPG / GIF / WebP / BMP
- OCR on import (Tesseract.js) so text is searchable
- Fast SQLite FTS5 search across OCR text and titles
- Copy meme images to the clipboard
- Fully local storage (no cloud, no account)

## Download

Grab the latest build for your OS from the [Releases](../../releases) page:

| Platform | Artifact |
| --- | --- |
| Windows | `.msi` / `.exe` |
| macOS | `.dmg` / `.app` (Intel + Apple Silicon) |
| Linux | `.AppImage` / `.deb` |

## Develop

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (stable)
- Platform deps for [Tauri](https://v2.tauri.app/start/prerequisites/)

### Run

```bash
npm install
npm run tauri dev
```

### Build locally

```bash
npm install
npm run tauri build
```

Installers land in `src-tauri/target/release/bundle/`.

## Stack

- [Tauri 2](https://tauri.app/) + Rust
- React + TypeScript + Vite
- SQLite FTS5
- Tesseract.js OCR

## License

[MIT](LICENSE)
