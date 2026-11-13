//! Asset library: downloaded assets, user uploads, favourites, ZIP asset packs,
//! the cached remote catalog and online image search.
//!
//! Everything lives under `<app data>/asset-library/`. Asset records are JSON
//! objects following the Studio metadata schema; they are always rebuilt by
//! `sanitize_record` so nothing from the network or a pack is trusted as-is.

use super::data_dir;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const MAX_ASSET_BYTES: usize = 30 * 1024 * 1024;
const MAX_PACK_BYTES: usize = 200 * 1024 * 1024;
const MAX_PACK_UNPACKED: u64 = 300 * 1024 * 1024;
const MAX_PACK_ENTRIES: usize = 2000;
const MAX_CATALOG_BYTES: usize = 10 * 1024 * 1024;
const PAGE_SIZE: usize = 24;

pub struct LibraryState {
    http: reqwest::Client,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    index_lock: Mutex<()>,
    imgflip: Mutex<Option<Vec<Value>>>,
    /// Set when Openverse rate-limits or blocks us; we back off until then.
    openverse_blocked_until: Mutex<Option<std::time::Instant>>,
}

impl LibraryState {
    pub fn new(version: &str) -> Result<Self, String> {
        // reqwest is built without a bundled crypto provider; use ring.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .user_agent(format!(
                "MemeFactory/{version} (+https://github.com/gabojkz/meme-factory)"
            ))
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            http,
            cancels: Mutex::new(HashMap::new()),
            index_lock: Mutex::new(()),
            imgflip: Mutex::new(None),
            openverse_blocked_until: Mutex::new(None),
        })
    }
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Index {
    #[serde(default)]
    assets: Vec<Value>,
    #[serde(default)]
    packs: Vec<Value>,
    #[serde(default)]
    favourites: Vec<Value>,
}

// ------------------------------------------------------------------- paths

fn lib_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("asset-library");
    fs::create_dir_all(dir.join("files")).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn load_index(app: &AppHandle) -> Result<Index, String> {
    let path = lib_dir(app)?.join("index.json");
    if !path.exists() {
        return Ok(Index::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("Asset library index is damaged: {e}"))
}

fn save_index(app: &AppHandle, index: &Index) -> Result<(), String> {
    let dir = lib_dir(app)?;
    let tmp = dir.join("index.json.tmp");
    let raw = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    fs::rename(tmp, dir.join("index.json")).map_err(|e| e.to_string())
}

/// Runs a read-modify-write on the index while holding the lock.
fn with_index<T>(
    app: &AppHandle,
    state: &LibraryState,
    f: impl FnOnce(&mut Index) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = state.index_lock.lock().map_err(|e| e.to_string())?;
    let mut index = load_index(app)?;
    let out = f(&mut index)?;
    save_index(app, &index)?;
    Ok(out)
}

// ------------------------------------------------------------- validation

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn check_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| format!("Invalid URL: {raw}"))?;
    match url.scheme() {
        "https" => Ok(url),
        // Lets `npm run tauri dev` serve the catalog from the Vite dev server.
        "http"
            if cfg!(debug_assertions)
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1")) =>
        {
            Ok(url)
        }
        _ => Err("Only HTTPS downloads are allowed".into()),
    }
}

fn text(v: Option<&Value>, max: usize) -> Option<String> {
    let s: String = v?
        .as_str()?
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max)
        .collect();
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn url_field(v: Option<&Value>) -> Value {
    text(v, 2048)
        .filter(|u| check_url(u).is_ok())
        .map(Value::String)
        .unwrap_or(Value::Null)
}

fn text_list(v: Option<&Value>, max_items: usize) -> Value {
    let items = v
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| text(Some(x), 40))
                .map(|s| s.to_lowercase())
                .take(max_items)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!(items)
}

fn opt_bool(v: Option<&Value>) -> Value {
    v.and_then(|b| b.as_bool()).map(Value::Bool).unwrap_or(Value::Null)
}

/// Rebuilds an asset record from untrusted input, keeping only known fields.
fn sanitize_record(input: &Value) -> Result<Value, String> {
    let id = text(input.get("id"), 96).ok_or("Asset is missing an id")?;
    if !valid_id(&id) {
        return Err(format!("Invalid asset id: {id}"));
    }
    let file = input.get("file").cloned().unwrap_or(Value::Null);
    let dims = input.get("dimensions").cloned().unwrap_or(Value::Null);
    let source = input.get("source").cloned().unwrap_or(Value::Null);
    let creator = input.get("creator").cloned().unwrap_or(Value::Null);
    let lic = input.get("licensing").cloned().unwrap_or(Value::Null);
    let mut out = json!({
        "id": id,
        "name": text(input.get("name"), 120).unwrap_or_else(|| "Untitled asset".into()),
        "description": text(input.get("description"), 600),
        "category": text(input.get("category"), 40).map(|s| s.to_lowercase()).unwrap_or_else(|| "objects".into()),
        "subcategory": text(input.get("subcategory"), 40).map(|s| s.to_lowercase()),
        "tags": text_list(input.get("tags"), 30),
        "emotions": text_list(input.get("emotions"), 12),
        "style": text(input.get("style"), 40).map(|s| s.to_lowercase()),
        "format": text(input.get("format"), 10).map(|s| s.to_lowercase()),
        "dimensions": {
            "width": dims.get("width").and_then(|v| v.as_u64()).unwrap_or(0),
            "height": dims.get("height").and_then(|v| v.as_u64()).unwrap_or(0),
        },
        "transparent": opt_bool(input.get("transparent")),
        "file": {
            "url": url_field(file.get("url")),
            "thumbnail": url_field(file.get("thumbnail")),
            "sizeBytes": file.get("sizeBytes").and_then(|v| v.as_u64()),
            "checksum": text(file.get("checksum"), 120),
        },
        "packId": text(input.get("packId"), 96).filter(|p| valid_id(p)),
        "packName": text(input.get("packName"), 120),
        "version": input.get("version").and_then(|v| v.as_u64()).unwrap_or(1),
        "source": {
            "name": text(source.get("name"), 120),
            "url": url_field(source.get("url")),
        },
        "creator": {
            "name": text(creator.get("name"), 120),
            "url": url_field(creator.get("url")),
        },
        "licensing": {
            "license": text(lic.get("license"), 80).unwrap_or_else(|| "Unknown".into()),
            "licenseUrl": url_field(lic.get("licenseUrl")),
            "commercialUse": opt_bool(lic.get("commercialUse")),
            "modification": opt_bool(lic.get("modification")),
            "redistribution": opt_bool(lic.get("redistribution")),
            "attributionRequired": opt_bool(lic.get("attributionRequired")),
            // Only the official catalog can claim verification; packs and
            // search results never can (see sanitize_untrusted).
            "verified": lic.get("verified").and_then(|v| v.as_bool()).unwrap_or(false),
            "verifiedAt": text(lic.get("verifiedAt"), 40),
            "declaredBy": text(lic.get("declaredBy"), 80),
            "attributionText": text(lic.get("attributionText"), 600),
        },
    });
    if let Some(o) = input.get("origin").and_then(|v| v.as_str()) {
        if matches!(o, "catalog" | "online") {
            out["origin"] = json!(o);
        }
    }
    Ok(out)
}

/// Same as `sanitize_record`, but licence verification claims are dropped.
fn sanitize_untrusted(input: &Value) -> Result<Value, String> {
    let mut rec = sanitize_record(input)?;
    rec["licensing"]["verified"] = json!(false);
    rec["licensing"]["verifiedAt"] = Value::Null;
    Ok(rec)
}

#[derive(Debug)]
struct ImageInfo {
    ext: &'static str,
    width: u32,
    height: u32,
    transparent: bool,
}

