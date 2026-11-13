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
- **Quick add**: paste an image (⌘V / Ctrl+V), drag one straight from your browser, or paste a link into the link box — the image is downloaded and saved automatically (links to a web page use the page's preview image)
- OCR on import (Tesseract.js) so text is searchable
- **GIFs**: animated GIFs and WebPs stay animated — pasting or dragging one from a browser downloads the original (not the browser's still copy), and Copy puts the file itself on the clipboard so it pastes animated. Links to X/Twitter posts (whose "GIFs" are really MP4 videos) and direct `.mp4` links are converted to a looping GIF (up to 20 s, 480 px)
- **Videos**: short video memes (MP4, MOV, WebM) live alongside images — import them, paste or drop them, or paste a link (X/Twitter video posts and pages with an `og:video` are followed). They preview on hover, play in the details, have their captions read from three frames for search, and Copy puts the video file on the clipboard. X "GIFs" are still saved as real GIFs
- **Stats**: the top-right corner shows the memes folder's size and how many memes, images, GIFs and videos you have (hover for each kind's size). Click Images, GIFs or Videos to show only that type, click others to add them back, or click Total to show everything — the choice is remembered
- **Sort and date filters**: every meme shows when it was added (on its card and in its details). Sort by newest (default), oldest or title — or best match while searching — and narrow to today, this week, last 7 days, this month, last 30 days, this year or a custom date range. Your choices are remembered
- **Danger zone** (Config): erase every meme and all MemeFactory data from the computer — library, tags, text, Studio projects, asset packs, settings, caches and browser storage. It lists exactly what will go, asks you to type ERASE, deletes directly (no Trash), clears the clipboard, then closes the app. A custom memes folder only loses its memes; other files in it are never touched
- **Tags**: add tags in a meme's details, click a tag to filter, or search `#cat` to match only that tag; search covers OCR text, titles and tags
- Fast SQLite FTS5 search across OCR text and titles
- Copy meme images to the clipboard
- Configurable local meme folder
- Fully local storage (no cloud, no account)
- Native installers for Windows, macOS, and Linux

### Meme Studio

Make new memes on a canvas, then save them straight into your library:

- Blank canvases (square, landscape, portrait, custom) or start from any image
- Add images from disk, from your library, by drag-and-drop or paste
- **Cut out** anything with the lasso or polygon tool (add/subtract, feather, invert) — the original image is never changed, and cutouts stay editable
- Meme text presets (top/bottom Impact, caption box), shapes, and emoji stickers
- Move, resize, rotate, flip, lock, hide, and reorder layers; undo/redo
- **Save to library** — the text on your meme becomes searchable right away
- Projects are saved with every layer editable, so you can come back later
- Export as PNG or JPEG

### Asset library

Open **📚 Asset library** in the Studio to drop characters, reactions, stickers, objects and backgrounds onto your canvas:

- **Starter kit** of 64 original assets, built in and available offline
- **Online catalog** (`catalog/` in this repo): browse thumbnails, download single assets or whole packs on demand (Blob Crew, Anime Feels, Ribbit & Friends, Internet Folk, Pixel Quest)
- **😀 Emotions** tab: browse everything by feeling — happy, laughing, excited, love, cool, smug, sleepy, embarrassed, shocked, scared, sad, crying, angry and more
- **Online search**: Creative Commons images via [Openverse](https://openverse.org), freely licensed images from [Wikimedia Commons](https://commons.wikimedia.org), and popular meme templates via Imgflip
- Search by name, tags, emotion or description; filter by emotion, style, format, transparency and licence
- Favourites (kept offline), **My uploads**, download manager with progress/cancel/retry, storage management
- Import asset packs as `.zip` (`manifest.json`, `assets/`, `metadata/`) — validated, no scripts or SVGs
- Every asset shows its source and licence; only MemeFactory-verified licences are presented as verified
- Images are embedded in your project, so removing a pack never breaks a saved meme

#### Categories

| Category | What's in it |
| --- | --- |
| Reactions | Emoji-style faces for 17 emotions |
| Anime & manga | Anime-style faces (blushing, crying, angry, shocked, smug), chibis, sweat drops, anger veins, blush marks, speed/focus lines, screentone |
| Internet characters | Line-art archetypes: gloomy, sunny, square-jaw, gray NPC, boomer, zoomer |
| Classic memes | Advice-style colour wheels, pixel shades, EPIC WIN / FAIL stamps |
| Gaming & fandom | Pixel hearts, coins, swords, potions, crowns, slimes, controller, rocket, UFO, GAME OVER / LEVEL UP! labels |
| Animals & frogs | Ribbit the frog in every mood, cats, dogs, birds |
| Characters, Stickers, Objects, Backgrounds, Templates | Blobs, speech bubbles, comic effects, everyday props, backdrops, Imgflip templates |

Everything bundled or in the catalog is original MemeFactory artwork. Characters owned by someone else — Pepe the Frog, Trollface, Nyan Cat, Doge, Success Kid, Bad Luck Brian, rage faces, Wojak and its variants — are **not** shipped with the app. Find them with **Online search** (Imgflip templates, Wikimedia Commons, Openverse), where each result shows its source and licence, or upload your own.

Regenerate the starter kit and sample catalog with `python3 scripts/generate-assets.py` (needs Pillow).

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

Safety checks, so a broken build never reaches users:

1. **Before tagging**, `release.sh` builds the frontend and runs the Rust tests locally, and stops if either fails.
2. **Before building installers**, the release workflow's `verify` job type-checks, builds and tests on Linux, Windows and macOS. Installers are built only if all three pass.
3. **After building**, each installer's app is launched for 20 seconds (`scripts/smoke-test.sh`) to catch crashes on startup. The Intel macOS build can't run on the Apple Silicon runner, so it's skipped.
4. **The release is a draft.** Publish it on the Releases page only when the Release run is fully green; download one installer and open it first.

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
