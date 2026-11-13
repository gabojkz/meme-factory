import { invoke } from "@tauri-apps/api/core";
import { videoFrames, videoMime, videoToGif } from "./videoToGif";

/** Something to add to the library: image bytes, or a link to download. */
export type QuickItem =
  | { kind: "blob"; blob: Blob; title: string | null }
  /** `fallback` is used when the download fails (e.g. the browser's still copy of a GIF). */
  | { kind: "url"; url: string; fallback?: { blob: Blob; title: string | null } };

export type Fetched = { blob: Blob; data: string; title: string | null; video: boolean };

const WEB_URL = /^https?:\/\/\S+$/i;

/** Links that are (or are likely) animated: .gif/.webp files and GIF hosts' media servers. */
const ANIMATED_URL = /\.(gif|webp)(?:[?#]|$)|^https?:\/\/(?:media\d*|i)\.giphy\.com\/|^https?:\/\/media\d*\.tenor\.com\//i;

export function looksAnimated(url: string): boolean {
  return ANIMATED_URL.test(url.trim());
}

export function isWebUrl(text: string): boolean {
  return WEB_URL.test(text.trim());
}

/** "funny-cat.png" → "funny cat"; generic names give null. */
export function titleFromName(name: string): string | null {
  const stem = name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_+]+/g, " ").trim();
  return !stem || /^(image|img|unknown|pasted image|screenshot)\b/i.test(stem) ? null : stem;
}

function firstImageSrc(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const src = doc.querySelector("img[src]")?.getAttribute("src");
  return src && isWebUrl(src) ? src : null;
}

/**
 * Reads what was pasted or dropped: image files first, otherwise a web link
 * (an image address, a page address, or the <img> a browser hands over).
 */
export function readTransfer(dt: DataTransfer | null): QuickItem[] {
  if (!dt) return [];
  const files = Array.from(dt.files).filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
  // Browsers' "Copy image" turns a GIF into a still PNG but also hand over the <img>
  // address — download the original so the animation survives.
  const fromHtml = firstImageSrc(dt.getData("text/html") || "");
  if (files.length === 1 && files[0].type.startsWith("image/") && files[0].type !== "image/gif" && fromHtml && looksAnimated(fromHtml)) {
    return [{ kind: "url", url: fromHtml, fallback: { blob: files[0], title: titleFromName(files[0].name) } }];
  }
  if (files.length) return files.map((f) => ({ kind: "blob", blob: f, title: titleFromName(f.name) }));

  const uris = (dt.getData("text/uri-list") || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && isWebUrl(l));
  // Browsers put the <img> itself in text/html; prefer it over a surrounding link.
  const text = (dt.getData("text/plain") || "").trim();
  const url = fromHtml ?? uris[0] ?? (isWebUrl(text) ? text : null);
  return url ? [{ kind: "url", url }] : [];
}

/** True when a drag carries something `readTransfer` could use. */
export function hasExternalPayload(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types);
  return types.includes("Files") || types.includes("text/uri-list") || types.includes("text/html");
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("Couldn’t read the image"));
    r.readAsDataURL(blob);
  });
}

/**
 * Downloads a link through the app (no CORS limits); pages resolve to their video
 * or preview image. `as`:
 * - "meme" keeps videos, except X-style "GIFs" (silent MP4s), which become real GIFs;
 * - "image" always returns a picture (a video's middle frame), for the Studio canvas.
 */
export async function fetchImage(
  url: string,
  onStatus?: (msg: string) => void,
  as: "meme" | "image" = "meme",
): Promise<Fetched> {
  const res = await invoke<{ data: string; ext: string; title: string | null; gifLike: boolean }>(
    "fetch_image_url",
    { url },
  );
  const bin = atob(res.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (res.ext === "mp4" || res.ext === "webm" || res.ext === "mov") {
    const video = new Blob([bytes], { type: videoMime(`x.${res.ext}`) });
    if (as === "image") {
      const [still] = await videoFrames(video, [0.5]);
      if (!still) throw new Error("Couldn’t take a picture from that video");
      return { blob: still, data: await blobToDataUrl(still), title: res.title, video: false };
    }
    if (!res.gifLike) return { blob: video, data: res.data, title: res.title, video: true };
    onStatus?.("Making a GIF…");
    const gif = await videoToGif(video, (pct) => onStatus?.(`Making a GIF… ${pct}%`)).catch((e) => {
      throw new Error(`Couldn’t turn that video into a GIF: ${e instanceof Error ? e.message : e}`);
    });
    return { blob: gif, data: await blobToDataUrl(gif), title: res.title, video: false };
  }
  const type = res.ext === "jpg" ? "image/jpeg" : `image/${res.ext}`;
  return { blob: new Blob([bytes], { type }), data: res.data, title: res.title, video: false };
}
