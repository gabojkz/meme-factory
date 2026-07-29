import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import Tesseract from "tesseract.js";
import "./App.css";

type Meme = {
  id: string;
  filename: string;
  path: string;
  title: string | null;
  ocrText: string;
  createdAt: string;
};

function App() {
  const [ready, setReady] = useState(false);
  const [inTauri, setInTauri] = useState(false);
  const [memes, setMemes] = useState<Meme[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<Meme | null>(null);
  const searchTimer = useRef<number | null>(null);

  const loadAll = useCallback(async () => {
    const rows = await invoke<Meme[]>("list_memes");
    setMemes(rows);
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
    loadAll().catch((e) => setStatus(String(e)));
  }, [loadAll]);

  useEffect(() => {
    if (!inTauri) return;
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      runSearch(query).catch((e) => setStatus(String(e)));
    }, 120);
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    };
  }, [query, runSearch, inTauri]);

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
        <button
          className="import"
          type="button"
          onClick={onImport}
          disabled={busy}
        >
          {busy ? "Working…" : "+ Import"}
        </button>
      </header>

      {status ? <p className="status">{status}</p> : null}

      {memes.length === 0 ? (
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
