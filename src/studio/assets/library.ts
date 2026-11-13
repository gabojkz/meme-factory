// Asset library services. Every source (bundled starter kit, remote catalog,
// installed packs, uploads, online search) is normalised into `LibraryAsset`,
// and everything is inserted through `toProjectAsset`.

import { useSyncExternalStore } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readFile } from "@tauri-apps/plugin-fs";
import type { Asset } from "../model";
import { assetFromBlob } from "../render";
import starterRecords from "./starter.json";

export type Licensing = {
  license: string;
  licenseUrl: string | null;
  commercialUse: boolean | null;
  modification: boolean | null;
  redistribution: boolean | null;
  attributionRequired: boolean | null;
  verified: boolean;
  verifiedAt: string | null;
  declaredBy: string | null;
  attributionText: string | null;
};

export type AssetOrigin = "starter" | "catalog" | "online" | "pack" | "upload";

export type LibraryAsset = {
  id: string;
  name: string;
  description: string | null;
  category: string;
  subcategory: string | null;
  tags: string[];
  emotions: string[];
  style: string | null;
  format: string | null;
  dimensions: { width: number; height: number };
  transparent: boolean | null;
  file: { url: string | null; thumbnail: string | null; sizeBytes: number | null; checksum: string | null };
  packId: string | null;
  packName: string | null;
  version: number;
  source: { name: string | null; url: string | null };
  creator?: { name: string | null; url: string | null };
  licensing: Licensing;
  origin?: AssetOrigin;
  /** Set once a copy lives on disk. */
  storage?: "download" | "upload" | "pack";
  localPath?: string;
  downloadedAt?: string;
};

export type InstalledPack = {
  id: string;
  name: string;
  description: string | null;
  author: string | null;
  version: string;
  license: string | null;
  assetCount: number;
  sizeBytes: number;
  installedAt: string;
  origin: "zip" | "catalog";
  previewPath: string | null;
};

export type CatalogPack = {
  id: string;
  name: string;
  description: string | null;
  author: string | null;
  version: string;
  license: string | null;
  preview: string | null;
  downloadUrl: string;
  sizeBytes: number | null;
  checksum: string | null;
  assetCount: number;
};

export type StorageInfo = {
  total: number;
  packs: Record<string, number>;
  uploads: number;
  downloads: number;
  catalog: number;
};

export type LocalLibrary = {
  assets: LibraryAsset[];
  packs: InstalledPack[];
  favourites: LibraryAsset[];
  storage: StorageInfo;
};

export type Catalog = {
  assets: LibraryAsset[];
  packs: CatalogPack[];
  offline: boolean;
  fetchedAt: string | null;
  error?: string;
};

export type PackPreview = {
  manifest: { id: string; name: string; description: string | null; author: string | null; version: string; license: string | null };
  assets: { id: string; name: string; category: string; license: string }[];
  sizeBytes: number;
  installedVersion: string | null;
  duplicates: string[];
  preview: string | null;
};

/** In dev the catalog is served from this repo by Vite; releases use GitHub. */
export const CATALOG_URL = import.meta.env.DEV
  ? `${window.location.origin}/catalog/catalog.json`
  : "https://raw.githubusercontent.com/gabojkz/meme-factory/main/catalog/catalog.json";

export const STARTER: LibraryAsset[] = (starterRecords as unknown as LibraryAsset[]).map((a) => ({
  ...a,
  creator: { name: null, url: null },
  origin: "starter",
}));

export const CATEGORIES: { id: string; label: string }[] = [
  { id: "characters", label: "Characters" },
  { id: "reactions", label: "Reactions" },
  { id: "anime", label: "Anime & manga" },
  { id: "internet", label: "Internet characters" },
  { id: "classic", label: "Classic memes" },
  { id: "gaming", label: "Gaming & fandom" },
  { id: "animals", label: "Animals & frogs" },
  { id: "stickers", label: "Stickers" },
  { id: "objects", label: "Objects" },
  { id: "backgrounds", label: "Backgrounds" },
  { id: "templates", label: "Templates" },
];

export const EMOTION_ICONS: Record<string, string> = {
  happy: "😀", laughing: "😂", excited: "🤩", love: "😍", cool: "😎", smug: "😏", proud: "😤",
  neutral: "😐", thinking: "🤔", confused: "😕", sleepy: "😴", embarrassed: "😳",
  shocked: "😲", scared: "😱", sad: "😢", crying: "😭", angry: "😠", disgusted: "🤢",
};

export const EMOTIONS = Object.keys(EMOTION_ICONS);

/** Full-canvas images: inserted to cover the canvas, at the bottom of the stack. */
export function isBackground(a: LibraryAsset): boolean {
  return a.category === "backgrounds" || a.subcategory === "backgrounds";
}
export const STYLES = ["cartoon", "hand-drawn", "vector", "pixel art", "3d", "realistic", "sketch"];

