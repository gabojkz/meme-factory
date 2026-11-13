//! "Erase everything": permanently removes every meme and every file MemeFactory
//! keeps on this machine. Deletion is direct (no Trash).
//!
//! Safety rules:
//! - App folders are removed whole only when their name contains the app identifier,
//!   so a bad path can never take a user folder with it.
//! - A custom memes folder (which may hold other files) only loses the memes in it;
//!   the folder itself goes only if that leaves it empty.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::{is_meme_path, AppState};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EraseItem {
    pub path: String,
    pub bytes: u64,
    /// What lives there, for the confirmation screen.
    pub what: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErasePlan {
    pub memes: u32,
    pub items: Vec<EraseItem>,
    /// A user-chosen memes folder: only its memes are removed.
    pub custom_folder: Option<String>,
    pub total_bytes: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EraseReport {
    pub files_removed: u32,
    pub bytes_removed: u64,
    /// Things that couldn't be removed, with the reason.
    pub failures: Vec<String>,
    /// Non-meme files left in a custom folder (so it was kept).
    pub kept_in_custom_folder: u32,
}

fn tree_size(path: &Path) -> (u64, u32) {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_file() => (m.len(), 1),
        Ok(m) if m.is_dir() => fs::read_dir(path)
            .map(|rd| {
                rd.flatten().fold((0, 0), |(b, n), e| {
                    let (eb, en) = tree_size(&e.path());
                    (b + eb, n + en)
                })
            })
            .unwrap_or((0, 0)),
        Ok(m) => (m.len(), 1), // symlink: removed, never followed
        Err(_) => (0, 0),
    }
}

/// Only paths whose last component names the app may be removed wholesale.
fn owned_by_app(path: &Path, identifier: &str) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == identifier || n.starts_with(&format!("{identifier}.")))
}

/// Every folder/file MemeFactory itself owns, deduplicated, existing ones only.
fn app_locations(app: &AppHandle) -> Vec<(PathBuf, &'static str)> {
    let id = app.config().identifier.clone();
    let p = app.path();
    let mut out: Vec<(PathBuf, &'static str)> = Vec::new();
    let mut push = |path: Option<PathBuf>, what: &'static str| {
        if let Some(path) = path {
            if path.exists() && owned_by_app(&path, &id) && !out.iter().any(|(q, _)| *q == path) {
                out.push((path, what));
            }
        }
    };
    push(p.app_data_dir().ok(), "Library database, settings, memes, Studio projects, asset packs");
    push(p.app_local_data_dir().ok(), "Local app data");
    push(p.app_config_dir().ok(), "App config");
    push(p.app_cache_dir().ok(), "Caches");
    push(p.app_log_dir().ok(), "Logs");
    if cfg!(target_os = "macos") {
        if let Ok(home) = p.home_dir() {
            let lib = home.join("Library");
            push(Some(lib.join("WebKit").join(&id)), "Browser storage (thumbnails cache, preferences)");
            push(Some(lib.join("HTTPStorages").join(&id)), "Web storage");
            push(Some(lib.join("Saved Application State").join(format!("{id}.savedState"))), "Window state");
            push(Some(lib.join("Preferences").join(format!("{id}.plist"))), "Preferences");
        }
    }
    out
}

fn custom_folder(app: &AppHandle, state: &AppState) -> Option<PathBuf> {
    let current = state.memes_dir.lock().ok()?.clone();
    let inside_app = app_locations(app).iter().any(|(dir, _)| current.starts_with(dir));
    (!inside_app).then_some(current)
}

fn tracked_paths(state: &AppState) -> Result<Vec<PathBuf>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT path FROM memes").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(PathBuf::from).collect())
}

/// Meme files directly inside a custom folder (what "Rescan folder" would index).
fn memes_in(folder: &Path) -> Vec<PathBuf> {
    fs::read_dir(folder)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file() && is_meme_path(p))
                .collect()
        })
        .unwrap_or_default()
}

