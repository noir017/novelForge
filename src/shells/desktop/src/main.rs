// Windows 的 release 构建不要挂控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Novel Forge 桌面壳。
//!
//! 它做三件事，没有第四件：
//!
//! 1. 起 sidecar（`src/standalone` 编出来的那个单文件可执行），**不传工程路径**
//! 2. 等它就绪，把窗口从本地 splash 页导航到 `http://127.0.0.1:PORT/`
//! 3. 退出时把 sidecar 收掉
//!
//! 上次打开的工程由 sidecar 读 `~/.novelforge/window.json` 恢复，与浏览器里
//! 跑 `novelforge` 同一条路。打开/关闭文件夹不重启 sidecar。

mod project;
mod sidecar;

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url};

/// splash 页要显示的状态。
///
/// 既 emit（状态变了推一次）又能 invoke 拉取（`boot_state`）：页面加载完成的时刻
/// 与 boot 任务推送的时刻没有先后保证，只推会丢事件，只拉又不知道何时更新。
#[derive(Clone, Serialize)]
struct BootState {
    /// `starting` 正在起服务 / `failed` 起失败了
    phase: String,
    message: Option<String>,
}

impl Default for BootState {
    fn default() -> Self {
        Self {
            phase: "starting".to_string(),
            message: None,
        }
    }
}

#[derive(Default)]
struct Boot(Mutex<BootState>);

fn set_state(app: &AppHandle, phase: &str, message: Option<String>) {
    let state = BootState {
        phase: phase.to_string(),
        message,
    };
    if let Some(boot) = app.try_state::<Boot>() {
        let mut guard = boot.0.lock().unwrap_or_else(|e| e.into_inner());
        *guard = state.clone();
    }
    let _ = app.emit("boot-state", state);
}

/// 起服务并导航过去。失败则把原因交给 splash 页显示。
async fn launch(app: AppHandle) {
    set_state(&app, "starting", None);

    match sidecar::start(app.clone()).await {
        Ok(url) => match Url::parse(&url) {
            Ok(parsed) => {
                if let Some(mut window) = app.get_webview_window("main") {
                    if let Err(err) = window.navigate(parsed) {
                        set_state(&app, "failed", Some(format!("窗口导航失败：{err}")));
                    }
                }
            }
            Err(err) => set_state(
                &app,
                "failed",
                Some(format!("服务给出的地址无法解析（{url}）：{err}")),
            ),
        },
        Err(message) => set_state(&app, "failed", Some(message)),
    }
}

#[tauri::command]
fn boot_state(app: AppHandle) -> BootState {
    app.try_state::<Boot>()
        .map(|boot| {
            boot.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        })
        .unwrap_or_default()
}

/// 「重试」只再起 sidecar，不传路径。
#[tauri::command]
fn retry(app: AppHandle) {
    tauri::async_runtime::spawn(launch(app));
}

#[tauri::command]
fn open_logs(app: AppHandle) -> Result<String, String> {
    let dir = sidecar::log_dir(&app).ok_or_else(|| "取不到日志目录".to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    reveal(&dir);
    Ok(dir.display().to_string())
}

/// 用系统文件管理器打开一个目录。与 src/standalone/fileHost.ts 里的做法一致。
fn reveal(path: &Path) {
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "macos")]
    let program = "open";

    let _ = std::process::Command::new(program).arg(path).spawn();
}

fn main() {
    tauri::Builder::default()
        // single-instance 必须第一个注册。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(sidecar::Sidecar::default())
        .manage(Boot::default())
        .invoke_handler(tauri::generate_handler![boot_state, retry, open_logs])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(err) = project::migrate_shell_json_once(&handle) {
                eprintln!("迁移 shell.json 失败：{err}");
            }
            tauri::async_runtime::spawn(async move {
                launch(handle).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                sidecar::kill(app);
            }
        });
}