export function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function isLocal(a: LibraryAsset): boolean {
  return a.origin === "starter" || !!a.localPath;
}

/** Thumbnail URL that works offline whenever a local copy exists. */
export function thumbSrc(a: LibraryAsset): string | null {
  if (a.localPath) return convertFileSrc(a.localPath);
  return a.file.thumbnail ?? a.file.url;
}

export function previewSrc(a: LibraryAsset): string | null {
  if (a.localPath) return convertFileSrc(a.localPath);
  return a.file.url ?? a.file.thumbnail;
}

// --------------------------------------------------------------- licensing

export type LicenceSummary = { tone: "ok" | "warn" | "unknown"; badge: string; commercial: string };

/** Honest wording: only MemeFactory-verified records may claim permissions. */
export function licenceSummary(l: Licensing): LicenceSummary {
  if (l.verified) {
    return {
      tone: l.commercialUse ? "ok" : "warn",
      badge: "Verified licence",
      commercial: l.commercialUse ? "Commercial use allowed" : "Not for commercial use",
    };
  }
  if (l.commercialUse === false) {
    return { tone: "warn", badge: "Licence declared by source", commercial: "Personal / non-commercial use only" };
  }
  if (l.commercialUse === true) {
    return {
      tone: "warn",
      badge: "Licence declared by source — not verified",
      commercial: "Source says commercial use is allowed — double-check before relying on it",
    };
  }
  return { tone: "unknown", badge: "Unknown licence", commercial: "Unknown — check the source before any commercial use" };
}

export type LicenceFilter = "" | "commercial" | "attribution" | "public" | "personal" | "unknown";

function matchesLicence(a: LibraryAsset, f: LicenceFilter): boolean {
  const l = a.licensing;
  switch (f) {
    case "commercial":
      return l.verified && l.commercialUse === true;
    case "attribution":
      return l.attributionRequired === true;
    case "public":
      return /cc0|public domain/i.test(l.license);
    case "personal":
      return l.commercialUse === false;
    case "unknown":
      return !l.verified && l.commercialUse == null;
    default:
      return true;
  }
}

// ----------------------------------------------------------------- search

export type Filters = {
  emotion: string;
  style: string;
  format: string;
  background: "" | "transparent" | "solid";
  licence: LicenceFilter;
};

export const NO_FILTERS: Filters = { emotion: "", style: "", format: "", background: "", licence: "" };

export function applyFilters(list: LibraryAsset[], f: Filters): LibraryAsset[] {
  return list.filter(
    (a) =>
      (!f.emotion || a.emotions.includes(f.emotion)) &&
      (!f.style || a.style === f.style) &&
      (!f.format || (a.format === "jpeg" ? "jpg" : a.format) === f.format) &&
      (!f.background || (f.background === "transparent" ? a.transparent === true : a.transparent === false)) &&
      matchesLicence(a, f.licence),
  );
}

function stem(w: string): string {
  if (w.length <= 4) return w;
  const s = w.replace(/(ing|ed|es|s)$/, "");
  // "sitting" → "sitt" → "sit"
  return /([^aeiou])\1$/.test(s) ? s.slice(0, -1) : s;
}

/**
 * Metadata search. Matches in the name rank highest, then category, tags,
 * emotions, description and pack. If nothing matches every word (common
 * with natural-language queries), results matching at least half the words
 * are returned, ranked by how many they hit.
 */
export function searchAssets(list: LibraryAsset[], query: string): LibraryAsset[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w && !STOP_WORDS.has(w));
  if (!words.length) return list;
  const exact = query.trim().toLowerCase();
  const scored: { a: LibraryAsset; score: number; hits: number }[] = [];
  for (const a of list) {
    let score = a.name.toLowerCase() === exact ? 100 : 0;
    let hits = 0;
    for (const w of words) {
      const st = stem(w);
      const has = (s: string | null | undefined) => !!s && s.toLowerCase().includes(st);
      let best = 0;
      if (has(a.name)) best = 40;
      else if (has(a.category) || has(a.subcategory)) best = 25;
      else if (a.tags.some(has)) best = 20;
      else if (a.emotions.some(has)) best = 15;
      else if (has(a.description)) best = 10;
      else if (has(a.style) || has(a.packName)) best = 8;
      if (w === "transparent" && a.transparent) best = Math.max(best, 12);
      if (best) hits++;
      score += best;
    }
    if (hits) scored.push({ a, score, hits });
  }
  const all = scored.filter((s) => s.hits === words.length);
  const pool = all.length ? all : scored.filter((s) => s.hits >= Math.ceil(words.length / 2));
  return pool.sort((x, y) => y.hits - x.hits || y.score - x.score).map((s) => s.a);
}

