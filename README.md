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
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-2ec4ff?style=for-the-badge" alt="Windows, macOS, Linux" />
</p>

## What is this for?

MemeFactory is for people who keep memes on their computer and hate digging through folders to find the right one.

It’s a **desktop app** that turns a local folder into a searchable meme library:

- Import your meme dump (PNG, JPG, GIF, WebP, BMP)
- OCR reads the text *inside* the images on import
- Search by that text instantly (no filenames required)
- Copy a meme to the clipboard when you need it in chat
- Keep everything **fully local** — no account, no cloud, no tracking

Built for everyday meme use: Discord, Slack, group chats, or just your own chaotic archive.

## Multi-platform

One app, three operating systems — grab the installer for your machine:

| Platform | Who it’s for | Installer |
| --- | --- | --- |
| **Windows** | Windows 10/11 (x64) | `.msi` |
| **macOS Apple Silicon** | M1 / M2 / M3 / M4 Macs | `.dmg` (arm64) |
| **macOS Intel** | Intel Macs | `.dmg` (x64) |
| **Linux** | Most x86_64 distros | `.AppImage`, `.deb`, or **Snap** |

**macOS tip:** Apple menu → About This Mac — if the chip says Apple M… use **arm64**; if it says Intel, use **x64**.

**macOS requirement:** roughly macOS 10.15+ (Catalina or newer). Older versions like OS X 10.11 are not supported.

## Features

- Multi-select import for PNG / JPG / GIF / WebP / BMP
- OCR on import (Tesseract.js) so text is searchable
- Fast SQLite FTS5 search across OCR text and titles
- Copy meme images to the clipboard
- Configurable local meme folder
- Fully local storage (no cloud, no account)
- Native installers for Windows, macOS, and Linux

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

### Linux Snap (Ubuntu Store)

MemeFactory ships a `snapcraft.yaml` for the [Snap Store](https://snapcraft.io/).

**You can’t build snaps on macOS** — use GitHub Actions instead.

#### 1. Register the snap name
1. Create an [Ubuntu One](https://login.ubuntu.com/) account  
2. Register `meme-factory` at https://snapcraft.io/account/register-snap  

#### 2. Add a GitHub secret (one-time)
On a Mac, the easiest way to export login credentials is [Multipass](https://multipass.run/):

```bash
brew install --cask multipass
multipass launch --name snap-login
multipass shell snap-login
```

Inside the VM:

```bash
sudo snap install snapcraft --classic
snapcraft export-login \
  --snaps=meme-factory \
  --channels=edge,beta,candidate,stable \
  exported.txt
cat exported.txt
```

Copy the full contents of `exported.txt`, then in GitHub:

**Repo → Settings → Secrets and variables → Actions → New repository secret**

- Name: `SNAPCRAFT_STORE_CREDENTIALS`  
- Value: paste the exported file contents  

You can delete the VM afterward: `multipass delete snap-login && multipass purge`

#### 3. Publish
- Push a version tag (`./scripts/release.sh 0.5.0`) → Snap workflow builds and publishes to **edge**  
- Or run **Actions → Snap → Run workflow** and pick a channel (`edge` / `stable`)

After it’s on the store:

```bash
sudo snap install meme-factory --edge
# later, when stable:
sudo snap install meme-factory
```

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
