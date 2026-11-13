import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isVideoPath } from "../videoToGif";

type LibraryMeme = {
  id: string;
  filename: string;
  path: string;
  title: string | null;
};

type Props = {
  onPick: (path: string) => void;
  onClose: () => void;
};

export default function LibraryPicker({ onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [memes, setMemes] = useState<LibraryMeme[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => {
      invoke<LibraryMeme[]>("search_memes", { query }).then(
        // Videos can't go on the canvas.
        (list) => setMemes(list.filter((m) => !isVideoPath(m.path))),
        (e) => setError(String(e)),
      );
    }, 120);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Pick from library" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <h2>Pick from library</h2>
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search OCR text…" aria-label="Search library" />
          <button type="button" className="ghost sm" onClick={onClose}>
            Close
          </button>
        </div>
        {error ? <p className="tip">{error}</p> : null}
        {memes.length === 0 ? (
          <p className="tip">{query ? "No matches." : "Your library is empty — import some memes first."}</p>
        ) : (
          <div className="picker-grid">
            {memes.map((m) => (
              <button key={m.id} type="button" className="card" onClick={() => onPick(m.path)} title={m.title ?? m.filename}>
                <img src={convertFileSrc(m.path)} alt={m.title || m.filename} loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
