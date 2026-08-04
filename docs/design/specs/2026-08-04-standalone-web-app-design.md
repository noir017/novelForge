# Novel Forge 独立 Web 程序设计

日期：2026-08-04
状态：已评审通过

## 背景与目标

Novel Forge 当前是 VS Code 插件，但核心能力（章节数据层、上下文预算构建、LLM 续写/总结/角色提取、对话会话管理）并不真正依赖 VS Code。本设计把它改造为**双形态共存**：

1. 保留 VS Code 插件形态（现有用户不丢失）；
2. 新增独立程序形态：Bun 打包、启动本地 Web 服务、浏览器里操作，类似 opencode 的使用方式。

两个形态共用同一套核心代码。

## 已确认的关键决策

| 决策点 | 结论 |
| --- | --- |
| 插件去留 | 双形态共存：共享 core，插件与独立程序两个壳 |
| 工程模型 | 单工程目录启动（`novelforge [dir]`，一个目录 = 一部小说） |
| 配置与密钥 | 存用户主目录 `~/.novelforge/`，不进工程目录 |
| 分发渠道 | 单可执行文件（bun compile）+ npm/bun 包，两者兼顾 |
| 章节编辑 | 独立版不含编辑器，纯对话形态；正文仍在用户自己的编辑器里改 |
| 网络范围 | 仅本机（127.0.0.1），自动开浏览器，无认证 |
| 改造路线 | 方案 A：单仓库分层，core + 两个宿主壳，通过 Host 接口隔离宿主能力 |

## 总体架构

三层结构，仍在现仓库：

```
src/
  core/                    # 零 vscode 依赖，纯 TypeScript
    model/                 # project / session / providers / types / markdown（Uri → path）
    context/               # builder / tokenizer
    features/              # continueWriting / summarize / characters / style
    llm/                   # provider 接口 + openai / anthropic 实现 + registry
    controller.ts          # 现 chatController 的消息语义处理，宿主无关
    protocol.ts            # InMessage / OutMessage 协议（renderHtml 移走）
    host.ts                # Host 接口定义
  vscode/                  # 插件壳
    extension.ts           # 命令注册，调 core 能力
    vscodeHost.ts          # Host 的 VS Code 实现（含 vscode-lm provider 注册）
    chatViewProvider.ts
    chatPanel.ts
  standalone/              # 独立壳
    cli.ts                 # 入口：解析参数、启动服务、开浏览器
    server.ts              # Bun.serve：HTTP 静态托管 + WebSocket
    fileHost.ts            # Host 的文件实现（~/.novelforge/）
    html.ts                # Web 版 renderHtml
media/                     # view.css / view.js 原样复用，新增 bridge.js
```

约束：`src/core/` 内不允许出现 `import 'vscode'`，由独立的 tsconfig（不含 `@types/vscode`）硬校验。

### 职责切分原则

现 `src/ui/chatController.ts` 混了两类逻辑，按此切开：

- **消息语义**（send / retry / accept / stop / session 管理 / 设置保存 / 状态推送）→ `core/controller.ts`，只依赖 `Host`；
- **宿主交互**（`vscode.commands.executeCommand` 分发、`showInputBox` 提问、打开编辑器 tab）→ 经 `Host` 回调由各壳实现。

## Host 接口

core 对宿主的唯一依赖面：

```ts
interface Host {
  config: ConfigStore;        // 读/写 novel.* 配置
  secrets: SecretStore;       // API Key get/set/delete/has
  input(opts): Promise<string | undefined>;                  // 替代 showInputBox
  confirm(message, actions): Promise<string | undefined>;    // 替代带按钮的 showInformationMessage
  pick(items, title): Promise<T | undefined>;                // 替代 showQuickPick
  progress<T>(title, fn: (signal: AbortSignal) => Promise<T>): Promise<T>; // 替代 withProgress + CancellationToken
  watch(dir, patterns, onChange): Disposable;                // 替代 FileSystemWatcher
  openFile(relPath): Promise<void>;
  toast(message, level): void;
}
```

要点：

- core 内取消 token 统一改为 `AbortSignal`；插件壳在 `progress` 实现里把 `CancellationToken` 桥接为 `AbortSignal`。
- `vscode-lm` provider 只在插件壳注册。配置中 kind 为 `vscode-lm` 的服务商在独立版设置页显示为「仅 VS Code 可用」，不可选、不可发起请求。
- 文件路径在 core 内统一用字符串相对路径 + `path` 模块，`vscode.Uri` 只出现在插件壳。

### 两个实现

**`vscodeHost.ts`**：VS Code API 的薄封装。`input/confirm/pick` 直接映射 `showInputBox` / `showInformationMessage` / `showQuickPick`；`openFile` 打开编辑器 tab；config 桥接到 `~/.novelforge/config.json`（迁移后不再读写 settings.json）。

**`fileHost.ts`**：

- config：`~/.novelforge/config.json`，形状沿用 `SettingsPayload`（providers / model / contextWindow / maxOutputTokens / temperature / recentChaptersFullText / prevChapterTailChars / summaryBatchSize / requestTimeoutMs）。
- secrets：`~/.novelforge/secrets.json`，权限 600（Windows 仅当前用户可读），文件头注释提醒勿提交。
- `input / confirm / pick`：经 WebSocket 下发 `prompt` 消息，网页弹 modal（复用现有 `providerModal` 的样式），用户提交后以新增的 `promptResult` InMessage 回传。典型场景：初始化输入作品名、缺 API Key 录入、总结选章。
- `watch`：轻量文件监听（轮询或等价机制），监听 `chapters/**/*.md`、`.novelforge/**/*.md`、`.novelforge/project.json`，语义与现有 250ms 合并防抖一致。
- `openFile`：降级为 toast 显示相对路径。

