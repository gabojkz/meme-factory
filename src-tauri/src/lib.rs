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

struct DbState(Mutex<Connection>);

fn app_dirs(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let memes = data.join("memes");
    fs::create_dir_all(&memes).map_err(|e| e.to_string())?;
    Ok((data, memes))
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
fn list_memes(db: State<'_, DbState>) -> Result<Vec<Meme>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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
fn search_memes(query: String, db: State<'_, DbState>) -> Result<Vec<Meme>, String> {
    let q = query.trim();
    if q.is_empty() {
        return list_memes(db);
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // Escape FTS5 special chars for simple substring-ish search
    let safe = q
        .replace('"', " ")
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('*', "")))
        .collect::<Vec<_>>()
        .join(" ");

    if safe.is_empty() {
        drop(conn);
        return list_memes(db);
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
    app: AppHandle,
    db: State<'_, DbState>,
) -> Result<Meme, String> {
    let (_, memes_dir) = app_dirs(&app)?;
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
        let conn = db.0.lock().map_err(|e| e.to_string())?;
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
fn delete_meme(id: String, db: State<'_, DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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
    db: State<'_, DbState>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE memes SET ocr_text = ?1 WHERE id = ?2",
        params![ocr_text.trim(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}


#[tauri::command]
fn copy_meme(id: String, db: State<'_, DbState>) -> Result<(), String> {
    let path: String = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
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
fn meme_count(db: State<'_, DbState>) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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
            let (data, _) = app_dirs(app.handle())?;
            let db_path = data.join("memes.db");
            let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
            init_db(&conn)?;
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_memes,
            search_memes,
            import_meme,
            delete_meme,
            update_meme_ocr,
            meme_count,
            copy_meme
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