/// Checks the bytes really are a supported raster image and decodes it.
fn validate_image(bytes: &[u8], claimed_ext: Option<&str>) -> Result<ImageInfo, String> {
    let format = image::guess_format(bytes).map_err(|_| "Not a supported image file".to_string())?;
    let ext = match format {
        image::ImageFormat::Png => "png",
        image::ImageFormat::Jpeg => "jpg",
        image::ImageFormat::WebP => "webp",
        image::ImageFormat::Gif => "gif",
        _ => return Err("Only PNG, JPEG, WebP and GIF images are supported".into()),
    };
    if let Some(claimed) = claimed_ext {
        let claimed = claimed.to_lowercase();
        let same = claimed == ext || (ext == "jpg" && claimed == "jpeg");
        if !same {
            return Err(format!("File says .{claimed} but contains {ext}"));
        }
    }
    let img = image::load_from_memory_with_format(bytes, format)
        .map_err(|e| format!("Image can’t be decoded: {e}"))?;
    let transparent = img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p.0[3] < 255);
    Ok(ImageInfo {
        ext,
        width: img.width(),
        height: img.height(),
        transparent,
    })
}

fn verify_checksum(bytes: &[u8], checksum: Option<&str>) -> Result<(), String> {
    let Some(expected) = checksum.and_then(|c| c.strip_prefix("sha256-")) else {
        return Ok(());
    };
    if expected.len() != 64 {
        return Ok(()); // placeholder / unsupported encoding
    }
    let actual: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err("Checksum mismatch — the download is corrupted or was changed".into())
    }
}

fn apply_image_info(rec: &mut Value, info: &ImageInfo, size: usize, path: &Path) {
    rec["format"] = json!(info.ext);
    rec["dimensions"] = json!({ "width": info.width, "height": info.height });
    rec["transparent"] = json!(info.transparent);
    rec["file"]["sizeBytes"] = json!(size);
    rec["localPath"] = json!(path.to_string_lossy());
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("part");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// --------------------------------------------------------------- downloads

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    received: u64,
    total: Option<u64>,
}

struct CancelGuard<'a> {
    state: &'a LibraryState,
    id: String,
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.state.cancels.lock() {
            map.remove(&self.id);
        }
    }
}

async fn fetch_bytes(
    app: &AppHandle,
    state: &LibraryState,
    job_id: &str,
    url: &str,
    max: usize,
) -> Result<Vec<u8>, String> {
    let url = check_url(url)?;
    let flag = Arc::new(AtomicBool::new(false));
    state
        .cancels
        .lock()
        .map_err(|e| e.to_string())?
        .insert(job_id.to_string(), flag.clone());
    let _guard = CancelGuard {
        state,
        id: job_id.to_string(),
    };

    let mut resp = state
        .http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Server answered {}", resp.status()));
    }
    let total = resp.content_length();
    if total.is_some_and(|t| t as usize > max) {
        return Err(format!("File is larger than {} MB", max / 1024 / 1024));
    }
    let mut buf = Vec::with_capacity(total.unwrap_or(0).min(max as u64) as usize);
    let mut last_emit = 0usize;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download interrupted: {e}"))? {
        if flag.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        buf.extend_from_slice(&chunk);
        if buf.len() > max {
            return Err(format!("File is larger than {} MB", max / 1024 / 1024));
        }
        if buf.len() - last_emit >= 64 * 1024 {
            last_emit = buf.len();
            let _ = app.emit(
                "library-progress",
                Progress { id: job_id.into(), received: buf.len() as u64, total },
            );
        }
    }
    if total.is_some_and(|t| t != buf.len() as u64) {
        return Err("Download incomplete".into());
    }
    let _ = app.emit(
        "library-progress",
        Progress { id: job_id.into(), received: buf.len() as u64, total: Some(buf.len() as u64) },
    );
    Ok(buf)
}

