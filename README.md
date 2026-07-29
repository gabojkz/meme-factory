# MemeFactory

Local comic-style meme library for **Windows**, **macOS**, and **Linux**.

Import memes, OCR the text, and search instantly — everything stays on your machine.

<p align="center">
  <a href="https://github.com/gabojkz/meme-factory/releases/latest/download/MemeFactory-macos-arm64.dmg">
    <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Apple Silicon" />
  </a>
  <a href="https://github.com/gabojkz/meme-factory/releases/latest/download/MemeFactory-macos-x64.dmg">
    <img src="https://img.shields.io/badge/macOS-Intel-555555?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Intel" />
  </a>
  <br />
  <a href="https://github.com/gabojkz/meme-factory/releases/latest/download/MemeFactory-windows-x64.msi">
    <img src="https://img.shields.io/badge/Windows-x64-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows" />
  </a>
  <a href="https://github.com/gabojkz/meme-factory/releases/latest/download/MemeFactory-linux-x86_64.AppImage">
    <img src="https://img.shields.io/badge/Linux-AppImage-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/gabojkz/meme-factory/releases/latest">
    <img src="https://img.shields.io/github/v/release/gabojkz/meme-factory?style=for-the-badge&label=latest&color=2ec4ff" alt="Latest release" />
  </a>
  <a href="https://github.com/gabojkz/meme-factory/releases/latest">
    <img src="https://img.shields.io/github/downloads/gabojkz/meme-factory/latest/total?style=for-the-badge&label=downloads&color=ff3b3b" alt="Latest downloads" />
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

Latest release assets:

| Platform | Build |
| --- | --- |
| macOS Apple Silicon | [`.dmg`](https://github.com/gabojkz/meme-factory/releases/latest/download/MemeFactory-macos-arm64.dmg) |
| macOS Intel | [`.dmg`](https://github.com/gabojkz/meme-factory/releases/latest/download/MemeFactory-macos-x64.dmg) |
| Windows | [`.msi`](https://github.com/gabojkz/meme-factory/releases/latest/download/MemeFactory-windows-x64.msi) |
| Linux | [`.AppImage`](https://github.com/gabojkz/meme-factory/releases/latest/download/MemeFactory-linux-x86_64.AppImage) |
| Linux | [`.deb`](https://github.com/gabojkz/meme-factory/releases/latest/download/MemeFactory-linux-amd64.deb) |

All releases: [github.com/gabojkz/meme-factory/releases](https://github.com/gabojkz/meme-factory/releases)

### macOS note

The macOS builds are not Apple notarized yet, so Gatekeeper may block the first open.

1. Open the `.dmg` and drag **MemeFactory** to Applications.
2. If macOS says it can’t be opened:
   - Right-click the app → **Open** → click **Open** again  
   - Or go to **System Settings → Privacy & Security** and click **Open Anyway**

Or clear the quarantine flag in Terminal:

```bash
xattr -cr /Applications/MemeFactory.app
```

Then open the app again.


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

### Release

```bash
./scripts/release.sh 0.3.0
```

That bumps every version file, commits, tags `v0.3.0`, and pushes to GitHub so the release workflow can build installers.

The release workflow also syncs the version from the git tag before building, so the published app always matches `vX.Y.Z`.

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
