# core — 无 UI 依赖的核心逻辑

与宿主（VS Code / 未来的独立 Web 服务）无关的核心逻辑。子目录按职责分层：

| 目录 | 职责 |
|---|---|
| [model/](model/README.md) | 数据层：数据结构、Markdown 解析、`NovelProject` 全部文件读写、服务商配置模型、会话存储 |
| [context/](context/README.md) | ★ 上下文装配：token 粗估与分层预算装配器 |
| [features/](features/README.md) | 功能编排：续写、摘要、角色卡、设定、文风提取 |
| [llm/](llm/README.md) | 模型接入：`LlmProvider` 接口、OpenAI / Anthropic 协议实现、provider 注册表 |
| [files/](files/) | ★ 工程文件能力：三区类文件操作、工程根范围移动/复制、内置编辑器路径守卫、资源管理器目录列举，以及 `@` 引用候选。`fileOps.ts` 与 `projectFiles.ts` 都坚持不越界、不静默覆盖；删除只搬进 `.novelforge/.trash/`。 |

依赖方向自上而下：`features/` → `context/` / `llm/` → `model/`，反向不允许。

本目录根下另有几个不属于任何子目录的文件：

| 文件 | 职责 |
|---|---|
| [protocol/](protocol/index.ts) | 前端 ↔ 后端的消息协议（`InMessage` / `OutMessage` / `ViewState`）。对外入口仍是 `core/protocol`。插件 webview 与独立版网页共用，是前后端的唯一契约。 |
| [controller/](controller/index.ts) | ★ `ChatController`：全部面板逻辑，按消息域拆在同目录模块里。收 `InMessage` → 调度 `CreationSession` / 会话存储 / 创作目标切换 / 设置读写 → 广播 `OutMessage`。通过 `ViewHost` 接口与视图宿主解耦，支持多宿主同时挂接。构造时订阅日志与任务表，把两者实时推给所有前端。 |
| [logger.ts](logger.ts) | ★ 运行日志：环形缓冲（上限 `MAX_ENTRIES`）+ 若干 sink。`scoped('摘要')` 取一个带来源的记录器。**零依赖**（连 host.ts 都不引），core 任何模块都能直接用。历史持久化不在这里——见 db.ts 的 `installLogPersistence`（反向 import 会成环）。 |
| [db.ts](db.ts) | ★ 工程库（`.novelforge/novelforge.db`）：失败记录 `errors` + 日志历史 `logs` 两张表，外加日志的攒批落盘（`installLogPersistence` / `flushPendingLogs` / `readLogHistory`）。**两个壳两个驱动**（Node 侧 `node:sqlite`、Bun 侧 `bun:sqlite`），模块名拼接后 `await import` 运行时探测。开不开得起来都不影响功能：失败一律吞掉并只 warn 一次。 |
| [errorLog.ts](errorLog.ts) | ★ 失败记录门面：`recordFailure` / `clearFailures` / `listActiveFailures`。工程页行上那个红色感叹号的数据源。features 只碰这三个函数，不写 SQL。 |
| [progress.ts](progress.ts) | ★ 长任务登记处：`runTask` 包住 `Host.progress`，一次调用同时做三件事——宿主原生进度、结构化进度推给网页（工程页据此画进度条）、开始/每步/结束进日志附耗时。`cancelTask` 供前端进度条上的「停止」用。 |
| [concurrency.ts](concurrency.ts) | ★ 有界并发：`runPool(items, limit, worker)` 跑一批**彼此无先后依赖**的条目（章节摘要、角色卡、全书摘要的阶段批次），逐项 settle 不整批 reject、结果按 index 对齐、`limit <= 1` 退化为严格串行、取消后不再起新任务。另有 `serialize()` 把若干次调用串成一条队列——批量角色卡并发分析，但 diff 审阅一次只弹一张。 |
| [host.ts](host.ts) | core 对宿主的唯一依赖面（窄接口）：弹窗/选择/进度/文件监听/打开文件等，两个壳各实现一份。 |
| [actions.ts](actions.ts) | 工程级交互流程（初始化、新建章节），命令面板与网页共用。 |
| [config.ts](config.ts) | `readConfig` / `readBudgetFallback` / `updateSettings`，数据源由宿主注入的 `ConfigStore` 提供。 |
| [stores.ts](stores.ts) | 文件后端的配置/密钥存储（`~/.novelforge/`），双壳共用。 |
| [projectView.ts](projectView.ts) | 工程页的数据来源：把数据层给的扁平文件清单折成 `ProjectNode` 目录树（章节、角色、设定、摘要新鲜度、草稿有无、流水线徽章），展开/折叠状态留在前端。另有 `buildChapterSummaryView`（悬停浮窗要看的单章摘要）与 `buildChapterPipelineView`（创作页的流水线条），两者都按需单取——它们数据大、只在用到时要一次，不塞进每次文件变动都全量重推的树里。 |
| [pipeline.ts](pipeline.ts) | ★ 章节流水线的读取聚合：把散落在 `plans/` `scenes/` `chapters/` `summaries/` 的四层产物合成一份「这一章现在到哪一步了」，并算出四段新鲜度。与 cast.ts 同级同类——那边把摘要反向聚合成出场索引，这边聚合成流水线状态。判断逻辑全在纯函数 `model/pipeline.ts` 里，这里只负责取数。 |
| [workbench.ts](workbench.ts) | ★ 创作页工作区卡的内容：**当前这一层的产物本身**（细纲的五节、场景的七节、正文的字数与场景进度、大纲的预览）。与 pipeline.ts 同级同类——那边聚合「走到哪一步了」，这边取出「我正在改的那份东西写了什么」。正文层刻意只给统计不给全文：三千字塞进一张常驻卡片既读不下去，又把消息流挤没了。**绝不抛**：章节刚被改名时给一张说得清情况的空卡，不让整条推送失败。 |
| [cast.ts](cast.ts) | ★ 出场人物索引：把各章摘要的 `cast` 反向聚合成「谁在哪些章出现过」。工程页的角色区、「更新角色卡」取语料、角色卡的 `appearsIn` 都吃它。 |