/// What "Erase everything" would remove, for the confirmation screen. Changes nothing.
#[tauri::command]
pub fn erase_plan(app: AppHandle, state: State<'_, AppState>) -> Result<ErasePlan, String> {
    let tracked = tracked_paths(&state)?;
    let mut items: Vec<EraseItem> = app_locations(&app)
        .into_iter()
        .map(|(path, what)| EraseItem {
            bytes: tree_size(&path).0,
            path: path.to_string_lossy().into_owned(),
            what: what.into(),
        })
        .collect();
    let custom = custom_folder(&app, &state);
    if let Some(folder) = &custom {
        let mut files = memes_in(folder);
        files.extend(tracked.iter().filter(|p| p.starts_with(folder) && p.exists()).cloned());
        files.sort();
        files.dedup();
        items.push(EraseItem {
            bytes: files.iter().map(|f| tree_size(f).0).sum(),
            path: folder.to_string_lossy().into_owned(),
            what: format!("{} meme files in your custom memes folder (other files stay)", files.len()),
        });
    }
    // Memes recorded somewhere else entirely (e.g. an old folder).
    let app_dirs = app_locations(&app);
    let stray: Vec<&PathBuf> = tracked
        .iter()
        .filter(|p| p.exists())
        .filter(|p| !app_dirs.iter().any(|(d, _)| p.starts_with(d)))
        .filter(|p| custom.as_ref().is_none_or(|c| !p.starts_with(c)))
        .collect();
    if !stray.is_empty() {
        items.push(EraseItem {
            bytes: stray.iter().map(|f| tree_size(f).0).sum(),
            path: "(other locations)".into(),
            what: format!("{} memes saved outside the memes folder", stray.len()),
        });
    }
    Ok(ErasePlan {
        memes: tracked.len() as u32,
        total_bytes: items.iter().map(|i| i.bytes).sum(),
        custom_folder: custom.map(|c| c.to_string_lossy().into_owned()),
        items,
    })
}

