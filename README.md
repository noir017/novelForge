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
3. 点活动栏的 Novel Forge 图标 → 「设置」页点一个预设添加服务商 → 填 API Key → 点该模型的「测试」
4. 回到「对话」页，在下拉框里选模型，描述接下来要写什么

## 独立 Web 版（不装 VS Code 也能用）

同一套核心逻辑另有一个独立壳：在本机起一个 Web 服务，浏览器里操作，写作仍在你自己的编辑器里完成。

```bash
# 方式一：源码直接跑（需要 Bun）
bun run src/standalone/main.ts [目录]          # 默认当前目录、端口 3680、自动开浏览器
bun run src/standalone/main.ts sample-novel --no-open --port 4000
bun run src/standalone/main.ts init [目录]     # 终端交互式初始化

# 方式二：编译成单文件可执行
npm run dist                                   # 产出 dist/novelforge（当前平台）
./dist/novelforge sample-novel

# 方式三：npm 包
npm i -g novel-forge && novelforge [目录]
```

服务只绑定 `127.0.0.1`，无鉴权——设计上只服务本机作者。配置与 API Key 存在 `~/.novelforge/config.json` / `secrets.json`（不再用 VS Code 的 settings.json / SecretStorage；插件壳首次激活时会把旧配置一次性迁移过去）。

与插件版的差异：

| 能力 | 插件 | 独立版 |
|---|---|---|
| 加入选区 | 读编辑器选区 | 弹粘贴框 |
| 角色卡更新 | diff 编辑器对比 | 确认框（无 diff） |
| 打开文件 | VS Code 文档 | 系统默认程序 |
| vscode-lm（Copilot） | 支持 | 隐藏（无 Copilot 授权） |
| 弹窗（输入/确认/选择） | 原生对话框 | 网页 modal（WebSocket 往返） |

断线时页面顶部出现红色重连条，恢复后自动重放全量状态。

## 界面

活动栏里只有一个侧边栏视图，全部内容都在这个 webview 里，顶部 tabbar 切四页：

| 页签 | 内容 |
|---|---|
| **对话** | 聊天式续写。描述剧情 → 流式生成 → 就地编辑 → 采纳写入 |
| **工程** | 章节 / 角色 / 设定 / 文风与摘要，以及各自的操作入口 |
| **历史** | 本工程的所有会话，可打开、重命名、删除 |
| **设置** | 服务商与模型清单、API Key、上下文预算 |

侧边栏太窄时，点右上角 ⧉ 可以把同一个面板作为标签页在编辑器区打开——两边是同一个会话，内容实时同步。

### 工程页

四个可折叠分组，鼠标悬停在某一行上才显出该行的操作，平时保持干净：

- **章节** —— 倒序排列（最新的在上）。行首圆点表示摘要新鲜度：`●` 最新、`○` 缺失或过期。点标题打开正文，行上有「在此续写」「总结」「看摘要」。
- **角色** / **设定** —— 点开对应的 Markdown 文件；副标题显示标签别名与 keywords。
- **文风与摘要** —— 全书摘要（含覆盖到第几章）、文风指南、全书大纲，以及「重建」「从正文提取」「同步过期摘要」「提取/更新角色卡」。

有过期摘要时顶部会出现黄条，点「立即同步」批量补齐。工作区还不是小说工程时，这一页显示初始化入口。

### 对话怎么用

输入框里直接写要发生什么，Enter 发送、Shift+Enter 换行。下方一排控件：

- **模型** —— 在已配置的模型间切换，形如 `glm/glm-4-plus`。切换即时生效，预算按新模型的窗口重算。
- **模式** —— 「续写正文」产出成稿；「讨论/建议」用来问「这个人物立住了吗」这类问题，此时不强制只输出正文。
- **写入位置** —— 采纳时是追加到某章，还是新建下一章。
- **目标字数** —— 0 表示不限。

模型的回复可以直接点进去改，改完再点「采纳写入」。每条回复下面折叠着这次的上下文明细，点开就知道带了什么、丢了什么。

### 引用上下文（Cursor 式）

两种方式往当前这轮对话里塞内容：

- 点 **@ 引用**（或在输入框直接敲 `@`）——列出所有章节、角色卡、设定条目，也能浏览工作区任意文件。
- 在编辑器里选中一段文字，按 <kbd>Ctrl+Shift+L</kbd>（macOS 为 <kbd>Cmd+Shift+L</kbd>），或右键「将选中文本加入对话上下文」。

