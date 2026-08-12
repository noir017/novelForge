# .vscode — 三个壳的启动方式

按 `F5` 能起的东西。三个壳（[插件](../src/shells/vscode/README.md) / [独立 Web 版](../src/shells/standalone/README.md) /
[桌面 App](../src/shells/desktop/README.md)）各有入口，这里把它们都摆成一条可点的配置，
省得每次回 README 抄命令。

## 有哪些

调试下拉框里按壳分组：

| 配置 | 起的是什么 | 断点 |
|---|---|---|
| **运行插件（示例小说工作区）** | Extension Development Host，自动打开 `sample-novel/` | ✅ TS 源码 |
| **运行插件（自选工程目录）** | 同上，但问你要打开哪个目录 | ✅ TS 源码 |
| **起独立 Web 版（示例小说工作区）** | `npm run standalone -- sample-novel --verbose` | ❌ 见下 |
| **起独立 Web 版（自选工程目录）** | 同上，目录来自输入框 | ❌ |
| **独立版 CLI：初始化工程（自选目录）** | `novelforge init`，终端问答 | ❌ |
| **跑单文件可执行（dist/novelforge）** | 先 `npm run dist`，再跑产物 | ❌ |
| **运行桌面 App（开发模式）** | `npm run app:dev`（Tauri，需 Rust 工具链） | ❌ Rust 那半边见下 |

任务（`Ctrl+Shift+B` 或命令面板「运行任务」）也按壳分：`watch` 是默认构建任务（插件壳用），
另有前端监听、内嵌资源、编译单文件、编 sidecar、出安装包，以及五档测试。

## 只有插件壳能打断点，另两个不能

这不是配置没写全，是三条不同的原因，写清楚免得下次有人来"修"：

- **独立版跑在 Bun 里，js-debug 挂不上。** VS Code 的 JS 调试器靠 `node:inspector`
  注入 bootloader，而 Bun 至今没实现它（[oven-sh/bun#2445](https://github.com/oven-sh/bun/issues/2445)）。
  Bun 自己有一套 WebKit inspector 协议，但那需要它自家的调试器扩展。所以这三条
  用的是 `node-terminal`：**它不假装能调试**，只是把命令跑在集成终端里，好处是输出里的
  文件路径可点、`--verbose` 的日志直接在眼前。要看服务内部发生了什么，走网页的「日志」页
  （比断点还全，它记得住每次模型调用与文件操作）。

- **单文件可执行是编译产物，本来就没有源码可停。** 这一条的用途不是调试，是验证
  **内嵌资源齐不齐**——`bun build --compile` 出来的东西没有外部资源可读，
  某个前端产物漏进 `embed-media.js` 的 `built` 数组时，只有跑它才会 404
  （`npm run standalone` 从磁盘读，看不出来）。

- **桌面壳的 Rust 那半边要 CodeLLDB，这里刻意没配。** `npm run app:dev` 由 Tauri CLI
  编译并启动 Rust 壳，想在 `src/main.rs` 上停就得让调试器去 attach 它编出来的
  可执行文件，那是另一条链路（`vadimcn.vscode-lldb` + 手写 `cargo` 构建配置）。
  而这层壳一共三百来行、只做"起 sidecar / 等就绪 / 导航 / 收尸"四件事，
  它的排查依据是 `<应用日志目录>/sidecar.log`（菜单「帮助 → 打开日志目录」）。
  真要 Rust 断点，装 CodeLLDB 后自己加一条 `lldb` 配置，别把它写进仓库当默认路径。
  窗口里那张**页面**是独立版，网页那半边照旧用浏览器开发者工具（Tauri 窗口右键 → 检查元素）。

## 几个容易踩的点

- **插件壳的 `${input:extensionRoot}` 必须给绝对路径。** 那个参数是交给 VS Code
  「打开文件夹」的，不经 [cli.ts](../src/shells/standalone/cli.ts) 的 `path.resolve`。
  独立版那两条的 `${input:projectDir}` 反过来——相对路径按仓库根解析，因为 `parseArgs`
  会 resolve。

- **独立版走 `npm run standalone` 而不是直接 `bun run src/shells/standalone/main.ts`。**
  npm 脚本里带了 `embed-media` 那一步；少了它 `mediaAssets.ts` 根本不存在，页面全 404。
  README 里那行裸 `bun run` 是给已经编过一次的人看的。

- **改了 `media/src/` 要重启独立版服务。** 资源是启动时从 `mediaAssets.ts` 读进内存的，
  热更新不了。改前端时用任务「前端：监听构建」+ 重启服务，或者干脆在插件壳里改
  （webview 刷新就行）。

- **`dist/` 整个不入库**，所以第一次 clone 下来直接按 F5 会缺东西：插件壳有
  `preLaunchTask` 兜着，单文件那条有 `preLaunchTask` 兜着，独立版靠 npm 脚本兜着。
  桌面壳靠 `tauri.conf.json` 的 `beforeDevCommand` 兜着。四条都不需要你先手动编。

- **这个目录已被 `.vscodeignore` 排除**，不会打进 `.vsix`。

## 推荐扩展

[extensions.json](extensions.json) 里只有三个，全是桌面壳需要的：`rust-analyzer`、
`CodeLLDB`（要 Rust 断点时才用得上）、`tauri-vscode`。只改 TS 的话一个都不用装。