/** Well-known meme names, so typos like "wodjak" still find "wojak". */
export const MEME_TERMS = [
  "wojak", "doomer", "bloomer", "zoomer", "soyjak", "chad", "gigachad", "npc", "pepe", "apu", "doge",
  "cheems", "trollface", "stonks", "drake", "harold", "kermit", "grumpy", "nyan", "shiba", "rage",
  "forever", "alone", "gusta", "distracted", "boyfriend", "spongebob", "pikachu", "galaxy", "brain",
  "feels", "anime", "manga", "chibi", "kawaii", "waifu", "senpai", "advice", "success", "brian",
  "trad", "nordic", "frog", "smug", "gamer", "trollge", "rickroll", "amogus", "among",
];

/** Optimal string alignment distance (Levenshtein + adjacent swaps). */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * Fixes likely typos against a vocabulary. Returns the corrected query, or
 * null when nothing needed changing.
 */
export function correctQuery(query: string, vocab: Iterable<string>): string | null {
  const known = new Set([...vocab].map((v) => v.toLowerCase()));
  let changed = false;
  const words = query.split(/(\s+)/).map((raw) => {
    const w = raw.toLowerCase();
    if (w.length < 4 || known.has(w) || STOP_WORDS.has(w) || /\s/.test(w)) return raw;
    const max = w.length >= 8 ? 2 : 1;
    let best: string | null = null;
    let bestD = max + 1;
    for (const k of known) {
      if (Math.abs(k.length - w.length) > max) continue;
      const dist = editDistance(w, k);
      if (dist < bestD) {
        best = k;
        bestD = dist;
      }
    }
    if (!best) return raw;
    changed = true;
    return best;
  });
  return changed ? words.join("") : null;
}

/** Words used by local assets (names, tags, categories) for typo correction. */
export function vocabulary(list: LibraryAsset[]): Set<string> {
  const out = new Set(MEME_TERMS);
  for (const a of list) {
    for (const text of [a.name, a.category, a.subcategory ?? "", ...a.tags, ...a.emotions]) {
      for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3) out.add(w);
    }
  }
  return out;
}

