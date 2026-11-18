mod assets;
mod erase;
mod video_sites;

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    pub tags: Vec<String>,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub updated_at: String,
    pub thumbnail_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct ProjectMeta {
    #[serde(default)]
    name: String,
    #[serde(default)]
    updated_at: String,
}

pub(crate) struct AppState {
    pub(crate) db: Mutex<Connection>,
    pub(crate) memes_dir: Mutex<PathBuf>,
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

fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("projects");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Project ids come from the frontend; only allow plain uuid-ish names so
/// they can never escape the projects folder.
fn check_project_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok {
        Ok(())
    } else {
        Err("Invalid project id".into())
    }
}

fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    // Accept both raw base64 and `data:image/png;base64,...` URLs.
    let raw = data.split_once(',').map(|(_, b)| b).unwrap_or(data);
    base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|e| format!("Invalid image data: {e}"))
}

const MEME_COLUMNS: &str = "m.id, m.filename, m.path, m.title, m.ocr_text, m.created_at, m.tags";

const FTS_SCHEMA: &str = "
        CREATE VIRTUAL TABLE IF NOT EXISTS memes_fts USING fts5(
            id UNINDEXED,
            title,
            ocr_text,
            filename,
            tags,
            content='memes',
            content_rowid='rowid'
        );
        CREATE TRIGGER IF NOT EXISTS memes_ai AFTER INSERT ON memes BEGIN
            INSERT INTO memes_fts(rowid, id, title, ocr_text, filename, tags)
            VALUES (new.rowid, new.id, new.title, new.ocr_text, new.filename, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS memes_ad AFTER DELETE ON memes BEGIN
            INSERT INTO memes_fts(memes_fts, rowid, id, title, ocr_text, filename, tags)
            VALUES ('delete', old.rowid, old.id, old.title, old.ocr_text, old.filename, old.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS memes_au AFTER UPDATE ON memes BEGIN
            INSERT INTO memes_fts(memes_fts, rowid, id, title, ocr_text, filename, tags)
            VALUES ('delete', old.rowid, old.id, old.title, old.ocr_text, old.filename, old.tags);
            INSERT INTO memes_fts(rowid, id, title, ocr_text, filename, tags)
            VALUES (new.rowid, new.id, new.title, new.ocr_text, new.filename, new.tags);
        END;
";

fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS memes (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            path TEXT NOT NULL,
            title TEXT,
            ocr_text TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            tags TEXT NOT NULL DEFAULT ''
        );
        ",
    )
    .map_err(|e| e.to_string())?;

    // v1: tags. Older libraries get the column, and the search index is
    // rebuilt so tags are searchable too.
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if version < 1 {
        let has_tags = conn
            .prepare("SELECT 1 FROM pragma_table_info('memes') WHERE name = 'tags'")
            .and_then(|mut st| st.exists([]))
            .map_err(|e| e.to_string())?;
        if !has_tags {
            conn.execute_batch("ALTER TABLE memes ADD COLUMN tags TEXT NOT NULL DEFAULT '';")
                .map_err(|e| e.to_string())?;
        }
        conn.execute_batch(
            "
            DROP TRIGGER IF EXISTS memes_ai;
            DROP TRIGGER IF EXISTS memes_ad;
            DROP TRIGGER IF EXISTS memes_au;
            DROP TABLE IF EXISTS memes_fts;
            ",
        )
        .map_err(|e| e.to_string())?;
        conn.execute_batch(FTS_SCHEMA).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "INSERT INTO memes_fts(memes_fts) VALUES ('rebuild');
             PRAGMA user_version = 1;",
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute_batch(FTS_SCHEMA).map_err(|e| e.to_string())
}

/// Tags are stored as ", "-joined text so the search index sees each word.
fn tags_to_text(tags: &[String]) -> String {
    tags.join(", ")
}

fn tags_from_text(text: &str) -> Vec<String> {
    text.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()
}

/// Lower-case, single-spaced, without commas or search syntax; unique, at most 30.
fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in tags {
        let clean: String = raw
            .trim()
            .trim_start_matches('#')
            .chars()
            .map(|c| if c == ',' || c == '"' || c == '*' || c.is_control() { ' ' } else { c })
            .collect::<String>()
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let clean: String = clean.chars().take(40).collect();
        if !clean.is_empty() && !out.contains(&clean) {
            out.push(clean);
        }
    }
    out.truncate(30);
    out
}

