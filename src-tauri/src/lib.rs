use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Meme {
    pub id: String,
    pub filename: String,
    pub path: String,
    pub title: Option<String>,
    pub ocr_text: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct ConfigFile {
    memes_dir: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub memes_dir: String,
    pub default_dir: String,
    pub is_default: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub moved: u32,
    pub indexed: u32,
    pub total: u32,
}


struct AppState {
    db: Mutex<Connection>,
    memes_dir: Mutex<PathBuf>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    Ok(data)
}

fn default_memes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("memes");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("config.json"))
}

fn load_config(app: &AppHandle) -> Result<ConfigFile, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(ConfigFile::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn save_config(app: &AppHandle, config: &ConfigFile) -> Result<(), String> {
    let path = config_path(app)?;
    let raw = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn resolve_memes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let config = load_config(app)?;
    if let Some(custom) = config.memes_dir.filter(|p| !p.trim().is_empty()) {
        let dir = PathBuf::from(custom);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(dir);
    }
    default_memes_dir(app)
}

fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS memes (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            path TEXT NOT NULL,
            title TEXT,
            ocr_text TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memes_fts USING fts5(
            id UNINDEXED,
            title,
            ocr_text,
            filename,
            content='memes',
            content_rowid='rowid'
        );
        CREATE TRIGGER IF NOT EXISTS memes_ai AFTER INSERT ON memes BEGIN
            INSERT INTO memes_fts(rowid, id, title, ocr_text, filename)
            VALUES (new.rowid, new.id, new.title, new.ocr_text, new.filename);
        END;
        CREATE TRIGGER IF NOT EXISTS memes_ad AFTER DELETE ON memes BEGIN
            INSERT INTO memes_fts(memes_fts, rowid, id, title, ocr_text, filename)
            VALUES ('delete', old.rowid, old.id, old.title, old.ocr_text, old.filename);
        END;
        CREATE TRIGGER IF NOT EXISTS memes_au AFTER UPDATE ON memes BEGIN
            INSERT INTO memes_fts(memes_fts, rowid, id, title, ocr_text, filename)
            VALUES ('delete', old.rowid, old.id, old.title, old.ocr_text, old.filename);
            INSERT INTO memes_fts(rowid, id, title, ocr_text, filename)
            VALUES (new.rowid, new.id, new.title, new.ocr_text, new.filename);
        END;
        ",
    )
    .map_err(|e| e.to_string())
}


fn is_image_path(path: &Path) -> bool {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") => true,
        _ => false,
    }
}

fn sync_library_inner(state: &AppState) -> Result<SyncReport, String> {
    let memes_dir = state.memes_dir.lock().map_err(|e| e.to_string())?.clone();
    fs::create_dir_all(&memes_dir).map_err(|e| e.to_string())?;

    let mut moved = 0u32;
    let mut indexed = 0u32;

    // Relocate existing library files into the active folder.
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, filename, path FROM memes")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(stmt);

        for (id, filename, old_path) in rows {
            let src = PathBuf::from(&old_path);
            let dest = memes_dir.join(&filename);
            let same = src.exists()
                && dest.exists()
                && src
                    .canonicalize()
                    .ok()
                    .zip(dest.canonicalize().ok())
                    .map(|(a, b)| a == b)
                    .unwrap_or(false);

            if same {
                if old_path != dest.to_string_lossy() {
                    conn.execute(
                        "UPDATE memes SET path = ?1 WHERE id = ?2",
                        params![dest.to_string_lossy().to_string(), id],
                    )
                    .map_err(|e| e.to_string())?;
                }
                continue;
            }

            if src.exists() {
                if src != dest {
                    if !dest.exists() {
                        fs::copy(&src, &dest).map_err(|e| e.to_string())?;
                    }
                    conn.execute(
                        "UPDATE memes SET path = ?1 WHERE id = ?2",
                        params![dest.to_string_lossy().to_string(), id],
                    )
                    .map_err(|e| e.to_string())?;
                    moved += 1;
                }
            }
        }
    }

    // Index image files already sitting in the folder.
    let known = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT path FROM memes")
            .map_err(|e| e.to_string())?;
        let paths = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        paths
            .into_iter()
            .map(|p| {
                PathBuf::from(&p)
                    .canonicalize()
                    .unwrap_or_else(|_| PathBuf::from(p))
            })
            .collect::<std::collections::HashSet<_>>()
    };

    let entries = fs::read_dir(&memes_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || !is_image_path(&path) {
            continue;
        }
        let canon = path.canonicalize().unwrap_or_else(|_| path.clone());
        if known.contains(&canon) {
            continue;
        }

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_lowercase();
        let id = Uuid::new_v4().to_string();
        let filename = path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{id}.{ext}"));
        let title = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string());
        let path_str = path.to_string_lossy().to_string();
        let created_at = Utc::now().to_rfc3339();

        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO memes (id, filename, path, title, ocr_text, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, filename, path_str, title, "", created_at],
        )
        .map_err(|e| e.to_string())?;
        indexed += 1;
    }

    let total = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT COUNT(*) FROM memes", [], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())? as u32
    };

    Ok(SyncReport {
        moved,
        indexed,
        total,
    })
}

