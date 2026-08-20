//! 把旧桌面壳的 `<app_config_dir>/shell.json` 迁到 sidecar 会读的
//! `~/.novelforge/window.json`。只迁一次：window.json 已经在就不碰。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Default, Serialize, Deserialize)]
struct ShellState {
    #[serde(default)]
    last_project: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct WindowRecent {
    root: String,
    name: String,
    #[serde(rename = "openedAt")]
    opened_at: u64,
}

#[derive(Serialize, Deserialize)]
struct WindowState {
    #[serde(rename = "lastOpen")]
    last_open: Option<String>,
    recents: Vec<WindowRecent>,
}

fn shell_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("取不到配置目录：{e}"))?;
    Ok(dir.join("shell.json"))
}

fn novelforge_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".novelforge"))
}

fn last_project(app: &AppHandle) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(shell_path(app).ok()?).ok()?;
    let state: ShellState = serde_json::from_str(&raw).ok()?;
    let path = PathBuf::from(state.last_project?);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

/// 若 `window.json` 还不存在，且旧 `shell.json` 里有还在的工程目录，写入一次。
pub fn migrate_shell_json_once(app: &AppHandle) -> Result<(), String> {
    let Some(dir) = novelforge_dir() else {
        return Ok(());
    };
    let win_path = dir.join("window.json");
    if win_path.exists() {
        return Ok(());
    }
    let Some(root) = last_project(app) else {
        return Ok(());
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("建 ~/.novelforge 失败：{e}"))?;
    let root_str = root.to_string_lossy().to_string();
    let name = file_name(&root);
    let opened_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let state = WindowState {
        last_open: Some(root_str.clone()),
        recents: vec![WindowRecent {
            root: root_str,
            name,
            opened_at,
        }],
    };
    let text = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    std::fs::write(&win_path, format!("{text}\n")).map_err(|e| format!("写 window.json 失败：{e}"))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}