## 独立程序运行时

### CLI

```
novelforge [dir]        # 在 dir（默认当前目录）启动服务；目录无 .novelforge/ 时提示是否初始化
novelforge init [dir]   # 交互式初始化小说工程（复用 core 的 initialize 逻辑）
  --port <n>            # 端口，默认自动选空闲端口
  --no-open             # 不自动开浏览器
```

### 服务（server.ts，Bun.serve）

- `GET /`：渲染 HTML（`html.ts`，复用 protocol 里的页面骨架；CSP 换成普通 Web 策略：同源 + nonce）。
- `GET /media/*`：静态托管 `view.css` / `view.js` / `bridge.js` / `icon.svg`。
- `WS /ws`：收到的 JSON 按 `InMessage` 分发给 core controller；controller 的 `OutMessage` 原样广播。单用户本机场景不做多会话隔离；多个 WS 连接共享同一 controller 实例（多开标签页内容同步）。
- Ctrl+C 退出；`SIGINT` 时把进行中的会话落盘。

### 前端桥接（media/bridge.js，新增的唯一前端文件）

- 检测运行环境：存在 `acquireVsCodeApi` 则用之（插件壳），否则建立 `WebSocket('/ws')`。
- 对外暴露与 webview 相同的形状：`postMessage(msg)` 与 `message` 事件。`view.js` 主体不改，仅有两处小适配：「加入选区」在非 VS Code 环境改弹粘贴 modal；WS 断线重连条由 bridge.js 注入 DOM 并驱动重连。
- WS 断线时页面顶部显示重连条；重连成功后重新发 `ready` 拉全量状态（现有 `init` 消息天然支持）。

### 协议增量

在现有 `InMessage` / `OutMessage` 上新增：

- `OutMessage`：`{ type: 'prompt'; promptId; kind: 'input' | 'confirm' | 'pick'; title?; message?; options?; placeholder?; password? }`
- `InMessage`：`{ type: 'promptResult'; promptId; value?: string; cancelled: boolean }`
- 插件壳不消费这两条消息（弹窗直接走 VS Code 原生 UI）。

### 功能降级与适配（独立版）

| 插件能力 | 独立版行为 |
| --- | --- |
| 「加入选区」 | 打开粘贴文本 modal，粘贴内容作为 text 类型附件加入（复用现有 attachments 机制，core 不改） |
| `openFile` | toast 显示相对路径；外部编辑器改动由文件监听自动感知刷新 |
| `vscode-lm` 服务商 | 设置页显示「仅 VS Code 可用」，不可选 |
| 「在 VS Code 设置中打开」按钮 | 隐藏（设置已统一在 `~/.novelforge/config.json`） |

## 配置与密钥迁移

一次性、有提示：

- 插件壳新版首次启动：读当前 VS Code `settings.json` 的 `novel.*` 与 SecretStorage 里的 Key → 写入 `~/.novelforge/config.json` / `secrets.json` → 提示「已迁移，VS Code 设置中的旧项不再使用」。
- 旧配置项在 `package.json` 标记 deprecated，保留一个版本周期的读取兜底（`~/.novelforge/config.json` 不存在时才回落读 settings.json）。
- 迁移后两个壳读写同一份 `~/.novelforge/config.json`，不再需要「工作区 vs 全局」的 ConfigurationTarget 逻辑。
- 工程内 `.novelforge/project.json` 清单不动——作品数据随工程走。
- API Key 旧键迁移沿用 registry 里现有的 legacy key 逻辑，只是存储后端从 SecretStorage 换为 `secrets.json`。

## 构建与发布

- **插件壳**：维持现有 esbuild 流程，入口改为 `src/vscode/extension.ts` → `dist/extension.js`，`vsce package` 不受影响。
- **独立壳**：`bun build src/standalone/cli.ts --compile` 产出单文件可执行（`novelforge.exe` / `novelforge`）；`media/` 资源通过 bun compile 的 asset 机制内嵌，分发即单文件。
- **npm 包**：同一 bun 构建产物 + `bin: { "novelforge": ... }`；`bun install -g novel-forge-cli` 或 `bunx novel-forge-cli` 可用。
- README 给出两条安装路：GitHub Release 下载可执行文件（推荐）与 bun 安装。
- CI 发布流水线不在本次范围；先保证本地 `npm run build:standalone` 可复现两条产物。

## 测试

- **类型校验**：tsconfig 拆两份——core + standalone 一份（不含 `@types/vscode`，硬校验零 vscode 依赖），插件壳一份。
- **smoke**：现有 5 个 smoke 脚本改为引用 core 构建产物继续跑（主要覆盖 model / llm / builder / session）。
- **新增 `smoke-server.js`**：起服务 → fetch `/` 断言 HTML → WS 连接断言收到 `init` 消息 → 发一条 `saveSettings` 断言回执。
- **手工验收**：`novelforge sample-novel` 后在浏览器里走一遍对话 / 工程 / 历史 / 设置页。

## 范围外（明确不做）

- 独立版内置章节/文件编辑器（首版纯对话）。
- 多工程枢纽 / 工程管理首页。
- 局域网访问与认证。
- CI 自动发布流水线。
- 终端 TUI（opencode 的 TUI 形态不在本次范围）。