/// Images and short videos the library can hold.
pub(crate) fn is_meme_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "mp4" | "m4v" | "mov" | "webm")
    )
}

/// "mp4", "mov" or "webm" when the bytes are one of those containers.
pub(crate) fn video_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() > 12 && &bytes[4..8] == b"ftyp" {
        Some(if &bytes[8..12] == b"qt  " { "mov" } else { "mp4" })
    } else if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some("webm")
    } else {
        None
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
        if !path.is_file() || !is_meme_path(&path) {
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
        tags: tags_from_text(&row.get::<_, String>(6)?),
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
            &format!("SELECT {MEME_COLUMNS} FROM memes m ORDER BY m.created_at DESC"),
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
    // Words match anywhere (prefix match); `#tag` matches only that tag.
    let safe = q
        .replace('"', " ")
        .split_whitespace()
        .filter_map(|t| {
            let (tag_only, word) = match t.strip_prefix('#') {
                Some(rest) => (true, rest),
                None => (false, t),
            };
            let word = word.replace(['*', ','], "");
            if word.is_empty() {
                return None;
            }
            Some(if tag_only {
                format!("tags : \"{word}\"*")
            } else {
                format!("\"{word}\"*")
            })
        })
        .collect::<Vec<_>>()
        .join(" AND ");

    if safe.is_empty() {
        drop(conn);
        return list_memes(state);
    }

    // Tag and title hits rank above text found by OCR.
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {MEME_COLUMNS}
             FROM memes m
             JOIN memes_fts f ON m.rowid = f.rowid
             WHERE memes_fts MATCH ?
             ORDER BY bm25(memes_fts, 0.0, 6.0, 1.0, 1.0, 10.0), m.created_at DESC"
        ))
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![safe], row_to_meme)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Replaces a meme's tags; returns them cleaned up.
#[tauri::command]
fn update_meme_tags(id: String, tags: Vec<String>, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let tags = normalize_tags(&tags);
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute("UPDATE memes SET tags = ?1 WHERE id = ?2", params![tags_to_text(&tags), id])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("Meme not found".into());
    }
    Ok(tags)
}

#[derive(Serialize)]
struct TagCount {
    tag: String,
    count: u32,
}

/// Every tag in the library, most used first.
#[tauri::command]
fn list_tags(state: State<'_, AppState>) -> Result<Vec<TagCount>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT tags FROM memes WHERE tags != ''")
        .map_err(|e| e.to_string())?;
    let mut counts: HashMap<String, u32> = HashMap::new();
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for text in rows {
        for tag in tags_from_text(&text.map_err(|e| e.to_string())?) {
            *counts.entry(tag).or_default() += 1;
        }
    }
    let mut out: Vec<TagCount> = counts.into_iter().map(|(tag, count)| TagCount { tag, count }).collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then(a.tag.cmp(&b.tag)));
    Ok(out)
}

/// The id of a meme whose file is byte-for-byte `bytes`, if the library has one.
/// Only files of the same size are read, so this stays cheap.
fn find_existing(conn: &Connection, bytes: &[u8]) -> Result<Option<String>, String> {
    let mut stmt = conn.prepare("SELECT id, path FROM memes").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, path) = row.map_err(|e| e.to_string())?;
        let same_size = fs::metadata(&path).map(|m| m.len() == bytes.len() as u64).unwrap_or(false);
        if same_size && fs::read(&path).map(|b| b == bytes).unwrap_or(false) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

const ALREADY_SAVED: &str = "That meme is already in your library";

/// Checks pasted/dropped/downloaded bytes before the slow text scan:
/// the id of the identical meme already in the library, if any.
#[tauri::command]
fn existing_meme(data: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let bytes = decode_base64(&data)?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    find_existing(&conn, &bytes)
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

    if !is_meme_path(src) {
        return Err("Not a supported image or video file".into());
    }
    {
        let bytes = fs::read(src).map_err(|e| e.to_string())?;
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if find_existing(&conn, &bytes)?.is_some() {
            return Err(ALREADY_SAVED.into());
        }
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
        tags: Vec::new(),
    })
}

