# Novel Forge

为 VS Code 写的长篇小说上下文管理插件。解决一个具体问题：**小说越写越长，模型窗口装不下全文，续写时人物走形、伏笔丢失、文风漂移。**

它做三件事：

1. **上下文注入** —— 续写时按 token 预算自动装配「文风指南 + 全书摘要 + 相关角色卡 + 近章原文」，并把装了什么、没装什么明明白白列给你看。
2. **纲要扩写** —— 你只写几句剧情纲要，模型扩充成成稿，流式预览、可编辑、可重写，确认后才落盘。
3. **整合总结** —— 手动命令把已写章节压缩成单章摘要、滚动全书摘要和角色卡，让「记忆」始终有限且可人工校正。

所有数据都是工作区里的普通 Markdown，可以 Git 版本管理，可以直接用编辑器改，插件挂了数据也还在。

---

## 快速开始

```bash
git clone <this-repo> && cd novel-forge
npm install
npm run compile
```

在 VS Code 里打开本仓库，按 `F5` 启动 Extension Development Host（会自动打开 `sample-novel/` 示例工程）。

用在自己的小说上：

1. 打开一个空文件夹作为工作区
2. 命令面板 → `Novel: 初始化小说工程`
3. 命令面板 → `Novel: 设置 API Key`（存在 SecretStorage，不写进 settings.json）
4. 侧边栏点 ✨ 打开续写面板

## 目录结构

初始化后的工作区：

```
chapters/                    正文，NNN-标题.md，序号即顺序
├── 001-楔子.md
└── 002-客栈里的女人.md
.novel/
├── project.json             章节索引 + 摘要新鲜度（hash 比对）
├── style.md                 文风指南 —— 每次续写必注入
├── outline.md               全书大纲（人工维护，不自动注入）
├── characters/<名字>.md      角色卡
├── lore/<条目>.md            世界观设定
└── summaries/
    ├── 001.md               单章摘要
    └── global.md            全书滚动摘要
```

### 角色卡格式

```markdown
---
name: 林昭
aliases: [阿昭]        # 纲要里出现别名也能命中
tags: [主角]           # 标 "主角" 的角色始终注入
firstAppear: 1
lastSeen: 3
---

# 林昭

## 身份
## 外貌
## 性格
## 语言习惯      ← 对保持角色声音最关键
## 人物关系
## 当前状态      ← 预算不足时优先保留
## 未收伏笔      ← 预算不足时优先保留
```

小节名固定。预算紧张时角色卡会降级为只保留「身份 / 当前状态 / 未收伏笔」三节。

---

## 上下文是怎么装配的

这是插件的核心。每次续写按优先级分层填充预算：

| 层级 | 内容 | 预算不足时 |
|---|---|---|
| **P0** | 系统提示、剧情纲要、上一章结尾原文、重写反馈 | 永远保留 |
| **P1** | 文风指南、全书滚动摘要 | 整块丢弃并标注 |
| **P2** | 相关角色卡 | 降级为「身份+当前状态+未收伏笔」 |
| **P3** | 最近 N 章完整原文（默认 2 章） | 降级为该章摘要 → 丢弃 |
| **P4** | 更早章节的摘要、命中关键词的设定 | 由近及远填充，填满即止 |

预算 = `contextWindow - maxOutputTokens - 512`。

**角色卡怎么选**：纲要里出现姓名/别名的 → 最近两章出场的（读摘要的「出场人物」）→ 标签含「主角」的。取并集去重。

**不静默截断**：任何被降级或丢弃的条目都会留在明细里，标明原因（「预算不足，需 800 token，剩 200」「该章尚无摘要」）。面板上灰色划线显示，你随时知道这次没带上什么。

**去重**：如果上一章整章原文能完整放下，P0 那份结尾片段会自动撤掉，同一段文字不会在 prompt 里出现两次。

面板上每个条目都能取消勾选临时排除，改完立刻重算预算。

---

## 命令

| 命令 | 说明 |
|---|---|
| `Novel: 初始化小说工程` | 创建目录结构与模板 |
| `Novel: 打开续写面板` | 主界面 |
| `Novel: 快速续写（不开面板）` | 输入纲要，结果流式写入新文档 |
| `Novel: 新建章节` | 自动分配序号 |
| `Novel: 总结本章` | 生成单章摘要（六个固定小节） |
| `Novel: 同步所有过期摘要` | 批量补齐，带进度条可取消 |
| `Novel: 重建全书摘要` | map-reduce：每 15 章一批 reduce，再合并 |
| `Novel: 提取/更新角色卡` | 新角色直接建，已有角色走 diff 确认 |
| `Novel: 提取文风指南` | 从 1~3 章样章归纳 |
| `Novel: 设置 / 清除 API Key` | 存 SecretStorage |

