# AGENTS.md

Novel Forge 是一个 VS Code 插件，为长篇小说写作做 LLM 上下文管理：按 token 预算自动装配「文风指南 + 全书摘要 + 角色卡 + 近章原文」并透明展示、纲要扩写成稿（流式预览、采纳才落盘）、章节/全书摘要与角色卡整合。所有数据是工作区里的普通 Markdown（`.novelforge/` 目录），可 Git、可手改。

产品文档（面向作者的完整使用说明）见根目录 [README.md](README.md)。本文件面向代码代理：先读模块 README 再动手。

## 常用命令

shell 为 PowerShell（不支持 `&&`，用 `;` 分隔），均在仓库根目录执行：

```powershell
npm install              # 依赖
npm run compile          # esbuild 打包到 dist/extension.js（F5 调试前必须有）
npm run watch            # 监听构建
npm run typecheck        # tsc --noEmit，必须零错误
npm run smoke            # 五个离线冒烟测试，不需要 API Key
npm test                 # typecheck + smoke
```

改了 `src/core/**` 后必须跑 `npm run smoke`；改了任何 TS 都要过 `npm run typecheck`。手动验证 UI 时按 `F5` 启动 Extension Development Host（自动打开 `sample-novel/`）。

## 模块地图

改动前先读对应模块的 README：

| 模块 | 一句话职责 | README |
|---|---|---|
| `src/` | 三层架构总览与一条续写请求的完整链路 | [src/README.md](src/README.md) |
| `src/core/` | 核心逻辑层入口（含协议 protocol.ts、工程页快照 projectView.ts） | [src/core/README.md](src/core/README.md) |
| `src/core/model/` | 数据层：NovelProject、Markdown 解析、服务商配置、会话存储 | [src/core/model/README.md](src/core/model/README.md) |
| `src/core/context/` | ★ 分层预算上下文装配器 + token 粗估 | [src/core/context/README.md](src/core/context/README.md) |
| `src/core/features/` | 功能编排：续写、摘要、角色卡、文风提取 | [src/core/features/README.md](src/core/features/README.md) |
| `src/core/llm/` | LlmProvider 接口、OpenAI / Anthropic 实现、注册表与 API Key | [src/core/llm/README.md](src/core/llm/README.md) |
| `src/ui/` | 宿主无关的面板逻辑：ChatController + @ 引用 | [src/ui/README.md](src/ui/README.md) |
| `src/vscode/` | VS Code 宿主层：extension 入口、webview 宿主、vscode-lm | [src/vscode/README.md](src/vscode/README.md) |
| `media/` | webview 前端（原生 JS/CSS，无框架） | [media/README.md](media/README.md) |
| `scripts/` | 离线冒烟测试（也是理解核心行为的最佳入口） | [scripts/README.md](scripts/README.md) |
| `sample-novel/` | 示例工程 / 测试夹具，勿随手改正文（hash 断言会挂） | [sample-novel/README.md](sample-novel/README.md) |

其他关键位置：

- [package.json](package.json) —— 命令 / 菜单 / 快捷键 / 全部 `novel.*` 配置项的声明。
- [esbuild.js](esbuild.js) —— 构建脚本，入口 `src/vscode/extension.ts` → `dist/extension.js`。
- `docs/design/plans/` 与 `docs/design/specs/` —— 「双形态改造」（共享核心 + VS Code 壳 + Bun 独立 Web 服务壳）的实施计划与设计文档，涉及分层调整时先读。

## 架构要点

- **三层、单向依赖**：`core/`（数据与逻辑）→ `ui/`（面板逻辑，宿主无关）→ `vscode/`（宿主壳），反向依赖不允许。`core/` 的目标是零 vscode 依赖（双形态改造前提），新代码不要给 `core/` 增加 `vscode` import。
- **消息协议是前后端唯一契约**：[src/core/protocol.ts](src/core/protocol.ts) 的 `InMessage` / `OutMessage`。改协议要同时改 [media/view.js](media/view.js) 与 `src/ui/chatController.ts`。
- **一个 controller，多个宿主**：侧边栏与编辑器标签页挂同一个 `ChatController`，同一会话双开实时同步。
- **前端无状态**：webview 靠 `ViewState` 全量推送重建，展开/折叠等 UI 状态留在前端。

## 必须遵守的行为约束

这些是产品承诺，改动时不可破坏（对应测试在 `scripts/`）：

1. **容错优先**：作者会手改任何 Markdown；解析失败退化为忽略，绝不抛崩。
2. **不静默截断**：装配器降级/丢弃任何条目都必须留在明细里并附原因。
3. **不静默覆盖**：角色卡更新走 diff 确认；style.md 覆盖前先问；「采纳写入」前正文只存在会话里。
4. **不偷偷烧 token**：摘要不自动生成，只提示过期。
5. **模型引用只在第一个斜杠处切分**：`openrouter/z-ai/glm-4.6` 中服务商前缀是 `openrouter`。

## 提交约定

中文正文可以，前缀用 `feat/refactor/chore/docs`。不要提交 `dist/`（已被 gitignore）。