引用会以标签形式挂在输入框上方，发送前可以逐个移除。**选区存的是快照**——你选的时候是什么样，历史记录里就一直是什么样，之后改了原文也不会让过去的对话跟着变；整文件引用则每次都读最新的。

### 对话历史

发出第一条消息后自动保存到 `.novelforge/sessions/<id>.json`，跟着工程走，可以提交到 Git。空会话不落盘，历史列表里不会堆一排没说过话的占位。

## 目录结构

初始化后的工作区：

```
chapters/                    正文，NNN-标题.md，序号即顺序
├── 001-楔子.md
└── 002-客栈里的女人.md
.novelforge/
├── project.json             章节索引 + 摘要新鲜度（hash 比对）
├── style.md                 文风指南 —— 每次续写必注入
├── outline.md               全书大纲（人工维护，不自动注入）
├── characters/<名字>.md      角色卡
├── lore/<条目>.md            世界观设定
├── sessions/                对话历史，一次会话一个 .json
└── summaries/
    ├── 001.md               单章摘要
    └── global.md            全书滚动摘要
```

> 从 0.1.x 升级：元数据目录由 `.novel/` 改名为 `.novelforge/`。插件启动时检测到旧目录会问一次是否重命名，不会静默改动。

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
| **P0** | 系统提示、剧情纲要、**用户 @ 的引用**、上一章结尾原文、重写反馈 | 永远保留；引用超限时截断 |
| **P1** | **本会话历史对话**、文风指南、全书滚动摘要 | 整块丢弃并标注 |
| **P2** | 相关角色卡 | 降级为「身份+当前状态+未收伏笔」 |
| **P3** | 最近 N 章完整原文（默认 2 章） | 降级为该章摘要 → 丢弃 |
| **P4** | 更早章节的摘要、命中关键词的设定 | 由近及远填充，填满即止 |

预算 = `contextWindow - maxOutputTokens - 512`。

**引用为什么在 P0**：你特意点了它，就不该被自动装配挤掉。但单条封顶预算的 35%，超出从头部截断——@ 一个大文件不能把前文全挤没。

**历史对话怎么带**：作为真正的多轮消息发出（role 交替），不是塞进一段「以下是我们之前的对话」。整体封顶预算的 30%、单轮 12%，由近及远填充；单轮过长时取结尾，因为越靠后越接近当前进度。

**角色卡怎么选**：纲要里出现姓名/别名的 → 最近两章出场的（读摘要的「出场人物」）→ 标签含「主角」的。取并集去重。

**不静默截断**：任何被降级或丢弃的条目都会留在明细里，标明原因（「预算不足，需 800 token，剩 200」「该章尚无摘要」「历史对话预算已满」）。每条回复下方折叠展示，你随时知道这次没带上什么。

**去重**：如果上一章整章原文能完整放下，P0 那份结尾片段会自动撤掉，同一段文字不会在 prompt 里出现两次。

---

## 命令

| 命令 | 说明 |
|---|---|
| `Novel: 初始化小说工程` | 创建目录结构与模板 |
| `Novel: 打开续写对话` | 聚焦侧边栏对话面板 |
| `Novel: 在编辑器中打开对话面板` | 同一会话，开成编辑器标签页 |
| `Novel: 新建对话` | 存下当前会话并开一个新的 |
| `Novel: 将选中文本加入对话上下文` | <kbd>Ctrl+Shift+L</kbd> |
| `Novel: 打开设置页` | 切到设置页签 |
| `Novel: 打开工程页` | 切到工程页签 |
| `Novel: 选择模型` | 在已配置的模型间切换 |
| `Novel: 快速续写（不开面板）` | 输入纲要，结果流式写入新文档 |
| `Novel: 新建章节` | 自动分配序号 |
| `Novel: 总结本章` | 生成单章摘要（六个固定小节） |
| `Novel: 同步所有过期摘要` | 批量补齐，带进度条可取消 |
| `Novel: 重建全书摘要` | map-reduce：每 15 章一批 reduce，再合并 |
| `Novel: 提取/更新角色卡` | 新角色直接建，已有角色走 diff 确认 |
| `Novel: 提取文风指南` | 从 1~3 章样章归纳 |
| `Novel: 设置 / 清除 API Key` | 按服务商存 SecretStorage |

