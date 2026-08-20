# desktop — 桌面壳（Windows / Linux）

第三个壳。前两个是 VS Code 插件（[vscode](../vscode/README.md)）与独立 Web 服务
（[standalone](../standalone/README.md)），这一个把**独立 Web 服务原封不动地装进一个桌面窗口**。

## 它是一层纯壳

`core/` 与 `media/` 一行都没有为它改过（除了它自己搬进 `src/shells/` 时那次改路径）。壳只做三件事：

1. 起 sidecar —— 就是 `npm run dist` 那个单文件可执行，只换了个文件名。**不传工程路径**
2. 等它就绪，把窗口从本地 `ui/splash.html` 导航到 `http://127.0.0.1:PORT/`
3. 退出时把 sidecar 收掉

上次打开的工程由 sidecar 读 `~/.novelforge/window.json` 恢复，与浏览器里跑 `novelforge` 同一条路。打开/关闭文件夹不 kill、不重启 sidecar。旧桌面记忆 `<app_config_dir>/shell.json` 只在 `window.json` 还不存在时迁一次。

**所以桌面版没有任何功能是"适配"出来的。** sidecar 是同一台机器上的普通进程，
`fs.watch`、`bun:sqlite`、`openExternal` 唤起系统程序全部照旧工作。用户看不到服务的存在，
但架构上它还在那儿——这也是 web 模式一行不改就能继续跑的原因。

**这个目录本身就是 Tauri 工程根**（`tauri.conf.json` 直接放在这里，不再套一层 `src-tauri/`）。
`npm run app:dev` / `app:build` 会先 `cd` 进来再调 CLI——Tauri 认「cwd 或 cwd/src-tauri 下的
tauri.conf.json」，站在这里是最稳的那条发现路径。CI 里对应的是 tauri-action 的
`projectPath: src/shells/desktop`。

这层壳之所以能这么薄，是因为独立版早就把需要的东西给齐了：`--no-open` 已有、
端口占用会自愈、[server.ts](../standalone/server.ts) 已经往 stdout 打了带端口的 URL、
`isAllowedOrigin` 天然放行 `http://127.0.0.1:PORT` 的 webview。

## 文件

| 文件 | 作用 |
|---|---|
| [src/main.rs](src/main.rs) | 启动编排、三个 `#[tauri::command]`、退出时收 sidecar。无原生 File/Help 菜单 |
| [src/sidecar.rs](src/sidecar.rs) | sidecar 生命周期：预挑端口、spawn（只传 `--no-open --port`）、等就绪、日志落盘、kill |
| [src/project.rs](src/project.rs) | 把旧 `shell.json` 的 `last_project` 迁到 `~/.novelforge/window.json`（只一次） |
| [ui/splash.html](ui/splash.html) + [ui/splash.js](ui/splash.js) | 启动页：启动中 / 失败（重试、查看日志）。不再选目录 |
| [icons/source.svg](icons/source.svg) | app 图标源文件，改了重跑 `npx tauri icon icons/source.svg` |

sidecar 由 [scripts/build-sidecar.js](../../../scripts/build-sidecar.js) 产出到 `binaries/`（不入库），
由 `tauri.conf.json` 的 `beforeDevCommand` / `beforeBuildCommand` 自动触发。

## 用法

```bash
npm run app:dev      # 开发运行（会自动先编 sidecar）
npm run app:build    # 出安装包
npm run sidecar      # 只编当前平台的 sidecar
npm run sidecar:all  # 连 Windows 的一起编（Bun 交叉编译）
```

前置：Rust 工具链（[rustup](https://rustup.rs)）。Linux 上还需要
`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf`。

## 三条不能改的约定

1. **不再把工程路径传给 sidecar。** 恢复上次工程、打开/关闭文件夹全在 sidecar 里，
   与 `novelforge` 空窗口同一条路。

2. **退出时必须 kill sidecar。** Windows 上的孤儿进程会占着端口，还会占着
   `.novelforge/novelforge.db`（[db.ts](../../core/runtime/db.ts) 里记过这个 EBUSY 坑）。

3. **绝不开 `dangerousRemoteDomainIpcAccess`。** 导航到 `http://127.0.0.1:PORT` 之后
   页面属于远程内容，[capabilities/default.json](capabilities/default.json) 刻意没有
   `remote` 段，所以它拿不到任何 IPC 权限。现有前端只用 WebSocket、不碰 Tauri API，
   本来也不需要。

## 已知坑

- **WSL2 里跑 `npm run app:dev`**：WSLg 能显示窗口，但 WebKitGTK 常需要
  `WEBKIT_DISABLE_COMPOSITING_MODE=1 npm run app:dev`。
- **Windows 安装包不能在 Linux 上编**。sidecar 可以（Bun 交叉编译），Rust 壳不行——
  用 [.github/workflows/app.yml](../../../.github/workflows/app.yml) 的 windows runner，或在
  Windows 上原生构建。
- **Bun 的 `--windows-*` 开关只在 Windows 上编译时接受**，交叉编译会直接报错。
  build-sidecar.js 因此只在原生构建时加它们；少了也无妨，Tauri spawn sidecar 时本来
  就带 `CREATE_NO_WINDOW`。
- **体积**：sidecar 单文件 ~95 MB，NSIS 压缩后约 35~45 MB，AppImage 约 100 MB。
  Tauri 的小体积优势在纯壳方案里没有——这是换来"零 core 改动"的代价。
- **未签名**：Windows 首次运行会有 SmartScreen 警告。
- **启动多一跳**：spawn + 起服务约 0.5~1.5 秒，splash 页负责让这段时间不难看。

## 排查

sidecar 的全部 stdout / stderr 都落在 `<app_log_dir>/sidecar.log`（每次启动截断重来），
失败闪屏上的「查看日志」打开它所在的目录。起不来的时候那是第一站。导航进页面之后，
Help → 打开日志目录打开的是 `~/.novelforge/`（配置与 window.json）。

注意这与网页里那个「日志」页是两回事：那一页是 sidecar 内部的业务日志（还会进
SQLite），这个文件是**壳看到的进程输出**——服务压根没起来时，只有这里有线索。
