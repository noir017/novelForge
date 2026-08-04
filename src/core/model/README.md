# core/model — 数据层

小说工程的数据模型与全部文件读写。所有上层功能（上下文装配、生成、摘要）都通过这一层访问数据，不直接碰磁盘。

核心约定：**数据是工作区里的普通 Markdown / JSON**，作者随时可以在编辑器里手改。因此本层的一切解析都以「容错优先」——手改文件不该让插件崩掉。

## 文件

| 文件 | 职责 |
|---|---|
| [types.ts](types.ts) | 全部数据结构：`Chapter` / `ChapterSummary` / `CharacterCard` / `LoreEntry` / `NovelConfig`，以及摘要与角色卡的**固定小节**定义（`SUMMARY_SECTION_KEYS`、`CHARACTER_SECTION_KEYS`）。 |
| [markdown.ts](markdown.ts) | 轻量 Markdown 结构工具：YAML frontmatter 与「## 小节」的解析/序列化。刻意不引入 yaml 依赖，解析失败退化为忽略该行而非抛错。 |
| [project.ts](project.ts) | ★ `NovelProject`：数据访问层，所有 read*/write* 都在这里。含初始化模板、章节索引、摘要新鲜度（hash 比对）、`.novel` → `.novelforge` 迁移检测。另导出 `readConfig()` 读取 `novel.*` 设置。 |
| [providers.ts](providers.ts) | ★ 多服务商/多模型的数据模型。「前缀/模型名」引用只在**第一个**斜杠处切分（OpenRouter 的模型名本就含斜杠）；含 0.1.x 单服务商配置的兼容兜底。 |
| [session.ts](session.ts) | 对话会话存储：`.novelforge/sessions/<id>.json`。含 `Attachment`（@ 引用）、`ContextDigest`（上下文明细快照）的序列化。 |

## 关键设计

- **每次读盘，不缓存正文**：`read*` 方法每次调用都重新读文件（作者可能刚手改完），只有章节列表做一层缓存，由 FileSystemWatcher 主动失效。
- **摘要新鲜度**：章节保存后重算 `contentHash`，与摘要 frontmatter 里的 `sourceHash` 比对，不一致即过期。摘要不自动生成，只提示。
- **会话用 JSON 而不是 Markdown**：会话是机器记录（含 token 明细、附件快照），不期待人工编写，但仍是纯文本、可 Git。
- **选区引用存快照**：`Attachment.text` 对 selection 存当时的快照，历史对话不因原文修改而变；整文件引用每次读盘取最新。

## 依赖关系

本层是依赖的最底层，只依赖 Node API（`fs` / `path` / `crypto`）与 `vscode`（仅用于读配置与消息提示）。`context/`、`features/`、`llm/`、`ui/` 都依赖本层，反向不允许。