### 摘要过期机制

保存章节 → 重算内容 hash → 与摘要里记录的 `sourceHash` 比对 → 不一致就在工程页把该章标成 `○`。

摘要**不会自动重新生成**（避免后台偷偷烧 token），但对话面板顶部会提示「有 N 章摘要已过期」，一键同步。

### 角色卡不会被静默覆盖

`提取/更新角色卡` 对已存在的角色一律打开 diff 编辑器让你对比确认，而且你可以在右侧直接改完再点采纳。模型留空的小节保留原文，别名和标签取并集。

---

## 配置

设置页（侧边栏 → 设置）能改全部配置，也可以直接编辑 settings.json。API Key 只存 SecretStorage，不写进配置文件。

### 服务商与模型

可以同时配置多个服务商，每个服务商下挂多个模型。模型用 **`前缀/模型名`** 引用，前缀就是服务商的 id：

```jsonc
"novel.providers": [
  {
    "id": "glm",                                              // 引用前缀
    "label": "智谱 GLM",
    "kind": "openai",                                         // openai / anthropic / vscode-lm
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "models": [
      { "name": "glm-4-plus", "contextWindow": 128000 },
      { "name": "glm-4-air" }
    ]
  },
  {
    "id": "openrouter",
    "kind": "openai",
    "baseUrl": "https://openrouter.ai/api/v1",
    "models": [
      { "name": "z-ai/glm-4.6", "contextWindow": 200000 }     // 模型名自带斜杠
    ]
  }
],
"novel.model": "glm/glm-4-plus"
```

于是：

| 引用 | 含义 |
|---|---|
| `glm/glm-4-plus` | 智谱官方的 glm-4-plus |
| `openrouter/z-ai/glm-4.6` | OpenRouter 上的 GLM |
| `ollama/qwen2.5:14b` | 本地 Ollama |

**引用只在第一个斜杠处切分**，后面的都属于模型名——OpenRouter 的模型名本就是 `厂商/型号`，不这样切就没法引用。所以服务商前缀不能含斜杠，设置页会挡住。

同一个模型走不同渠道就是两条独立的引用，各有各的 baseUrl、各有各的 API Key，切换只要在输入框旁的下拉框里选一下（或用命令 `Novel: 选择模型`）。

**每个模型可以单独设窗口**。同一家的 32k 和 200k 模型常常并存，模型上填了 `contextWindow` 就以它为准，没填才用全局的 `novel.contextWindow`。装配器据此算预算，所以切模型时预算会跟着变。

设置页备了 9 个常用预设（OpenAI / DeepSeek / 智谱 / Kimi / 通义 / OpenRouter / Anthropic / 本地 Ollama / Copilot），点一下**添加一整个服务商**（含常用模型和窗口大小），不会覆盖已有的。每个模型行右边有「测试」，当场发一个最小请求验证——比写半章才发现 Key 填错强。

API Key 按服务商 id 分开存。本地 Ollama 随便填一个非空值即可；`vscode-lm`（Copilot）不需要 Key，但模型有硬性输入配额，装配器会自动按其 `maxInputTokens` 收紧预算，明细里会标注「已按模型配额压缩」。

### 其余设置项

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `novel.providers` | `[]` | 服务商与模型清单，见上 |
| `novel.model` | 第一个可用 | 当前模型引用，如 `glm/glm-4-plus` |
| `novel.contextWindow` | `128000` | 默认窗口，模型自带的优先 |
| `novel.maxOutputTokens` | `4096` | 默认输出上限，模型自带的优先 |
| `novel.temperature` | `0.8` | 摘要类任务内部固定用 0.3 |
| `novel.recentChaptersFullText` | `2` | 注入几章完整原文 |
| `novel.prevChapterTailChars` | `1500` | 上一章结尾片段字数 |
| `novel.summaryBatchSize` | `15` | 重建全书摘要的批大小 |
| `novel.requestTimeoutMs` | `300000` | |

> 从 0.1.x 升级：旧的 `novel.provider` / `novel.openai.*` / `novel.anthropic.*` / `novel.vscodeLm.family` 仍然生效——`novel.providers` 为空时会自动按它们生成一份服务商列表（前缀分别是 `openai` / `anthropic` / `copilot`），旧的 API Key 也会迁到新键上，不用重新输。在设置页保存一次即转为新结构。

---

## 开发

