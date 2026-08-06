# core — 无 UI 依赖的核心逻辑

与宿主（VS Code / 未来的独立 Web 服务）无关的核心逻辑。子目录按职责分层：

| 目录 | 职责 |
|---|---|
| [model/](model/README.md) | 数据层：数据结构、Markdown 解析、`NovelProject` 全部文件读写、服务商配置模型、会话存储 |
| [context/](context/README.md) | ★ 上下文装配：token 粗估与分层预算装配器 |
| [features/](features/README.md) | 功能编排：续写、摘要、角色卡、文风提取 |
| [llm/](llm/README.md) | 模型接入：`LlmProvider` 接口、OpenAI / Anthropic 协议实现、provider 注册表 |

依赖方向自上而下：`features/` → `context/` / `llm/` → `model/`，反向不允许。

本目录根下另有几个不属于任何子目录的文件：

| 文件 | 职责 |
|---|---|
| [protocol.ts](protocol.ts) | 前端 ↔ 后端的消息协议（`InMessage` / `OutMessage` / `ViewState`）。插件 webview 与独立版网页共用，是前后端的唯一契约。 |
| [controller.ts](controller.ts) | ★ `ChatController`：全部面板逻辑。收 `InMessage` → 调度 `ContinueSession` / 会话存储 / 设置读写 → 广播 `OutMessage`。通过 `ViewHost` 接口与视图宿主解耦，支持多宿主同时挂接。 |
| [host.ts](host.ts) | core 对宿主的唯一依赖面（窄接口）：弹窗/选择/进度/文件监听/打开文件等，两个壳各实现一份。 |
| [actions.ts](actions.ts) | 工程级交互流程（初始化、新建章节），命令面板与网页共用。 |
| [fileOps.ts](fileOps.ts) | ★ 类文件操作：新建文件夹、重命名、移动、删除。三条硬约束——操作锁在所属区内（章节/角色/设定，`..` 与绝对路径一律拒绝）、目标已存在就报错不覆盖、删除是搬进 `.novelforge/.trash/` 而非真删。 |
| [attachments.ts](attachments.ts) | @ 引用的候选列表构建（展示与选择交给 Host.pick）。 |
| [config.ts](config.ts) | `readConfig` / `readGlobalBudget` / `updateSettings`，数据源由宿主注入的 `ConfigStore` 提供。 |
| [stores.ts](stores.ts) | 文件后端的配置/密钥存储（`~/.novelforge/`），双壳共用。 |
| [projectView.ts](projectView.ts) | 工程页的数据来源：把数据层给的扁平文件清单折成 `ProjectNode` 目录树（章节、角色、设定、摘要新鲜度），展开/折叠状态留在前端。 |

## 已知约定

- 本层**零 vscode 依赖**（双形态改造的前提）：弹窗/进度/文件监听等宿主能力全部经窄接口 `host.ts`。新代码不要增加对 `vscode` 的依赖，也不要依赖具体的视图/面板类型；完整改造背景见 `docs/design/plans` 的 standalone 改造计划。
- `readConfig` / `readGlobalBudget` 已移入 `config.ts`，数据源由宿主注入的 `ConfigStore` 提供；新增设置项时同时更新 `PersistedSettings` 与两处默认值。
- **层级是纯收纳**：章节顺序永远由文件名的数字前缀决定，与它在第几层子目录无关；分卷不重置编号。上下文装配、摘要新鲜度、@ 引用都不看目录结构。