/// Saves pasted, dropped or downloaded image bytes into the library.
#[tauri::command]
fn import_meme_bytes(
    data: String,
    title: Option<String>,
    ocr_text: String,
    state: State<'_, AppState>,
) -> Result<Meme, String> {
    let bytes = decode_base64(&data)?;
    let ext = match (image::guess_format(&bytes), video_ext(&bytes)) {
        (_, Some(video)) => video,
        (Ok(image::ImageFormat::Png), _) => "png",
        (Ok(image::ImageFormat::Jpeg), _) => "jpg",
        (Ok(image::ImageFormat::Gif), _) => "gif",
        (Ok(image::ImageFormat::WebP), _) => "webp",
        (Ok(image::ImageFormat::Bmp), _) => "bmp",
        _ => return Err("Not a supported image or video (PNG, JPEG, GIF, WebP, BMP, MP4, MOV or WebM)".into()),
    };
    if video_ext(&bytes).is_none() {
        image::load_from_memory(&bytes).map_err(|e| format!("Failed to decode image: {e}"))?;
    }
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if find_existing(&conn, &bytes)?.is_some() {
            return Err(ALREADY_SAVED.into());
        }
    }

    let memes_dir = state.memes_dir.lock().map_err(|e| e.to_string())?.clone();
    fs::create_dir_all(&memes_dir).map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let filename = format!("{id}.{ext}");
    let dest = memes_dir.join(&filename);
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;

    let created_at = Utc::now().to_rfc3339();
    let path_str = dest.to_string_lossy().to_string();
    let title = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
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
        tags: Vec::new(),
    })
}

/// Saves a PNG rendered by the Studio canvas straight into the library.
#[tauri::command]
fn save_creation(
    data: String,
    title: Option<String>,
    ocr_text: String,
    state: State<'_, AppState>,
) -> Result<Meme, String> {
    let bytes = decode_base64(&data)?;
    image::load_from_memory(&bytes).map_err(|e| format!("Failed to decode image: {e}"))?;

    let memes_dir = state.memes_dir.lock().map_err(|e| e.to_string())?.clone();
    fs::create_dir_all(&memes_dir).map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();
    let filename = format!("{id}.png");
    let dest = memes_dir.join(&filename);
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;

    let created_at = Utc::now().to_rfc3339();
    let path_str = dest.to_string_lossy().to_string();
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
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
        tags: Vec::new(),
    })
}