fn row_to_meme(row: &rusqlite::Row<'_>) -> rusqlite::Result<Meme> {
    Ok(Meme {
        id: row.get(0)?,
        filename: row.get(1)?,
        path: row.get(2)?,
        title: row.get(3)?,
        ocr_text: row.get(4)?,
        created_at: row.get(5)?,
    })
}

#[tauri::command]
fn get_settings(app: AppHandle, state: State<'_, AppState>) -> Result<AppSettings, String> {
    let memes_dir = state
        .memes_dir
        .lock()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    let default_dir = default_memes_dir(&app)?.to_string_lossy().to_string();
    Ok(AppSettings {
        is_default: memes_dir == default_dir,
        memes_dir,
        default_dir,
    })
}

#[tauri::command]
fn set_memes_folder(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(AppSettings, SyncReport), String> {
    let dir = PathBuf::from(path.trim());
    if dir.as_os_str().is_empty() {
        return Err("Folder path is empty".into());
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut config = load_config(&app)?;
    config.memes_dir = Some(dir.to_string_lossy().to_string());
    save_config(&app, &config)?;

    *state.memes_dir.lock().map_err(|e| e.to_string())? = dir;
    let report = sync_library_inner(&state)?;
    Ok((get_settings(app, state)?, report))
}

#[tauri::command]
fn reset_memes_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(AppSettings, SyncReport), String> {
    let dir = default_memes_dir(&app)?;
    let mut config = load_config(&app)?;
    config.memes_dir = None;
    save_config(&app, &config)?;
    *state.memes_dir.lock().map_err(|e| e.to_string())? = dir;
    let report = sync_library_inner(&state)?;
    Ok((get_settings(app, state)?, report))
}

#[tauri::command]
fn sync_library(state: State<'_, AppState>) -> Result<SyncReport, String> {
    sync_library_inner(&state)
}

#[tauri::command]
fn list_memes(state: State<'_, AppState>) -> Result<Vec<Meme>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, filename, path, title, ocr_text, created_at
             FROM memes ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_meme)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
fn search_memes(query: String, state: State<'_, AppState>) -> Result<Vec<Meme>, String> {
    let q = query.trim();
    if q.is_empty() {
        return list_memes(state);
    }

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let safe = q
        .replace('"', " ")
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('*', "")))
        .collect::<Vec<_>>()
        .join(" ");

    if safe.is_empty() {
        drop(conn);
        return list_memes(state);
    }

    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.filename, m.path, m.title, m.ocr_text, m.created_at
             FROM memes m
             JOIN memes_fts f ON m.rowid = f.rowid
             WHERE memes_fts MATCH ?
             ORDER BY rank, m.created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![safe], row_to_meme)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
fn import_meme(
    source_path: String,
    ocr_text: String,
    title: Option<String>,
    state: State<'_, AppState>,
) -> Result<Meme, String> {
    let memes_dir = state.memes_dir.lock().map_err(|e| e.to_string())?.clone();
    fs::create_dir_all(&memes_dir).map_err(|e| e.to_string())?;

    let src = Path::new(&source_path);
    if !src.exists() {
        return Err("Source file not found".into());
    }

    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let id = Uuid::new_v4().to_string();
    let filename = format!("{id}.{ext}");
    let dest = memes_dir.join(&filename);
    fs::copy(src, &dest).map_err(|e| e.to_string())?;

    let created_at = Utc::now().to_rfc3339();
    let path_str = dest.to_string_lossy().to_string();
    let original_name = src
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());
    let title = title.or(original_name);
    let ocr_clean = ocr_text.trim().to_string();

    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO memes (id, filename, path, title, ocr_text, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, filename, path_str, title, ocr_clean, created_at],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(Meme {
        id,
        filename,
        path: path_str,
        title,
        ocr_text: ocr_clean,
        created_at,
    })
}

#[tauri::command]
fn delete_meme(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let path: String = conn
        .query_row(
            "SELECT path FROM memes WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM memes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    let _ = fs::remove_file(path);
    Ok(())
}

#[tauri::command]
fn update_meme_ocr(
    id: String,
    ocr_text: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE memes SET ocr_text = ?1 WHERE id = ?2",
        params![ocr_text.trim(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn copy_meme(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let path: String = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT path FROM memes WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?
    };

    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to decode image: {e}"))?
        .into_rgba8();
    let (w, h) = img.dimensions();

    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set_image(arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Owned(img.into_raw()),
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn meme_count(state: State<'_, AppState>) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT COUNT(*) FROM memes", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let data = data_dir(app.handle())?;
            let memes_dir = resolve_memes_dir(app.handle())?;
            let db_path = data.join("memes.db");
            let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
            init_db(&conn)?;
            app.manage(AppState {
                db: Mutex::new(conn),
                memes_dir: Mutex::new(memes_dir),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_memes,
            search_memes,
            import_meme,
            delete_meme,
            update_meme_ocr,
            meme_count,
            copy_meme,
            get_settings,
            set_memes_folder,
            reset_memes_folder,
            sync_library
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
