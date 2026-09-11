use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::PathBuf;
use tauri::Manager;

// One rollover at 2 MB: enough history to cover a few days of a rare failure, small enough to
// paste somewhere whole.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

fn log_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("lookout.log"))
}

#[tauri::command]
pub fn log_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(log_file(&app)?.to_string_lossy().into_owned())
}

// Append one already-formatted line. The webview decides what (and whether) to log; this only writes.
#[tauri::command]
pub fn log_append(app: tauri::AppHandle, line: String) -> Result<(), String> {
    let path = log_file(&app)?;
    if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
        let _ = fs::rename(&path, path.with_extension("log.1"));
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn log_clear(app: tauri::AppHandle) -> Result<(), String> {
    let path = log_file(&app)?;
    let _ = fs::remove_file(path.with_extension("log.1"));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