#[tauri::command]
fn list_projects(app: AppHandle) -> Result<Vec<ProjectSummary>, String> {
    let dir = projects_dir(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        let meta: ProjectMeta = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let thumb = dir.join(format!("{id}.png"));
        out.push(ProjectSummary {
            name: if meta.name.is_empty() {
                "Untitled meme".into()
            } else {
                meta.name
            },
            updated_at: meta.updated_at,
            thumbnail_path: thumb
                .exists()
                .then(|| thumb.to_string_lossy().to_string()),
            id,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
fn load_project(id: String, app: AppHandle) -> Result<String, String> {
    check_project_id(&id)?;
    let path = projects_dir(&app)?.join(format!("{id}.json"));
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_project(
    id: String,
    data: String,
    thumbnail: Option<String>,
    app: AppHandle,
) -> Result<ProjectSummary, String> {
    check_project_id(&id)?;
    let meta: ProjectMeta =
        serde_json::from_str(&data).map_err(|e| format!("Invalid project data: {e}"))?;
    let dir = projects_dir(&app)?;
    let json_path = dir.join(format!("{id}.json"));
    let tmp_path = dir.join(format!("{id}.json.tmp"));
    // Write then rename so a crash mid-save never corrupts the old copy.
    fs::write(&tmp_path, &data).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &json_path).map_err(|e| e.to_string())?;

    let thumb_path = dir.join(format!("{id}.png"));
    if let Some(thumb) = thumbnail {
        fs::write(&thumb_path, decode_base64(&thumb)?).map_err(|e| e.to_string())?;
    }

    Ok(ProjectSummary {
        id,
        name: meta.name,
        updated_at: meta.updated_at,
        thumbnail_path: thumb_path
            .exists()
            .then(|| thumb_path.to_string_lossy().to_string()),
    })
}

#[tauri::command]
fn delete_project(id: String, app: AppHandle) -> Result<(), String> {
    check_project_id(&id)?;
    let dir = projects_dir(&app)?;
    fs::remove_file(dir.join(format!("{id}.json"))).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(dir.join(format!("{id}.png")));
    Ok(())
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

/// True for GIFs and WebPs with more than one frame.
fn is_animated(bytes: &[u8]) -> bool {
    use image::AnimationDecoder;
    use std::io::Cursor;
    match image::guess_format(bytes) {
        Ok(image::ImageFormat::Gif) => image::codecs::gif::GifDecoder::new(Cursor::new(bytes))
            .map(|d| d.into_frames().take(2).count() > 1)
            .unwrap_or(false),
        Ok(image::ImageFormat::WebP) => image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))
            .map(|d| d.has_animation())
            .unwrap_or(false),
        _ => false,
    }
}

/// Path of a small PNG shown under the cursor while a meme is dragged out to
/// another app. Images get a cached thumbnail; videos (no decoder here) get the app icon.
#[tauri::command]
fn drag_icon(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let path: String = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT path FROM memes WHERE id = ?1", params![id], |row| row.get(0))
            .map_err(|e| e.to_string())?
    };
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("drag-icons");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let out = dir.join(format!("{safe}.png"));
    if !out.exists() {
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let thumb = if video_ext(&bytes).is_some() {
            None
        } else {
            image::load_from_memory(&bytes).ok().map(|img| img.thumbnail(160, 160))
        };
        match thumb {
            Some(img) => img.save_with_format(&out, image::ImageFormat::Png).map_err(|e| e.to_string())?,
            None => fs::write(&out, include_bytes!("../icons/128x128.png")).map_err(|e| e.to_string())?,
        }
    }
    Ok(out.to_string_lossy().into_owned())
}

/// Copies a meme. Videos and animated images go on the clipboard as the file itself
/// (pixels would keep only the first frame); returns "video", "file" or "image".
#[tauri::command]
fn copy_meme(id: String, state: State<'_, AppState>) -> Result<&'static str, String> {
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
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    if video_ext(&bytes).is_some() {
        clipboard
            .set()
            .file_list(&[PathBuf::from(&path)])
            .map_err(|e| e.to_string())?;
        return Ok("video");
    }
    if is_animated(&bytes) {
        clipboard
            .set()
            .file_list(&[PathBuf::from(&path)])
            .map_err(|e| e.to_string())?;
        return Ok("file");
    }

    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to decode image: {e}"))?
        .into_rgba8();
    let (w, h) = img.dimensions();
    clipboard
        .set_image(arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Owned(img.into_raw()),
        })
        .map_err(|e| e.to_string())?;
    Ok("image")
}

#[tauri::command]
fn meme_count(state: State<'_, AppState>) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT COUNT(*) FROM memes", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct KindStats {
    count: u32,
    bytes: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct LibraryStats {
    total: u32,
    images: KindStats,
    gifs: KindStats,
    videos: KindStats,
    /// Everything in the memes folder, including files the library doesn't index.
    folder_bytes: u64,
    folder: String,
}

fn dir_size(dir: &Path, depth: u8) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            Ok(t) if t.is_dir() && depth > 0 => dir_size(&e.path(), depth - 1),
            _ => 0, // symlinks are not followed
        })
        .sum()
}