fn remove_file(path: &Path, report: &mut EraseReport) {
    let bytes = fs::symlink_metadata(path).map(|m| m.len()).unwrap_or(0);
    match fs::remove_file(path) {
        Ok(()) => {
            report.files_removed += 1;
            report.bytes_removed += bytes;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => report.failures.push(format!("{}: {e}", path.display())),
    }
}

fn remove_tree(path: &Path, report: &mut EraseReport) {
    let (bytes, files) = tree_size(path);
    let result = if fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    match result {
        Ok(()) => {
            report.files_removed += files;
            report.bytes_removed += bytes;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => report.failures.push(format!("{}: {e}", path.display())),
    }
}

/// Removes tracked memes, the memes in `custom`, then `custom` itself if left empty.
pub(crate) fn erase_files(
    tracked: &[PathBuf],
    custom: Option<&Path>,
    app_dirs: &[PathBuf],
    report: &mut EraseReport,
) {
    for path in tracked {
        remove_file(path, report);
    }
    if let Some(folder) = custom {
        for path in memes_in(folder) {
            remove_file(&path, report);
        }
        // .DS_Store is the Finder's, not the user's: it shouldn't keep the folder alive.
        let _ = fs::remove_file(folder.join(".DS_Store"));
        let left = fs::read_dir(folder).map(|rd| rd.count() as u32).unwrap_or(0);
        if left == 0 {
            let _ = fs::remove_dir(folder);
        } else {
            report.kept_in_custom_folder = left;
        }
    }
    for dir in app_dirs {
        remove_tree(dir, report);
    }
}

/// Permanently erases every meme and all MemeFactory data. The caller must quit
/// the app afterwards (nothing works once the library is gone).
#[tauri::command]
pub fn erase_everything(confirm: String, app: AppHandle, state: State<'_, AppState>) -> Result<EraseReport, String> {
    if confirm != "ERASE" {
        return Err("Type ERASE to confirm".into());
    }
    let tracked = tracked_paths(&state)?;
    let custom = custom_folder(&app, &state);
    let app_dirs: Vec<PathBuf> = app_locations(&app).into_iter().map(|(p, _)| p).collect();

    // Close the database so its files (and -wal/-shm) can be deleted.
    {
        let mut db = state.db.lock().map_err(|e| e.to_string())?;
        *db = rusqlite::Connection::open_in_memory().map_err(|e| e.to_string())?;
    }

    // Browser-side data: storage, caches of shown memes.
    for (_, webview) in app.webview_windows() {
        let _ = webview.clear_all_browsing_data();
    }

    let mut report = EraseReport::default();
    erase_files(&tracked, custom.as_deref(), &app_dirs, &mut report);

    // A copied meme may still be on the clipboard.
    if let Ok(mut clipboard) = arboard::Clipboard::new() {
        let _ = clipboard.clear();
    }
    Ok(report)
}

/// Quits after an erase, clearing browser data once more so nothing is written back.
#[tauri::command]
pub fn quit_after_erase(app: AppHandle) {
    for (_, webview) in app.webview_windows() {
        let _ = webview.clear_all_browsing_data();
    }
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mf-erase-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_app_named_folders_are_owned() {
        let id = "com.tusk.memefactory";
        assert!(owned_by_app(Path::new("/x/Application Support/com.tusk.memefactory"), id));
        assert!(owned_by_app(Path::new("/x/Preferences/com.tusk.memefactory.plist"), id));
        assert!(!owned_by_app(Path::new("/Users/me/Desktop"), id));
        assert!(!owned_by_app(Path::new("/Users/me/com.tusk.memefactory-notes"), id));
        assert!(!owned_by_app(Path::new("/"), id));
    }

    #[test]
    fn custom_folder_keeps_other_files_and_app_dirs_go() {
        let root = scratch();
        let app_dir = root.join("com.tusk.memefactory");
        fs::create_dir_all(app_dir.join("memes")).unwrap();
        fs::write(app_dir.join("memes.db"), b"db").unwrap();
        fs::write(app_dir.join("memes").join("a.png"), b"png").unwrap();

        let custom = root.join("My Memes");
        fs::create_dir_all(&custom).unwrap();
        fs::write(custom.join("b.gif"), b"gif").unwrap();
        fs::write(custom.join("c.mp4"), b"mp4").unwrap();
        fs::write(custom.join("taxes.pdf"), b"keep me").unwrap();
        fs::create_dir_all(custom.join("subfolder")).unwrap();
        fs::write(custom.join("subfolder").join("d.png"), b"not indexed, keep").unwrap();

        let elsewhere = root.join("old.png");
        fs::write(&elsewhere, b"old").unwrap();

        let mut report = EraseReport::default();
        erase_files(&[elsewhere.clone(), custom.join("b.gif")], Some(&custom), &[app_dir.clone()], &mut report);

        assert!(!app_dir.exists());
        assert!(!elsewhere.exists());
        assert!(!custom.join("b.gif").exists() && !custom.join("c.mp4").exists());
        assert!(custom.join("taxes.pdf").exists(), "non-meme files must survive");
        assert!(custom.join("subfolder").join("d.png").exists(), "subfolders are not touched");
        assert_eq!(report.kept_in_custom_folder, 2);
        assert!(report.failures.is_empty());
        assert_eq!(report.files_removed, 2 + 1 + 2); // app files, stray, custom memes
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn empty_custom_folder_is_removed() {
        let root = scratch();
        let custom = root.join("memes");
        fs::create_dir_all(&custom).unwrap();
        fs::write(custom.join("x.webp"), b"w").unwrap();
        fs::write(custom.join(".DS_Store"), b"finder").unwrap();
        let mut report = EraseReport::default();
        erase_files(&[], Some(&custom), &[], &mut report);
        assert!(!custom.exists());
        assert_eq!(report.kept_in_custom_folder, 0);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn symlinks_are_removed_not_followed() {
        let root = scratch();
        let precious = root.join("precious");
        fs::create_dir_all(&precious).unwrap();
        fs::write(precious.join("keep.txt"), b"keep").unwrap();
        let app_dir = root.join("com.tusk.memefactory");
        fs::create_dir_all(&app_dir).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&precious, app_dir.join("link")).unwrap();
        let mut report = EraseReport::default();
        erase_files(&[], None, &[app_dir.clone()], &mut report);
        assert!(!app_dir.exists());
        assert!(precious.join("keep.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
