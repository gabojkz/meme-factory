import { type DragEvent as ReactDragEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import Tesseract from "tesseract.js";
import Studio from "./studio/Studio";
import {
  blobToDataUrl,
  fetchImage,
  hasExternalPayload,
  isWebUrl,
  readTransfer,
  type QuickItem,
} from "./quickAdd";
import "./App.css";
import { DangerZone, ErasedScreen, type EraseReport } from "./DangerZone";
import { VIDEO_EXTENSIONS, isVideoPath, videoFrames, videoMime } from "./videoToGif";
import {
  ANY_TIME,
  DATE_LABEL,
  SORT_LABEL,
  filterByDate,
  formatBytes,
  fullAdded,
  shortAdded,
  sortMemes,
  type DateFilter,
  type DatePreset,
  type SortOrder,
} from "./libraryView";

const REPO_URL = "https://github.com/gabojkz/meme-factory";
const ISSUES_URL = `${REPO_URL}/issues`;
const RELEASES_URL = `${REPO_URL}/releases/latest`;
const LATEST_RELEASE_API =
  "https://api.github.com/repos/gabojkz/meme-factory/releases/latest";
const COFFEE_URL = "https://www.buymeacoffee.com/gaboz";
const SHARE_TEXT = `MemeFactory — free local meme library with OCR search. ${REPO_URL}`;
const PASTE_KEY = /Mac/i.test(navigator.userAgent) ? "⌘V" : "Ctrl+V";
/** Sites can't receive a local file by URL, so we copy the image and open the composer. */
const SOCIALS = [
  { name: "X", url: "https://x.com/compose/post" },
  { name: "Facebook", url: "https://www.facebook.com/" },
  { name: "Reddit", url: "https://www.reddit.com/submit?type=IMAGE" },
  { name: "WhatsApp", url: "https://web.whatsapp.com/" },
  { name: "Telegram", url: "https://web.telegram.org/" },
  { name: "Discord", url: "https://discord.com/channels/@me" },
  { name: "Bluesky", url: "https://bsky.app/intent/compose" },
];

type Meme = {
  id: string;
  filename: string;
  path: string;
  title: string | null;
  ocrText: string;
  createdAt: string;
  tags: string[];
};

type TagCount = { tag: string; count: number };
type KindStats = { count: number; bytes: number };
type LibraryStats = {
  total: number;
  images: KindStats;
  gifs: KindStats;
  videos: KindStats;
  folderBytes: number;
  folder: string;
};

type AppSettings = {
  memesDir: string;
  defaultDir: string;
  isDefault: boolean;
};

type SyncReport = {
  moved: number;
  indexed: number;
  total: number;
};

type UpdateCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current"; latest: string }
  | { status: "available"; latest: string }
  | { status: "error"; message: string };

type View = "library" | "studio" | "settings" | "about";

function formatSync(report: SyncReport): string {
  const bits = [];
  if (report.moved) bits.push(`moved ${report.moved}`);
  if (report.indexed) bits.push(`found ${report.indexed} new`);
  if (bits.length === 0) return `Library synced · ${report.total} memes`;
  return `${bits.join(", ")} · ${report.total} total`;
}

function parseVersion(raw: string): number[] {
  return raw
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part.replace(/[^0-9].*$/, ""), 10) || 0);
}

function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

async function fetchLatestVersion(): Promise<string> {
  const res = await fetch(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`Couldn’t reach GitHub (${res.status})`);
  const data = (await res.json()) as { tag_name?: string };
  if (!data.tag_name) throw new Error("No release found");
  return data.tag_name.replace(/^v/i, "");
}

/** Must match ALREADY_SAVED in src-tauri/src/lib.rs. */
const ALREADY_SAVED = "That meme is already in your library";

/** "2 memes saved · 1 already in your library" */
function savedText(ok: number, dupes: number): string {
  if (!ok && dupes) return dupes === 1 ? ALREADY_SAVED : `All ${dupes} are already in your library`;
  const saved = ok === 1 ? "1 meme saved" : `${ok} memes saved`;
  return dupes ? `${saved} · ${dupes} already in your library` : saved;
}

