import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CATEGORIES,
  EMOTIONS,
  EMOTION_ICONS,
  NO_FILTERS,
  STARTER,
  STYLES,
  MEME_TERMS,
  applyFilters,
  correctQuery,
  downloads,
  ensureLocal,
  errText,
  formatBytes,
  installRemotePack,
  isLocal,
  licenceSummary,
  loadCatalog,
  loadLocal,
  previewSrc,
  searchAssets,
  searchOnline,
  thumbSrc,
  useDownloads,
  vocabulary,
  webImageSearchUrl,
  type Catalog,
  type CatalogPack,
  type Filters,
  type Job,
  type LibraryAsset,
  type LocalLibrary,
  type PackPreview,
} from "./library";

type Mode = "library" | "online";
type Tab = "all" | "emotions" | (typeof CATEGORIES)[number]["id"] | "uploads" | "downloaded" | "favourites" | "packs" | "storage";
type Provider = "openverse" | "wikimedia" | "imgflip";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "emotions", label: "😀 Emotions" },
  ...CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
  { id: "uploads", label: "My uploads" },
  { id: "downloaded", label: "Downloaded" },
  { id: "favourites", label: "★ Favourites" },
  { id: "packs", label: "Packs" },
  { id: "storage", label: "Storage" },
];

const PAGE = 90;

type Props = {
  onClose: () => void;
  /** `at` is a screen position when the asset was dragged onto the canvas. */
  onInsert: (asset: LibraryAsset, at?: { x: number; y: number }) => Promise<void>;
  /** Present when an image layer is selected. */
  onReplace: ((asset: LibraryAsset) => Promise<void>) | null;
  setStatus: (s: string) => void;
};