#[tauri::command]
pub fn library_cancel(id: String, state: State<'_, LibraryState>) -> Result<(), String> {
    if let Some(flag) = state.cancels.lock().map_err(|e| e.to_string())?.get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Downloads a catalog asset or online image, validates it and keeps it locally.
#[tauri::command]
pub async fn library_download(
    record: Value,
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<Value, String> {
    let from_catalog = record.get("origin").and_then(|v| v.as_str()) == Some("catalog");
    let mut rec = if from_catalog {
        sanitize_record(&record)?
    } else {
        sanitize_untrusted(&record)?
    };
    let id = rec["id"].as_str().unwrap_or_default().to_string();
    let version = rec["version"].as_u64().unwrap_or(1);

    // Already downloaded and current? Reuse the local copy.
    if let Some(existing) = load_index(&app)?.assets.into_iter().find(|a| a["id"] == json!(id)) {
        let path = existing["localPath"].as_str().map(PathBuf::from);
        if existing["version"].as_u64().unwrap_or(1) >= version && path.is_some_and(|p| p.exists()) {
            return Ok(existing);
        }
    }

    let url = rec["file"]["url"]
        .as_str()
        .ok_or("This asset has no downloadable file")?
        .to_string();
    let bytes = fetch_bytes(&app, &state, &id, &url, MAX_ASSET_BYTES).await?;
    if let Some(expected) = rec["file"]["sizeBytes"].as_u64() {
        if from_catalog && expected != bytes.len() as u64 {
            return Err("Downloaded file size doesn’t match the catalog".into());
        }
    }
    verify_checksum(&bytes, rec["file"]["checksum"].as_str())?;
    let info = validate_image(&bytes, None)?;

    let path = lib_dir(&app)?.join("files").join(format!("{id}.{}", info.ext));
    write_atomic(&path, &bytes)?;
    apply_image_info(&mut rec, &info, bytes.len(), &path);
    if rec.get("origin").is_none() {
        rec["origin"] = json!("online");
    }
    rec["storage"] = json!("download");
    rec["downloadedAt"] = json!(Utc::now().to_rfc3339());

    let saved = rec.clone();
    with_index(&app, &state, move |index| {
        index.assets.retain(|a| a["id"] != saved["id"]);
        index.assets.push(saved);
        Ok(())
    })?;
    Ok(rec)
}

/// Adds one of the user's own images to "My uploads".
#[tauri::command]
pub fn library_upload(
    path: String,
    category: Option<String>,
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<Value, String> {
    let src = PathBuf::from(&path);
    let meta = fs::metadata(&src).map_err(|e| e.to_string())?;
    if meta.len() as usize > MAX_ASSET_BYTES {
        return Err("Image is larger than 30 MB".into());
    }
    let bytes = fs::read(&src).map_err(|e| e.to_string())?;
    let claimed = src.extension().and_then(|e| e.to_str());
    let info = validate_image(&bytes, claimed)?;
    let id = format!("upload-{}", Uuid::new_v4());
    let name = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("My image")
        .to_string();
    let mut rec = sanitize_untrusted(&json!({
        "id": id,
        "name": name,
        "category": category.unwrap_or_else(|| "uploads".into()),
        "tags": ["upload"],
        "source": { "name": "My uploads" },
        "licensing": { "license": "Your own image", "declaredBy": "You" },
    }))?;
    let dest = lib_dir(&app)?.join("files").join(format!("{id}.{}", info.ext));
    write_atomic(&dest, &bytes)?;
    apply_image_info(&mut rec, &info, bytes.len(), &dest);
    rec["origin"] = json!("upload");
    rec["storage"] = json!("upload");
    rec["downloadedAt"] = json!(Utc::now().to_rfc3339());
    let saved = rec.clone();
    with_index(&app, &state, move |index| {
        index.assets.push(saved);
        Ok(())
    })?;
    Ok(rec)
}

#[tauri::command]
pub fn library_remove(id: String, app: AppHandle, state: State<'_, LibraryState>) -> Result<(), String> {
    with_index(&app, &state, |index| {
        let Some(pos) = index.assets.iter().position(|a| a["id"] == json!(id)) else {
            return Ok(());
        };
        if index.assets[pos]["storage"] == json!("pack") {
            return Err("This asset belongs to a pack — remove the pack instead".into());
        }
        let removed = index.assets.remove(pos);
        if let Some(p) = removed["localPath"].as_str() {
            let _ = fs::remove_file(p);
        }
        Ok(())
    })
}

#[tauri::command]
pub fn library_favourite(
    record: Value,
    on: bool,
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<(), String> {
    let id = text(record.get("id"), 96).ok_or("Asset is missing an id")?;
    // Bundled starter assets have no remote URL; keep at least the id + name.
    let rec = sanitize_record(&record).unwrap_or_else(|_| json!({ "id": id }));
    with_index(&app, &state, move |index| {
        index.favourites.retain(|f| f["id"] != json!(id));
        if on {
            index.favourites.push(rec);
        }
        Ok(())
    })
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    };
    entries
        .flatten()
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                dir_size(&p)
            } else {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

/// Everything the library UI needs: local assets, packs, favourites, storage.
#[tauri::command]
pub fn library_state(app: AppHandle) -> Result<Value, String> {
    let dir = lib_dir(&app)?;
    let mut index = load_index(&app)?;
    // Drop records whose file vanished (e.g. deleted by hand).
    index.assets.retain(|a| a["localPath"].as_str().is_some_and(|p| Path::new(p).exists()));

    let mut by_pack: HashMap<String, u64> = HashMap::new();
    let (mut uploads, mut downloads) = (0u64, 0u64);
    for a in &index.assets {
        let size = a["localPath"]
            .as_str()
            .and_then(|p| fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0);
        match a["storage"].as_str() {
            Some("pack") => {
                *by_pack
                    .entry(a["packId"].as_str().unwrap_or_default().to_string())
                    .or_default() += size
            }
            Some("upload") => uploads += size,
            _ => downloads += size,
        }
    }
    let catalog = fs::metadata(dir.join("catalog-cache.json")).map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "assets": index.assets,
        "packs": index.packs,
        "favourites": index.favourites,
        "storage": {
            "total": dir_size(&dir),
            "packs": by_pack,
            "uploads": uploads,
            "downloads": downloads,
            "catalog": catalog,
        },
    }))
}

/// Deletes downloaded (non-favourite, non-pack) files. Projects keep their
/// own embedded copies, so nothing that is already on a canvas breaks.
#[tauri::command]
pub fn library_clear_cache(app: AppHandle, state: State<'_, LibraryState>) -> Result<u32, String> {
    with_index(&app, &state, |index| {
        let favs: HashSet<String> = index
            .favourites
            .iter()
            .filter_map(|f| f["id"].as_str().map(String::from))
            .collect();
        let mut removed = 0;
        index.assets.retain(|a| {
            let keep = a["storage"] != json!("download")
                || a["id"].as_str().is_some_and(|id| favs.contains(id));
            if !keep {
                if let Some(p) = a["localPath"].as_str() {
                    let _ = fs::remove_file(p);
                }
                removed += 1;
            }
            keep
        });
        Ok(removed)
    })
}

// ------------------------------------------------------------------- packs

#[derive(Debug)]
struct PackFile {
    record: Value,
    bytes: Vec<u8>,
    info: ImageInfo,
}

#[derive(Debug)]
struct PackContents {
    manifest: Value,
    files: Vec<PackFile>,
    preview: Option<(Vec<u8>, &'static str)>,
}

fn file_ext(name: &str) -> Option<String> {
    Path::new(name).extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase())
}

fn read_pack(path: &Path) -> Result<PackContents, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() as usize > MAX_PACK_BYTES {
        return Err("Pack is larger than 200 MB".into());
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "Not a valid ZIP file".to_string())?;
    if zip.len() > MAX_PACK_ENTRIES {
        return Err("Pack contains too many files".into());
    }

    // Read every entry with hard limits; paths must stay inside the archive.
    let mut entries: HashMap<String, Vec<u8>> = HashMap::new();
    let mut unpacked = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry
            .enclosed_name()
            .ok_or("Pack contains an unsafe file path")?
            .to_string_lossy()
            .replace('\\', "/");
        if name.starts_with("__MACOSX/") || name.ends_with(".DS_Store") {
            continue;
        }
        let mut buf = Vec::new();
        let limit = (MAX_ASSET_BYTES as u64).min(MAX_PACK_UNPACKED - unpacked) + 1;
        entry.by_ref().take(limit).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        if buf.len() as u64 >= limit {
            return Err(format!("{name} is too large"));
        }
        unpacked += buf.len() as u64;
        entries.insert(name, buf);
    }

    // Allow packs zipped as a folder: strip a single shared top-level dir.
    let prefix = entries
        .keys()
        .find(|k| k.ends_with("manifest.json") && k.matches('/').count() <= 1)
        .map(|k| k.trim_end_matches("manifest.json").to_string())
        .ok_or("Pack has no manifest.json")?;
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    for (name, bytes) in entries {
        let Some(rel) = name.strip_prefix(&prefix) else {
            return Err(format!("Unexpected file outside the pack folder: {name}"));
        };
        let ext = file_ext(rel).unwrap_or_default();
        let allowed = rel == "manifest.json"
            || (rel.starts_with("preview.") && matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp"))
            || (rel.starts_with("assets/")
                && rel.matches('/').count() == 1
                && matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif"))
            || (rel.starts_with("metadata/") && rel.matches('/').count() == 1 && ext == "json");
        if !allowed {
            return Err(if ext == "svg" {
                format!("SVG files aren’t allowed in packs ({rel})")
            } else {
                format!("Unsupported file in pack: {rel}")
            });
        }
        files.insert(rel.to_string(), bytes);
    }

    let manifest: Value = serde_json::from_slice(&files["manifest.json"])
        .map_err(|e| format!("manifest.json is malformed: {e}"))?;
    let pack_id = text(manifest.get("id"), 96)
        .filter(|id| valid_id(id))
        .ok_or("manifest.json needs a valid id")?;
    let pack_name = text(manifest.get("name"), 120).ok_or("manifest.json needs a name")?;
    let wanted: Vec<String> = manifest
        .get("assets")
        .and_then(|a| a.as_array())
        .ok_or("manifest.json needs an assets list")?
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    if wanted.is_empty() {
        return Err("The pack lists no assets".into());
    }

    let mut by_id: HashMap<String, (Value, String)> = HashMap::new();
    for (name, bytes) in files.iter().filter(|(n, _)| n.starts_with("metadata/")) {
        let raw: Value =
            serde_json::from_slice(bytes).map_err(|e| format!("{name} is malformed: {e}"))?;
        let rec = sanitize_untrusted(&raw).map_err(|e| format!("{name}: {e}"))?;
        let id = rec["id"].as_str().unwrap_or_default().to_string();
        // The image is referenced by a relative path, or shares the json's name.
        let declared = raw["file"]["path"]
            .as_str()
            .or_else(|| raw["file"]["url"].as_str().filter(|u| !u.contains("://")))
            .map(|p| p.trim_start_matches("./").to_string());
        let stem = Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or_default();
        let image = declared
            .filter(|p| files.contains_key(p))
            .or_else(|| {
                ["png", "webp", "jpg", "jpeg", "gif"]
                    .iter()
                    .map(|e| format!("assets/{stem}.{e}"))
                    .find(|p| files.contains_key(p))
            })
            .ok_or(format!("{name}: image file not found in assets/"))?;
        if by_id.insert(id.clone(), (rec, image)).is_some() {
            return Err(format!("Duplicate asset id in pack: {id}"));
        }
    }

    let mut out = Vec::new();
    for id in &wanted {
        let (mut rec, image) = by_id
            .remove(id)
            .ok_or(format!("manifest lists {id} but metadata/ has no record for it"))?;
        let bytes = files[&image].clone();
        let info = validate_image(&bytes, file_ext(&image).as_deref())
            .map_err(|e| format!("{image}: {e}"))?;
        rec["packId"] = json!(pack_id);
        rec["packName"] = json!(pack_name);
        out.push(PackFile { record: rec, bytes, info });
    }

    let preview = files
        .iter()
        .find(|(n, _)| n.starts_with("preview."))
        .and_then(|(_, b)| validate_image(b, None).ok().map(|i| (b.clone(), i.ext)));

    let manifest = json!({
        "id": pack_id,
        "name": pack_name,
        "description": text(manifest.get("description"), 600),
        "author": text(manifest.get("author"), 120),
        "version": text(manifest.get("version"), 20).unwrap_or_else(|| "1.0.0".into()),
        "license": text(manifest.get("license"), 200),
    });
    Ok(PackContents { manifest, files: out, preview })
}

fn data_url(bytes: &[u8], ext: &str) -> String {
    use base64::Engine;
    let mime = if ext == "jpg" { "jpeg" } else { ext };
    format!(
        "data:image/{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Validates a pack ZIP and describes it without installing anything.
#[tauri::command]
pub fn pack_inspect(path: String, app: AppHandle) -> Result<Value, String> {
    let pack = read_pack(Path::new(&path))?;
    let index = load_index(&app)?;
    let pack_id = pack.manifest["id"].clone();
    let installed = index.packs.iter().find(|p| p["id"] == pack_id).map(|p| p["version"].clone());
    let duplicates: Vec<Value> = pack
        .files
        .iter()
        .filter(|f| {
            let pack_id = pack_id.as_str().unwrap_or_default();
            index.assets.iter().any(|a| a["id"] == f.record["id"] && owned_elsewhere(a, pack_id))
        })
        .map(|f| f.record["id"].clone())
        .collect();
    let preview = pack
        .preview
        .as_ref()
        .map(|(b, e)| data_url(b, e))
        .or_else(|| pack.files.first().map(|f| data_url(&f.bytes, f.info.ext)));
    Ok(json!({
        "manifest": pack.manifest,
        "assets": pack.files.iter().map(|f| json!({
            "id": f.record["id"],
            "name": f.record["name"],
            "category": f.record["category"],
            "license": f.record["licensing"]["license"],
        })).collect::<Vec<_>>(),
        "sizeBytes": pack.files.iter().map(|f| f.bytes.len() as u64).sum::<u64>(),
        "installedVersion": installed,
        "duplicates": duplicates,
        "preview": preview,
    }))
}

/// True when an existing record belongs to an upload or a different pack
/// (loose downloads don't count — a pack install replaces them).
fn owned_elsewhere(existing: &Value, pack_id: &str) -> bool {
    match existing["storage"].as_str() {
        Some("upload") => true,
        Some("pack") => existing["packId"] != json!(pack_id),
        _ => false,
    }
}

fn install_pack(
    app: &AppHandle,
    state: &LibraryState,
    path: &Path,
    origin: &str,
) -> Result<Value, String> {
    let pack = read_pack(path)?;
    let pack_id = pack.manifest["id"].as_str().unwrap_or_default().to_string();
    let dir = lib_dir(app)?.join("files").join(format!("pack-{pack_id}"));

    with_index(app, state, |index| {
        let clash: Vec<String> = pack
            .files
            .iter()
            .filter_map(|f| f.record["id"].as_str())
            .filter(|id| index.assets.iter().any(|a| a["id"] == json!(id) && owned_elsewhere(a, &pack_id)))
            .map(String::from)
            .collect();
        if !clash.is_empty() {
            return Err(format!("Asset ids already in your library: {}", clash.join(", ")));
        }

        // Updating replaces the previous version of this pack.
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Loose downloads of these assets are superseded by the pack copy.
        let ids: HashSet<&str> = pack.files.iter().filter_map(|f| f.record["id"].as_str()).collect();
        index.assets.retain(|a| {
            let replaced = (a["packId"] == json!(pack_id) && a["storage"] == json!("pack"))
                || (a["storage"] == json!("download") && a["id"].as_str().is_some_and(|id| ids.contains(id)));
            if replaced && a["storage"] == json!("download") {
                if let Some(p) = a["localPath"].as_str() {
                    let _ = fs::remove_file(p);
                }
            }
            !replaced
        });
        index.packs.retain(|p| p["id"] != json!(pack_id));

        let mut size = 0u64;
        for f in &pack.files {
            let id = f.record["id"].as_str().unwrap_or_default();
            let dest = dir.join(format!("{id}.{}", f.info.ext));
            fs::write(&dest, &f.bytes).map_err(|e| e.to_string())?;
            let mut rec = f.record.clone();
            apply_image_info(&mut rec, &f.info, f.bytes.len(), &dest);
            rec["origin"] = json!("pack");
            rec["storage"] = json!("pack");
            rec["downloadedAt"] = json!(Utc::now().to_rfc3339());
            index.assets.push(rec);
            size += f.bytes.len() as u64;
        }
        let preview_path = match &pack.preview {
            Some((bytes, ext)) => {
                let p = dir.join(format!("_preview.{ext}"));
                fs::write(&p, bytes).map_err(|e| e.to_string())?;
                Some(p.to_string_lossy().to_string())
            }
            None => None,
        };
        let mut info = pack.manifest.clone();
        info["assetCount"] = json!(pack.files.len());
        info["sizeBytes"] = json!(size);
        info["installedAt"] = json!(Utc::now().to_rfc3339());
        info["origin"] = json!(origin);
        info["previewPath"] = json!(preview_path);
        index.packs.push(info.clone());
        Ok(info)
    })
}

#[tauri::command]
pub fn pack_install(path: String, app: AppHandle, state: State<'_, LibraryState>) -> Result<Value, String> {
    install_pack(&app, &state, Path::new(&path), "zip")
}

/// Downloads a pack ZIP listed in the remote catalog and installs it.
#[tauri::command]
pub async fn pack_install_remote(
    pack: Value,
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<Value, String> {
    let id = text(pack.get("id"), 96).filter(|i| valid_id(i)).ok_or("Invalid pack id")?;
    let url = text(pack.get("downloadUrl"), 2048).ok_or("Pack has no download URL")?;
    let job = format!("pack:{id}");
    let bytes = fetch_bytes(&app, &state, &job, &url, MAX_PACK_BYTES).await?;
    if let Some(expected) = pack.get("sizeBytes").and_then(|v| v.as_u64()) {
        if expected != bytes.len() as u64 {
            return Err("Downloaded pack size doesn’t match the catalog".into());
        }
    }
    verify_checksum(&bytes, pack.get("checksum").and_then(|v| v.as_str()))?;
    let tmp = lib_dir(&app)?.join(format!("download-{}.zip", Uuid::new_v4()));
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    let result = install_pack(&app, &state, &tmp, "catalog");
    let _ = fs::remove_file(&tmp);
    let info = result?;
    if info["id"] != json!(id) {
        return Err("Downloaded pack id doesn’t match the catalog".into());
    }
    Ok(info)
}

#[tauri::command]
pub fn pack_remove(id: String, app: AppHandle, state: State<'_, LibraryState>) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Invalid pack id".into());
    }
    let dir = lib_dir(&app)?.join("files").join(format!("pack-{id}"));
    with_index(&app, &state, |index| {
        index.packs.retain(|p| p["id"] != json!(id));
        index.assets.retain(|a| a["packId"] != json!(id) || a["storage"] != json!("pack"));
        Ok(())
    })?;
    let _ = fs::remove_dir_all(dir);
    Ok(())
}

// ----------------------------------------------------------------- catalog

/// Fetches the remote catalog; falls back to the last cached copy offline.
#[tauri::command]
pub async fn catalog_fetch(
    url: String,
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<Value, String> {
    let cache_path = lib_dir(&app)?.join("catalog-cache.json");
    let fresh = async {
        let resp = state
            .http
            .get(check_url(&url)?)
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Catalog server answered {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        if bytes.len() > MAX_CATALOG_BYTES {
            return Err("Catalog is too large".to_string());
        }
        serde_json::from_slice::<Value>(&bytes).map_err(|e| format!("Catalog is malformed: {e}"))
    }
    .await;

    match fresh {
        Ok(data) => {
            let now = Utc::now().to_rfc3339();
            let cached = json!({ "url": url, "fetchedAt": now, "data": data });
            let _ = fs::write(&cache_path, cached.to_string());
            Ok(json!({ "data": cached["data"], "fetchedAt": now, "offline": false }))
        }
        Err(err) => {
            let cached: Option<Value> = fs::read_to_string(&cache_path)
                .ok()
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .filter(|c: &Value| c["url"] == json!(url));
            match cached {
                Some(c) => Ok(json!({ "data": c["data"], "fetchedAt": c["fetchedAt"], "offline": true, "error": err })),
                None => Err(err),
            }
        }
    }
}

/// Normalises and sanitises the records of a catalog (done in Rust so the
/// frontend only ever sees clean data).
#[tauri::command]
pub fn catalog_sanitize(assets: Vec<Value>) -> Vec<Value> {
    assets
        .iter()
        .filter_map(|a| sanitize_record(a).ok())
        .map(|mut a| {
            a["origin"] = json!("catalog");
            a
        })
        .collect()
}

// ------------------------------------------------------------ online search

fn cc_label(license: &str, version: &str) -> String {
    match license {
        "cc0" => "CC0 1.0 (public domain)".into(),
        "pdm" => "Public Domain Mark".into(),
        other => format!("CC {} {}", other.to_uppercase(), version).trim().to_string(),
    }
}

fn openverse_record(r: &Value) -> Option<Value> {
    let id = r["id"].as_str()?;
    let license = r["license"].as_str().unwrap_or_default();
    let public = matches!(license, "cc0" | "pdm");
    let url = r["url"].as_str()?;
    let format = r["filetype"]
        .as_str()
        .map(String::from)
        .or_else(|| file_ext(url.split('?').next().unwrap_or(url)));
    let raw = json!({
        "id": format!("openverse-{id}"),
        "name": r["title"].as_str().filter(|t| !t.trim().is_empty()).unwrap_or("Untitled image"),
        "description": r["attribution"],
        "category": "online",
        "tags": r["tags"].as_array().map(|t| t.iter().filter_map(|x| x["name"].as_str()).take(12).collect::<Vec<_>>()).unwrap_or_default(),
        "format": format,
        "dimensions": { "width": r["width"], "height": r["height"] },
        "file": { "url": url, "thumbnail": r["thumbnail"], "sizeBytes": r["filesize"] },
        "source": { "name": r["source"].as_str().or(r["provider"].as_str()), "url": r["foreign_landing_url"] },
        "creator": { "name": r["creator"], "url": r["creator_url"] },
        "licensing": {
            "license": cc_label(license, r["license_version"].as_str().unwrap_or_default()),
            "licenseUrl": r["license_url"],
            "commercialUse": !license.contains("nc"),
            "modification": !license.contains("nd"),
            "redistribution": true,
            "attributionRequired": !public,
            "declaredBy": "Openverse / original source",
            "attributionText": r["attribution"],
        },
    });
    let mut rec = sanitize_untrusted(&raw).ok()?;
    rec["origin"] = json!("online");
    Some(rec)
}

/// Removes HTML tags/entities from Commons metadata (artist names are HTML).
fn strip_html(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    for c in raw.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn wikimedia_record(page: &Value) -> Option<Value> {
    let info = page["imageinfo"].get(0)?;
    let meta = &info["extmetadata"];
    let field = |k: &str| meta[k]["value"].as_str().map(strip_html).filter(|s| !s.is_empty());
    let mime = info["mime"].as_str().unwrap_or_default();
    let format = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => return None, // SVG, TIFF, PDF… can't be used safely as layers
    };
    let title = page["title"].as_str()?.trim_start_matches("File:");
    let name = field("ObjectName").unwrap_or_else(|| {
        title.rsplit_once('.').map(|(n, _)| n).unwrap_or(title).replace('_', " ")
    });
    let license = field("LicenseShortName").unwrap_or_else(|| "See source page".into());
    let lower = license.to_lowercase();
    let public = lower.contains("public domain") || lower.contains("cc0") || lower.contains("pd");
    let nc = lower.contains("nc");
    let attribution = meta["AttributionRequired"]["value"].as_str().map(|v| v == "true");
    let artist = field("Artist");
    let attribution_text = artist.as_ref().map(|a| format!("“{name}” by {a}, {license}, via Wikimedia Commons"));
    let raw = json!({
        "id": format!("wikimedia-{}", page["pageid"].as_u64()?),
        "name": name,
        "description": field("ImageDescription"),
        "category": "online",
        "format": format,
        "dimensions": { "width": info["width"], "height": info["height"] },
        "transparent": if format == "jpg" { Value::Bool(false) } else { Value::Null },
        "file": {
            "url": info["url"],
            "thumbnail": info["thumburl"],
            "sizeBytes": info["size"],
        },
        "source": { "name": "Wikimedia Commons", "url": info["descriptionurl"] },
        "creator": { "name": artist },
        "licensing": {
            "license": license,
            "licenseUrl": meta["LicenseUrl"]["value"],
            "commercialUse": !nc,
            "modification": !lower.contains("nd"),
            "redistribution": true,
            "attributionRequired": attribution.unwrap_or(!public),
            "declaredBy": "Wikimedia Commons file page",
            "attributionText": attribution_text,
        },
    });
    let mut rec = sanitize_untrusted(&raw).ok()?;
    rec["origin"] = json!("online");
    Some(rec)
}

/// Keyless search of Wikimedia Commons (freely licensed media only).
async fn search_wikimedia(state: &LibraryState, query: &str, page: u32, transparent: bool) -> Result<Value, String> {
    const PER_PAGE: u32 = 20;
    // `filetype:bitmap` excludes SVG/PDF/video; `filemime` narrows to PNG.
    let mut search = format!("filetype:bitmap {query}");
    if transparent {
        search.push_str(" filemime:image/png");
    }
    let offset = (page - 1) * PER_PAGE;
    let params = [
        ("action", "query".to_string()),
        ("format", "json".into()),
        ("generator", "search".into()),
        ("gsrsearch", search),
        ("gsrnamespace", "6".into()),
        ("gsrlimit", PER_PAGE.to_string()),
        ("gsroffset", offset.to_string()),
        ("prop", "imageinfo".into()),
        ("iiprop", "url|size|mime|extmetadata".into()),
        ("iiurlwidth", "320".into()),
        (
            "iiextmetadatafilter",
            "ObjectName|ImageDescription|Artist|LicenseShortName|LicenseUrl|AttributionRequired".into(),
        ),
    ];
    let resp = state
        .http
        .get("https://commons.wikimedia.org/w/api.php")
        .query(&params)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    if matches!(resp.status().as_u16(), 403 | 429) {
        return Err("Wikimedia Commons is limiting searches right now — try again in a minute".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Wikimedia Commons answered {}", resp.status()));
    }
    let data: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut pages: Vec<&Value> = data["query"]["pages"]
        .as_object()
        .map(|m| m.values().collect())
        .unwrap_or_default();
    pages.sort_by_key(|p| p["index"].as_u64().unwrap_or(u64::MAX));
    let results: Vec<Value> = pages.into_iter().filter_map(wikimedia_record).collect();
    Ok(json!({ "results": results, "hasMore": data.get("continue").is_some() }))
}

async fn imgflip_templates(state: &LibraryState) -> Result<Vec<Value>, String> {
    if let Some(list) = state.imgflip.lock().map_err(|e| e.to_string())?.clone() {
        return Ok(list);
    }
    let data: Value = state
        .http
        .get("https://api.imgflip.com/get_memes")
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let list: Vec<Value> = data["data"]["memes"]
        .as_array()
        .ok_or("Imgflip returned no templates")?
        .iter()
        .filter_map(|m| {
            let id = m["id"].as_str()?;
            let url = m["url"].as_str()?;
            let raw = json!({
                "id": format!("imgflip-{id}"),
                "name": m["name"],
                "description": "Popular meme template from Imgflip.",
                "category": "templates",
                "tags": ["template", "meme"],
                "format": file_ext(url),
                "dimensions": { "width": m["width"], "height": m["height"] },
                "transparent": false,
                "file": { "url": url, "thumbnail": url },
                "source": { "name": "Imgflip", "url": format!("https://imgflip.com/memegenerator/{id}") },
                "licensing": {
                    "license": "Unknown — meme template",
                    "commercialUse": null,
                    "declaredBy": "Not declared; rights belong to the original owners",
                },
            });
            let mut rec = sanitize_untrusted(&raw).ok()?;
            rec["origin"] = json!("online");
            Some(rec)
        })
        .collect();
    *state.imgflip.lock().map_err(|e| e.to_string())? = Some(list.clone());
    Ok(list)
}

pub async fn search_online(
    state: &LibraryState,
    provider: &str,
    query: &str,
    page: u32,
    commercial: bool,
    transparent: bool,
) -> Result<Value, String> {
    let page = page.max(1);
    match provider {
        "openverse" => {
            const BLOCKED: &str = "Openverse is limiting searches from your network right now (anonymous rate limit). \
                Try Wikimedia Commons, or search Openverse again in a few minutes.";
            if let Some(until) = *state.openverse_blocked_until.lock().map_err(|e| e.to_string())? {
                if std::time::Instant::now() < until {
                    return Err(BLOCKED.into());
                }
            }
            let mut params = vec![
                ("q", query.to_string()),
                ("page", page.to_string()),
                // Anonymous Openverse requests are limited to 20 per page.
                ("page_size", "20".to_string()),
                ("mature", "false".into()),
            ];
            if commercial {
                params.push(("license_type", "commercial".into()));
            }
            if transparent {
                params.push(("extension", "png".into()));
            }
            let resp = state
                .http
                .get("https://api.openverse.org/v1/images/")
                .query(&params)
                .timeout(std::time::Duration::from_secs(20))
                .send()
                .await
                .map_err(|e| format!("Network error: {e}"))?;
            // 429 = rate limit; 403 = Cloudflare bot challenge for this IP.
            // Neither can be solved by an app, so back off instead of retrying.
            if matches!(resp.status().as_u16(), 403 | 429) {
                *state.openverse_blocked_until.lock().map_err(|e| e.to_string())? =
                    Some(std::time::Instant::now() + std::time::Duration::from_secs(120));
                return Err(BLOCKED.into());
            }
            if !resp.status().is_success() {
                return Err(format!("Openverse answered {}", resp.status()));
            }
            let data: Value = resp.json().await.map_err(|e| e.to_string())?;
            let results: Vec<Value> = data["results"]
                .as_array()
                .map(|a| a.iter().filter_map(openverse_record).collect())
                .unwrap_or_default();
            let has_more = data["page_count"].as_u64().unwrap_or(0) > page as u64;
            Ok(json!({ "results": results, "hasMore": has_more }))
        }
        "imgflip" => {
            let all = imgflip_templates(state).await?;
            let tokens: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
            let hits: Vec<Value> = all
                .into_iter()
                .filter(|r| {
                    let name = r["name"].as_str().unwrap_or_default().to_lowercase();
                    tokens.iter().all(|t| name.contains(t.as_str()))
                })
                .collect();
            let start = (page as usize - 1) * PAGE_SIZE;
            let results: Vec<Value> = hits.iter().skip(start).take(PAGE_SIZE).cloned().collect();
            Ok(json!({ "results": results, "hasMore": hits.len() > start + PAGE_SIZE }))
        }
        "wikimedia" => search_wikimedia(state, query, page, transparent).await,
        _ => Err(format!("Unknown search provider: {provider}")),
    }
}

#[tauri::command]
pub async fn online_search(
    provider: String,
    query: String,
    page: u32,
    commercial: bool,
    transparent: bool,
    state: State<'_, LibraryState>,
) -> Result<Value, String> {
    search_online(&state, &provider, query.trim(), page, commercial, transparent).await
}

// ------------------------------------------------------- quick add by link

/// Finds the preview image a web page advertises (og:image / twitter:image).
fn page_image(html: &str, base: &reqwest::Url) -> Option<reqwest::Url> {
    meta_url(html, base, &["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"])
}

/// A page's og:video, which may be a real file — or an embeddable player page.
fn page_video(html: &str, base: &reqwest::Url) -> Option<reqwest::Url> {
    meta_url(html, base, &["og:video:secure_url", "og:video:url", "og:video"])
}

fn meta_url(html: &str, base: &reqwest::Url, keys: &[&str]) -> Option<reqwest::Url> {
    // ASCII lowering keeps byte offsets identical to `html`.
    let lower = html.to_ascii_lowercase();
    for key in keys {
        let mut from = 0;
        while let Some(i) = lower[from..].find("<meta") {
            let start = from + i;
            let end = start + lower[start..].find('>')?;
            from = end;
            let tag = &html[start..end];
            let tag_l = &lower[start..end];
            let named = [format!("property=\"{key}\""), format!("name=\"{key}\""), format!("property='{key}'"), format!("name='{key}'")]
                .iter()
                .any(|n| tag_l.contains(n.as_str()));
            if !named {
                continue;
            }
            let at = tag_l.find("content=")? + "content=".len();
            let rest = &tag[at..];
            let quote = rest.chars().next()?;
            let value = if quote == '"' || quote == '\'' {
                rest[1..].split(quote).next()?
            } else {
                rest.split(char::is_whitespace).next()?
            };
            let value = value.replace("&amp;", "&");
            if let Ok(url) = base.join(value.trim()) {
                return Some(url);
            }
        }
    }
    None
}

/// A readable title from the last path segment, e.g. ".../distracted-boyfriend.jpg".
fn title_from_url(url: &reqwest::Url) -> Option<String> {
    let seg = url.path_segments()?.filter(|s| !s.is_empty()).last()?;
    let stem = seg.rsplit_once('.').map(|(s, _)| s).unwrap_or(seg);
    let decoded = percent_decode(stem).replace(['-', '_', '+'], " ");
    let clean: String = decoded.chars().filter(|c| !c.is_control()).take(80).collect();
    let clean = clean.trim().to_string();
    // Hash-like names ("a8F3kq0Z") make poor titles.
    let wordy = clean.contains(' ') || clean.chars().all(|c| c.is_alphabetic());
    (!clean.is_empty() && wordy).then_some(clean)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Downloads an image from a pasted or dropped link. A link to a web page is
/// followed to the image the page advertises. Returns base64 data, the real
/// format and a suggested title.
#[tauri::command]
pub async fn fetch_image_url(url: String, app: AppHandle, state: State<'_, LibraryState>) -> Result<Value, String> {
    use base64::Engine;
    let raw = url.trim();
    let raw = match raw.strip_prefix("http://") {
        Some(rest) if !cfg!(debug_assertions) => format!("https://{rest}"),
        _ => raw.to_string(),
    };
    let mut target = check_url(&raw)?;
    let job = format!("quick-add-{}", Uuid::new_v4());
    let mut title = None;
    // True for X's "GIFs": silent MP4s the user thinks of as GIFs.
    let mut gif_like = false;

    if let Some(id) = tweet_id(&target) {
        let post = tweet_media(&state, &id).await?;
        target = check_url(&post.file)?;
        title = post.title;
        gif_like = post.gif_like;
    } else if let Some(video) = tweet_thumb_video(&target) {
        target = video;
        gif_like = true;
    }

    let is_media = |b: &[u8]| image::guess_format(b).is_ok() || crate::video_ext(b).is_some();
    let mut bytes = fetch_bytes(&app, &state, &job, target.as_str(), MAX_VIDEO_BYTES).await?;
    if !is_media(&bytes) {
        let html = String::from_utf8_lossy(&bytes[..bytes.len().min(2 * 1024 * 1024)]).into_owned();
        let page = target.clone();
        let mut found = None;
        // A page's own video beats its preview still (og:video can also be a player page).
        if let Some(video) = page_video(&html, &page).and_then(|u| check_url(u.as_str()).ok()) {
            if let Ok(b) = fetch_bytes(&app, &state, &job, video.as_str(), MAX_VIDEO_BYTES).await {
                if crate::video_ext(&b).is_some() {
                    found = Some((video, b));
                }
            }
        }
        if found.is_none() {
            let Some(still) = page_image(&html, &page) else {
                return Err("That link isn’t an image or video, and the page doesn’t point to one. Try right-clicking it → Copy Image/Video Address.".into());
            };
            let url = match tweet_thumb_video(&still) {
                Some(video) => {
                    gif_like = true;
                    video
                }
                None => check_url(still.as_str())?,
            };
            let b = fetch_bytes(&app, &state, &job, url.as_str(), MAX_VIDEO_BYTES).await?;
            found = Some((url, b));
        }
        (target, bytes) = found.expect("set above");
    }
    let ext = match crate::video_ext(&bytes) {
        Some(ext) => ext,
        None if bytes.len() > MAX_ASSET_BYTES => {
            return Err(format!("Images over {} MB aren’t supported", MAX_ASSET_BYTES / 1024 / 1024));
        }
        None => validate_image(&bytes, None)?.ext,
    };
    Ok(json!({
        "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "ext": ext,
        "title": title.or_else(|| title_from_url(&target)),
        "gifLike": gif_like && crate::video_ext(&bytes).is_some(),
    }))
}

/// Short meme videos; bigger files are almost certainly not memes.
const MAX_VIDEO_BYTES: usize = 100 * 1024 * 1024;

struct TweetMedia {
    file: String,
    title: Option<String>,
    gif_like: bool,
}

/// The post id of an x.com / twitter.com (or fx/vx mirror) status link.
fn tweet_id(url: &reqwest::Url) -> Option<String> {
    let host = url.host_str()?.trim_start_matches("www.").trim_start_matches("mobile.");
    if !matches!(
        host,
        "x.com" | "twitter.com" | "fxtwitter.com" | "vxtwitter.com" | "fixupx.com" | "fixvx.com"
    ) {
        return None;
    }
    let segs: Vec<&str> = url.path_segments()?.collect();
    let pos = segs.iter().position(|s| *s == "status" || *s == "statuses")?;
    let id = segs.get(pos + 1)?;
    (!id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit())).then(|| id.to_string())
}

/// pbs.twimg.com/tweet_video_thumb/<key>.jpg is the still of video.twimg.com/tweet_video/<key>.mp4.
fn tweet_thumb_video(url: &reqwest::Url) -> Option<reqwest::Url> {
    if url.host_str()? != "pbs.twimg.com" {
        return None;
    }
    let key = url.path().strip_prefix("/tweet_video_thumb/")?;
    let key = key.split('.').next()?;
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return None;
    }
    reqwest::Url::parse(&format!("https://video.twimg.com/tweet_video/{key}.mp4")).ok()
}

/// X's embed widgets compute this from the id; the endpoint only needs it present.
fn syndication_token(id: &str) -> String {
    let n = id.parse::<f64>().unwrap_or(0.0) / 1e15 * std::f64::consts::PI;
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let (mut int, mut frac) = (n.trunc() as u64, n.fract());
    let mut head = Vec::new();
    loop {
        head.push(DIGITS[(int % 36) as usize]);
        int /= 36;
        if int == 0 {
            break;
        }
    }
    head.reverse();
    let mut out = String::from_utf8(head).unwrap_or_default();
    for _ in 0..10 {
        frac *= 36.0;
        out.push(DIGITS[frac.trunc() as usize % 36] as char);
        frac = frac.fract();
    }
    let token: String = out.chars().filter(|c| *c != '0').collect();
    if token.is_empty() { "a".into() } else { token }
}

/// The best media file of a post (MP4 for GIFs/videos, the photo otherwise) and a title.
async fn tweet_media(state: &LibraryState, id: &str) -> Result<TweetMedia, String> {
    let url = format!(
        "https://cdn.syndication.twimg.com/tweet-result?id={id}&token={}&lang=en",
        syndication_token(id)
    );
    let resp = state
        .http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("X didn’t share that post (answered {}). It may be private or deleted.", resp.status()));
    }
    let post: Value = resp.json().await.map_err(|_| "X sent an unexpected answer for that post".to_string())?;
    let media = post["mediaDetails"].as_array().and_then(|m| m.first()).ok_or_else(|| {
        "That post has no image or GIF (or X is hiding it — sensitive posts need a login)".to_string()
    })?;
    let file = if media["type"] == "photo" {
        media["media_url_https"].as_str().map(|u| format!("{u}?name=large"))
    } else {
        // Highest-bitrate MP4 (GIFs have exactly one, at bitrate 0).
        media["video_info"]["variants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v["content_type"] == "video/mp4")
            .max_by_key(|v| v["bitrate"].as_u64().unwrap_or(0))
            .and_then(|v| v["url"].as_str())
            .map(str::to_string)
    }
    .ok_or("Couldn’t find a downloadable file in that post")?;

    let text = post["text"].as_str().unwrap_or("");
    let words: Vec<&str> = text
        .split_whitespace()
        .filter(|w| !w.starts_with("https://t.co/") && !w.starts_with('@'))
        .collect();
    let mut title: String = words.join(" ").chars().take(80).collect();
    if title.is_empty() {
        let what = if media["type"] == "photo" { "Image" } else if media["type"] == "video" { "Video" } else { "GIF" };
        title = post["user"]["name"].as_str().map(|n| format!("{what} from {n}")).unwrap_or_default();
    }
    Ok(TweetMedia {
        file,
        title: (!title.is_empty()).then_some(title),
        gif_like: media["type"] == "animated_gif",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn understands_x_links() {
        let u = |s: &str| reqwest::Url::parse(s).unwrap();
        assert_eq!(tweet_id(&u("https://x.com/i/status/2120481018196971889")).as_deref(), Some("2120481018196971889"));
        assert_eq!(tweet_id(&u("https://twitter.com/someone/status/123?s=20")).as_deref(), Some("123"));
        assert_eq!(tweet_id(&u("https://mobile.twitter.com/a/status/9/photo/1")).as_deref(), Some("9"));
        assert_eq!(tweet_id(&u("https://x.com/someone")), None);
        assert_eq!(tweet_id(&u("https://example.com/i/status/123")), None);
        assert_eq!(
            tweet_thumb_video(&u("https://pbs.twimg.com/tweet_video_thumb/HW12PlmWoAAvXYl?format=webp&name=large")).unwrap().as_str(),
            "https://video.twimg.com/tweet_video/HW12PlmWoAAvXYl.mp4"
        );
        assert_eq!(tweet_thumb_video(&u("https://pbs.twimg.com/media/abc.jpg")), None);
        assert!(!syndication_token("2120481018196971889").is_empty());
        assert_eq!(crate::video_ext(b"\0\0\0\x18ftypmp42\0\0\0\0"), Some("mp4"));
        assert_eq!(crate::video_ext(b"\0\0\0\x14ftypqt  \0\0\0\0"), Some("mov"));
        assert_eq!(crate::video_ext(b"\x89PNG\r\n\x1a\n...."), None);
    }

    #[test]
    fn rejects_bad_ids_and_urls() {
        assert!(valid_id("wojak-crying-001"));
        assert!(!valid_id("../etc"));
        assert!(!valid_id("a/b"));
        assert!(check_url("https://example.com/a.png").is_ok());
        assert!(check_url("http://example.com/a.png").is_err());
        assert!(check_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn untrusted_records_cannot_claim_verification() {
        let rec = sanitize_untrusted(&json!({
            "id": "x", "name": "X",
            "file": { "url": "javascript:alert(1)" },
            "licensing": { "license": "CC0", "verified": true }
        }))
        .unwrap();
        assert_eq!(rec["licensing"]["verified"], json!(false));
        assert_eq!(rec["file"]["url"], Value::Null);
    }

    #[test]
    fn strips_html_from_commons_metadata() {
        assert_eq!(strip_html("<a href=\"x\">Jane &amp; Co</a>\n  "), "Jane & Co");
    }

    #[test]
    fn checksum_is_enforced() {
        let hex: String = Sha256::digest(b"hi").iter().map(|b| format!("{b:02x}")).collect();
        assert!(verify_checksum(b"hi", Some(&format!("sha256-{hex}"))).is_ok());
        assert!(verify_checksum(b"ho", Some(&format!("sha256-{hex}"))).is_err());
        assert!(verify_checksum(b"ho", Some("sha256-placeholder")).is_ok());
    }

    fn zip_with(files: &[(&str, &[u8])]) -> PathBuf {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("mf-test-{}.zip", Uuid::new_v4()));
        let mut z = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (name, bytes) in files {
            z.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(bytes).unwrap();
        }
        z.finish().unwrap();
        path
    }

    fn sample_pack() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../catalog/packs/blob-crew.zip")
    }

    #[test]
    fn reads_the_sample_pack() {
        let pack = read_pack(&sample_pack()).unwrap();
        assert_eq!(pack.manifest["id"], json!("blob-crew"));
        assert_eq!(pack.files.len(), 10);
        assert!(pack.files.iter().all(|f| f.info.transparent));
        assert!(pack.files.iter().all(|f| f.record["licensing"]["verified"] == json!(false)));
    }

    #[test]
    fn finds_page_preview_images() {
        let base = reqwest::Url::parse("https://example.com/post/1").unwrap();
        let html = r#"<head><meta name="x" content="y"><meta property="og:image" content="/img/a.png?w=1&amp;h=2"></head>"#;
        assert_eq!(page_image(html, &base).unwrap().as_str(), "https://example.com/img/a.png?w=1&h=2");
        let tw = r#"<meta content='https://cdn.example.com/b.jpg' name='twitter:image'>"#;
        assert_eq!(page_image(tw, &base).unwrap().as_str(), "https://cdn.example.com/b.jpg");
        assert!(page_image("<p>no images</p>", &base).is_none());
        let u = reqwest::Url::parse("https://i.example.com/x/distracted-boyfriend.jpg").unwrap();
        assert_eq!(title_from_url(&u).as_deref(), Some("distracted boyfriend"));
        let h = reqwest::Url::parse("https://i.example.com/a8F3kq0Z.jpg").unwrap();
        assert_eq!(title_from_url(&h), None);
    }

    #[test]
    fn reads_every_catalog_pack() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../catalog");
        let catalog: Value = serde_json::from_slice(&fs::read(root.join("catalog.json")).unwrap()).unwrap();
        for entry in catalog["packs"].as_array().unwrap() {
            let pack = read_pack(&root.join(entry["downloadUrl"].as_str().unwrap())).unwrap();
            assert_eq!(pack.manifest["id"], entry["id"]);
            assert_eq!(json!(pack.files.len()), entry["assetCount"]);
        }
    }

    #[test]
    fn rejects_unsafe_packs() {
        let png = fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/32x32.png")).unwrap();
        let manifest = br#"{"id":"p","name":"P","assets":["a"]}"#;
        let meta = br#"{"id":"a","name":"A"}"#;

        let ok = zip_with(&[("manifest.json", manifest), ("metadata/a.json", meta), ("assets/a.png", &png)]);
        assert!(read_pack(&ok).is_ok());

        let traversal = zip_with(&[("manifest.json", manifest), ("../evil.png", &png)]);
        assert!(read_pack(&traversal).unwrap_err().contains("unsafe"));

        let svg = zip_with(&[("manifest.json", manifest), ("assets/a.svg", b"<svg onload=alert(1)/>")]);
        assert!(read_pack(&svg).unwrap_err().contains("SVG"));

        let script = zip_with(&[("manifest.json", manifest), ("run.sh", b"rm -rf /")]);
        assert!(read_pack(&script).unwrap_err().contains("Unsupported"));

        let fake = zip_with(&[("manifest.json", manifest), ("metadata/a.json", meta), ("assets/a.png", b"not an image")]);
        assert!(read_pack(&fake).is_err());

        let no_manifest = zip_with(&[("assets/a.png", &png)]);
        assert!(read_pack(&no_manifest).unwrap_err().contains("manifest"));

        let missing = zip_with(&[("manifest.json", br#"{"id":"p","name":"P","assets":["a","b"]}"#), ("metadata/a.json", meta), ("assets/a.png", &png)]);
        assert!(read_pack(&missing).unwrap_err().contains("b"));

        for p in [ok, traversal, svg, script, fake, no_manifest, missing] {
            let _ = fs::remove_file(p);
        }
    }

    #[test]
    fn image_validation_checks_real_format() {
        let png = fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/32x32.png")).unwrap();
        assert!(validate_image(&png, Some("png")).is_ok());
        assert!(validate_image(&png, Some("jpg")).unwrap_err().contains("contains png"));
        assert!(validate_image(b"<svg/>", None).is_err());
    }

    /// Hits the real APIs: `cargo test -- --ignored online`
    #[test]
    #[ignore]
    fn online_search_works() {
        let state = LibraryState::new("test").unwrap();
        tauri::async_runtime::block_on(async {
            // Openverse may block anonymous traffic (Cloudflare); then the
            // error must be the friendly one, and a retry must not hit the API.
            match search_online(&state, "openverse", "happy frog", 1, false, false).await {
                Ok(ov) => assert!(!ov["results"].as_array().unwrap().is_empty()),
                Err(e) => {
                    assert!(e.contains("limiting"), "{e}");
                    let again = search_online(&state, "openverse", "x", 1, false, false).await.unwrap_err();
                    assert!(again.contains("limiting"));
                }
            }
            let wm = search_online(&state, "wikimedia", "happy frog cartoon", 1, false, false).await.unwrap();
            let first = &wm["results"][0];
            assert!(first["file"]["url"].as_str().unwrap().starts_with("https://upload.wikimedia.org/"));
            assert_eq!(first["licensing"]["verified"], json!(false));
            assert!(wm["results"].as_array().unwrap().iter().all(|r| r["format"] != json!("svg")));
            let ifl = search_online(&state, "imgflip", "drake", 1, false, false).await.unwrap();
            assert!(!ifl["results"].as_array().unwrap().is_empty());
        });
    }
}
