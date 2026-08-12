//! 工程目录的记忆与选择。
//!
//! 落点是 `<app_config_dir>/shell.json`，**只存壳自己的状态**（上次打开的工程路径）。
//! 小说数据、模型配置、API Key 一概不在这里——那些还在 `~/.novelforge/` 与工程目录里，
//! 由 sidecar 负责。换句话说：把 shell.json 删了，只是下次要重新选一次工程。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Default, Serialize, Deserialize)]
pub struct ShellState {
    /// 上次打开的工程目录（绝对路径）。
    #[serde(default)]
    pub last_project: Option<String>,
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("取不到配置目录：{e}"))?;
    Ok(dir.join("shell.json"))
}

/// 读上次的工程目录。**目录已经不存在时返回 None**——用户可能把它挪走或删了，
/// 那种情况下不该拿一个死路径去起 sidecar，直接退回选择界面更好。
pub fn last_project(app: &AppHandle) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(state_path(app).ok()?).ok()?;
    let state: ShellState = serde_json::from_str(&raw).ok()?;
    let path = PathBuf::from(state.last_project?);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

/// 记住工程目录。写失败只是下次要重选一遍，不该让它挡住正事，所以只回 Err 给调用方记日志。
pub fn remember(app: &AppHandle, root: &Path) -> Result<(), String> {
    let path = state_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建配置目录失败：{e}"))?;
    }
    let state = ShellState {
        last_project: Some(root.to_string_lossy().to_string()),
    };
    let text = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{text}\n")).map_err(|e| format!("写 shell.json 失败：{e}"))
}

/// 弹系统文件夹选择器。
///
/// **必须在非主线程上调用**（Tauri 命令默认就在独立线程上跑）：GTK / Win32 的模态
/// 对话框在主线程上阻塞会死锁。所以这个函数只从 `#[tauri::command]` 里调，
/// 绝不在 `setup()` 里调——首次启动是由 splash 页上的按钮触发的，不是自动弹窗。
pub fn pick(app: &AppHandle) -> Option<PathBuf> {
    app.dialog()
        .file()
        .set_title("选择小说工程目录")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
}