export default function AssetLibrary({ onClose, onInsert, onReplace, setStatus }: Props) {
  const [mode, setMode] = useState<Mode>("library");
  const [tab, setTab] = useState<Tab>("all");
  const [sub, setSub] = useState("");
  const [query, setQuery] = useState("");
  /** User chose "search exactly what I typed" over the typo correction. */
  const [exact, setExact] = useState(false);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [local, setLocal] = useState<LocalLibrary | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [selected, setSelected] = useState<LibraryAsset | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [showDownloads, setShowDownloads] = useState(false);
  const [packPreview, setPackPreview] = useState<{ path: string; info: PackPreview } | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  // Online search
  const [provider, setProvider] = useState<Provider>("openverse");
  const [commercialOnly, setCommercialOnly] = useState(false);
  const [transparentOnly, setTransparentOnly] = useState(false);
  const [results, setResults] = useState<LibraryAsset[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchSeq = useRef(0);
  const jobs = useDownloads();

  const refreshLocal = useCallback(async () => {
    try {
      setLocal(await loadLocal());
    } catch (e) {
      setStatus(errText(e));
    }
  }, [setStatus]);

  const refreshCatalog = useCallback(async () => {
    try {
      setCatalog(await loadCatalog());
      setCatalogError("");
    } catch (e) {
      setCatalogError(errText(e));
    }
  }, []);

  useEffect(() => {
    void refreshLocal();
    void refreshCatalog();
  }, [refreshLocal, refreshCatalog]);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  // Refresh local state whenever a download or pack install finishes.
  const doneCount = jobs.filter((j) => j.state === "done").length;
  useEffect(() => {
    if (doneCount) void refreshLocal();
  }, [doneCount, refreshLocal]);

  // ------------------------------------------------------------ data

  const favouriteIds = useMemo(() => new Set(local?.favourites.map((f) => f.id)), [local]);

  /** Starter + installed + catalog, de-duplicated with local copies winning. */
  const everything = useMemo(() => {
    const byId = new Map<string, LibraryAsset>();
    for (const a of catalog?.assets ?? []) byId.set(a.id, a);
    for (const a of STARTER) byId.set(a.id, a);
    for (const a of local?.assets ?? []) byId.set(a.id, a);
    return [...byId.values()];
  }, [catalog, local]);

  const tabList = useMemo(() => {
    switch (tab) {
      case "all":
        return everything.filter((a) => a.origin !== "online" || a.storage);
      case "emotions":
        return everything.filter((a) => a.emotions.length && (a.origin !== "online" || a.storage));
      case "uploads":
        return everything.filter((a) => a.storage === "upload");
      case "downloaded":
        return everything.filter((a) => a.storage === "download" || a.storage === "pack");
      case "favourites": {
        const known = new Map(everything.map((a) => [a.id, a]));
        return (local?.favourites ?? []).map((f) => known.get(f.id) ?? f).filter((a) => a.name);
      }
      case "packs":
      case "storage":
        return [];
      default:
        return everything.filter((a) => a.category === tab);
    }
  }, [tab, everything, local]);

  /** Chips under the tabs: subcategories, or emotions on the Emotions tab. */
  const subcategories = useMemo(() => {
    if (tab === "emotions") {
      const present = new Set(tabList.flatMap((a) => a.emotions));
      return EMOTIONS.filter((e) => present.has(e));
    }
    if (!CATEGORIES.some((c) => c.id === tab)) return [];
    return [...new Set(tabList.map((a) => a.subcategory).filter(Boolean) as string[])].sort();
  }, [tab, tabList]);

  const vocab = useMemo(() => vocabulary(everything), [everything]);

  // Local search: if the query finds nothing, retry with typos corrected.
  const { visible, localFix } = useMemo(() => {
    const scoped = !sub ? tabList : tabList.filter((a) => (tab === "emotions" ? a.emotions.includes(sub) : a.subcategory === sub));
    let hits = searchAssets(scoped, query);
    let fix: string | null = null;
    if (!hits.length && !exact) {
      const corrected = correctQuery(query, vocab);
      const retry = corrected ? searchAssets(scoped, corrected) : [];
      if (retry.length) {
        hits = retry;
        fix = corrected;
      }
    }
    return { visible: applyFilters(hits, filters), localFix: fix };
  }, [tab, tabList, sub, query, filters, exact, vocab]);

  // Online search only corrects well-known meme names; general words go as typed.
  const onlineFix = useMemo(() => (exact ? null : correctQuery(query, MEME_TERMS)), [query, exact]);
  const onlineQuery = onlineFix ?? query;
  const fixedQuery = mode === "online" ? onlineFix : localFix;

  useEffect(() => {
    setLimit(PAGE);
    setSub((s) => (subcategories.includes(s) ? s : ""));
  }, [tab, query, filters, subcategories]);

  // ---------------------------------------------------- online search

  const runOnlineSearch = useCallback(
    async (nextPage: number) => {
      if (provider !== "imgflip" && !onlineQuery.trim()) {
        setResults([]);
        setHasMore(false);
        return;
      }
      if (!navigator.onLine) {
        setSearchError("You’re offline — online search needs an internet connection.");
        return;
      }
      const seq = ++searchSeq.current;
      setSearching(true);
      setSearchError("");
      try {
        const res = await searchOnline(provider, onlineQuery, nextPage, { commercial: commercialOnly, transparent: transparentOnly });
        if (seq !== searchSeq.current) return; // a newer search superseded this one
        setResults((prev) => (nextPage === 1 ? res.results : [...prev, ...res.results]));
        setHasMore(res.hasMore);
        setPage(nextPage);
      } catch (e) {
        if (seq === searchSeq.current) setSearchError(errText(e));
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [provider, onlineQuery, commercialOnly, transparentOnly],
  );

  useEffect(() => {
    if (mode !== "online") return;
    const t = window.setTimeout(() => void runOnlineSearch(1), 450);
    return () => window.clearTimeout(t);
  }, [mode, runOnlineSearch]);

  // --------------------------------------------------------- actions

  async function insert(a: LibraryAsset, at?: { x: number; y: number }) {
    try {
      await onInsert(a, at);
      void refreshLocal();
    } catch (e) {
      setStatus(`Couldn’t insert ${a.name}: ${errText(e)}`);
    }
  }

  async function replace(a: LibraryAsset) {
    if (!onReplace) return;
    try {
      await onReplace(a);
    } catch (e) {
      setStatus(`Couldn’t replace image: ${errText(e)}`);
    }
  }

  async function toggleFavourite(a: LibraryAsset) {
    const on = !favouriteIds.has(a.id);
    try {
      await invoke("library_favourite", { record: a, on });
      // Favourites are kept offline: download them right away.
      if (on && !isLocal(a) && a.file.url && navigator.onLine) void ensureLocal(a).catch(() => {});
      await refreshLocal();
    } catch (e) {
      setStatus(errText(e));
    }
  }

  async function download(a: LibraryAsset) {
    try {
      const rec = await ensureLocal(a);
      setStatus(`${rec.name} is available offline`);
      await refreshLocal();
      setSelected((s) => (s?.id === rec.id ? rec : s));
    } catch (e) {
      setStatus(`Download failed: ${errText(e)}`);
    }
  }

  async function removeLocal(a: LibraryAsset) {
    if (!window.confirm(`Remove “${a.name}” from this computer? Projects that use it keep their own copy.`)) return;
    try {
      await invoke("library_remove", { id: a.id });
      await refreshLocal();
      setSelected(null);
    } catch (e) {
      setStatus(errText(e));
    }
  }

  async function onUpload() {
    const picked = await open({ multiple: true, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }] });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    let ok = 0;
    for (const path of paths) {
      try {
        await invoke("library_upload", { path, category: null });
        ok++;
      } catch (e) {
        setStatus(`${path.split(/[\\/]/).pop()}: ${errText(e)}`);
      }
    }
    if (ok) {
      setStatus(ok === 1 ? "Added to My uploads" : `Added ${ok} images to My uploads`);
      setMode("library");
      setTab("uploads");
    }
    await refreshLocal();
  }

  async function onImportPack() {
    const picked = await open({ multiple: false, filters: [{ name: "Asset pack", extensions: ["zip"] }] });
    if (!picked || Array.isArray(picked)) return;
    try {
      setPackPreview({ path: picked, info: await invoke<PackPreview>("pack_inspect", { path: picked }) });
    } catch (e) {
      setStatus(`Not a valid pack: ${errText(e)}`);
    }
  }

  async function confirmPackInstall() {
    if (!packPreview) return;
    try {
      const info = await invoke<{ name: string }>("pack_install", { path: packPreview.path });
      setStatus(`Installed ${info.name}`);
      setPackPreview(null);
      await refreshLocal();
    } catch (e) {
      setStatus(`Install failed: ${errText(e)}`);
    }
  }

  async function installPack(p: CatalogPack) {
    try {
      const info = await installRemotePack(p);
      setStatus(`Installed ${info.name}`);
      await refreshLocal();
    } catch (e) {
      setStatus(`Pack download failed: ${errText(e)}`);
    }
  }

  async function removePack(id: string, name: string) {
    if (!window.confirm(`Remove the “${name}” pack? Memes and projects that already use its images are not affected.`)) return;
    try {
      await invoke("pack_remove", { id });
      await refreshLocal();
      setStatus(`Removed ${name}`);
    } catch (e) {
      setStatus(errText(e));
    }
  }

  async function clearCache() {
    if (!window.confirm("Delete downloaded assets (favourites and packs are kept)?")) return;
    try {
      const n = await invoke<number>("library_clear_cache");
      setStatus(`Cleared ${n} cached ${n === 1 ? "asset" : "assets"}`);
      await refreshLocal();
    } catch (e) {
      setStatus(errText(e));
    }
  }

  // Pointer-based drag to the canvas (HTML5 drag-and-drop is unreliable in
  // Tauri webviews because native file drops are intercepted).
  const drag = useRef<{ asset: LibraryAsset; x: number; y: number; active: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ src: string | null; x: number; y: number } | null>(null);

  function onCardPointerDown(e: React.PointerEvent, a: LibraryAsset) {
    if (e.button !== 0) return;
    drag.current = { asset: a, x: e.clientX, y: e.clientY, active: false };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!d.active && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 6) d.active = true;
      if (d.active) setGhost({ src: thumbSrc(d.asset), x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = drag.current;
      drag.current = null;
      setGhost(null);
      if (d?.active) void insert(d.asset, { x: ev.clientX, y: ev.clientY });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const jobFor = (a: LibraryAsset) => jobs.find((j) => j.id === `asset:${a.id}`);
  const activeJobs = jobs.filter((j) => j.state === "queued" || j.state === "downloading").length;
  const failedJobs = jobs.filter((j) => j.state === "failed").length;

  // ------------------------------------------------------------ render

  const list = mode === "online" ? results : visible.slice(0, limit);

  return (
    <div className="asset-drawer" role="dialog" aria-label="Asset library">
      <header className="asset-head">
        <div className="seg" role="group" aria-label="Source">
          <button type="button" className={mode === "library" ? "on" : ""} onClick={() => setMode("library")}>
            Library
          </button>
          <button type="button" className={mode === "online" ? "on" : ""} onClick={() => setMode("online")}>
            🌐 Online
          </button>
        </div>
        <input
          className="asset-search"
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setExact(false);
          }}
          onKeyDown={(e) => e.key === "Escape" && (query ? setQuery("") : onClose())}
          placeholder={mode === "online" ? (provider === "imgflip" ? "Filter meme templates…" : "Describe an image, e.g. happy cartoon frog") : "Search assets — e.g. crying, shocked face, arrow"}
          aria-label="Search assets"
        />
        {mode === "library" ? (
          <button type="button" className={`ghost sm${showFilters ? " on" : ""}`} onClick={() => setShowFilters((s) => !s)}>
            Filters{Object.values(filters).some(Boolean) ? " •" : ""}
          </button>
        ) : null}
        <div className="dl-wrap">
          <button type="button" className={`ghost sm${showDownloads ? " on" : ""}`} onClick={() => setShowDownloads((s) => !s)} title="Download manager">
            ⬇{activeJobs ? ` ${activeJobs}` : ""}
            {failedJobs ? <span className="badge-fail">{failedJobs}</span> : null}
          </button>
          {showDownloads ? <DownloadPanel jobs={jobs} onClose={() => setShowDownloads(false)} /> : null}
        </div>
        <button type="button" className="ghost sm" onClick={onUpload} title="Add your own images to My uploads">
          ⬆ Upload
        </button>
        <button type="button" className="ghost sm" onClick={onClose} aria-label="Close asset library">
          ✕
        </button>
      </header>

      {mode === "library" ? (
        <>
          <nav className="asset-tabs" aria-label="Asset categories">
            {TABS.map((t) => (
              <button key={t.id} type="button" className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          {subcategories.length > 1 || (tab === "emotions" && subcategories.length) ? (
            <div className="chips">
              <button type="button" className={!sub ? "on" : ""} onClick={() => setSub("")}>
                all
              </button>
              {subcategories.map((s) => (
                <button key={s} type="button" className={sub === s ? "on" : ""} onClick={() => setSub(s)}>
                  {tab === "emotions" ? `${EMOTION_ICONS[s] ?? ""} ${s}` : s}
                </button>
              ))}
            </div>
          ) : null}
          {showFilters ? <FilterBar filters={filters} onChange={setFilters} /> : null}
          {catalog?.offline || catalogError ? (
            <p className="asset-banner">
              {catalog?.offline
                ? `Offline — showing the catalog saved ${catalog.fetchedAt ? new Date(catalog.fetchedAt).toLocaleDateString() : "earlier"}. Downloaded and starter assets still work.`
                : `Online catalog unavailable (${catalogError}). Starter and downloaded assets still work.`}{" "}
              <button type="button" className="status-link" onClick={refreshCatalog}>
                Retry
              </button>
            </p>
          ) : null}
        </>
      ) : (
        <div className="online-bar">
          <div className="seg" role="group" aria-label="Search provider">
            <button type="button" className={provider === "openverse" ? "on" : ""} onClick={() => setProvider("openverse")} title="Openly licensed images via Openverse">
              Openverse
            </button>
            <button type="button" className={provider === "wikimedia" ? "on" : ""} onClick={() => setProvider("wikimedia")} title="Freely licensed images from Wikimedia Commons">
              Wikimedia
            </button>
            <button type="button" className={provider === "imgflip" ? "on" : ""} onClick={() => setProvider("imgflip")} title="Popular meme templates from Imgflip">
              Meme templates
            </button>
          </div>
          {provider !== "imgflip" ? (
            <>
              {provider === "openverse" ? (
                <label className="check">
                  <input type="checkbox" checked={commercialOnly} onChange={(e) => setCommercialOnly(e.target.checked)} />
                  Commercial use
                </label>
              ) : null}
              <label className="check">
                <input type="checkbox" checked={transparentOnly} onChange={(e) => setTransparentOnly(e.target.checked)} />
                PNG only
              </label>
            </>
          ) : null}
          <span className="tip">
            {provider === "openverse"
              ? "Creative Commons images from Openverse. Licences are declared by each source."
              : provider === "wikimedia"
                ? "Freely licensed images from Wikimedia Commons. Licences are declared on each file page."
                : "Imgflip’s top templates. Licence unknown — rights stay with the original owners."}
          </span>
        </div>
      )}

      <div className="asset-body">
        <div className="asset-main">
          {mode === "library" && tab === "packs" ? (
            <PacksView
              local={local}
              catalog={catalog}
              jobs={jobs}
              online={online}
              onInstall={installPack}
              onRemove={removePack}
              onImport={onImportPack}
              onOpen={(id) => {
                setTab("all");
                setQuery("");
                setSelected(null);
                setFilters(NO_FILTERS);
                const pack = local?.packs.find((p) => p.id === id) ?? catalog?.packs.find((p) => p.id === id);
                if (pack) setQuery(pack.name);
              }}
            />
          ) : mode === "library" && tab === "storage" ? (
            <StorageView local={local} onClearCache={clearCache} onRemovePack={removePack} />
          ) : (
            <>
              {mode === "online" && !online ? <p className="asset-banner">You’re offline — online search is unavailable.</p> : null}
              {fixedQuery ? (
                <p className="asset-banner">
                  Showing results for <strong>{fixedQuery}</strong>.{" "}
                  <button type="button" className="status-link" onClick={() => setExact(true)}>
                    Search for “{query}” instead
                  </button>
                </p>
              ) : null}
              {searchError ? (
                <p className="asset-banner error">
                  {searchError}
                  {provider === "openverse" && /limiting/.test(searchError) ? (
                    <>
                      {" "}
                      <button type="button" className="status-link" onClick={() => setProvider("wikimedia")}>
                        Search Wikimedia Commons instead
                      </button>
                    </>
                  ) : null}
                </p>
              ) : null}
              {list.length === 0 ? (
                <p className="tip asset-empty">
                  {mode === "online"
                    ? searching
                      ? "Searching…"
                      : provider !== "imgflip" && !query.trim()
                        ? "Type what you’re looking for — e.g. “shocked cartoon face” or “dog holding a phone”."
                        : null
                    : tab === "uploads"
                      ? "No uploads yet — use ⬆ Upload to add your own images."
                      : tab === "favourites"
                        ? "Star assets to keep them here (and offline)."
                        : "Nothing matches in your library."}
                  {mode === "library" && query.trim() && tab !== "uploads" && tab !== "favourites" ? (
                    <>
                      {" "}
                      <button type="button" className="status-link" onClick={() => setMode("online")}>
                        Search online for “{query.trim()}”
                      </button>
                    </>
                  ) : null}
                </p>
              ) : (
                <div className="asset-grid">
                  {list.map((a) => (
                    <AssetCard
                      key={a.id}
                      asset={a}
                      job={jobFor(a)}
                      selected={selected?.id === a.id}
                      favourite={favouriteIds.has(a.id)}
                      onSelect={() => setSelected(a)}
                      onInsert={() => void insert(a)}
                      onFavourite={() => void toggleFavourite(a)}
                      onPointerDown={(e) => onCardPointerDown(e, a)}
                    />
                  ))}
                </div>
              )}
              {mode === "online" && !searching && !searchError && onlineQuery.trim() && results.length < 6 && !hasMore ? (
                <div className="asset-banner sparse">
                  <strong>{results.length ? "Only a few openly licensed images match." : `No openly licensed images found for “${onlineQuery.trim()}”.`}</strong>
                  <span>
                    Popular meme characters (Wojak, Pepe and friends) are rarely published under free licences, so these sources carry
                    few of them. {provider !== "wikimedia" ? "Try Wikimedia, or a" : "Try a"} broader description — or bring your own:
                  </span>
                  <div className="row wrap">
                    {provider !== "wikimedia" ? (
                      <button type="button" className="ghost sm" onClick={() => setProvider("wikimedia")}>
                        Try Wikimedia
                      </button>
                    ) : null}
                    <button type="button" className="ghost sm" onClick={() => void openUrl(webImageSearchUrl(onlineQuery.trim()))}>
                      Search the web ↗
                    </button>
                    <button type="button" className="import sm" onClick={onUpload}>
                      ⬆ Upload my own
                    </button>
                  </div>
                  <span className="tip">
                    Images from a web search open in your browser — save one, then drag it onto the canvas or add it with Upload. Check the
                    rights before sharing commercially.
                  </span>
                </div>
              ) : null}
              {mode === "library" && visible.length > limit ? (
                <button type="button" className="ghost sm more" onClick={() => setLimit((l) => l + PAGE)}>
                  Show more ({visible.length - limit})
                </button>
              ) : null}
              {mode === "online" && hasMore ? (
                <button type="button" className="ghost sm more" disabled={searching} onClick={() => void runOnlineSearch(page + 1)}>
                  {searching ? "Loading…" : "Load more"}
                </button>
              ) : null}
            </>
          )}
        </div>

        {selected && tab !== "packs" && tab !== "storage" ? (
          <AssetPreview
            asset={(local?.assets.find((x) => x.id === selected.id) ?? selected) as LibraryAsset}
            job={jobFor(selected)}
            favourite={favouriteIds.has(selected.id)}
            canReplace={!!onReplace}
            onInsert={(a) => void insert(a)}
            onReplace={(a) => void replace(a)}
            onDownload={(a) => void download(a)}
            onRemove={(a) => void removeLocal(a)}
            onFavourite={(a) => void toggleFavourite(a)}
            onRetry={(a) => void download(a)}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </div>

      {ghost ? (
        <div className="drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
          {ghost.src ? <img src={ghost.src} alt="" /> : null}
        </div>
      ) : null}

      {packPreview ? (
        <PackInstallDialog preview={packPreview.info} onCancel={() => setPackPreview(null)} onInstall={confirmPackInstall} />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ parts

function AssetCard({
  asset,
  job,
  selected,
  favourite,
  onSelect,
  onInsert,
  onFavourite,
  onPointerDown,
}: {
  asset: LibraryAsset;
  job?: Job;
  selected: boolean;
  favourite: boolean;
  onSelect: () => void;
  onInsert: () => void;
  onFavourite: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const src = thumbSrc(asset);
  const busy = job && (job.state === "queued" || job.state === "downloading");
  const pct = job?.total ? Math.round((job.received / job.total) * 100) : null;
  return (
    <div
      className={`asset-card${selected ? " sel" : ""}`}
      role="button"
      tabIndex={0}
      title={`${asset.name} — double-click or drag onto the canvas to insert`}
      onClick={onSelect}
      onDoubleClick={onInsert}
      onKeyDown={(e) => {
        if (e.key === "Enter") onInsert();
        if (e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      onPointerDown={onPointerDown}
    >
      <div className="asset-thumb checker">
        {src ? <img src={src} alt="" loading="lazy" draggable={false} /> : <span className="tip">No preview</span>}
        {busy ? (
          <div className="asset-progress">
            <span style={{ width: `${pct ?? 30}%` }} className={pct == null ? "indeterminate" : ""} />
          </div>
        ) : null}
      </div>
      <div className="asset-meta">
        <strong>{asset.name}</strong>
        <span>
          {asset.category}
          {asset.format ? ` · ${asset.format.toUpperCase()}` : ""}
        </span>
      </div>
      <div className="asset-flags">
        {asset.transparent ? <span title="Transparent background">◩</span> : null}
        <span title={isLocal(asset) ? "Available offline" : "Online — downloads when used"}>
          {job?.state === "failed" ? "⚠" : isLocal(asset) ? "✓" : "☁"}
        </span>
        <button
          type="button"
          className={`fav${favourite ? " on" : ""}`}
          title={favourite ? "Remove from favourites" : "Add to favourites"}
          onClick={(e) => {
            e.stopPropagation();
            onFavourite();
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {favourite ? "★" : "☆"}
        </button>
      </div>
    </div>
  );
}

function FilterBar({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  return (
    <div className="filter-bar">
      <label className="field">
        <span>Emotion</span>
        <select value={filters.emotion} onChange={(e) => set({ emotion: e.target.value })}>
          <option value="">Any</option>
          {EMOTIONS.map((e) => (
            <option key={e} value={e}>
              {EMOTION_ICONS[e]} {e}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Style</span>
        <select value={filters.style} onChange={(e) => set({ style: e.target.value })}>
          <option value="">Any</option>
          {STYLES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Format</span>
        <select value={filters.format} onChange={(e) => set({ format: e.target.value })}>
          <option value="">Any</option>
          <option value="png">PNG</option>
          <option value="webp">WebP</option>
          <option value="jpg">JPG</option>
          <option value="gif">GIF</option>
        </select>
      </label>
      <label className="field">
        <span>Background</span>
        <select value={filters.background} onChange={(e) => set({ background: e.target.value as Filters["background"] })}>
          <option value="">Any</option>
          <option value="transparent">Transparent</option>
          <option value="solid">Solid / full image</option>
        </select>
      </label>
      <label className="field">
        <span>Licence</span>
        <select value={filters.licence} onChange={(e) => set({ licence: e.target.value as Filters["licence"] })}>
          <option value="">Any</option>
          <option value="commercial">Commercial use (verified)</option>
          <option value="attribution">Attribution required</option>
          <option value="public">Public domain / CC0</option>
          <option value="personal">Personal use only</option>
          <option value="unknown">Unknown / unverified</option>
        </select>
      </label>
      <button type="button" className="ghost sm" onClick={() => onChange(NO_FILTERS)}>
        Reset
      </button>
    </div>
  );
}

function AssetPreview({
  asset,
  job,
  favourite,
  canReplace,
  onInsert,
  onReplace,
  onDownload,
  onRemove,
  onFavourite,
  onRetry,
  onClose,
}: {
  asset: LibraryAsset;
  job?: Job;
  favourite: boolean;
  canReplace: boolean;
  onInsert: (a: LibraryAsset) => void;
  onReplace: (a: LibraryAsset) => void;
  onDownload: (a: LibraryAsset) => void;
  onRemove: (a: LibraryAsset) => void;
  onFavourite: (a: LibraryAsset) => void;
  onRetry: (a: LibraryAsset) => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(false);
  const lic = licenceSummary(asset.licensing);
  const busy = job && (job.state === "queued" || job.state === "downloading");
  const src = previewSrc(asset);
  const local = isLocal(asset);
  return (
    <aside className="asset-preview">
      <div className="preview-head">
        <h3>{asset.name}</h3>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close preview">
          ✕
        </button>
      </div>
      <button type="button" className={`preview-img checker${zoom ? " zoom" : ""}`} onClick={() => setZoom((z) => !z)} title={zoom ? "Zoom out" : "Zoom in"}>
        {src ? <img src={src} alt={asset.name} draggable={false} /> : null}
      </button>
      {asset.description ? <p className="preview-desc">{asset.description}</p> : null}
      <dl className="meta-list">
        <dt>Category</dt>
        <dd>
          {asset.category}
          {asset.subcategory ? ` / ${asset.subcategory}` : ""}
        </dd>
        {asset.tags.length ? (
          <>
            <dt>Tags</dt>
            <dd>{asset.tags.join(", ")}</dd>
          </>
        ) : null}
        {asset.dimensions.width ? (
          <>
            <dt>Size</dt>
            <dd>
              {asset.dimensions.width} × {asset.dimensions.height}
              {asset.file.sizeBytes ? ` · ${formatBytes(asset.file.sizeBytes)}` : ""}
              {asset.format ? ` · ${asset.format.toUpperCase()}` : ""}
            </dd>
          </>
        ) : null}
        <dt>Background</dt>
        <dd>{asset.transparent == null ? "Unknown" : asset.transparent ? "Transparent" : "Solid"}</dd>
        <dt>Status</dt>
        <dd>{local ? (asset.origin === "starter" ? "Built in" : "Downloaded — works offline") : "Online — downloads when used"}</dd>
        {asset.packName ? (
          <>
            <dt>Pack</dt>
            <dd>{asset.packName}</dd>
          </>
        ) : null}
        {asset.source.name ? (
          <>
            <dt>Source</dt>
            <dd>{asset.source.name}</dd>
          </>
        ) : null}
        {asset.creator?.name ? (
          <>
            <dt>Creator</dt>
            <dd>{asset.creator.name}</dd>
          </>
        ) : null}
      </dl>
      <div className={`licence ${lic.tone}`}>
        <strong>{asset.licensing.license}</strong>
        <span>{lic.badge}</span>
        <span>{lic.commercial}</span>
        {asset.licensing.attributionRequired ? <span>Attribution required{asset.licensing.attributionText ? `: ${asset.licensing.attributionText}` : ""}</span> : null}
        {asset.licensing.declaredBy && !asset.licensing.verified ? <span className="tip">Declared by: {asset.licensing.declaredBy}</span> : null}
      </div>
      {job?.state === "failed" ? (
        <p className="asset-banner error">
          Download failed: {job.error}{" "}
          <button type="button" className="status-link" onClick={() => onRetry(asset)}>
            Retry
          </button>
        </p>
      ) : null}
      <div className="stack">
        <button type="button" className="import sm" disabled={busy} onClick={() => onInsert(asset)}>
          {busy ? "Downloading…" : local ? "Add to canvas" : "Download & add to canvas"}
        </button>
        {canReplace ? (
          <button type="button" className="ghost sm" disabled={busy} onClick={() => onReplace(asset)}>
            Replace selected image
          </button>
        ) : null}
        <div className="row wrap">
          <button type="button" className={`ghost sm${favourite ? " on" : ""}`} onClick={() => onFavourite(asset)}>
            {favourite ? "★ Favourite" : "☆ Favourite"}
          </button>
          {!local && asset.file.url ? (
            <button type="button" className="ghost sm" disabled={busy} onClick={() => onDownload(asset)}>
              {asset.origin === "online" ? "Save to my assets" : "Keep offline"}
            </button>
          ) : null}
          {busy ? (
            <button type="button" className="ghost sm" onClick={() => void downloads.cancel(`asset:${asset.id}`)}>
              Cancel
            </button>
          ) : null}
          {asset.storage === "download" || asset.storage === "upload" ? (
            <button type="button" className="ghost sm danger" onClick={() => onRemove(asset)}>
              Remove
            </button>
          ) : null}
          {asset.source.url ? (
            <button type="button" className="ghost sm" onClick={() => void openUrl(asset.source.url!)}>
              Source ↗
            </button>
          ) : null}
          {asset.licensing.licenseUrl ? (
            <button type="button" className="ghost sm" onClick={() => void openUrl(asset.licensing.licenseUrl!)}>
              Licence ↗
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function DownloadPanel({ jobs, onClose }: { jobs: Job[]; onClose: () => void }) {
  return (
    <div className="dl-panel">
      <div className="preview-head">
        <h3>Downloads</h3>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close downloads">
          ✕
        </button>
      </div>
      {jobs.length === 0 ? <p className="tip">Nothing downloaded this session.</p> : null}
      <ul>
        {jobs.map((j) => {
          const pct = j.total ? Math.round((j.received / j.total) * 100) : null;
          const busy = j.state === "queued" || j.state === "downloading";
          return (
            <li key={j.id} className={j.state}>
              <div className="dl-row">
                <strong>
                  {j.kind === "pack" ? "📦 " : ""}
                  {j.name}
                </strong>
                <span>
                  {j.state === "downloading"
                    ? `${formatBytes(j.received)}${j.total ? ` / ${formatBytes(j.total)}` : ""}`
                    : j.state === "failed"
                      ? "Failed"
                      : j.state}
                </span>
              </div>
              {busy ? (
                <div className="asset-progress inline">
                  <span style={{ width: `${pct ?? 30}%` }} className={pct == null ? "indeterminate" : ""} />
                </div>
              ) : null}
              {j.error && j.state === "failed" ? <span className="tip">{j.error}</span> : null}
              {busy ? (
                <button type="button" className="status-link" onClick={() => void downloads.cancel(j.id)}>
                  Cancel
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {jobs.some((j) => j.state !== "queued" && j.state !== "downloading") ? (
        <button type="button" className="ghost sm" onClick={() => downloads.clearFinished()}>
          Clear finished
        </button>
      ) : null}
      <p className="tip">Failed downloads can be retried from the asset’s preview.</p>
    </div>
  );
}

function PacksView({
  local,
  catalog,
  jobs,
  online,
  onInstall,
  onRemove,
  onImport,
  onOpen,
}: {
  local: LocalLibrary | null;
  catalog: Catalog | null;
  jobs: Job[];
  online: boolean;
  onInstall: (p: CatalogPack) => void;
  onRemove: (id: string, name: string) => void;
  onImport: () => void;
  onOpen: (id: string) => void;
}) {
  const installed = local?.packs ?? [];
  const remote = catalog?.packs ?? [];
  return (
    <div className="packs">
      <div className="row">
        <button type="button" className="import sm" onClick={onImport}>
          📦 Import pack (.zip)
        </button>
        <span className="tip">Packs contain manifest.json, assets/ and metadata/. Scripts and SVG files are never accepted.</span>
      </div>
      <h3>Installed</h3>
      {installed.length === 0 ? <p className="tip">No packs installed yet. The built-in starter kit is always available.</p> : null}
      <div className="pack-list">
        {installed.map((p) => {
          const remoteVersion = remote.find((r) => r.id === p.id);
          const update = remoteVersion && remoteVersion.version !== p.version;
          return (
            <div key={p.id} className="pack-card">
              <div className="pack-preview checker">{p.previewPath ? <img src={convertFileSrc(p.previewPath)} alt="" /> : null}</div>
              <div className="pack-info">
                <strong>{p.name}</strong>
                <span className="tip">
                  v{p.version} · {p.assetCount} assets · {formatBytes(p.sizeBytes)}
                  {p.author ? ` · by ${p.author}` : ""}
                </span>
                {p.description ? <span className="tip">{p.description}</span> : null}
                <div className="row wrap">
                  <button type="button" className="ghost sm" onClick={() => onOpen(p.id)}>
                    Browse
                  </button>
                  {update ? (
                    <button type="button" className="import sm" disabled={!online} onClick={() => onInstall(remoteVersion)}>
                      Update to v{remoteVersion.version}
                    </button>
                  ) : null}
                  <button type="button" className="ghost sm danger" onClick={() => onRemove(p.id, p.name)}>
                    Remove
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <h3>Available online</h3>
      {!catalog ? <p className="tip">Online catalog unavailable.</p> : null}
      <div className="pack-list">
        {remote
          .filter((p) => !installed.some((i) => i.id === p.id))
          .map((p) => {
            const job = jobs.find((j) => j.id === `pack:${p.id}`);
            const busy = job && (job.state === "queued" || job.state === "downloading");
            const pct = job?.total ? Math.round((job.received / job.total) * 100) : null;
            return (
              <div key={p.id} className="pack-card">
                <div className="pack-preview checker">{p.preview ? <img src={p.preview} alt="" /> : null}</div>
                <div className="pack-info">
                  <strong>{p.name}</strong>
                  <span className="tip">
                    v{p.version} · {p.assetCount} assets · {formatBytes(p.sizeBytes)}
                    {p.author ? ` · by ${p.author}` : ""}
                  </span>
                  {p.description ? <span className="tip">{p.description}</span> : null}
                  {busy ? (
                    <div className="asset-progress inline">
                      <span style={{ width: `${pct ?? 30}%` }} className={pct == null ? "indeterminate" : ""} />
                    </div>
                  ) : null}
                  {job?.state === "failed" ? <span className="tip error-text">Failed: {job.error}</span> : null}
                  <div className="row wrap">
                    {busy ? (
                      <button type="button" className="ghost sm" onClick={() => void downloads.cancel(`pack:${p.id}`)}>
                        Cancel
                      </button>
                    ) : (
                      <button type="button" className="import sm" disabled={!online} onClick={() => onInstall(p)}>
                        {job?.state === "failed" ? "Retry" : "Install"}
                      </button>
                    )}
                    <button type="button" className="ghost sm" onClick={() => onOpen(p.id)}>
                      Preview assets
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

function StorageView({ local, onClearCache, onRemovePack }: { local: LocalLibrary | null; onClearCache: () => void; onRemovePack: (id: string, name: string) => void }) {
  if (!local) return <p className="tip">Loading…</p>;
  const s = local.storage;
  const downloaded = local.assets.filter((a) => a.storage === "download").length;
  return (
    <div className="storage">
      <div className="storage-grid">
        <div>
          <strong>{formatBytes(s.total)}</strong>
          <span>Total used</span>
        </div>
        <div>
          <strong>{local.assets.length}</strong>
          <span>Assets on this computer</span>
        </div>
        <div>
          <strong>{formatBytes(s.downloads)}</strong>
          <span>Downloaded ({downloaded})</span>
        </div>
        <div>
          <strong>{formatBytes(s.uploads)}</strong>
          <span>My uploads</span>
        </div>
        <div>
          <strong>{formatBytes(s.catalog)}</strong>
          <span>Catalog cache</span>
        </div>
      </div>
      <h3>Packs</h3>
      {local.packs.length === 0 ? <p className="tip">No packs installed.</p> : null}
      <ul className="storage-packs">
        {local.packs.map((p) => (
          <li key={p.id}>
            <span>{p.name}</span>
            <span>{formatBytes(s.packs[p.id] ?? 0)}</span>
            <button type="button" className="status-link" onClick={() => onRemovePack(p.id, p.name)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" className="ghost sm danger" onClick={onClearCache} disabled={!downloaded}>
          Clear downloaded assets
        </button>
      </div>
      <p className="tip">
        Favourites and packs are kept when clearing. Images already placed in a project are stored inside the project, so removing
        anything here never breaks your saved memes or projects.
      </p>
    </div>
  );
}

function PackInstallDialog({ preview, onCancel, onInstall }: { preview: PackPreview; onCancel: () => void; onInstall: () => void }) {
  const m = preview.manifest;
  const blocked = preview.duplicates.length > 0;
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Install pack" onClick={onCancel}>
      <div className="pack-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Install “{m.name}”?</h2>
        {preview.preview ? (
          <div className="pack-preview big checker">
            <img src={preview.preview} alt="" />
          </div>
        ) : null}
        <p className="settings-copy">{m.description}</p>
        <dl className="meta-list">
          <dt>Version</dt>
          <dd>
            {m.version}
            {preview.installedVersion ? ` (replaces installed v${preview.installedVersion})` : ""}
          </dd>
          <dt>Author</dt>
          <dd>{m.author ?? "Unknown"}</dd>
          <dt>Assets</dt>
          <dd>
            {preview.assets.length} · {formatBytes(preview.sizeBytes)}
          </dd>
          <dt>Licence</dt>
          <dd>{m.license ?? "See individual assets"} — declared by the pack, not verified</dd>
        </dl>
        <ul className="pack-assets">
          {preview.assets.slice(0, 40).map((a) => (
            <li key={a.id}>
              {a.name} <span className="tip">({a.category} · {a.license})</span>
            </li>
          ))}
          {preview.assets.length > 40 ? <li className="tip">…and {preview.assets.length - 40} more</li> : null}
        </ul>
        {blocked ? <p className="asset-banner error">These asset ids already exist in your library: {preview.duplicates.join(", ")}</p> : null}
        <div className="settings-actions">
          <button type="button" className="import" disabled={blocked} onClick={onInstall}>
            {preview.installedVersion ? "Update pack" : "Install pack"}
          </button>
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