function App() {
  const [ready, setReady] = useState(false);
  const [inTauri, setInTauri] = useState(false);
  const [view, setView] = useState<View>("library");
  const [memes, setMemes] = useState<Meme[]>([]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  // Set once "Erase everything" has run: the app shows only the goodbye screen.
  const [erased, setErased] = useState<EraseReport | null>(null);
  // Which kinds the grid shows; null = everything. Remembered between launches.
  const [shownKinds, setShownKinds] = useState<MemeKind[] | null>(loadShownKinds);
  useEffect(() => {
    try {
      if (shownKinds) localStorage.setItem(KINDS_KEY, JSON.stringify(shownKinds));
      else localStorage.removeItem(KINDS_KEY);
    } catch {
      // storage unavailable: the filter just isn't remembered
    }
  }, [shownKinds]);
  const [sortOrder, setSortOrder] = useStoredState<SortOrder>(SORT_KEY, "newest", (v) => typeof v === "string" && v in SORT_LABEL);
  const [dateFilter, setDateFilter] = useStoredState<DateFilter>(
    DATE_KEY,
    ANY_TIME,
    (v) => !!v && typeof v === "object" && (v as DateFilter).preset in DATE_LABEL,
  );

  /** First click shows only that kind; further clicks add or remove kinds. */
  function toggleKind(kind: MemeKind) {
    setView("library");
    setShownKinds((cur) => {
      if (!cur) return [kind];
      const next = cur.includes(kind) ? cur.filter((k) => k !== kind) : [...cur, kind];
      return next.length === 0 || next.length === KINDS.length ? null : next;
    });
  }
  // Any add, delete, rescan or folder change shows up as a new `memes` list.
  useEffect(() => {
    invoke<LibraryStats>("library_stats").then(setStats, () => setStats(null));
  }, [memes]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck>({ status: "idle" });
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  // "Best match" only means something while searching.
  const effectiveSort: SortOrder = sortOrder === "relevance" && !searching ? "newest" : sortOrder;
  const kindFiltered = shownKinds ? memes.filter((m) => shownKinds.includes(memeKind(m.path))) : memes;
  const visibleMemes = sortMemes(filterByDate(kindFiltered, dateFilter), effectiveSort);
  const filtering = !!shownKinds || dateFilter.preset !== "all";
  function clearFilters() {
    setShownKinds(null);
    setDateFilter(ANY_TIME);
  }
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<Meme | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [selected]);
  const [remixPath, setRemixPath] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [allTags, setAllTags] = useState<TagCount[]>([]);
  const [dragging, setDragging] = useState(false);
  const searchTimer = useRef<number | null>(null);

  const loadAll = useCallback(async () => {
    const rows = await invoke<Meme[]>("list_memes");
    setMemes(rows);
  }, []);

  const loadSettings = useCallback(async () => {
    const next = await invoke<AppSettings>("get_settings");
    setSettings(next);
  }, []);

  const loadTags = useCallback(async () => {
    setAllTags(await invoke<TagCount[]>("list_tags"));
  }, []);

  const runSearch = useCallback(async (q: string) => {
    const rows = await invoke<Meme[]>("search_memes", { query: q });
    setMemes(rows);
  }, []);

  const checkForUpdates = useCallback(
    async (currentVersion: string, opts?: { quiet?: boolean }) => {
      const quiet = opts?.quiet ?? false;
      if (!currentVersion) return;
      setUpdateCheck({ status: "checking" });
      try {
        const latest = await fetchLatestVersion();
        if (isNewerVersion(latest, currentVersion)) {
          setUpdateCheck({ status: "available", latest });
          setStatus(`Update available · v${latest}`);
        } else {
          setUpdateCheck({ status: "current", latest });
          if (!quiet) setStatus(`You’re on the latest · v${latest}`);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setUpdateCheck({ status: "error", message });
        if (!quiet) setStatus(message);
      }
    },
    [],
  );

  useEffect(() => {
    const ok = isTauri();
    setInTauri(ok);
    setReady(true);
    if (!ok) return;
    (async () => {
      try {
        const [version] = await Promise.all([
          getVersion(),
          invoke<SyncReport>("sync_library"),
        ]);
        setAppVersion(version);
        await Promise.all([loadAll(), loadSettings(), loadTags()]);
        void checkForUpdates(version, { quiet: true });
      } catch (e) {
        setStatus(String(e));
      }
    })();
  }, [loadAll, loadSettings, loadTags, checkForUpdates]);

  useEffect(() => {
    if (!inTauri || view !== "library") return;
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      runSearch(query).catch((e) => setStatus(String(e)));
    }, 120);
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    };
  }, [query, runSearch, inTauri, view]);

  async function ocrImage(path: string): Promise<string> {
    return ocrBlob(await readMemeFile(path));
  }

  async function ocrBlob(blob: Blob): Promise<string> {
    if (blob.type.startsWith("video/")) {
      // Captions can change during a clip: read three stills and keep each new line.
      const texts: string[] = [];
      for (const still of await videoFrames(blob, [0.15, 0.5, 0.85])) {
        const t = await ocrBlob(still);
        if (t && !texts.some((x) => x.includes(t))) texts.push(t);
      }
      return texts.filter((t) => !texts.some((x) => x !== t && x.includes(t))).join(" ");
    }
    // Hand Tesseract the pixels directly: a blob: URL makes it fetch(), which
    // the CSP may refuse — and that used to fail silently.
    const { data } = await Tesseract.recognize(await prepareForOcr(blob), "eng", {
      logger: () => {},
    });
    return (data.text || "").replace(/\s+/g, " ").trim();
  }

  /** OCR that reports failures instead of saving empty text silently. */
  async function scanText(blob: Blob): Promise<{ text: string; error: string | null }> {
    try {
      return { text: await ocrBlob(blob), error: null };
    } catch (e) {
      return { text: "", error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function onRescan(meme: Meme) {
    setBusy(true);
    setStatus("Scanning text…");
    try {
      const { text, error } = await scanText(await readMemeFile(meme.path));
      if (error) throw new Error(error);
      await invoke("update_meme_ocr", { id: meme.id, ocrText: text });
      const next = { ...meme, ocrText: text };
      setSelected((cur) => (cur?.id === meme.id ? next : cur));
      setMemes((list) => list.map((m) => (m.id === meme.id ? next : m)));
      setStatus(
        text
          ? `Text found: “${text.length > 60 ? `${text.slice(0, 60)}…` : text}”`
          : `No text found in this ${isVideoPath(meme.path) ? "video" : "image"}`,
      );
    } catch (e) {
      setStatus(`Couldn’t read the text: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    const picked = await open({
      multiple: true,
      filters: [
        {
          name: "Images and videos",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", ...VIDEO_EXTENSIONS],
        },
      ],
    });
    if (!picked) return;

    const paths = Array.isArray(picked) ? picked : [picked];
    setBusy(true);
    let ok = 0;
    let dupes = 0;

    try {
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        setStatus(`Scanning ${i + 1}/${paths.length}…`);
        let text = "";
        try {
          text = await ocrImage(path);
        } catch {
          text = "";
        }
        try {
          await invoke<Meme>("import_meme", {
            sourcePath: path,
            ocrText: text,
            title: null,
          });
          ok += 1;
        } catch (e) {
          if (String(e) !== ALREADY_SAVED) throw e;
          dupes += 1;
        }
      }
      setStatus(savedText(ok, dupes));
      await runSearch(query);
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Paste, drop and link-box imports all land here. */
  async function quickAdd(items: QuickItem[]) {
    if (!items.length) return;
    setBusy(true);
    let ok = 0;
    let dupes = 0;
    let lastError = "";
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const n = items.length > 1 ? ` ${i + 1}/${items.length}` : "";
      try {
        let blob: Blob;
        let data: string;
        let title: string | null;
        if (item.kind === "url") {
          setStatus(`Downloading${n}…`);
          try {
            ({ blob, data, title } = await fetchImage(item.url, (msg) => setStatus(msg + n)));
          } catch (err) {
            if (!item.fallback) throw err;
            // Keep the still copy rather than nothing.
            blob = item.fallback.blob;
            data = await blobToDataUrl(blob);
            title = item.fallback.title;
          }
        } else {
          blob = item.blob;
          data = await blobToDataUrl(blob);
          title = item.title;
        }
        // Already saved (e.g. a meme dragged from the grid back onto it): skip the scan.
        if (await invoke<string | null>("existing_meme", { data })) {
          dupes += 1;
          continue;
        }
        setStatus(`Scanning text${n}…`);
        const { text, error } = await scanText(blob);
        await invoke<Meme>("import_meme_bytes", { data, title, ocrText: text });
        ok += 1;
        if (error) lastError = `text couldn’t be read (${error}) — open the meme and use Scan text again`;
      } catch (e) {
        if (String(e) === ALREADY_SAVED) dupes += 1;
        else lastError = String(e);
      }
    }
    setBusy(false);
    await runSearch(query).catch(() => {});
    const saved = savedText(ok, dupes);
    setStatus(lastError ? (ok || dupes ? `${saved} · ${lastError}` : lastError) : saved);
    return ok > 0 || dupes > 0;
  }

  async function onAddLink(e?: FormEvent, value = link) {
    e?.preventDefault();
    const url = value.trim();
    if (!url || busy) return;
    if (!isWebUrl(url)) {
      setStatus("That doesn’t look like a link — it should start with https://");
      return;
    }
    if (await quickAdd([{ kind: "url", url }])) setLink("");
  }

  // ⌘V / Ctrl+V anywhere in the library: an image, or an image/page link.
  const quickAddRef = useRef(quickAdd);
  const dragIcons = useRef(new Map<string, Promise<string>>());
  quickAddRef.current = quickAdd;
  useEffect(() => {
    if (view !== "library" || selected) return;
    function onPaste(e: ClipboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".quick-add")) return; // the link box handles itself
      const items = readTransfer(e.clipboardData);
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      // Text pasted into the search box stays text; images are always imported.
      if (!items.length || (typing && items[0].kind === "url")) return;
      e.preventDefault();
      void quickAddRef.current(items);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [view, selected]);

  // The webview opens any file dropped where nothing handles it (a video would
  // take over the whole window). Refuse every drop nobody claimed.
  useEffect(() => {
    function refuse(e: DragEvent) {
      if (e.defaultPrevented) return; // a drop zone (library, Studio) took it
      e.preventDefault();
      if (e.type === "dragover" && e.dataTransfer) e.dataTransfer.dropEffect = "none";
    }
    window.addEventListener("dragover", refuse);
    window.addEventListener("drop", refuse);
    return () => {
      window.removeEventListener("dragover", refuse);
      window.removeEventListener("drop", refuse);
    };
  }, []);

  // Drag images (files or straight from a web page) onto the library.
  useEffect(() => {
    if (view !== "library") return;
    let depth = 0;
    function onEnter(e: DragEvent) {
      if (!hasExternalPayload(e.dataTransfer)) return;
      depth += 1;
      setDragging(true);
    }
    function onOver(e: DragEvent) {
      if (!hasExternalPayload(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }
    function onLeave(e: DragEvent) {
      if (!hasExternalPayload(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    }
    function onDrop(e: DragEvent) {
      depth = 0;
      setDragging(false);
      const items = readTransfer(e.dataTransfer);
      if (!items.length) return;
      e.preventDefault();
      void quickAddRef.current(items);
    }
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      setDragging(false);
    };
  }, [view]);

  async function onTagsChange(meme: Meme, tags: string[]) {
    try {
      const saved = await invoke<string[]>("update_meme_tags", { id: meme.id, tags });
      const next = { ...meme, tags: saved };
      setSelected((cur) => (cur?.id === meme.id ? next : cur));
      setMemes((list) => list.map((m) => (m.id === meme.id ? next : m)));
      await loadTags();
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onDelete(meme: Meme) {
    try {
      await invoke("delete_meme", { id: meme.id });
      if (selected?.id === meme.id) setSelected(null);
      await runSearch(query);
      await loadTags();
      setStatus("Deleted");
    } catch (e) {
      setStatus(String(e));
    }
  }

  // Drag a meme out as a real file: into a browser post, chat, Finder, any app.
  function dragIcon(id: string) {
    let icon = dragIcons.current.get(id);
    if (!icon) {
      icon = invoke<string>("drag_icon", { id });
      icon.catch(() => dragIcons.current.delete(id));
      dragIcons.current.set(id, icon);
    }
    return icon;
  }
  function dragProps(meme: Meme) {
    return {
      draggable: true,
      onPointerEnter: () => void dragIcon(meme.id).catch(() => {}),
      onDragStart: (e: ReactDragEvent) => {
        e.preventDefault();
        void dragOut(meme);
      },
    };
  }
  // Dropping it back onto the library is harmless: imports skip memes already saved.
  async function dragOut(meme: Meme) {
    try {
      const icon = await dragIcon(meme.id);
      await startDrag({ item: [meme.path], icon, mode: "copy" });
    } catch (e) {
      setStatus(`Couldn’t drag that meme: ${String(e)}`);
    }
  }

  async function onCopy(meme: Meme) {
    try {
      const how = await invoke<CopyKind>("copy_meme", { id: meme.id });
      setStatus(
        how === "video"
          ? "Copied video — paste it into a chat or post"
          : how === "file"
            ? "Copied animated GIF — paste it to keep the animation"
            : "Copied image",
      );
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onShareTo(meme: Meme, site: (typeof SOCIALS)[number]) {
    try {
      const how = await invoke<CopyKind>("copy_meme", { id: meme.id });
      await openUrl(site.url);
      const what = how === "video" ? "Video" : how === "file" ? "GIF" : "Image";
      setStatus(`${what} copied — paste it into ${site.name} with ${PASTE_KEY}`);
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onChooseFolder() {
    const picked = await open({
      directory: true,
      multiple: false,
    });
    if (!picked || Array.isArray(picked)) return;
    try {
      setBusy(true);
      setStatus("Syncing library…");
      const [next, report] = await invoke<[AppSettings, SyncReport]>(
        "set_memes_folder",
        { path: picked },
      );
      setSettings(next);
      await loadAll();
      setStatus(formatSync(report));
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onResetFolder() {
    try {
      setBusy(true);
      setStatus("Syncing library…");
      const [next, report] = await invoke<[AppSettings, SyncReport]>(
        "reset_memes_folder",
      );
      setSettings(next);
      await loadAll();
      setStatus(formatSync(report));
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onRescanFolder() {
    try {
      setBusy(true);
      setStatus("Scanning folder…");
      const report = await invoke<SyncReport>("sync_library");
      await loadAll();
      setStatus(formatSync(report));
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onShare() {
    try {
      await navigator.clipboard.writeText(SHARE_TEXT);
      setStatus("Share link copied");
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onCoffee() {
    try {
      await openUrl(COFFEE_URL);
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onOpenRepo() {
    try {
      await openUrl(REPO_URL);
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onOpenIssues() {
    try {
      await openUrl(ISSUES_URL);
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onOpenReleases() {
    try {
      await openUrl(RELEASES_URL);
    } catch (e) {
      setStatus(String(e));
    }
  }

  if (!ready) return null;

  if (!inTauri) {
    return (
      <div className="stage">
        <div className="halftone" aria-hidden />
        <div className="empty">
          <div className="bubble">
            <strong>Open the desktop app</strong>
            <span>
              This page has no Tauri bridge. Run{" "}
              <code>npm run tauri dev</code> and use the MemeFactory window —
              not the browser tab.
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (erased) {
    return (
      <div className="stage">
        <div className="halftone" aria-hidden />
        <ErasedScreen report={erased} />
      </div>
    );
  }

  return (
    <div className="stage">
      <div className="halftone" aria-hidden />
      <header className="top">
        <div className="brand">
          <h1>MemeFactory</h1>
          <p>stash · scan · find · make</p>
        </div>
        {view === "library" ? (
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(query);
            }}
          >
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search text, titles or #tags…"
              aria-label="Search memes"
            />
          </form>
        ) : (
          <div className="search-spacer" />
        )}
        <div className="top-end">
        {stats ? (
          <div
            className="stats"
            role="group"
            aria-label="Show memes by type"
            title={[
              `Folder: ${stats.folder}`,
              `Images: ${stats.images.count} · ${formatBytes(stats.images.bytes)}`,
              `GIFs: ${stats.gifs.count} · ${formatBytes(stats.gifs.bytes)}`,
              `Videos: ${stats.videos.count} · ${formatBytes(stats.videos.bytes)}`,
              "",
              "Click a type to show only it; click others to add them back.",
            ].join("\n")}
          >
            <div className="stat stat-size">
              <span className="stat-label">Folder</span>
              <span className="stat-value">{formatBytes(stats.folderBytes)}</span>
            </div>
            <button
              type="button"
              className="stat"
              aria-pressed={!shownKinds}
              onClick={() => {
                setView("library");
                setShownKinds(null);
              }}
            >
              <span className="stat-label">Total</span>
              <span className="stat-value">{stats.total}</span>
            </button>
            {KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className="stat"
                aria-pressed={!!shownKinds?.includes(kind)}
                data-hidden={shownKinds && !shownKinds.includes(kind) ? "" : undefined}
                onClick={() => toggleKind(kind)}
              >
                <span className="stat-label">{KIND_LABEL[kind]}</span>
                <span className="stat-value">{stats[KIND_STAT[kind]].count}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="header-actions">
          {view === "library" ? (
            <button
              className="import"
              type="button"
              onClick={onImport}
              disabled={busy}
            >
              {busy ? "Working…" : "+ Import"}
            </button>
          ) : (
            <button
              className="ghost"
              type="button"
              onClick={() => setView("library")}
            >
              Library
            </button>
          )}
          <button
            className={view === "studio" ? "import active" : "ghost"}
            type="button"
            onClick={() => setView("studio")}
          >
            Studio
          </button>
          <button
            className={view === "settings" ? "import active" : "ghost"}
            type="button"
            onClick={() => setView("settings")}
          >
            Config
          </button>
          <button
            className={view === "about" ? "import active" : "ghost"}
            type="button"
            onClick={() => setView("about")}
          >
            About
          </button>
        </div>
        </div>
      </header>

      {status || updateCheck.status === "available" ? (
        <p className="status">
          {status ||
            (updateCheck.status === "available"
              ? `Update available · v${updateCheck.latest}`
              : "")}
          {updateCheck.status === "available" ? (
            <>
              {" · "}
              <button
                type="button"
                className="status-link"
                onClick={onOpenReleases}
              >
                Get update
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      {view === "library" ? (
        <form className="quick-add" onSubmit={onAddLink}>
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onPaste={(e) => {
              const items = readTransfer(e.clipboardData);
              if (!items.length) return;
              e.preventDefault();
              const first = items[0];
              if (first.kind === "url") {
                setLink(first.url);
                void onAddLink(undefined, first.url);
              } else {
                void quickAdd(items);
              }
            }}
            placeholder="Paste a meme link — it’s downloaded and saved automatically"
            aria-label="Meme link"
            disabled={busy}
          />
          <button type="submit" disabled={busy || !link.trim()}>
            Add
          </button>
          <small>
            or paste an image ({PASTE_KEY}) · or drag one in from your browser
          </small>
        </form>
      ) : null}

      {view === "library" && memes.length ? (
        <div className="view-bar">
          <label>
            <span>Sort</span>
            <select value={effectiveSort} onChange={(e) => setSortOrder(e.target.value as SortOrder)}>
              {(Object.keys(SORT_LABEL) as SortOrder[])
                .filter((o) => o !== "relevance" || searching)
                .map((o) => (
                  <option key={o} value={o}>
                    {SORT_LABEL[o]}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>Added</span>
            <select
              value={dateFilter.preset}
              onChange={(e) => setDateFilter({ ...dateFilter, preset: e.target.value as DatePreset })}
            >
              {(Object.keys(DATE_LABEL) as DatePreset[]).map((p) => (
                <option key={p} value={p}>
                  {DATE_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          {dateFilter.preset === "custom" ? (
            <span className="date-range">
              <input
                type="date"
                value={dateFilter.from}
                max={dateFilter.to || undefined}
                onChange={(e) => setDateFilter({ ...dateFilter, from: e.target.value })}
                aria-label="Added from"
              />
              <span>to</span>
              <input
                type="date"
                value={dateFilter.to}
                min={dateFilter.from || undefined}
                onChange={(e) => setDateFilter({ ...dateFilter, to: e.target.value })}
                aria-label="Added until"
              />
            </span>
          ) : null}
          <span className="view-count">
            {filtering ? `Showing ${visibleMemes.length} of ${memes.length}` : `${memes.length} memes`}
          </span>
          {filtering ? (
            <button type="button" className="status-link" onClick={clearFilters}>
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      {view === "library" && allTags.length ? (
        <nav className="tag-bar" aria-label="Tags">
          {allTags.slice(0, 24).map(({ tag, count }) => {
            const q = `#${tag.replace(/ /g, " #")}`;
            const on = query.trim() === q;
            return (
              <button
                key={tag}
                type="button"
                className={on ? "on" : ""}
                onClick={() => setQuery(on ? "" : q)}
                title={on ? "Show all memes" : `Show memes tagged “${tag}”`}
              >
                #{tag} <span>{count}</span>
              </button>
            );
          })}
        </nav>
      ) : null}

      {dragging ? (
        <div className="drop-overlay" aria-hidden>
          <div className="bubble">
            <strong>Drop to add to your library</strong>
          </div>
        </div>
      ) : null}

      <div className="studio-host" hidden={view !== "studio"}>
        <Studio
          active={view === "studio"}
          remixPath={remixPath}
          onRemixConsumed={() => setRemixPath(null)}
          setStatus={setStatus}
          onLibraryChanged={() => void runSearch(query).catch((e) => setStatus(String(e)))}
        />
      </div>

      {view === "studio" ? null : view === "settings" ? (
        <div className="settings">
          <section className="settings-card">
            <h2>Meme folder</h2>
            <p className="settings-copy">
              This folder is your library. Changing it moves your saved memes
              here and indexes any images already inside.
            </p>
            <code className="path-box">{settings?.memesDir ?? "…"}</code>
            <div className="settings-actions">
              <button
                type="button"
                className="import"
                onClick={onChooseFolder}
                disabled={busy}
              >
                Choose folder
              </button>
              <button
                type="button"
                className="ghost"
                onClick={onRescanFolder}
                disabled={busy}
              >
                Rescan
              </button>
              <button
                type="button"
                className="ghost"
                onClick={onResetFolder}
                disabled={busy || settings?.isDefault}
              >
                Use default
              </button>
            </div>
            {settings && !settings.isDefault ? (
              <p className="hint">Default: {settings.defaultDir}</p>
            ) : null}
          </section>

          <section className="settings-card">
            <h2>Version</h2>
            <p className="settings-copy">
              You’re running <strong>MemeFactory {appVersion || "…"}</strong>
            </p>
            {updateCheck.status === "available" ? (
              <p className="hint update-hint">
                New version available: v{updateCheck.latest}
              </p>
            ) : updateCheck.status === "current" ? (
              <p className="hint">You’re up to date (v{updateCheck.latest})</p>
            ) : updateCheck.status === "error" ? (
              <p className="hint">{updateCheck.message}</p>
            ) : updateCheck.status === "checking" ? (
              <p className="hint">Checking for updates…</p>
            ) : null}
            <div className="settings-actions">
              <button
                type="button"
                className="import"
                onClick={() => checkForUpdates(appVersion)}
                disabled={!appVersion || updateCheck.status === "checking"}
              >
                {updateCheck.status === "checking"
                  ? "Checking…"
                  : "Check for updates"}
              </button>
              {updateCheck.status === "available" ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={onOpenReleases}
                >
                  Get update
                </button>
              ) : null}
            </div>
          </section>

          <DangerZone
            disabled={busy}
            onErased={(report) => {
              setSelected(null);
              setErased(report);
            }}
          />
        </div>
      ) : view === "about" ? (
        <div className="settings about-page">
          <section className="settings-card about hero-about">
            <p className="eyebrow">made by gabo</p>
            <h2>Hey I’m gabo.</h2>
            <p className="settings-copy">
              Indie builder who likes small tools that feel personal. I make
              software that stays on your machine, respects your time, and
              doesn't need an account to be useful.
            </p>
          </section>

          <section className="settings-card">
            <h2>What is this?</h2>
            <p className="settings-copy">
              <strong>MemeFactory</strong> is a free, open-source meme library
              for Windows, macOS, and Linux. Import your memes, OCR the text,
              search instantly, and keep everything local. Comic vibes, minimal
              UI, no cloud, no tracking, MIT licensed.
            </p>
          </section>

          <section className="settings-card about">
            <h2>Share the chaos</h2>
            <p className="settings-copy">
              If MemeFactory helps you find that one meme at 2am, please share
              it with a friend — stars, posts, DMs, whatever you’ve got. Open
              source only works when people pass it on.
            </p>
            <div className="settings-actions">
              <button type="button" className="import" onClick={onShare}>
                Copy share link
              </button>
              <button type="button" className="ghost" onClick={onOpenRepo}>
                Open GitHub
              </button>
            </div>
          </section>

          <section className="settings-card about">
            <h2>Love this project?</h2>
            <p className="settings-copy">
              If people enjoy MemeFactory, I’ll keep working on it and shipping
              more features. Got a recommendation, idea, or bug? Drop it on the
              GitHub Issues page — that’s the best place to tell me what you
              want next.
            </p>
            <div className="settings-actions">
              <button type="button" className="import" onClick={onOpenIssues}>
                Open Issues
              </button>
            </div>
          </section>

          <section className="settings-card coffee">
            <h2>Buy me a coffee</h2>
            <p className="settings-copy">
              This project is free forever. If you want to say thanks, a coffee
              keeps the late-night builds going — no pressure, ever.
            </p>
            <div className="settings-actions">
              <button type="button" className="import coffee-btn" onClick={onCoffee}>
                Buy me a coffee
              </button>
            </div>
          </section>
        </div>
      ) : memes.length === 0 ? (
        <div className="empty">
          <div className="bubble">
            <strong>No memes yet.</strong>
            <span>
              Hit Import, paste an image, video or link, or drag one in from
              your browser — OCR indexes the text for instant search.
            </span>
          </div>
        </div>
      ) : visibleMemes.length === 0 ? (
        <div className="empty">
          <div className="bubble">
            <strong>
              {shownKinds
                ? `No ${shownKinds.map((k) => KIND_LABEL[k].toLowerCase()).join(" or ")}`
                : "Nothing"}
              {dateFilter.preset !== "all" ? ` added ${dateFilterText(dateFilter)}` : ""}
              {searching ? " matches your search" : ""}.
            </strong>
            <span>
              Some memes are hidden by your filters.{" "}
              <button type="button" className="status-link" onClick={clearFilters}>
                Show everything
              </button>
            </span>
          </div>
        </div>
      ) : (
        <div className="grid">
          {visibleMemes.map((m) => (
            <button
              key={m.id}
              type="button"
              className="card"
              onClick={() => setSelected(m)}
              title="Click to open · drag into any app to share"
              {...dragProps(m)}
            >
              {isVideoPath(m.path) ? (
                <>
                  {/* #t=0.1 makes WebKit paint a first frame; hover plays it. */}
                  <video
                    src={`${convertFileSrc(m.path)}#t=0.1`}
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
                    onMouseLeave={(e) => e.currentTarget.pause()}
                    aria-label={m.title || m.filename}
                  />
                  <span className="video-badge" aria-hidden="true">▶</span>
                </>
              ) : (
                <img
                  src={convertFileSrc(m.path)}
                  alt={m.title || m.filename}
                  loading="lazy"
                />
              )}
              <time className="card-date" dateTime={m.createdAt} title={`Added ${fullAdded(m.createdAt)}`}>
                {shortAdded(m.createdAt)}
              </time>
            </button>
          ))}
        </div>
      )}

      {selected ? (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          onClick={() => setSelected(null)}
          onKeyDown={(e) => e.key === "Escape" && setSelected(null)}
        >
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="panel-close"
              onClick={() => setSelected(null)}
              aria-label="Close"
              title="Close"
            >
              ✕
            </button>
            {isVideoPath(selected.path) ? (
              <video
                key={selected.id}
                {...dragProps(selected)}
                src={convertFileSrc(selected.path)}
                controls
                autoPlay
                loop
                playsInline
                aria-label={selected.title || selected.filename}
              />
            ) : (
              <img
                {...dragProps(selected)}
                src={convertFileSrc(selected.path)}
                alt={selected.title || selected.filename}
              />
            )}
            <div className="meta">
              <h2>{selected.title || "Untitled"}</h2>
              <p className="added">
                Added <time dateTime={selected.createdAt}>{fullAdded(selected.createdAt)}</time>
              </p>
              <TagEditor
                tags={selected.tags}
                suggestions={allTags.map((t) => t.tag)}
                onChange={(tags) => onTagsChange(selected, tags)}
                onPick={(tag) => {
                  setSelected(null);
                  setQuery(`#${tag.replace(/ /g, " #")}`);
                }}
              />
              <div className="share">
                <span>Share to</span>
                <div className="share-links">
                  {SOCIALS.map((site) => (
                    <button
                      key={site.name}
                      type="button"
                      onClick={() => onShareTo(selected, site)}
                      title={`Copy the meme and open ${site.name}`}
                    >
                      {site.name}
                    </button>
                  ))}
                </div>
                <small>
                  The meme is copied for you — paste it with {PASTE_KEY}.
                </small>
              </div>
              {confirmDelete ? (
                <div className="confirm-delete" role="alertdialog" aria-label="Confirm delete">
                  <p>
                    Delete <strong>{selected.title || selected.filename}</strong>?
                    The file is removed from your memes folder and can’t be undone.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      className="danger"
                      onClick={() => onDelete(selected)}
                    >
                      Yes, delete
                    </button>
                    <button
                      type="button"
                      autoFocus
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="actions">
                  <button type="button" onClick={() => onCopy(selected)}>
                    Copy
                  </button>
                  {isVideoPath(selected.path) ? null : (
                    <button
                      type="button"
                      onClick={() => {
                        setRemixPath(selected.path);
                        setSelected(null);
                        setView("studio");
                      }}
                    >
                      Remix
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onRescan(selected)}
                    disabled={busy}
                    title="Read the text in this meme again, for search"
                  >
                    Scan text again
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete
                  </button>
                  <button type="button" onClick={() => setSelected(null)}>
                    Close
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Decodes any format the webview can show (GIF, WebP, AVIF…), puts
 * transparency on white, and enlarges small web images so letters are big
 * enough for Tesseract. Returns PNG bytes.
 */
type CopyKind = "video" | "file" | "image";

type MemeKind = "image" | "gif" | "video";
const KINDS: MemeKind[] = ["image", "gif", "video"];
const KIND_LABEL: Record<MemeKind, string> = { image: "Images", gif: "GIFs", video: "Videos" };
const KIND_STAT = { image: "images", gif: "gifs", video: "videos" } as const;
const KINDS_KEY = "memefactory.shownKinds";
const SORT_KEY = "memefactory.sort";
const DATE_KEY = "memefactory.dateFilter";

/** useState that's remembered in localStorage (and works without it). */
function useStoredState<T>(key: string, fallback: T, valid: (v: unknown) => boolean) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      return parsed !== null && valid(parsed) ? (parsed as T) : fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable: the choice just isn't remembered
    }
  }, [key, value]);
  return [value, setValue] as const;
}

function dateFilterText(f: DateFilter): string {
  if (f.preset !== "custom") return DATE_LABEL[f.preset].toLowerCase();
  const day = (v: string) =>
    new Date(`${v}T00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (f.from && f.to) return `between ${day(f.from)} and ${day(f.to)}`;
  if (f.from) return `since ${day(f.from)}`;
  if (f.to) return `before the end of ${day(f.to)}`;
  return "at any time";
}

function memeKind(path: string): MemeKind {
  if (isVideoPath(path)) return "video";
  return /\.gif$/i.test(path) ? "gif" : "image";
}

function loadShownKinds(): MemeKind[] | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KINDS_KEY) ?? "null");
    if (!Array.isArray(raw)) return null;
    const kinds = KINDS.filter((k) => raw.includes(k));
    return kinds.length && kinds.length < KINDS.length ? kinds : null;
  } catch {
    return null;
  }
}


/** Reads a library file as a Blob, typed so videos are recognised. */
async function readMemeFile(path: string): Promise<Blob> {
  const bytes = await readFile(path);
  return new Blob([bytes], isVideoPath(path) ? { type: videoMime(path) } : {});
}

async function prepareForOcr(blob: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob; // let Tesseract try the original bytes
  }
  const longest = Math.max(bitmap.width, bitmap.height);
  const k = longest < 1600 ? Math.min(3, 1600 / longest) : Math.min(1, 4000 / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * k));
  canvas.height = Math.max(1, Math.round(bitmap.height * k));
  const ctx = canvas.getContext("2d");
  if (!ctx) return blob;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? blob), "image/png"));
}

/** Tag chips with an input: Enter or comma adds, Backspace on empty removes the last. */
function TagEditor({
  tags,
  suggestions,
  onChange,
  onPick,
}: {
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
  onPick: (tag: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const fresh = raw
      .split(",")
      .map((t) => t.trim().replace(/^#+/, "").toLowerCase())
      .filter((t) => t && !tags.includes(t));
    setDraft("");
    if (fresh.length) onChange([...tags, ...fresh]);
  };
  const unused = suggestions.filter((t) => !tags.includes(t));
  return (
    <div className="tag-editor">
      {tags.map((t) => (
        <span key={t} className="tag">
          <button type="button" className="tag-name" onClick={() => onPick(t)} title={`Show all memes tagged “${t}”`}>
            #{t}
          </button>
          <button
            type="button"
            className="tag-remove"
            onClick={() => onChange(tags.filter((x) => x !== t))}
            aria-label={`Remove tag ${t}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        list="meme-tag-suggestions"
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(",")) add(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && tags.length) {
            onChange(tags.slice(0, -1));
          }
        }}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={tags.length ? "Add tag…" : "Add tags, e.g. cat, reaction…"}
        aria-label="Add tag"
      />
      <datalist id="meme-tag-suggestions">
        {unused.slice(0, 50).map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}

export default App;
