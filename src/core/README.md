# core — 无 UI 依赖的核心逻辑

与宿主（VS Code / 未来的独立 Web 服务）无关的核心逻辑。子目录按职责分层：

| 目录 | 职责 |
|---|---|
| [model/](model/README.md) | 数据层：数据结构、Markdown 解析、`NovelProject` 全部文件读写、服务商配置模型、会话存储 |
| [context/](context/README.md) | ★ 上下文装配：token 粗估与分层预算装配器 |
| [features/](features/README.md) | 功能编排：续写、摘要、角色卡、文风提取 |
| [llm/](llm/README.md) | 模型接入：`LlmProvider` 接口、OpenAI / Anthropic 协议实现、provider 注册表 |

依赖方向自上而下：`features/` → `context/` / `llm/` → `model/`，反向不允许。

本目录根下另有两个不属于任何子目录的文件：

| 文件 | 职责 |
|---|---|
| [protocol.ts](protocol.ts) | Webview ↔ 扩展的消息协议（`InMessage` / `OutMessage` / `ViewState`）。两个宿主（侧边栏 / 编辑器面板）共用，是前后端的唯一契约。 |
| [projectView.ts](projectView.ts) | 工程页的数据来源：产出一份可序列化的 `ProjectTree` 快照（章节、角色、设定、摘要新鲜度），展开/折叠状态留在前端。 |

## 已知约定

- 目标是本层**零 vscode 依赖**（双形态改造的前提）。目前仍有少量残留：只读 API（读配置、CancellationToken）与 features 里的 QuickPick / diff 编辑器交互，正按计划逐步移入宿主层或窄接口，见 `docs/design/plans` 的 standalone 改造计划。新代码不要再增加对 `vscode` 的依赖，也不要依赖具体的视图/面板类型。
- `project.ts` 中有一个进行中的拆分 TODO：`readConfig` / `readGlobalBudget` 计划移入独立的 `config.ts`，改动时注意不要新增对现状的依赖。
