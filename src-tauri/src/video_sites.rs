//! Saving the real video from Instagram, TikTok and YouTube links.
//!
//! Those sites never hand the video file to a plain download (login walls,
//! signed links, scrambled stream URLs), so MemeFactory bundles yt-dlp as a
//! sidecar (fetched and checksum-verified by scripts/fetch-ytdlp.mjs) and runs it.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// Bigger files are almost certainly not memes (matches the other link imports).
const MAX_MB: u32 = 100;
/// yt-dlp normally finishes in a few seconds; give up rather than hang the app.
const TIMEOUT: Duration = Duration::from_secs(180);

/// The site's name if this is a video link yt-dlp should handle.
pub fn video_site(url: &reqwest::Url) -> Option<&'static str> {
    let host = url.host_str()?.to_ascii_lowercase();
    let host = host.trim_start_matches("www.").trim_start_matches("m.");
    let path = url.path();
    match host {
        "instagram.com" | "instagr.am" => ["/p/", "/reel/", "/reels/", "/tv/"]
            .iter()
            .any(|p| path.starts_with(p) || path.contains(p))
            .then_some("Instagram"),
        "tiktok.com" | "vm.tiktok.com" | "vt.tiktok.com" => {
            (path.contains("/video/") || path.starts_with("/t/") || host != "tiktok.com").then_some("TikTok")
        }
        "youtube.com" | "music.youtube.com" | "youtube-nocookie.com" => {
            (path == "/watch" || ["/shorts/", "/embed/", "/live/", "/v/"].iter().any(|p| path.starts_with(p)))
                .then_some("YouTube")
        }
        "youtu.be" => (path.len() > 1).then_some("YouTube"),
        _ => None,
    }
}

/// The bundled yt-dlp: Tauri puts sidecars next to the app's own executable.
/// Prefixed so the Linux package doesn't clash with a system yt-dlp.
fn sidecar() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("Can’t find the app folder")?;
    let path = dir.join(format!("memefactory-yt-dlp{}", std::env::consts::EXE_SUFFIX));
    if path.exists() {
        Ok(path)
    } else {
        Err("The video downloader is missing from this copy of MemeFactory — reinstall the app.".into())
    }
}

/// Downloads the video behind `url`; returns its bytes and title.
pub async fn download(app: &AppHandle, url: &reqwest::Url, site: &'static str) -> Result<(Vec<u8>, Option<String>), String> {
    let bin = sidecar()?;
    let work = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(format!("video-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let url = url.to_string();
    let dir = work.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run(&bin, &url, &dir, site))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    let _ = fs::remove_dir_all(&work);
    result
}

fn run(bin: &Path, url: &str, dir: &Path, site: &str) -> Result<(Vec<u8>, Option<String>), String> {
    let out_path = dir.join("stdout.txt");
    let err_path = dir.join("stderr.txt");
    let mut cmd = Command::new(bin);
    cmd.current_dir(dir)
        .args([
            "--ignore-config",
            "--no-cache-dir", // leave nothing behind outside the app's folders
            "--no-playlist",
            "--no-warnings",
            "--no-progress",
            "--no-part",
            "--no-mtime",
            "--socket-timeout",
            "20",
            // One file with picture and sound: there's no ffmpeg to merge separate streams.
            "-f",
            "b[ext=mp4]/b[ext=webm]/b",
            "--max-filesize",
            &format!("{MAX_MB}M"),
            "--no-simulate",
            "-O",
            "before_dl:title:%(title)s",
            "-O",
            "after_move:file:%(filepath)s",
            "-o",
            "video.%(ext)s",
            "--",
            url,
        ])
        .stdin(Stdio::null())
        .stdout(fs::File::create(&out_path).map_err(|e| e.to_string())?)
        .stderr(fs::File::create(&err_path).map_err(|e| e.to_string())?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    }

    let mut child = cmd.spawn().map_err(|e| format!("Couldn’t start the video downloader: {e}"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{site} took too long to send the video — try again."));
        }
        std::thread::sleep(Duration::from_millis(150));
    };

    let stdout = fs::read_to_string(&out_path).unwrap_or_default();
    let stderr = fs::read_to_string(&err_path).unwrap_or_default();
    let title = stdout
        .lines()
        .find_map(|l| l.strip_prefix("title:"))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty() && t != "NA");
    let file = stdout
        .lines()
        .find_map(|l| l.strip_prefix("file:"))
        .map(|f| dir.join(f.trim()))
        .filter(|f| f.is_file());

    let Some(file) = file.filter(|_| status.success()) else {
        return Err(explain(&stderr, site));
    };
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    if crate::video_ext(&bytes).is_none() {
        return Err(format!("{site} sent a format MemeFactory can’t play (only MP4, MOV and WebM)."));
    }
    Ok((bytes, title))
}

