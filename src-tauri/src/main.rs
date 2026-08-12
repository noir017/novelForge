// Windows 的 release 构建不要挂控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Novel Forge 桌面壳。
//!
//! 它做四件事，没有第五件：
//!
//! 1. 想起（或让用户选）一个小说工程目录
//! 2. 起 sidecar（`src/standalone` 编出来的那个单文件可执行）
//! 3. 等它就绪，把窗口从本地 splash 页导航到 `http://127.0.0.1:PORT/`
//! 4. 退出时把 sidecar 收掉
//!
//! **`src/` 与 `media/` 一行都没为这个壳改过。** 界面、模型调用、文件读写、
//! 文件监视、SQLite 全在 sidecar 里跑——它是同一台机器上的一个普通进程，
//! 该有的系统能力一样都不少，所以壳不需要实现任何宿主适配。

mod project;
mod sidecar;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Url};

/// splash 页要显示的状态。
///
/// 既 emit（状态变了推一次）又能 invoke 拉取（`boot_state`）：页面加载完成的时刻
/// 与 boot 任务推送的时刻没有先后保证，只推会丢事件，只拉又不知道何时更新。
#[derive(Clone, Serialize)]
struct BootState {
    /// `picking` 还没选工程 / `starting` 正在起服务 / `failed` 起失败了
    phase: String,
    project: Option<String>,
    message: Option<String>,
}

impl Default for BootState {
    fn default() -> Self {
        Self {
            phase: "starting".to_string(),
            project: None,
            message: None,
        }
    }
}

#[derive(Default)]
struct Boot(Mutex<BootState>);

fn set_state(app: &AppHandle, phase: &str, project: Option<String>, message: Option<String>) {
    let state = BootState {
        phase: phase.to_string(),
        project,
        message,
    };
    if let Some(boot) = app.try_state::<Boot>() {
        let mut guard = boot.0.lock().unwrap_or_else(|e| e.into_inner());
        *guard = state.clone();
    }
    let _ = app.emit("boot-state", state);
}

/// 起服务并导航过去。失败则把原因交给 splash 页显示。
async fn launch(app: AppHandle, root: PathBuf) {
    let shown = root.display().to_string();
    set_state(&app, "starting", Some(shown.clone()), None);

    match sidecar::start(app.clone(), root.clone()).await {
        Ok(url) => {
            // 记住工程放在**起成功之后**：起不来的目录不值得记，否则下次开 app
            // 又直接撞上同一个坏路径。
            if let Err(err) = project::remember(&app, &root) {
                eprintln!("记住工程目录失败：{err}");
            }
            match Url::parse(&url) {
                Ok(parsed) => {
                    if let Some(mut window) = app.get_webview_window("main") {
                        if let Err(err) = window.navigate(parsed) {
                            set_state(
                                &app,
                                "failed",
                                Some(shown),
                                Some(format!("窗口导航失败：{err}")),
                            );
                        }
                    }
                }
                Err(err) => set_state(
                    &app,
                    "failed",
                    Some(shown),
                    Some(format!("服务给出的地址无法解析（{url}）：{err}")),
                ),
            }
        }
        Err(message) => set_state(&app, "failed", Some(shown), Some(message)),
    }
}

/// 弹文件夹选择器，选中就起。
///
/// 选择器**必须在独立线程上**弹：GTK / Win32 的模态对话框在主线程或 async
/// 运行时的 worker 上阻塞都可能死锁。
fn choose_then_launch(app: AppHandle) {
    std::thread::spawn(move || {
        if let Some(root) = project::pick(&app) {
            tauri::async_runtime::spawn(launch(app.clone(), root));
        }
    });
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

#[tauri::command]
fn select_project(app: AppHandle) {
    choose_then_launch(app);
}

/// 「重试」：拿记住的工程再起一次；没有记住的就退回选择界面。
#[tauri::command]
fn retry(app: AppHandle) {
    match project::last_project(&app) {
        Some(root) => {
            tauri::async_runtime::spawn(launch(app, root));
        }
        None => set_state(&app, "picking", None, None),
    }
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

fn build_menu(handle: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(handle, "open-project", "打开其他工程…", true, None::<&str>)?;
    let logs = MenuItem::with_id(handle, "open-logs", "打开日志目录", true, None::<&str>)?;
    let file = Submenu::with_items(
        handle,
        "文件",
        true,
        &[&open, &PredefinedMenuItem::separator(handle)?, &PredefinedMenuItem::quit(handle, Some("退出"))?],
    )?;
    let help = Submenu::with_items(handle, "帮助", true, &[&logs])?;
    Menu::with_items(handle, &[&file, &help])
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
        .menu(build_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            // 切换工程 = 收掉旧 sidecar + 用新目录起一个。sidecar::start 里
            // 已经先 kill 了，这里不必重复。
            "open-project" => choose_then_launch(app.clone()),
            "open-logs" => {
                let _ = open_logs(app.clone());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            boot_state,
            select_project,
            retry,
            open_logs
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match project::last_project(&handle) {
                    Some(root) => launch(handle, root).await,
                    // 首次启动不自动弹系统对话框——splash 页上给一个按钮，
                    // 由用户点击触发（顺带绕开主线程弹模态框的死锁风险）。
                    None => set_state(&handle, "picking", None, None),
                }
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