export function webImageSearchUrl(query: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(`${query} transparent png`)}&iax=images&ia=images`;
}

const STOP_WORDS = new Set(["a", "an", "the", "of", "at", "on", "in", "with", "and", "or", "to", "is", "png", "image", "picture", "meme", "some"]);

// ---------------------------------------------------------------- catalog

function resolveUrl(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

export async function loadCatalog(): Promise<Catalog> {
  const res = await invoke<{ data: { assets?: unknown[]; packs?: CatalogPack[] }; fetchedAt: string; offline: boolean; error?: string }>(
    "catalog_fetch",
    { url: CATALOG_URL },
  );
  const rawAssets = (res.data.assets ?? []).map((a) => {
    const rec = a as LibraryAsset;
    return {
      ...rec,
      file: {
        ...rec.file,
        url: resolveUrl(rec.file?.url, CATALOG_URL),
        thumbnail: resolveUrl(rec.file?.thumbnail, CATALOG_URL),
      },
    };
  });
  const assets = await invoke<LibraryAsset[]>("catalog_sanitize", { assets: rawAssets });
  const packs = (res.data.packs ?? [])
    .map((p) => ({
      ...p,
      preview: resolveUrl(p.preview, CATALOG_URL),
      downloadUrl: resolveUrl(p.downloadUrl, CATALOG_URL) ?? "",
    }))
    .filter((p) => p.id && p.downloadUrl);
  return { assets, packs, offline: res.offline, fetchedAt: res.fetchedAt, error: res.error };
}

export async function loadLocal(): Promise<LocalLibrary> {
  return invoke<LocalLibrary>("library_state");
}

export async function searchOnline(
  provider: "openverse" | "wikimedia" | "imgflip",
  query: string,
  page: number,
  opts: { commercial: boolean; transparent: boolean },
): Promise<{ results: LibraryAsset[]; hasMore: boolean }> {
  return invoke("online_search", { provider, query, page, commercial: opts.commercial, transparent: opts.transparent });
}

// ------------------------------------------------------- download manager

export type JobState = "queued" | "downloading" | "done" | "failed" | "cancelled";

export type Job = {
  id: string;
  kind: "asset" | "pack";
  name: string;
  state: JobState;
  received: number;
  total: number | null;
  error?: string;
  startedAt: number;
};

const MAX_CONCURRENT = 3;

type Task = { job: Job; run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };

class DownloadManager {
  private jobs = new Map<string, Job>();
  private inflight = new Map<string, Promise<unknown>>();
  private tasks = new Map<string, Task>();
  private queue: string[] = [];
  private running = 0;
  private listeners = new Set<() => void>();
  private snapshot: Job[] = [];
  private listening = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    if (!this.listening) {
      this.listening = true;
      void listen<{ id: string; received: number; total: number | null }>("library-progress", (e) => {
        const key = this.jobs.has(e.payload.id) ? e.payload.id : `asset:${e.payload.id}`;
        const job = this.jobs.get(key);
        if (job && job.state === "downloading") this.update(key, { received: e.payload.received, total: e.payload.total });
      });
    }
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    this.listeners.forEach((fn) => fn());
  }

  private update(key: string, patch: Partial<Job>) {
    const job = this.jobs.get(key);
    if (!job) return;
    this.jobs.set(key, { ...job, ...patch });
    this.emit();
  }

  /** Queues work under a stable key; repeated requests share one download. */
  enqueue<T>(key: string, kind: Job["kind"], name: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const job: Job = { id: key, kind, name, state: "queued", received: 0, total: null, startedAt: Date.now() };
    this.jobs.set(key, job);
    const p = new Promise<unknown>((resolve, reject) => {
      this.tasks.set(key, { job, run, resolve, reject });
      this.queue.push(key);
    });
    this.inflight.set(key, p);
    p.catch(() => {}).finally(() => this.inflight.delete(key));
    this.emit();
    this.pump();
    return p as Promise<T>;
  }

  private pump() {
    while (this.running < MAX_CONCURRENT && this.queue.length) {
      const key = this.queue.shift()!;
      const task = this.tasks.get(key);
      if (!task) continue;
      this.running++;
      this.update(key, { state: "downloading" });
      task
        .run()
        .then(
          (v) => {
            this.update(key, { state: "done", received: this.jobs.get(key)?.total ?? this.jobs.get(key)?.received ?? 0 });
            task.resolve(v);
          },
          (e) => {
            const msg = errText(e);
            this.update(key, { state: msg === "Cancelled" ? "cancelled" : "failed", error: msg });
            task.reject(e);
          },
        )
        .finally(() => {
          this.running--;
          this.tasks.delete(key);
          this.pump();
        });
    }
  }

  async cancel(key: string) {
    const queued = this.queue.indexOf(key);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      const task = this.tasks.get(key);
      this.tasks.delete(key);
      this.update(key, { state: "cancelled", error: "Cancelled" });
      task?.reject(new Error("Cancelled"));
      return;
    }
    // Backend job ids: assets use their id, packs use `pack:<id>`.
    await invoke("library_cancel", { id: key.startsWith("asset:") ? key.slice(6) : key });
  }

  clearFinished() {
    for (const [k, j] of this.jobs) if (j.state !== "queued" && j.state !== "downloading") this.jobs.delete(k);
    this.emit();
  }
}

export const downloads = new DownloadManager();

export function useDownloads(): Job[] {
  return useSyncExternalStore(downloads.subscribe, downloads.getSnapshot);
}

/** Makes sure an asset has a validated local copy (downloads if needed). */
export function ensureLocal(a: LibraryAsset): Promise<LibraryAsset> {
  if (isLocal(a)) return Promise.resolve(a);
  if (!a.file.url) return Promise.reject(new Error("This asset can’t be downloaded"));
  if (!navigator.onLine) return Promise.reject(new Error("You’re offline — this asset isn’t downloaded yet"));
  return downloads.enqueue(`asset:${a.id}`, "asset", a.name, () => invoke<LibraryAsset>("library_download", { record: a }));
}

export function installRemotePack(p: CatalogPack): Promise<InstalledPack> {
  if (!navigator.onLine) return Promise.reject(new Error("You’re offline"));
  return downloads.enqueue(`pack:${p.id}`, "pack", p.name, () => invoke<InstalledPack>("pack_install_remote", { pack: p }));
}

// -------------------------------------------------------------- insertion

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/**
 * Turns any library asset into a project asset with an embedded copy of the
 * image, so projects never depend on packs or caches staying installed.
 */
export async function toProjectAsset(a: LibraryAsset): Promise<Asset> {
  const local = await ensureLocal(a);
  let blob: Blob;
  if (local.localPath) {
    const ext = local.localPath.split(".").pop()?.toLowerCase() ?? "png";
    blob = new Blob([await readFile(local.localPath)], { type: MIME[ext] ?? "image/png" });
  } else {
    const res = await fetch(local.file.url!);
    if (!res.ok) throw new Error(`Couldn’t load ${a.name}`);
    blob = await res.blob();
  }
  const asset = await assetFromBlob(blob, a.name);
  // A stable id lets repeated inserts of the same asset share one embedded copy.
  return { ...asset, id: `lib-${a.id}`, name: a.name };
}