/// Counts and sizes for the header: images, GIFs and videos, plus the folder's size.
#[tauri::command]
fn library_stats(state: State<'_, AppState>) -> Result<LibraryStats, String> {
    let memes_dir = state.memes_dir.lock().map_err(|e| e.to_string())?.clone();
    let paths: Vec<String> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT path FROM memes").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    let mut stats = LibraryStats {
        total: paths.len() as u32,
        folder_bytes: dir_size(&memes_dir, 4),
        folder: memes_dir.to_string_lossy().to_string(),
        ..Default::default()
    };
    for path in paths {
        let p = Path::new(&path);
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        let kind = match ext.as_str() {
            "gif" => &mut stats.gifs,
            "mp4" | "m4v" | "mov" | "webm" => &mut stats.videos,
            _ => &mut stats.images,
        };
        kind.count += 1;
        kind.bytes += fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    }
    Ok(stats)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            let version = app.package_info().version.to_string();
            app.manage(assets::LibraryState::new(&version)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_memes,
            search_memes,
            import_meme,
            import_meme_bytes,
            delete_meme,
            update_meme_ocr,
            update_meme_tags,
            list_tags,
            meme_count,
            library_stats,
            erase::erase_plan,
            erase::erase_everything,
            erase::quit_after_erase,
            copy_meme,
            drag_icon,
            existing_meme,
            get_settings,
            set_memes_folder,
            reset_memes_folder,
            sync_library,
            save_creation,
            list_projects,
            load_project,
            save_project,
            delete_project,
            assets::library_state,
            assets::fetch_image_url,
            assets::library_download,
            assets::library_cancel,
            assets::library_upload,
            assets::library_remove,
            assets::library_favourite,
            assets::library_clear_cache,
            assets::pack_inspect,
            assets::pack_install,
            assets::pack_install_remote,
            assets::pack_remove,
            assets::catalog_fetch,
            assets::catalog_sanitize,
            assets::online_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(conn: &Connection, q: &str) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM memes_fts WHERE memes_fts MATCH ?1", params![q], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn finds_byte_identical_memes_only() {
        let dir = std::env::temp_dir().join(format!("mf-dupe-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let path = dir.join("a.gif");
        fs::write(&path, b"GIF89a-one").unwrap();
        conn.execute(
            "INSERT INTO memes (id, filename, path, created_at) VALUES ('a', 'a.gif', ?1, 'now')",
            params![path.to_string_lossy()],
        )
        .unwrap();
        assert_eq!(find_existing(&conn, b"GIF89a-one").unwrap().as_deref(), Some("a"));
        assert_eq!(find_existing(&conn, b"GIF89a-two").unwrap(), None); // same size, other bytes
        assert_eq!(find_existing(&conn, b"GIF89a").unwrap(), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn detects_animated_gifs() {
        use image::codecs::gif::GifEncoder;
        use image::{Frame, RgbaImage};
        let gif = |frames: u32| {
            let mut out = Vec::new();
            {
                let mut enc = GifEncoder::new(&mut out);
                for i in 0..frames {
                    let img = RgbaImage::from_pixel(4, 4, image::Rgba([i as u8 * 80, 0, 0, 255]));
                    enc.encode_frame(Frame::new(img)).unwrap();
                }
            }
            out
        };
        assert!(is_animated(&gif(3)));
        assert!(!is_animated(&gif(1)));
        let mut png = Vec::new();
        image::DynamicImage::new_rgba8(2, 2)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        assert!(!is_animated(&png));
    }

    #[test]
    fn upgrades_old_libraries_and_indexes_tags() {
        let conn = Connection::open_in_memory().unwrap();
        // The schema before tags existed.
        conn.execute_batch(
            "CREATE TABLE memes (id TEXT PRIMARY KEY, filename TEXT NOT NULL, path TEXT NOT NULL,
                title TEXT, ocr_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
             CREATE VIRTUAL TABLE memes_fts USING fts5(id UNINDEXED, title, ocr_text, filename,
                content='memes', content_rowid='rowid');
             CREATE TRIGGER memes_ai AFTER INSERT ON memes BEGIN
                INSERT INTO memes_fts(rowid, id, title, ocr_text, filename)
                VALUES (new.rowid, new.id, new.title, new.ocr_text, new.filename);
             END;
             INSERT INTO memes (id, filename, path, title, ocr_text, created_at)
             VALUES ('a', 'a.png', '/a.png', 'Old one', 'when the code works', 'now');",
        )
        .unwrap();

        init_db(&conn).unwrap();
        init_db(&conn).unwrap(); // idempotent
        assert_eq!(matches(&conn, "\"code\"*"), 1, "old text is still searchable");

        let tags = normalize_tags(&["#Cats".into(), " Reaction  Face ".into(), "cats".into(), "".into()]);
        assert_eq!(tags, vec!["cats", "reaction face"]);
        conn.execute("UPDATE memes SET tags = ?1 WHERE id = 'a'", params![tags_to_text(&tags)]).unwrap();
        assert_eq!(matches(&conn, "tags : \"cat\"*"), 1);
        assert_eq!(matches(&conn, "tags : \"code\"*"), 0, "#tag only looks at tags");
        assert_eq!(matches(&conn, "\"reaction\"*"), 1);
        assert_eq!(tags_from_text(&tags_to_text(&tags)), tags);
    }
}
