# core — 无 UI 依赖的核心逻辑

与宿主（VS Code 插件 / 独立 Web 服务 / 桌面壳）无关的核心逻辑。子目录按职责分层：

| 目录 | 职责 |
|---|---|
| [model/](model/README.md) | 数据层：数据结构、Markdown 解析、`NovelProject` 的领域查询、服务商配置、会话存储；写盘全在 `workspace/`。 |
| [workspace/](workspace/README.md) | ★ **工程的唯一读写网关**（`list` / `read` / `write` / `edit` / `move` / `remove` / `search`）；新代码不许绕过 `guard.ts` 直接写盘。 |
| [context/](context/README.md) | ★ 上下文装配：token 粗估与分层预算装配器 |
| [generation/](generation/README.md) | ★ 创作的一次单步：`generate.ts` 无状态地装配 → 调模型 → `Draft`，`accept.ts` 落盘分派，`drafts.ts` 让没落盘的产物活过刷新。 |
| [tools/](tools/README.md) | ★ **工具层**：契约、schema 校验、注册表与 `novel/` 的工具；没有删除 / 改名 / 移动。 |
| [mcp/](mcp/README.md) | ★ **把工具端给外部 agent**：MCP 协议与 Streamable HTTP，执行端在 `controller/mcp.ts`；本项目不自带循环。 |
| [features/](features/README.md) | 功能编排：批量流水线、定稿、叙事线、预检、全文大纲、角色卡、设定名录、文风、拆书。 |
| [skills/](skills/README.md) | 写作技能：三个来源、从 GitHub 先检查再安装、阶段绑定（`.novelforge/skills.json`）。 |
| [llm/](llm/README.md) | 模型接入：`LlmProvider` 接口、OpenAI / Anthropic 协议实现、provider 注册表 |
| [files/](files/) | ★ 工程文件能力的交互流程（三区界限、输入框、提示文案、目录列举与 `@` 候选），落盘一律转调 `workspace/`。 |
| [views/](views/README.md) | ★ 只读聚合与界面快照，只从磁盘取数、不写盘；`model/pipeline.ts` 是纯状态机，不迁入 `views/`。 |
| [runtime/](runtime/README.md) | ★ 运行时设施：日志、SQLite 痕迹库、失败记录、长任务、有界并发；`logger.ts` 零依赖，依赖方向不可反转。 |

依赖方向自上而下：`features/` / `generation/` → `context/` / `llm/` → `skills/` → `workspace/` → `model/`，反向不允许（`skills/` 只 `import type` 网关，写绑定时由调用方把 `Workspace` 交进来）。`tools/` 坐在最上面（它调 `generation/`、`workspace/` 与 `features/`），**不认识 `controller/`**——反过来会成环。

`mcp/` 只认 `tools/` 的契约（`ToolSpec`、`NOVEL_TOOLS`），tools 一行都不 import `mcp/` 与 `controller/`。绑在一起的是 `controller/mcp.ts`——它给工具绑好当前工程，占生成锁、在对话页挂 MCP 气泡、问那两句（`always` 动手前、产物落盘前）。这条边由 [tests/contract/layerBoundary.test.js](../../tests/contract/layerBoundary.test.js) 守着。

本目录根下只保留入口胶水与跨子目录契约：

| 文件 | 职责 |
|---|---|
| [protocol/](protocol/index.ts) | 前端 ↔ 后端的消息协议（`InMessage` / `OutMessage` / `ViewState`），前后端的唯一契约。 |
| [controller/](controller/index.ts) | ★ `ChatController`：全部面板逻辑，按消息域拆在同目录模块里；并发锁与动手前那一问都在这一层。 |
| [host.ts](host.ts) | core 对宿主的唯一依赖面（窄接口）：弹窗/选择/进度/文件监听/打开文件等，两个壳各实现一份。 |
| [actions.ts](actions.ts) | 工程级交互流程（初始化、新建一章、粘进现成的一章、新建一本书），命令面板与网页共用。 |
| [config.ts](config.ts) | `readConfig` / `readBudgetFallback` / `updateSettings`，数据源由宿主注入的 `ConfigStore` 提供。 |
| [stores.ts](stores.ts) | 文件后端的配置/密钥存储（`~/.novelforge/`），双壳共用。环境变量 `NOVELFORGE_HOME` 能把它挪走：Android 壳的家目录是放书的公共目录，密钥指回 app 私有目录。 |