## 已知约定

- 本层**零 vscode 依赖**（双形态改造的前提）：弹窗/进度/文件监听等宿主能力全部经窄接口 `host.ts`。新代码不要增加对 `vscode` 的依赖，也不要依赖具体的视图/面板类型；完整改造背景见 `docs/design/plans` 的 standalone 改造计划。
- **长任务一律走 `runTask`，不要直接调 `getHost().progress`**：直调只有宿主自己的 UI 看得见（VS Code 的通知条 / 独立版什么都没有），网页上那条进度条与计时不会动，日志里也不会留下开始/结束与耗时。`runTask` 把这三件事一次做完，`report({ message, current, total })` 给了 `total` 前端才画得出进度条。并发跑时 `current` **只在一项真正结束时 +1**（`runPool` 的 `onSettled` 会把已完成数递给你），按启动数递增会让进度条冲到头然后干等。
- **日志三条硬约束**（对应 `logger.ts` 的实现）：① 所有文本过 `redact`，API Key 绝不落进日志——它会被用户复制进 issue；② sink 抛异常只被吞掉，日志坏了不能带崩正事；③ 只记条数与字数，**绝不记 prompt / 正文全文**——一次正文生成的 prompt 有十万字，进了缓冲会把此前所有日志挤没（见 `features/creation.ts` 的 `logAssembly`）。
- **降级与丢弃必须同时进日志**：「不静默截断」这条产品承诺过去只落在界面的上下文明细里，折叠着不点开就看不见。现在装配器的降级项、摘要同步跳过的章节、超预算被截断的正文都会打一条 `warn`。新加截断逻辑时记得跟上。
- **失败还要留在出错的东西身上，不只是日志**：日志与 toast 都要求用户「恰好在看」。角色卡/章节/设定失败时经 `errorLog.ts` 记一条（`severity: 'error'` = 目标一字未改，`'warn'` = 部分完成、下次重来），工程页那一行就挂上感叹号，一直挂到成功。**成功路径必须 `clearFailures`**——修好了还挂着比一开始不报错更糟，用户会学会无视它。`targetKey` 一律用 relPath（名字会被作者改，路径才是当下的身份，而且前端的树本来就按 relPath 索引）。
- **库不可用不是错误路径**：`db.ts` / `errorLog.ts` 的每个 API 都自己吞异常并降级为「没有库」。纯读取的调用方（`listActiveFailures`、`clearFailures`、`readLogHistory`）必须带 `{ create: false }`——否则光是打开工程页就会在作者的 `.novelforge/` 里凭空生出一个 db 文件。写日志失败**绝不能再打日志**（会递归刷屏），只往 stderr 说一次然后彻底静默。
- `readConfig` / `readBudgetFallback` 位于 `config.ts`，数据源由宿主注入的 `ConfigStore` 提供。模型预算在模型条目上配置；`readBudgetFallback` 只为未填写的模型与旧版全局值兜底，不是设置页配置项。
- **层级是纯收纳**：章节顺序永远由文件名的数字前缀决定，与它在第几层子目录无关；分卷不重置编号。上下文装配、摘要新鲜度、@ 引用都不看目录结构。工程页每层内**正序**展示（第 1 章在上，与文件名顺序一致）。
- **摘要正文不进 `ProjectTree`**：那棵树每次文件变动都全量重推（`pushState` → `buildProjectTree`），一本两百章的书每章带上千字摘要，等于每保存一次正文就推几百 KB。悬停浮窗要的摘要走单独的 `requestSummary` / `summary` 一问一答（`buildChapterSummaryView`），前端按 order 缓存、收到新树即作废。往树上加字段前先想想它会不会把这条推送撑爆。（`failures` 是有意的例外：一条几十字，**且只有出错的目标才有**，正常工程是空对象。）
- **草稿不是可管理区**：`drafts/` 不在 `files/fileOps.ts` 的三个区里（工程页上也没有它的节点），但它是**可打开的**——`files/fileEditing.ts` 只看工程根包含 + 扩展名/章节规则 + 大小，草稿天然满足。草稿路径由 `NovelProject.draftRelPathFor` 从章节路径推导，别在别处另拼一份。
- **草稿永不自动注入**：`context/builder.ts` 里没有任何一处读 `drafts/`，草稿只能经 `resolveAttachment`（作者显式 `@` 引用）进 prompt。加功能时别打破这条——它是「不偷偷烧 token」的一部分。
- **`openDraft` 会写盘**：`controller/files.ts` 里那句 `listChapters().find(...)` 是它没变成「往 `drafts/<任意路径>` 写文件」的原语的唯一原因。别为了省一次扫描就信任前端传来的路径。
- **摘要是出场人物的唯一真相**：角色卡 frontmatter 里的 `appearsIn` / `updatedThrough` **只是缓存**。想知道谁在哪出场，一律经 `cast.ts` 的 `buildCastIndex()` 从摘要重算，别读角色卡的字段——摘要重跑之后那里就旧了。索引按 `name ∪ aliases` 匹配（摘要里的名字是模型写的，角色卡文件名是作者起的，两者没有硬关联）。
- **别名只收专属称呼，正式名压过别名**：aliases 是「谁是谁」的判据（`cast.ts` / `model/identity.ts` 都吃它），泛称会把几个角色串成一个，别人的名字会让出场章节整批记错人。所以模型产出的别名一律经 `model/naming.ts` 过滤，索引两趟建表（先占正式名再登记别名）。抢名的情况记进 `CastIndex.conflicts`，由工程页与日志说出来——出场统计必然有一张卡是错的，而这件事从界面上看不出来。
- **判定两个称呼是同一个人，只信同章共现**：`model/identity.ts` 里同一章 cast 中各自出场的两个称呼是硬约束，永不合并；别的都只是证据。把两个角色错并成一个远比多建一张卡难收拾——此后所有出场统计与角色卡语料都是错的，而界面上一切正常。
- **`characterAction` 与 `fileAction` 不能合并**：前者的作用对象是**一个角色**（用名字标识），未建卡的人物根本没有文件，走 `fileAction` 那套区守卫无从谈起。
- **资源管理器只列不改，写走 projectFiles**：`files/fileTree.ts` 是纯读取，没有新建/删除/改名。「文件」页的写入口只有 `files/projectFiles.ts`（重命名/移动/复制，工程根范围，固定目录受保护，同名不覆盖）；删除入口仍然只在工程页（`files/fileOps.ts`，搬进 `.trash/`）。往文件页加新写操作前，先想清楚它绕过了这里的哪一条约束。
- **`watchedDirs` 是前端说了算的**：controller 记住前端最近一次 `listDir` 报上来的展开集合，`pushTabData` 时照着重推。它只是「该关注哪些目录」的缓存，不是权限——每次列举仍然过 `resolveInRoot`，越界照拒。