### 摘要过期机制

保存章节 → 重算内容 hash → 与摘要里记录的 `sourceHash` 比对 → 不一致就在侧边栏标 ⚠。

摘要**不会自动重新生成**（避免后台偷偷烧 token），但续写面板顶部会提示「有 N 章摘要已过期」，一键同步。

### 角色卡不会被静默覆盖

`提取/更新角色卡` 对已存在的角色一律打开 diff 编辑器让你对比确认，而且你可以在右侧直接改完再点采纳。模型留空的小节保留原文，别名和标签取并集。

---

## 配置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `novel.provider` | `openai` | `openai` / `anthropic` / `vscode-lm` |
| `novel.openai.baseUrl` | `https://api.openai.com/v1` | 任何 OpenAI 兼容接口 |
| `novel.openai.model` | `gpt-4o` | |
| `novel.anthropic.model` | `claude-sonnet-4-5` | |
| `novel.vscodeLm.family` | `gpt-4o` | 复用 Copilot 订阅 |
| `novel.contextWindow` | `128000` | 用于算预算 |
| `novel.maxOutputTokens` | `4096` | |
| `novel.temperature` | `0.8` | 摘要类任务内部固定用 0.3 |
| `novel.recentChaptersFullText` | `2` | 注入几章完整原文 |
| `novel.prevChapterTailChars` | `1500` | 上一章结尾片段字数 |
| `novel.summaryBatchSize` | `15` | 重建全书摘要的批大小 |
| `novel.requestTimeoutMs` | `300000` | |

### 接其他服务商

只要是 OpenAI 兼容接口，改 `baseUrl` + `model` 即可：

- DeepSeek：`https://api.deepseek.com/v1` + `deepseek-chat`
- Kimi：`https://api.moonshot.cn/v1` + `moonshot-v1-128k`
- 通义：`https://dashscope.aliyuncs.com/compatible-mode/v1` + `qwen-max`
- 本地 Ollama：`http://localhost:11434/v1` + 你的模型名（API Key 随便填）

用 `vscode-lm`（Copilot）时无需 API Key，但模型有硬性输入配额，装配器会自动按其 `maxInputTokens` 收紧预算，面板上会标注「已按模型配额压缩」。

---

## 开发

```bash
npm run watch       # esbuild 监听
npm run typecheck   # tsc --noEmit
npm run smoke       # 离线冒烟测试（不需要 API Key）
npm test            # typecheck + smoke
```

### 测试

`scripts/` 下三个离线测试，都不需要真实 API Key：

- **`smoke.js`** —— markdown 解析、tokenizer、模型输出清洗、摘要/角色 JSON 解析的容错，以及示例工程的 hash 一致性
- **`smoke-builder.js`** —— 用真实文件系统的 vscode 桩跑完整上下文装配：优先级、预算、降级链、手动排除、provider 配额压缩、无前文/追加等场景
- **`smoke-llm.js`** —— 起本地假服务器模拟 SSE，验证流式解析（含跨块切分、CRLF、心跳、非 JSON 行）、取消、超时、HTTP 401/404/429 错误信息，以及 Anthropic 的 system 提取与消息合并

### 代码结构

```
src/
├── extension.ts           命令注册、FileSystemWatcher
├── model/
│   ├── types.ts           数据结构与固定小节定义
│   ├── markdown.ts        frontmatter + 小节解析（容错优先，手改文件不该让插件崩）
│   └── project.ts         NovelProject：所有文件读写
├── llm/
│   ├── provider.ts        LlmProvider 接口、SSE 解析、取消/超时
│   ├── openaiProvider.ts  OpenAI 兼容
│   ├── anthropicProvider.ts
│   ├── vscodeLmProvider.ts
│   └── registry.ts        provider 选择 + SecretStorage
├── context/
│   ├── tokenizer.ts       粗估：中文 1.5x，拉丁 /4
│   └── builder.ts         ★ 分层预算装配
├── features/
│   ├── continueWriting.ts 续写编排 + 输出清洗
│   ├── summarize.ts       单章 / map-reduce 全书摘要
│   ├── characters.ts      角色抽取 + diff 合并
│   └── style.ts           文风提取
└── ui/
    ├── treeProvider.ts    侧边栏
    └── continuePanel.ts   Webview
```

关于 tokenizer：没有引入 tiktoken（体积大、要 wasm，且各家分词器本就不同）。粗估只要保证不低估，加上 512 的安全余量就够用。

## License

MIT