## 已知约定

- 本层**零 vscode 依赖**（双形态改造的前提）：弹窗/进度/文件监听等宿主能力全部经窄接口 `host.ts`。新代码不要增加对 `vscode` 的依赖，也不要依赖具体的视图/面板类型；完整改造背景见 `docs/design/plans` 的 standalone 改造计划。
- **长任务一律走 `runTask`，不要直接调 `getHost().progress`**：直调只有宿主自己的 UI 看得见（VS Code 的通知条 / 独立版什么都没有），网页上那条进度条与计时不会动，日志里也不会留下开始/结束与耗时。`runTask` 把这三件事一次做完，`report({ message, current, total })` 给了 `total` 前端才画得出进度条。并发跑时 `current` **只在一项真正结束时 +1**（`runPool` 的 `onSettled` 会把已完成数递给你），按启动数递增会让进度条冲到头然后干等。
- **日志三条硬约束**（对应 `runtime/logger.ts` 的实现）：① 所有文本过 `redact`，API Key 绝不落进日志——它会被用户复制进 issue；② sink 抛异常只被吞掉，日志坏了不能带崩正事；③ 只记条数与字数，**绝不记 prompt / 正文全文**——一次正文生成的 prompt 有十万字，进了缓冲会把此前所有日志挤没（见 `features/creation.ts` 的 `logAssembly`）。
- **降级与丢弃必须同时进日志**：「不静默截断」这条产品承诺过去只落在界面的上下文明细里，折叠着不点开就看不见。现在装配器的降级项、定稿与同步细纲跳过的章、超预算被截断的正文都会打一条 `warn`。新加截断逻辑时记得跟上。
- **失败还要留在出错的东西身上，不只是日志**：日志与 toast 都要求用户「恰好在看」。角色卡/章/设定失败时经 `runtime/errorLog.ts` 记一条（`severity: 'error'` = 目标一字未改，`'warn'` = 部分完成、下次重来），工程页那一行就挂上感叹号，一直挂到成功。**成功路径必须 `clearFailures`**——修好了还挂着比一开始不报错更糟，用户会学会无视它。`targetKey` 一律用 relPath（名字会被作者改，路径才是当下的身份，而且前端的树本来就按 relPath 索引）。
- **库不可用不是错误路径**：`runtime/db.ts` / `runtime/errorLog.ts` 的每个 API 都自己吞异常并降级为「没有库」。纯读取的调用方（`listActiveFailures`、`clearFailures`、`readLogHistory`）必须带 `{ create: false }`——否则光是打开工程页就会在作者的 `.novelforge/` 里凭空生出一个 db 文件。写日志失败**绝不能再打日志**（会递归刷屏），只往 stderr 说一次然后彻底静默。
- `readConfig` / `readBudgetFallback` 位于 `config.ts`，数据源由宿主注入的 `ConfigStore` 提供。模型预算在模型条目上配置；`readBudgetFallback` 只为未填写的模型与旧版全局值兜底，不是设置页配置项。
- **一条轴：细纲号 = 章号**：章节顺序永远由文件名的数字前缀决定，与它在第几层子目录无关；分卷目录只是收纳，不重置编号。细纲**镜像正文在章节根下的相对路径**，扩展名换成 `.md`（`chapters/第一卷/003-深处.txt` ↔ `.novelforge/summaries/第一卷/003-深处.md`，与草稿同一套镜像）：`summaries/` 递归扫描，各级子目录里数字开头的 `.md` 都是细纲（`global.md` 是全文大纲，老工程的 `plots/` 判 `other`、不读）。有正文的章**按路径**认它的细纲（`NovelProject.plotFor` / `plotOfChapter`），还没有正文的计划按文件名的章号认，正文照它的路径反推着落（`chapterPathForPlot`）。章节在工具里改名/移动时细纲跟着搬（`workspace/handlers/chapter.ts` 的 `carryPlot`）；在外面改了正文的名，旧细纲不冒认。定稿照正文反向更新**同一份**细纲，不另存一份。上下文装配的正文只取 `chapters/`，定稿过没有、定稿之后正文改没改（细纲的 `sourceHash` 对正文的 hash）一律按 `chapters/` 算。工程页每层内**正序**展示（第 1 章在上，与文件名顺序一致）。
- **细纲正文不进 `ProjectTree`**：那棵树每次文件变动都全量重推（`pushState` → `buildProjectTree`），一本两百章的书每章带上千字细纲，等于每保存一次正文就推几百 KB。悬停浮窗要的细纲走单独的 `requestSummary` / `summary` 一问一答（`buildPlotSummaryView`），前端按行路径缓存、收到新树即作废。往树上加字段前先想想它会不会把这条推送撑爆。（`failures` 是有意的例外：一条几十字，**且只有出错的目标才有**，正常工程是空对象。）
- **草稿不是可管理区**：`drafts/` 不在 `files/fileOps.ts` 的三个区里（工程页上也没有它的节点），但它是**可打开的**——`files/fileEditing.ts` 只看工程根包含 + 扩展名/章节规则 + 大小，草稿天然满足。草稿路径由 `NovelProject.draftRelPathFor` 从章节路径推导，别在别处另拼一份。
- **草稿永不自动注入**：`context/builder.ts` 里没有任何一处读 `drafts/`，草稿只能经 `resolveAttachment`（作者显式 `@` 引用）进 prompt。加功能时别打破这条——它是「不偷偷烧 token」的一部分。
- **`openDraft` 会写盘**：`controller/files.ts` 里那句 `listChapters().find(...)` 是它没变成「往 `drafts/<任意路径>` 写文件」的原语的唯一原因。别为了省一次扫描就信任前端传来的路径。
- **定稿过的细纲是出场人物的唯一真相**：角色卡 frontmatter 里的 `appearsIn` / `updatedThrough` **只是缓存**。想知道谁在哪出场，一律经 `views/cast.ts` 的 `buildCastIndex()` 从定稿过的细纲重算，别读角色卡的字段——重新定稿之后那里就旧了。只认有 `sourceHash` 的细纲：没定稿的那份「出场人物」是计划出场，只给装配器挑角色卡用，混进来会污染统计。索引按 `name ∪ aliases` 匹配（细纲里的名字是模型写的，角色卡文件名是作者起的，两者没有硬关联）。
- **别名只收专属称呼，正式名压过别名**：aliases 是「谁是谁」的判据（`views/cast.ts` / `model/identity.ts` 都吃它），泛称会把几个角色串成一个，别人的名字会让出场章整批记错人。所以模型产出的别名一律经 `model/naming.ts` 过滤，索引两趟建表（先占正式名再登记别名）。抢名的情况记进 `CastIndex.conflicts`，由工程页与日志说出来——出场统计必然有一张卡是错的，而这件事从界面上看不出来。
- **判定两个称呼是同一个人，只信同章共现**：`model/identity.ts` 里同一章 cast 中各自出场的两个称呼是硬约束，永不合并；别的都只是证据。把两个角色错并成一个远比多建一张卡难收拾——此后所有出场统计与角色卡语料都是错的，而界面上一切正常。
- **`characterAction` 与 `fileAction` 不能合并**：前者的作用对象是**一个角色**（用名字标识），未建卡的人物根本没有文件，走 `fileAction` 那套区守卫无从谈起。
- **资源管理器只列不改，写走 projectFiles**：`files/fileTree.ts` 是纯读取，没有新建/删除/改名。「文件」页的写入口只有 `files/projectFiles.ts`（重命名/移动/复制，工程根范围，固定目录受保护，同名不覆盖；移动与复制都经网关的 `move` / `copy`——复制不进回收站、会话目录、历史版本，会话与工程库复制不出来，回收站与历史版本里的复制得出来）；删除入口仍然只在工程页（`files/fileOps.ts`，搬进 `.trash/`）。往文件页加新写操作前，先想清楚它绕过了这里的哪一条约束。
- **`watchedDirs` 是前端说了算的**：controller 记住前端最近一次 `listDir` 报上来的展开集合，`pushTabData` 时照着重推。它只是「该关注哪些目录」的缓存，不是权限——每次列举仍然过 `resolveInRoot`，越界照拒。