```bash
npm run watch        # esbuild 监听（插件 bundle）
npm run typecheck    # tsc --noEmit
node scripts/check-core-purity.js   # 断言 src/core 零 vscode 依赖
npm run smoke        # 离线冒烟 + bun 起的独立服务冒烟（不需要 API Key）
npm test             # typecheck + 纯度检查 + smoke
npm run standalone   # bun 起独立 Web 服务
npm run dist         # 编译独立版单文件可执行（dist/novelforge）
```

### 测试

`scripts/` 下的离线测试，都不需要真实 API Key：

- **`smoke.js`** —— markdown 解析、tokenizer、模型输出清洗、摘要/角色 JSON 解析的容错，以及示例工程的 hash 一致性
- **`smoke-providers.js`** —— 模型引用解析（含嵌套斜杠 `openrouter/z-ai/glm-4.6`）、服务商配置容错、按模型覆盖窗口、0.1.x 单服务商配置的兜底
- **`smoke-builder.js`** —— 用真实文件系统跑完整上下文装配：优先级、预算、降级链、手动排除、附件截断、多轮历史封顶、discuss 模式、provider 配额压缩；另含工程页快照
- **`smoke-llm.js`** —— 起本地假服务器模拟 SSE，验证流式解析（含跨块切分、CRLF、心跳、非 JSON 行）、取消、超时、HTTP 401/404/429 错误信息，以及 Anthropic 的 system 提取与消息合并
- **`smoke-session.js`** —— 会话读写 round-trip、损坏文件容错、列表排序、重命名/删除（移入 `.trash`）、id 唯一性，以及 `.novel` → `.novelforge` 的迁移
- **`smoke-server.js`** —— 用 bun 起独立服务，验证首页/静态资源 200、WebSocket 首条消息为 init/state（需 Bun）

### 代码结构

双形态架构：`src/core/` 零 vscode 依赖，插件壳与独立壳各实现一个 `Host` 窄接口。

```
src/
├── core/                  ★ 宿主无关核心（永不 import vscode）
│   ├── host.ts            Host 窄接口（弹窗/进度/监听/打开文件），双壳各实现一份
│   ├── controller.ts      ★ ChatController：面板逻辑，经 ViewHost 与视图解耦
│   ├── config.ts          readConfig/updateSettings，数据源由 ConfigStore 注入
│   ├── stores.ts          FileConfigStore/FileSecretStore（~/.novelforge/）
│   ├── actions.ts         初始化/新建章节等工程级流程
│   ├── attachments.ts     @ 引用候选列表构建
│   ├── protocol.ts        前后端消息协议（+ 独立版 prompt/promptResult）
│   ├── model/             types / markdown / providers / session / project
│   ├── llm/               provider / openai / anthropic / registry（vscode-lm 经工厂钩子）
│   ├── context/           tokenizer + 分层预算装配
│   └── features/          续写 / 摘要 / 角色 / 文风（交互全走 Host）
├── vscode/                插件壳
│   ├── extension.ts       命令注册、initHost(VsCodeHost)、迁移
│   ├── vscodeHost.ts      Host 的 VS Code 实现
│   ├── migrate.ts         settings.json/SecretStorage → ~/.novelforge 一次性迁移
│   ├── vscodeLmProvider.ts、chatViewProvider.ts、chatPanel.ts、webviewHtml.ts
└── standalone/            独立壳（Bun）
    ├── main.ts / cli.ts   入口与参数解析
    ├── server.ts          Bun.serve：静态页 + /ws WebSocket
    ├── fileHost.ts        Host 的文件/网页实现（弹窗经 PromptHub）
    ├── promptHub.ts       未决网页弹窗管理
    └── html.ts            内嵌资源直出的页面
```

面板逻辑集中在 `core/controller.ts`，两个视图宿主（侧边栏 / 编辑器）与独立版 WebSocket 各自只负责收发消息，因此同一个会话能在多处同时打开且保持同步。

界面不使用 VS Code 自带的 TreeView 等控件，全部由 webview 渲染：一套 UI 同时供侧边栏和编辑器标签页使用，工程页与对话页共享同一个 tabbar，不再上下分栏。`projectView.ts` 只产出一份可序列化快照，展开/折叠状态留在前端。

关于 tokenizer：没有引入 tiktoken（体积大、要 wasm，且各家分词器本就不同）。粗估只要保证不低估，加上 512 的安全余量就够用。

## License

MIT
