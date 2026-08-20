# shells — 三个宿主壳

同一份 [core/](../core/README.md) 装在三个壳里：VS Code 插件、独立 Web 服务、桌面 app。
三个并排放在这里，不再一个在 `src/` 下、一个在仓库根上。

| 壳 | 是什么 | README |
|---|---|---|
| [vscode/](vscode/README.md) | VS Code 插件：命令、两个 webview 宿主、vscode-lm | [vscode/README.md](vscode/README.md) |
| [standalone/](standalone/README.md) | 独立 Web 服务（Bun）：HTTP/WS + 浏览器界面；工程可空、运行时热换 | [standalone/README.md](standalone/README.md) |
| [desktop/](desktop/README.md) | 桌面 app（Tauri / Rust）：把独立版当 sidecar 装进一个窗口 | [desktop/README.md](desktop/README.md) |
| [shared/](shared/panes.ts) | 两个以上壳共用的页面骨架（**所有 pane 的 DOM 唯一来源**） | 见下 |

## 壳的契约

壳只做三件事：

1. **实现 `Host`** —— 把 [core/host.ts](../core/host.ts) 的窄接口接到平台能力上（弹窗、进度、文件监听、打开文件）。
2. **传输与生命周期** —— 进程入口、消息通道、窗口/视图挂载、退出收尸。
3. **平台专属入口** —— 命令、菜单、CLI 参数、原生对话框。

壳**不做**这三件：

- **业务逻辑。** 一个动作要问什么、算什么、写什么，都在 core 里；壳只负责把它接到一个按钮或一条命令上。
  同一个流程绝不允许在两个壳里各写一遍——`initProjectFlow`（[core/actions.ts](../core/actions.ts)）
  同时服务插件命令、网页按钮与 CLI `init`，就是这一条的样板。
- **页面内容。** DOM 与文案属于前端，不属于宿主。被两个以上壳用到的结构必须放
  [shared/panes.ts](shared/panes.ts)；只有一个壳用到的可以留在那个壳里，但**仍然不许出现第二份**。
  壳负责的只是布局外壳（插件是 tabbar 直排，独立版是标题栏＋活动栏＋侧栏＋编辑器）与 head/CSP/资源 URL。
- **「我是哪个壳」的分支。** 差异一律表达成「宿主有没有这个能力」：`Host` 上的可选方法
  （`openInEditor` / `reviewReplace` / `openNativeSettings` …），或渲染期的选项
  （`settingsPane({ nativeSettings })`）。`Host.name` 只用于日志与诊断。
  为什么这条最要紧：按身份分支会腐烂。曾经 core 里有一句 `host.name === 'standalone'` 决定设置页
  那行存储说明该怎么写，后来两个壳都换成了 `FileConfigStore`，而插件形态那半边分支没人想起来改，
  于是插件的设置页在很长一段时间里都在说一句已经不成立的话（「设置写入工作区 settings.json」）。
  能力式表达没有这个失效模式：没有那个能力，那段界面根本不会被渲染出来。

`media/` 里的前端也遵守同一条：区分形态用能力探测（`#wbEditor` 存不存在、`maybeById` 取不到就跳过），
不判断环境字符串。

## 为什么共享的页面骨架在这里，而不在 media/

`media/` 是**浏览器**产物（esbuild `platform: browser`，自己一份 tsconfig 带 DOM lib）。
页面骨架是宿主在 Node / Bun 里拼出来的字符串，跑在服务端那一侧，所以它归壳这一层。
`shared/panes.ts` 因此是零 import 的纯字符串函数：不碰 `vscode`、不碰 `node:`、不碰 `bun:`
——这条由 [tests/contract/shellPurity.test.js](../../tests/contract/shellPurity.test.js) 守着。

## 依赖方向

```
core/  ←  shells/shared/  ←  shells/vscode/
                          ←  shells/standalone/  ←  shells/desktop/（当 sidecar 起它，不 import）
```

反向依赖不允许（core 不认识任何壳），**壳与壳之间也不许互相 import**——桌面壳复用独立版靠的是
「把它当子进程起起来」，不是代码耦合。同样由 `shellPurity.test.js` 守着。
