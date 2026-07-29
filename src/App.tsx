import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import Tesseract from "tesseract.js";
import "./App.css";

const REPO_URL = "https://github.com/tusk/MemeFactory";
const ISSUES_URL = "https://github.com/gabojkz/meme-factory/issues";
const COFFEE_URL = "https://www.buymeacoffee.com/gaboz";
const SHARE_TEXT = `MemeFactory — free local meme library with OCR search. ${REPO_URL}`;

type Meme = {
  id: string;
  filename: string;
  path: string;
  title: string | null;
  ocrText: string;
  createdAt: string;
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

type View = "library" | "settings" | "about";

function formatSync(report: SyncReport): string {
  const bits = [];
  if (report.moved) bits.push(`moved ${report.moved}`);
  if (report.indexed) bits.push(`found ${report.indexed} new`);
  if (bits.length === 0) return `Library synced · ${report.total} memes`;
  return `${bits.join(", ")} · ${report.total} total`;
}

function App() {
  const [ready, setReady] = useState(false);
  const [inTauri, setInTauri] = useState(false);
  const [view, setView] = useState<View>("library");
  const [memes, setMemes] = useState<Meme[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<Meme | null>(null);
  const searchTimer = useRef<number | null>(null);

  const loadAll = useCallback(async () => {
    const rows = await invoke<Meme[]>("list_memes");
    setMemes(rows);
  }, []);

  const loadSettings = useCallback(async () => {
    const next = await invoke<AppSettings>("get_settings");
    setSettings(next);
  }, []);

  const runSearch = useCallback(async (q: string) => {
    const rows = await invoke<Meme[]>("search_memes", { query: q });
    setMemes(rows);
  }, []);

  useEffect(() => {
    const ok = isTauri();
    setInTauri(ok);
    setReady(true);
    if (!ok) return;
    (async () => {
      try {
        await invoke<SyncReport>("sync_library");
        await Promise.all([loadAll(), loadSettings()]);
      } catch (e) {
        setStatus(String(e));
      }
    })();
  }, [loadAll, loadSettings]);

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
    const bytes = await readFile(path);
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    try {
      const { data } = await Tesseract.recognize(url, "eng", {
        logger: () => {},
      });
      return (data.text || "").replace(/\s+/g, " ").trim();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function onImport() {
    const picked = await open({
      multiple: true,
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
        },
      ],
    });
    if (!picked) return;

    const paths = Array.isArray(picked) ? picked : [picked];
    setBusy(true);
    let ok = 0;

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
        await invoke<Meme>("import_meme", {
          sourcePath: path,
          ocrText: text,
          title: null,
        });
        ok += 1;
      }
      setStatus(ok === 1 ? "1 meme saved" : `${ok} memes saved`);
      await runSearch(query);
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(meme: Meme) {
    await invoke("delete_meme", { id: meme.id });
    if (selected?.id === meme.id) setSelected(null);
    await runSearch(query);
    setStatus("Deleted");
  }

  async function onCopy(meme: Meme) {
    try {
      await invoke("copy_meme", { id: meme.id });
      setStatus("Copied image");
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

  return (
    <div className="stage">
      <div className="halftone" aria-hidden />
      <header className="top">
        <div className="brand">
          <h1>MemeFactory</h1>
          <p>stash · scan · find</p>
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
              placeholder="Search OCR text…"
              aria-label="Search memes"
            />
          </form>
        ) : (
          <div className="search-spacer" />
        )}
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
      </header>

      {status ? <p className="status">{status}</p> : null}

      {view === "settings" ? (
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
        </div>
      ) : view === "about" ? (
        <div className="settings about-page">
          <section className="settings-card about hero-about">
            <p className="eyebrow">made by gabo</p>
            <h2>Hey — I’m gabo.</h2>
            <p className="settings-copy">
              Indie builder who likes small tools that feel personal. I make
              software that stays on your machine, respects your time, and
              doesn’t need an account to be useful.
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
            <span>Hit Import — OCR indexes the text for instant search.</span>
          </div>
        </div>
      ) : (
        <div className="grid">
          {memes.map((m) => (
            <button
              key={m.id}
              type="button"
              className="card"
              onClick={() => setSelected(m)}
            >
              <img
                src={convertFileSrc(m.path)}
                alt={m.title || m.filename}
                loading="lazy"
              />
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
            <img
              src={convertFileSrc(selected.path)}
              alt={selected.title || selected.filename}
            />
            <div className="meta">
              <h2>{selected.title || "Untitled"}</h2>
              <p className="ocr">
                {selected.ocrText || "No text detected"}
              </p>
              <div className="actions">
                <button type="button" onClick={() => onCopy(selected)}>
                  Copy
                </button>
                <button type="button" onClick={() => setSelected(null)}>
                  Close
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => onDelete(selected)}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
