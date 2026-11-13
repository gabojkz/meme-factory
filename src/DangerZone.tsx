import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { formatBytes } from "./libraryView";

type EraseItem = { path: string; bytes: number; what: string };
type ErasePlan = { memes: number; items: EraseItem[]; customFolder: string | null; totalBytes: number };
export type EraseReport = {
  filesRemoved: number;
  bytesRemoved: number;
  failures: string[];
  keptInCustomFolder: number;
};

const CONFIRM_WORD = "ERASE";

/**
 * Config section that permanently erases every meme and all app data.
 * Two steps: open the plan (shows exactly what goes), then type ERASE.
 */
export function DangerZone({ disabled, onErased }: { disabled: boolean; onErased: (r: EraseReport) => void }) {
  const [plan, setPlan] = useState<ErasePlan | null>(null);
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  async function open() {
    setError("");
    setTyped("");
    try {
      setPlan(await invoke<ErasePlan>("erase_plan"));
    } catch (e) {
      setError(String(e));
    }
  }

  async function erase() {
    if (typed !== CONFIRM_WORD) return;
    setWorking(true);
    setError("");
    try {
      onErased(await invoke<EraseReport>("erase_everything", { confirm: typed }));
    } catch (e) {
      setError(String(e));
      setWorking(false);
    }
  }

  return (
    <section className="settings-card danger-zone" aria-labelledby="danger-title">
      <h2 id="danger-title">⚠ Danger zone</h2>
      <p className="settings-copy">
        Erase every meme and everything MemeFactory has stored on this computer — your library, tags, text,
        Studio projects, downloaded asset packs, settings and caches. Files are deleted directly, not moved to
        the Trash. <strong>This can’t be undone.</strong>
      </p>

      {!plan ? (
        <div className="settings-actions">
          <button type="button" className="danger-btn" onClick={open} disabled={disabled}>
            Erase everything…
          </button>
        </div>
      ) : (
        <div className="erase-confirm" role="alertdialog" aria-labelledby="erase-heading">
          <h3 id="erase-heading">
            This will permanently delete {plan.memes === 1 ? "1 meme" : `${plan.memes} memes`} and{" "}
            {formatBytes(plan.totalBytes)} of data:
          </h3>
          <ul className="erase-list">
            {plan.items.map((item) => (
              <li key={item.path}>
                <span>{item.what}</span>
                <code>{item.path}</code>
                <small>{formatBytes(item.bytes)}</small>
              </li>
            ))}
          </ul>
          {plan.customFolder ? (
            <p className="hint">
              Your memes folder is a folder you chose, so only the memes inside it are deleted. Any other files
              there are left alone, and the folder is removed only if it ends up empty.
            </p>
          ) : null}
          <details className="erase-limits">
            <summary>What this can’t reach</summary>
            <ul>
              <li>The original files you imported from (Import copies them; the originals stay where they were).</li>
              <li>Memes you’ve already sent, posted or saved somewhere else.</li>
              <li>Backups such as Time Machine, and folders synced to iCloud or Dropbox.</li>
              <li>
                Deleted data on SSDs can’t be guaranteed unrecoverable by forensic tools; with FileVault on, what’s
                left is encrypted and unreadable.
              </li>
              <li>The MemeFactory app itself — drag it to the Trash afterwards if you want it gone too.</li>
            </ul>
            <p className="hint">The clipboard is cleared too, in case a meme is still on it.</p>
          </details>
          <label className="erase-type">
            <span>
              Type <strong>{CONFIRM_WORD}</strong> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void erase()}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={working}
              autoFocus
              aria-label={`Type ${CONFIRM_WORD} to confirm`}
            />
          </label>
          <div className="settings-actions">
            <button
              type="button"
              className="danger-btn"
              onClick={erase}
              disabled={working || typed !== CONFIRM_WORD}
            >
              {working ? "Erasing…" : "Erase everything forever"}
            </button>
            <button type="button" className="ghost" onClick={() => setPlan(null)} disabled={working}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error ? <p className="hint erase-error">{error}</p> : null}
    </section>
  );
}

/** Shown instead of the whole app once everything is erased. */
export function ErasedScreen({ report }: { report: EraseReport }) {
  return (
    <div className="erased">
      <div className="settings-card erased-card">
        <h2>Everything is gone.</h2>
        <p className="settings-copy">
          Deleted {report.filesRemoved} {report.filesRemoved === 1 ? "file" : "files"} (
          {formatBytes(report.bytesRemoved)}). MemeFactory needs to close now — next time it opens, it starts
          empty.
        </p>
        {report.keptInCustomFolder ? (
          <p className="hint">
            Your chosen memes folder still holds {report.keptInCustomFolder} other{" "}
            {report.keptInCustomFolder === 1 ? "item" : "items"} that weren’t memes, so it was kept.
          </p>
        ) : null}
        {report.failures.length ? (
          <div className="erase-error">
            <p className="hint">These couldn’t be deleted — remove them by hand:</p>
            <ul>
              {report.failures.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="settings-actions">
          <button type="button" className="danger-btn" onClick={() => void invoke("quit_after_erase")} autoFocus>
            Close MemeFactory
          </button>
        </div>
      </div>
    </div>
  );
}
