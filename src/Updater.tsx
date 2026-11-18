/**
 * In-app updates: check GitHub for a newer published release, download and install
 * it with a progress bar, then restart. Memes, tags and settings live in the user's
 * data folder, never inside the app, so an update can't touch them.
 *
 * Releases carry a signed `latest.json` (see .github/workflows/release.yml). Releases
 * without one (older ones) still get noticed, with a link to the download page.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";

const RELEASES_URL = "https://github.com/gabojkz/meme-factory/releases/latest";
const LATEST_RELEASE_API = "https://api.github.com/repos/gabojkz/meme-factory/releases/latest";
/** Set just before installing; the next launch on that version says "updated!" once. */
const JUST_UPDATED_KEY = "memefactory.updatedTo";

export type UpdaterState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "current"; version: string }
  | { phase: "available"; version: string }
  | { phase: "manual"; version: string } // newer release that can't install itself
  | { phase: "downloading"; version: string; percent: number | null }
  | { phase: "installing"; version: string }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };

export type Updater = ReturnType<typeof useUpdater>;

function parseVersion(raw: string): number[] {
  return raw
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part.replace(/[^0-9].*$/, ""), 10) || 0);
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

async function fetchLatestVersion(): Promise<string> {
  const res = await fetch(LATEST_RELEASE_API, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`couldn’t reach GitHub (${res.status})`);
  const data = (await res.json()) as { tag_name?: string };
  if (!data.tag_name) throw new Error("no release found");
  return data.tag_name.replace(/^v/i, "");
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function storage(action: "get" | "set" | "remove", value?: string): string | null {
  try {
    if (action === "get") return localStorage.getItem(JUST_UPDATED_KEY);
    if (action === "set") localStorage.setItem(JUST_UPDATED_KEY, value ?? "");
    else localStorage.removeItem(JUST_UPDATED_KEY);
  } catch {
    /* storage unavailable: the "updated!" note is just skipped */
  }
  return null;
}

export function useUpdater(currentVersion: string) {
  const [state, setState] = useState<UpdaterState>({ phase: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const [justUpdated, setJustUpdated] = useState<string | null>(null);
  const pending = useRef<Update | null>(null);

  // First launch after an update: say so once.
  useEffect(() => {
    if (!currentVersion) return;
    const to = storage("get");
    if (!to) return;
    storage("remove");
    if (to === currentVersion) setJustUpdated(to);
  }, [currentVersion]);

  const checkNow = useCallback(
    async (quiet = false) => {
      if (!currentVersion) return;
      setState({ phase: "checking" });
      if (!quiet) setDismissed(false);
      try {
        const update = await check({ timeout: 20_000 });
        if (update) {
          pending.current = update;
          setState({ phase: "available", version: update.version });
        } else {
          setState({ phase: "current", version: currentVersion });
        }
      } catch (e) {
        // The newest release has no signed update (or the check failed): ask GitHub directly.
        try {
          const latest = await fetchLatestVersion();
          setState(
            isNewerVersion(latest, currentVersion)
              ? { phase: "manual", version: latest }
              : { phase: "current", version: currentVersion },
          );
        } catch (e2) {
          setState(quiet ? { phase: "idle" } : { phase: "error", message: `Couldn’t check for updates: ${message(e2 ?? e)}` });
        }
      }
    },
    [currentVersion],
  );

  const install = useCallback(async () => {
    const update = pending.current;
    if (!update) return;
    let total = 0;
    let done = 0;
    setDismissed(false);
    setState({ phase: "downloading", version: update.version, percent: null });
    storage("set", update.version); // Windows closes the app to install; the next launch reads this
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
        } else if (ev.event === "Progress") {
          done += ev.data.chunkLength;
          setState({
            phase: "downloading",
            version: update.version,
            percent: total ? Math.min(100, Math.round((done / total) * 100)) : null,
          });
        } else {
          setState({ phase: "installing", version: update.version });
        }
      });
      setState({ phase: "ready", version: update.version });
    } catch (e) {
      storage("remove");
      setState({
        phase: "error",
        message: `The update didn’t install (${message(e)}). Nothing changed and your memes are safe. Try again, or get it from the website.`,
      });
    }
  }, []);

  const restart = useCallback(async () => {
    try {
      await relaunch();
    } catch (e) {
      setState({ phase: "error", message: `Couldn’t restart (${message(e)}). Close and reopen MemeFactory to finish.` });
    }
  }, []);

  const openReleases = useCallback(() => {
    void openUrl(RELEASES_URL).catch(() => {});
  }, []);

  return {
    state,
    checkNow,
    install,
    restart,
    openReleases,
    dismissed,
    dismiss: () => setDismissed(true),
    justUpdated,
    clearJustUpdated: () => setJustUpdated(null),
  };
}