/// Turns yt-dlp's error output into something a person can act on.
fn explain(stderr: &str, site: &str) -> String {
    let line = stderr
        .lines()
        .rev()
        .find(|l| l.starts_with("ERROR:"))
        .unwrap_or("")
        .trim_start_matches("ERROR:")
        .trim();
    let low = line.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| low.contains(w));
    if stderr.contains("larger than max-filesize") {
        return format!("That {site} video is over {MAX_MB} MB — too big for a meme.");
    }
    if has(&["login", "log in", "sign in", "cookies", "rate-limit", "rate limit", "age-restricted", "confirm your age"]) {
        return format!("{site} only shows that video to logged-in users, so it can’t be saved from the link. Download it another way and drop the file in.");
    }
    if has(&["private", "unavailable", "removed", "not available", "does not exist", "404"]) {
        return format!("That {site} video is private, removed or not available in your region.");
    }
    if has(&["unable to download", "timed out", "connection", "network", "resolve"]) {
        return format!("Couldn’t reach {site} — check your connection and try again.");
    }
    if line.is_empty() {
        format!("Couldn’t get the video from {site}.")
    } else {
        format!("Couldn’t get the video from {site}: {line}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(u: &str) -> Option<&'static str> {
        video_site(&reqwest::Url::parse(u).unwrap())
    }

    #[test]
    fn recognises_video_links() {
        assert_eq!(site("https://www.instagram.com/reel/C1abcDEF/"), Some("Instagram"));
        assert_eq!(site("https://instagram.com/p/C1abcDEF/?igsh=x"), Some("Instagram"));
        assert_eq!(site("https://www.instagram.com/someuser/reel/C1abcDEF/"), Some("Instagram"));
        assert_eq!(site("https://www.instagram.com/someuser/"), None);
        assert_eq!(site("https://www.tiktok.com/@user/video/7300000000000000000"), Some("TikTok"));
        assert_eq!(site("https://vm.tiktok.com/ZMabc123/"), Some("TikTok"));
        assert_eq!(site("https://www.tiktok.com/@user"), None);
        assert_eq!(site("https://www.youtube.com/watch?v=jNQXAC9IVRw"), Some("YouTube"));
        assert_eq!(site("https://youtube.com/shorts/abc123"), Some("YouTube"));
        assert_eq!(site("https://m.youtube.com/watch?v=abc"), Some("YouTube"));
        assert_eq!(site("https://youtu.be/jNQXAC9IVRw"), Some("YouTube"));
        assert_eq!(site("https://www.youtube.com/@channel"), None);
        assert_eq!(site("https://example.com/watch"), None);
    }

    #[test]
    fn explains_common_failures() {
        assert!(explain("ERROR: [Instagram] abc: Requested content is not available, rate-limit reached or login required", "Instagram")
            .contains("logged-in"));
        assert!(explain("ERROR: [youtube] x: Private video", "YouTube").contains("private"));
        assert!(explain("", "TikTok").contains("Couldn’t get the video from TikTok"));
    }
}
