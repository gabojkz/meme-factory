# MemeFactory

Local comic-style meme library for **Windows**, **macOS**, and **Linux**.

Import memes, OCR the text, and search instantly — everything stays on your machine.

<p align="center">
  <a href="https://github.com/tusk/MemeFactory/releases/latest/download/MemeFactory-macos-arm64.dmg">
    <img src="https://img.shields.io/badge/Download-macOS%20(Apple%20Silicon)-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS Apple Silicon" />
  </a>
  <a href="https://github.com/tusk/MemeFactory/releases/latest/download/MemeFactory-macos-x64.dmg">
    <img src="https://img.shields.io/badge/Download-macOS%20(Intel)-555555?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS Intel" />
  </a>
  <br />
  <a href="https://github.com/tusk/MemeFactory/releases/latest/download/MemeFactory-windows-x64.msi">
    <img src="https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download Windows" />
  </a>
  <a href="https://github.com/tusk/MemeFactory/releases/latest/download/MemeFactory-linux-x86_64.AppImage">
    <img src="https://img.shields.io/badge/Download-Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download Linux" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/tusk/MemeFactory/releases/latest">
    <img src="https://img.shields.io/github/v/release/tusk/MemeFactory?style=for-the-badge&label=latest&color=2ec4ff" alt="Latest release" />
  </a>
  <a href="https://github.com/tusk/MemeFactory/releases/latest">
    <img src="https://img.shields.io/github/downloads/tusk/MemeFactory/latest/total?style=for-the-badge&label=downloads&color=ff3b3b" alt="Latest downloads" />
  </a>
  <img src="https://img.shields.io/badge/license-MIT-yellow.svg?style=for-the-badge" alt="MIT license" />
</p>

## Features

- Multi-select import for PNG / JPG / GIF / WebP / BMP
- OCR on import (Tesseract.js) so text is searchable
- Fast SQLite FTS5 search across OCR text and titles
- Copy meme images to the clipboard
- Configurable local meme folder
- Fully local storage (no cloud, no account)

## Download

Badges above always point at the **latest** GitHub release assets:

| Platform | File |
| --- | --- |
| macOS Apple Silicon | [`MemeFactory-macos-arm64.dmg`](https://github.com/tusk/MemeFactory/releases/latest/download/MemeFactory-macos-arm64.dmg) |
| macOS Intel | [`MemeFactory-macos-x64.dmg`](https://github.com/tusk/MemeFactory/releases/latest/download/MemeFactory-macos-x64.dmg) |
| Windows | [`MemeFactory-windows-x64.msi`](https://github.com/tusk/MemeFactory/releases/latest/download/MemeFactory-windows-x64.msi) |
| Linux | [`MemeFactory-linux-x86_64.AppImage`](https://github.com/tusk/MemeFactory/releases/latest/download/MemeFactory-linux-x86_64.AppImage) |
| Linux (deb) | [`MemeFactory-linux-amd64.deb`](https://github.com/tusk/MemeFactory/releases/latest/download/MemeFactory-linux-amd64.deb) |

All releases: [github.com/tusk/MemeFactory/releases](https://github.com/tusk/MemeFactory/releases)

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

## Love this project?

If people enjoy MemeFactory, I'll keep working on it and shipping more features.

Have a recommendation, idea, or bug? Open an issue on the [GitHub Issues page](https://github.com/gabojkz/meme-factory/issues) — that's the best place to share feedback.

Repo: [github.com/gabojkz/meme-factory](https://github.com/gabojkz/meme-factory)

## License

[MIT](LICENSE) — free and open source.
