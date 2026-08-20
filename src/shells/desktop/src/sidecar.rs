//! sidecar（`novelforge` 单文件可执行）的生命周期。
//!
//! ## 就绪信号为什么是 stdout 里那行 URL
//!
//! `src/standalone/server.ts` 在 `Bun.serve` 返回**之后**打一行
//! `服务已启动：http://127.0.0.1:PORT/`。返回意味着 listen 已完成，所以这一行
//! 既给出端口、又证明端口已经能连——不需要再轮询探活。
//!
//! 这里刻意只匹配 URL 那一段，不匹配「服务已启动」这几个中文字：日志文案将来
//! 改了不该把壳弄坏。
//!
//! ## 为什么还要预挑端口
//!
//! sidecar 自己在端口被占时会顺延重试（`main.ts`），顺延之后的端口只有它知道。
//! 预挑一个空闲端口传给它，是为了让「碰撞」几乎不发生；真发生了也不怕，
//! 因为端口的**权威来源始终是 stdout 那行 URL**，不是我们挑的这个数。
//! 预挑的值只用在一处：stdout 迟迟不来时的 TCP 兜底探测。

use std::io::Write;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// tauri.conf.json 里 `externalBin` 的末段，也是 scripts/build-sidecar.js 的 BASE。
const BIN: &str = "novelforge";
const URL_PREFIX: &str = "http://127.0.0.1:";

/// 轮询间隔与两个阈值。
const TICK: Duration = Duration::from_millis(100);
/// 8 秒还没等到 stdout 就开始 TCP 兜底探测（管道缓冲异常之类）。
const PROBE_AFTER_TICKS: u32 = 80;
/// 30 秒仍不就绪就认定失败——比 sidecar 自己顺延 20 次端口的最坏情况还宽。
const GIVE_UP_TICKS: u32 = 300;

/// 持有正在跑的 sidecar 子进程。退出时从这里取。
#[derive(Default)]
pub struct Sidecar {
    child: Mutex<Option<CommandChild>>,
}

/// 收掉当前 sidecar。**退出时必须调**：Windows 上留下孤儿进程会占着端口，
/// 还会占着 `.novelforge/novelforge.db`（`src/core/runtime/db.ts` 里记过这个 EBUSY 坑）。
///
/// 幂等——没有在跑的子进程时什么都不做。
pub fn kill(app: &AppHandle) {
    let Some(state) = app.try_state::<Sidecar>() else {
        return;
    };
    // 锁中毒也要把子进程收掉，所以不用 unwrap。
    let mut guard = state.child.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(child) = guard.take() {
        let _ = child.kill();
    }
}

pub fn log_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_log_dir().ok()
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    Some(log_dir(app)?.join("sidecar.log"))
}

/// 起一个 sidecar，等它就绪，返回该访问的 URL。
///
/// 会先收掉已有的 sidecar，所以失败后点「重试」直接调它即可。
pub async fn start(app: AppHandle) -> Result<String, String> {
    kill(&app);

    let port = free_port()?;
    let log = log_path(&app);
    // 每次启动截断重来：这是「上次为什么起不来」的排查依据，不需要历史。
    if let Some(path) = &log {
        reset_log(path, port);
    }

    let (mut rx, child) = app
        .shell()
        .sidecar(BIN)
        .map_err(|e| format!("找不到内置服务程序：{e}"))?
        .args([
            "--no-open".to_string(),
            "--port".to_string(),
            port.to_string(),
        ])
        .spawn()
        .map_err(|e| format!("启动内置服务失败：{e}"))?;

    if let Some(state) = app.try_state::<Sidecar>() {
        let mut guard = state.child.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(child);
    }

    // sidecar 的 stdout/stderr 全量落盘，同时从里面捞就绪信号。
    let (tx, mut ready) = tokio::sync::mpsc::channel::<Result<String, String>>(4);
    let log_for_task = log.clone();
    tauri::async_runtime::spawn(async move {
        let mut reported = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    append(&log_for_task, &text);
                    if !reported {
                        if let Some(url) = text.lines().find_map(parse_url) {
                            reported = true;
                            let _ = tx.send(Ok(url)).await;
                        }
                    }
                }
                CommandEvent::Error(message) => {
                    append(&log_for_task, &format!("[壳] 子进程错误：{message}"));
                    if !reported {
                        reported = true;
                        let _ = tx.send(Err(message)).await;
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let message = format!(
                        "内置服务退出（code={:?}, signal={:?}）",
                        payload.code, payload.signal
                    );
                    append(&log_for_task, &format!("[壳] {message}"));
                    if !reported {
                        reported = true;
                        let _ = tx.send(Err(message)).await;
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    for tick in 0..GIVE_UP_TICKS {
        match ready.try_recv() {
            Ok(Ok(url)) => return Ok(url),
            Ok(Err(message)) => return Err(message),
            Err(_) => {}
        }
        // stdout 没来但端口在听：按预挑的端口走，别干等着。
        if tick >= PROBE_AFTER_TICKS && tick % 10 == 0 && port_alive(port) {
            append(
                &log,
                "[壳] 没等到 stdout 的就绪行，但端口已在监听，按预挑端口继续。",
            );
            return Ok(format!("{URL_PREFIX}{port}/"));
        }
        tokio::time::sleep(TICK).await;
    }

    Err("内置服务 30 秒内没有就绪".to_string())
}

/// 挑一个空闲端口：绑 0 号口让系统分配，取到号就放掉。
fn free_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("挑不到空闲端口：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("取不到端口号：{e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn port_alive(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// 从一行日志里抠出 `http://127.0.0.1:PORT/`。认不出返回 None。
fn parse_url(line: &str) -> Option<String> {
    let at = line.find(URL_PREFIX)?;
    let digits: String = line[at + URL_PREFIX.len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    if digits.is_empty() {
        return None;
    }
    Some(format!("{URL_PREFIX}{digits}/"))
}

fn reset_log(path: &Path, port: u16) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        path,
        format!("[壳] 启动内置服务，预挑端口 {port}\n"),
    );
}

/// 追加一段 sidecar 输出。**所有错误都吞掉**——日志是排查手段，不该成为
/// 新的失败源（与 src/core/runtime/db.ts 里对 SQLite 的态度一致）。
fn append(path: &Option<PathBuf>, text: &str) {
    let Some(path) = path else {
        return;
    };
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = file.write_all(text.as_bytes());
    if !text.ends_with('\n') {
        let _ = file.write_all(b"\n");
    }
}