/** Bar under the header: "new version", then download progress. */
export function UpdateBanner({ updater }: { updater: Updater }) {
  const { state, dismissed } = updater;
  if (dismissed) return null;

  if (state.phase === "available" || state.phase === "manual") {
    return (
      <div className="update-banner" role="status">
        <span className="update-emoji" aria-hidden="true">✨</span>
        <span className="update-text">
          <strong>MemeFactory {state.version} is out.</strong>{" "}
          {state.phase === "available"
            ? "Update in one click. Your memes stay right where they are."
            : "Download it from the website to update."}
        </span>
        <span className="update-actions">
          <button type="button" className="status-link" onClick={updater.openReleases}>
            What’s new
          </button>
          {state.phase === "available" ? (
            <button type="button" className="import" onClick={() => void updater.install()}>
              Update now
            </button>
          ) : (
            <button type="button" className="import" onClick={updater.openReleases}>
              Download
            </button>
          )}
          <button type="button" className="update-close" onClick={updater.dismiss} aria-label="Later" title="Later">
            ✕
          </button>
        </span>
      </div>
    );
  }

  if (state.phase === "downloading" || state.phase === "installing") {
    const pct = state.phase === "installing" ? 100 : state.percent;
    return (
      <div className="update-banner" role="status" aria-live="polite">
        <span className="update-emoji" aria-hidden="true">⬇</span>
        <span className="update-text">
          <strong>
            {state.phase === "installing" ? `Installing ${state.version}…` : `Downloading ${state.version}…`}
          </strong>{" "}
          {pct != null ? `${pct}%` : ""} · keep MemeFactory open
          <span className="update-progress" aria-hidden="true">
            <span style={{ width: `${pct ?? 15}%` }} className={pct == null ? "indeterminate" : ""} />
          </span>
        </span>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="update-banner update-error" role="alert">
        <span className="update-emoji" aria-hidden="true">⚠</span>
        <span className="update-text">{state.message}</span>
        <span className="update-actions">
          <button type="button" className="status-link" onClick={updater.openReleases}>
            Website
          </button>
          <button type="button" className="update-close" onClick={updater.dismiss} aria-label="Close" title="Close">
            ✕
          </button>
        </span>
      </div>
    );
  }
  return null;
}

/** "Updated! Restart" after installing, and "You're on X" on the first launch after. */
export function UpdateDialogs({ updater }: { updater: Updater }) {
  const { state, justUpdated } = updater;

  if (state.phase === "ready" && !updater.dismissed) {
    return (
      <div className="update-overlay" role="dialog" aria-modal="true" aria-labelledby="update-ready-title">
        <div className="update-card">
          <div className="update-badge" aria-hidden="true">🎉</div>
          <h2 id="update-ready-title">MemeFactory {state.version} is installed</h2>
          <p>
            Restart to start using the new version. Your memes, tags, text and settings stay exactly where they
            are. Nothing gets lost.
          </p>
          <div className="settings-actions">
            <button type="button" className="import" onClick={() => void updater.restart()} autoFocus>
              Restart now
            </button>
            <button type="button" className="ghost" onClick={updater.dismiss}>
              Later
            </button>
          </div>
          <p className="hint">“Later” is fine too: the new version starts next time you open MemeFactory.</p>
        </div>
      </div>
    );
  }

  if (justUpdated) {
    return (
      <div className="update-overlay" role="dialog" aria-modal="true" aria-labelledby="update-done-title">
        <div className="update-card">
          <div className="update-badge" aria-hidden="true">🚀</div>
          <h2 id="update-done-title">You’re on MemeFactory {justUpdated}</h2>
          <p>The update worked. Every meme, tag and setting is right where you left it. Enjoy the new stuff!</p>
          <div className="settings-actions">
            <button type="button" className="import" onClick={updater.clearJustUpdated} autoFocus>
              Nice
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                updater.openReleases();
                updater.clearJustUpdated();
              }}
            >
              What’s new
            </button>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

/** The Version card in Config. */
export function UpdateSettings({ updater, appVersion }: { updater: Updater; appVersion: string }) {
  const { state } = updater;
  const busy = state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";
  return (
    <section className="settings-card">
      <h2>Version</h2>
      <p className="settings-copy">
        You’re running <strong>MemeFactory {appVersion || "…"}</strong>
      </p>
      {state.phase === "available" ? (
        <p className="hint update-hint">Version {state.version} is ready to install.</p>
      ) : state.phase === "manual" ? (
        <p className="hint update-hint">Version {state.version} is out. Download it from the website.</p>
      ) : state.phase === "current" ? (
        <p className="hint">You’re up to date.</p>
      ) : state.phase === "checking" ? (
        <p className="hint">Checking for updates…</p>
      ) : state.phase === "downloading" ? (
        <p className="hint">Downloading {state.version}… {state.percent != null ? `${state.percent}%` : ""}</p>
      ) : state.phase === "installing" ? (
        <p className="hint">Installing {state.version}…</p>
      ) : state.phase === "ready" ? (
        <p className="hint update-hint">Version {state.version} is installed. Restart to use it.</p>
      ) : state.phase === "error" ? (
        <p className="hint">{state.message}</p>
      ) : null}
      <div className="settings-actions">
        {state.phase === "available" ? (
          <button type="button" className="import" onClick={() => void updater.install()}>
            Update now
          </button>
        ) : state.phase === "ready" ? (
          <button type="button" className="import" onClick={() => void updater.restart()}>
            Restart now
          </button>
        ) : (
          <button
            type="button"
            className="import"
            onClick={() => void updater.checkNow(false)}
            disabled={!appVersion || busy}
          >
            {state.phase === "checking" ? "Checking…" : "Check for updates"}
          </button>
        )}
        {state.phase === "manual" ? (
          <button type="button" className="ghost" onClick={updater.openReleases}>
            Get update
          </button>
        ) : null}
      </div>
      <p className="hint">Updates never touch your memes, tags or settings.</p>
    </section>
  );
}
