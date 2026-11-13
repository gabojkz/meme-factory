import { GIFEncoder, applyPalette, quantize } from "gifenc";

/** GIF frame delays are in hundredths of a second; 7 ≈ 14 fps keeps timing exact. */
const FRAME_CS = 7;
const MAX_SECONDS = 20;
const MAX_SIDE = 480;

function waitFor(v: HTMLVideoElement, event: string, ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { clear(); resolve(); };
    const fail = () => { clear(); reject(new Error("the video couldn’t be decoded")); };
    const timer = window.setTimeout(() => { clear(); reject(new Error("the video took too long to load")); }, ms);
    const clear = () => {
      window.clearTimeout(timer);
      v.removeEventListener(event, done);
      v.removeEventListener("error", fail);
    };
    v.addEventListener(event, done, { once: true });
    v.addEventListener("error", fail, { once: true });
  });
}

export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm"];

export function isVideoPath(path: string): boolean {
  const ext = path.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTENSIONS.includes(ext);
}

export function videoMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4";
}

/** Loads a video off-screen, runs `work`, and always cleans up. */
async function withVideo<T>(blob: Blob, work: (v: HTMLVideoElement) => Promise<T>): Promise<T> {
  const url = URL.createObjectURL(blob);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  // Some WebKit builds only decode frames for videos that are in the page.
  v.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(v);
  try {
    const loaded = waitFor(v, "loadeddata");
    v.src = url;
    await loaded;
    if (!v.videoWidth || !v.videoHeight) throw new Error("the video has no picture");
    return await work(v);
  } finally {
    v.removeAttribute("src");
    v.load();
    v.remove();
    URL.revokeObjectURL(url);
  }
}

async function seek(v: HTMLVideoElement, t: number) {
  if (Math.abs(v.currentTime - t) <= 1e-4) return;
  const seeked = waitFor(v, "seeked");
  v.currentTime = t;
  await seeked;
}

/**
 * Stills from a video at the given fractions of its length (0–1), as PNGs — for
 * reading the caption, or to use a video where only a picture fits.
 */
export function videoFrames(video: Blob, at: number[] = [0.5]): Promise<Blob[]> {
  return withVideo(video, async (v) => {
    const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas available");
    const out: Blob[] = [];
    for (const f of at) {
      await seek(v, Math.max(0, Math.min(duration - 0.05, duration * f)));
      ctx.drawImage(v, 0, 0);
      const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (png) out.push(png);
    }
    return out;
  });
}

/**
 * Turns a short MP4/WebM (how X, Giphy and others store "GIFs") into a looping
 * animated GIF, frame by frame, in the webview. Long clips are cut at 20 s.
 */
export function videoToGif(video: Blob, onProgress?: (pct: number) => void): Promise<Blob> {
  return withVideo(video, async (v) => {
    const scale = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.max(1, Math.round(v.videoWidth * scale));
    const h = Math.max(1, Math.round(v.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no canvas available");

    const duration = Number.isFinite(v.duration) && v.duration > 0 ? Math.min(v.duration, MAX_SECONDS) : FRAME_CS / 100;
    const step = FRAME_CS / 100;
    const count = Math.max(1, Math.round(duration / step));
    const gif = GIFEncoder();
    for (let i = 0; i < count; i++) {
      await seek(v, Math.min(i * step, Math.max(0, duration - 0.001)));
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(v, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      const palette = quantize(data, 256);
      gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay: FRAME_CS * 10 });
      onProgress?.(Math.round(((i + 1) / count) * 100));
    }
    gif.finish();
    return new Blob([gif.bytes() as BlobPart], { type: "image/gif" });
  });
}
