// Downloads the pinned yt-dlp build that MemeFactory bundles (as a Tauri sidecar)
// to save videos from Instagram, TikTok and YouTube links.
// Runs on `npm install` / `npm ci`. Every file is checked against the SHA-256
// pinned below, so a tampered or wrong download fails the build.
//
// To update: pick a release at https://github.com/yt-dlp/yt-dlp/releases, set
// VERSION, and copy the four hashes from that release's SHA2-256SUMS.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2026.10.26";
const ASSETS = {
  "yt-dlp_macos": "0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa",
  "yt-dlp.exe": "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d",
  "yt-dlp_linux": "767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795",
  "yt-dlp_linux_aarch64": "e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483",
};

// Tauri looks for binaries/<name>-<target triple>[.exe]. The name is prefixed so the
// Linux .deb doesn't clash with a system yt-dlp in /usr/bin. macOS builds both
// architectures from one machine, and yt-dlp_macos is universal, so it gets both names.
const PLATFORMS = {
  "darwin-arm64": ["yt-dlp_macos", ["aarch64-apple-darwin", "x86_64-apple-darwin"]],
  "darwin-x64": ["yt-dlp_macos", ["aarch64-apple-darwin", "x86_64-apple-darwin"]],
  "win32-x64": ["yt-dlp.exe", ["x86_64-pc-windows-msvc"]],
  "linux-x64": ["yt-dlp_linux", ["x86_64-unknown-linux-gnu"]],
  "linux-arm64": ["yt-dlp_linux_aarch64", ["aarch64-unknown-linux-gnu"]],
};

const key = `${process.platform}-${process.arch}`;
const platform = PLATFORMS[key];
if (!platform) {
  console.error(`✗ yt-dlp: no bundled build for ${key}. Supported: ${Object.keys(PLATFORMS).join(", ")}`);
  process.exit(1);
}
const [asset, triples] = platform;
const expected = ASSETS[asset];
const ext = process.platform === "win32" ? ".exe" : "";
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "binaries");
const targets = triples.map((t) => join(dir, `memefactory-yt-dlp-${t}${ext}`));

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const isCurrent = (file) => existsSync(file) && sha256(readFileSync(file)) === expected;

if (targets.every(isCurrent)) {
  console.log(`✓ yt-dlp ${VERSION} already present`);
  process.exit(0);
}

const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/${asset}`;
console.log(`→ Downloading yt-dlp ${VERSION} (${asset})`);
let data;
for (let attempt = 1; ; attempt++) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
    break;
  } catch (e) {
    if (attempt >= 3) {
      console.error(`✗ yt-dlp download failed: ${e.message}\n  ${url}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

const actual = sha256(data);
if (actual !== expected) {
  console.error(`✗ yt-dlp checksum mismatch for ${asset}\n  expected ${expected}\n  got      ${actual}`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
for (const target of targets) {
  const tmp = `${target}.part`;
  writeFileSync(tmp, data);
  chmodSync(tmp, 0o755);
  renameSync(tmp, target);
}
console.log(`✓ yt-dlp ${VERSION} verified → ${targets.map((t) => t.split(/[\\/]/).pop()).join(", ")}`);
