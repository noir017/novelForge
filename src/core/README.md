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
| [controller.ts](controller.ts) | ★ `ChatController`：全部面板逻辑。收 `InMessage` → 调度 `ContinueSession` / 会话存储 / 设置读写 → 广播 `OutMessage`。通过 `ViewHost` 接口与视图宿主解耦，支持多宿主同时挂接。构造时订阅日志与任务表，把两者实时推给所有前端。 |
| [logger.ts](logger.ts) | ★ 运行日志：环形缓冲（上限 `MAX_ENTRIES`）+ 若干 sink。`scoped('摘要')` 取一个带来源的记录器。**零依赖**（连 host.ts 都不引），core 任何模块都能直接用。 |
| [progress.ts](progress.ts) | ★ 长任务登记处：`runTask` 包住 `Host.progress`，一次调用同时做三件事——宿主原生进度、结构化进度推给网页（工程页据此画进度条）、开始/每步/结束进日志附耗时。`cancelTask` 供前端进度条上的「停止」用。 |
| [concurrency.ts](concurrency.ts) | ★ 有界并发：`runPool(items, limit, worker)` 跑一批**彼此无先后依赖**的条目（章节摘要、角色卡、全书摘要的阶段批次），逐项 settle 不整批 reject、结果按 index 对齐、`limit <= 1` 退化为严格串行、取消后不再起新任务。另有 `serialize()` 把若干次调用串成一条队列——批量角色卡并发分析，但 diff 审阅一次只弹一张。 |
| [host.ts](host.ts) | core 对宿主的唯一依赖面（窄接口）：弹窗/选择/进度/文件监听/打开文件等，两个壳各实现一份。 |
| [actions.ts](actions.ts) | 工程级交互流程（初始化、新建章节），命令面板与网页共用。 |
| [fileOps.ts](fileOps.ts) | ★ 类文件操作（工程页）：新建文件夹、重命名、移动、删除。三条硬约束——操作锁在所属区内（章节/角色/设定，`..` 与绝对路径一律拒绝）、目标已存在就报错不覆盖、删除是搬进 `.novelforge/.trash/` 而非真删。章节改名/移动时 `carryDraft` 把对应草稿一并搬走。 |
| [projectFiles.ts](projectFiles.ts) | 文件页的根范围文件操作：`renameAny` / `moveInto` / `copyInto`。不限三区但不出工程根；`isProtectedPath` 保护固定目录（chapters/、drafts/、.novelforge 及其关键子目录）、同名逐项拒绝、`.trash` 内容不可操作；章节移动仍带草稿跟随与 manifest 同步。逐项结果经 `filesOpDone` 回推前端。 |
| [attachments.ts](attachments.ts) | @ 引用的候选列表构建（展示与选择交给 Host.pick）。分组：章节 / 草稿（只列已存在的）/ 角色 / 设定 / 其他。 |
| [fileEditing.ts](fileEditing.ts) | 内置编辑器的文件读写：路径必须落在工程根内、有大小上限、只碰纯文本（扩展名白名单 **∪ 章节文件名规则**——`001-楔子` 这种无扩展名的章节也得打得开），保存走内容 hash 乐观锁（磁盘变过就抛 `FileConflictError`，绝不静默覆盖）。独立版用；插件壳走 VS Code 自己的编辑器，不经这里。 |
| [config.ts](config.ts) | `readConfig` / `readGlobalBudget` / `updateSettings`，数据源由宿主注入的 `ConfigStore` 提供。 |
| [stores.ts](stores.ts) | 文件后端的配置/密钥存储（`~/.novelforge/`），双壳共用。 |
| [projectView.ts](projectView.ts) | 工程页的数据来源：把数据层给的扁平文件清单折成 `ProjectNode` 目录树（章节、角色、设定、摘要新鲜度、草稿有无），展开/折叠状态留在前端。另有 `buildChapterSummaryView`——悬停浮窗要看的单章摘要，按需单取。 |
| [cast.ts](cast.ts) | ★ 出场人物索引：把各章摘要的 `cast` 反向聚合成「谁在哪些章出现过」。工程页的角色区、「更新角色卡」取语料、角色卡的 `appearsIn` 都吃它。 |
| [naming.ts](naming.ts) | ★ 称呼学（纯函数、零 I/O）：`isGenericAppellation` 判断一个词是不是泛称（代词、亲属称谓、`少女`/`丫头` 这类谁都能用的词、带修饰语的描述短语），`sanitizeAliases` 据此过滤别名。**只过滤 aliases，绝不过滤 name**——`店小二`、`家老`、`房东` 这类以泛称当正式名的角色确实存在。 |
| [identity.ts](identity.ts) | ★ 同一人聚类（纯函数）：把摘要里散落的称呼归并成人。判据是**同章共现作硬约束的贪心聚类**——同一章 cast 里各自出场的两个称呼永不合并，候选链接按「多少章这么写过」计票贪心处理。朴素并查集在这里是错的：一条幻觉别名会顺着传递闭包把主角和她孪生弟弟并成一个人。 |
| [fileTree.ts](fileTree.ts) | 独立版「文件」页（资源管理器）的数据来源：按目录**懒加载**列举磁盘上的真实结构，一层一次。与 projectView.ts 是两件事——那边是整理过的语义视图，这里一个文件都不藏（**含 `.novelforge/` 等点开头的目录**，只挡 `node_modules` 与 `.git`）。路径包含检查复用 fileEditing.ts；读失败降级成带 `error` 的空结果而不抛。 |

## 已知约定

- 本层**零 vscode 依赖**（双形态改造的前提）：弹窗/进度/文件监听等宿主能力全部经窄接口 `host.ts`。新代码不要增加对 `vscode` 的依赖，也不要依赖具体的视图/面板类型；完整改造背景见 `docs/design/plans` 的 standalone 改造计划。
- **长任务一律走 `runTask`，不要直接调 `getHost().progress`**：直调只有宿主自己的 UI 看得见（VS Code 的通知条 / 独立版什么都没有），网页上那条进度条与计时不会动，日志里也不会留下开始/结束与耗时。`runTask` 把这三件事一次做完，`report({ message, current, total })` 给了 `total` 前端才画得出进度条。并发跑时 `current` **只在一项真正结束时 +1**（`runPool` 的 `onSettled` 会把已完成数递给你），按启动数递增会让进度条冲到头然后干等。
- **日志三条硬约束**（对应 `logger.ts` 的实现）：① 所有文本过 `redact`，API Key 绝不落进日志——它会被用户复制进 issue；② sink 抛异常只被吞掉，日志坏了不能带崩正事；③ 只记条数与字数，**绝不记 prompt / 正文全文**——一次续写的 prompt 有十万字，进了缓冲会把此前所有日志挤没（见 `continueWriting.ts` 的 `logAssembly`）。
- **降级与丢弃必须同时进日志**：「不静默截断」这条产品承诺过去只落在界面的上下文明细里，折叠着不点开就看不见。现在装配器的降级项、摘要同步跳过的章节、超预算被截断的正文都会打一条 `warn`。新加截断逻辑时记得跟上。
- `readConfig` / `readGlobalBudget` 已移入 `config.ts`，数据源由宿主注入的 `ConfigStore` 提供；新增设置项时同时更新 `PersistedSettings` 与两处默认值。
- **层级是纯收纳**：章节顺序永远由文件名的数字前缀决定，与它在第几层子目录无关；分卷不重置编号。上下文装配、摘要新鲜度、@ 引用都不看目录结构。工程页每层内**正序**展示（第 1 章在上，与文件名顺序一致）。
- **摘要正文不进 `ProjectTree`**：那棵树每次文件变动都全量重推（`pushState` → `buildProjectTree`），一本两百章的书每章带上千字摘要，等于每保存一次正文就推几百 KB。悬停浮窗要的摘要走单独的 `requestSummary` / `summary` 一问一答（`buildChapterSummaryView`），前端按 order 缓存、收到新树即作废。往树上加字段前先想想它会不会把这条推送撑爆。
- **草稿不是可管理区**：`drafts/` 不在 `fileOps.ts` 的三个区里（工程页上也没有它的节点），但它是**可打开的**——`fileEditing.ts` 只看工程根包含 + 扩展名/章节规则 + 大小，草稿天然满足。草稿路径由 `NovelProject.draftRelPathFor` 从章节路径推导，别在别处另拼一份。
- **草稿永不自动注入**：`context/builder.ts` 里没有任何一处读 `drafts/`，草稿只能经 `resolveAttachment`（作者显式 `@` 引用）进 prompt。加功能时别打破这条——它是「不偷偷烧 token」的一部分。
- **`openDraft` 会写盘**：`controller.ts` 里那句 `listChapters().find(...)` 是它没变成「往 `drafts/<任意路径>` 写文件」的原语的唯一原因。别为了省一次扫描就信任前端传来的路径。
- **摘要是出场人物的唯一真相**：角色卡 frontmatter 里的 `appearsIn` / `updatedThrough` **只是缓存**。想知道谁在哪出场，一律经 `cast.ts` 的 `buildCastIndex()` 从摘要重算，别读角色卡的字段——摘要重跑之后那里就旧了。索引按 `name ∪ aliases` 匹配（摘要里的名字是模型写的，角色卡文件名是作者起的，两者没有硬关联）。
- **别名只收专属称呼，正式名压过别名**：aliases 是「谁是谁」的判据（`cast.ts` / `identity.ts` 都吃它），泛称会把几个角色串成一个，别人的名字会让出场章节整批记错人。所以模型产出的别名一律经 `naming.ts` 过滤，索引两趟建表（先占正式名再登记别名）。抢名的情况记进 `CastIndex.conflicts`，由工程页与日志说出来——出场统计必然有一张卡是错的，而这件事从界面上看不出来。
- **判定两个称呼是同一个人，只信同章共现**：`identity.ts` 里同一章 cast 中各自出场的两个称呼是硬约束，永不合并；别的都只是证据。把两个角色错并成一个远比多建一张卡难收拾——此后所有出场统计与角色卡语料都是错的，而界面上一切正常。
- **`characterAction` 与 `fileAction` 不能合并**：前者的作用对象是**一个角色**（用名字标识），未建卡的人物根本没有文件，走 `fileAction` 那套区守卫无从谈起。
- **资源管理器只列不改，写走 projectFiles**：`fileTree.ts` 是纯读取，没有新建/删除/改名。「文件」页的写入口只有 `projectFiles.ts`（重命名/移动/复制，工程根范围，固定目录受保护，同名不覆盖）；删除入口仍然只在工程页（`fileOps.ts`，搬进 `.trash/`）。往文件页加新写操作前，先想清楚它绕过了这里的哪一条约束。
- **`watchedDirs` 是前端说了算的**：controller 记住前端最近一次 `listDir` 报上来的展开集合，`pushTabData` 时照着重推。它只是「该关注哪些目录」的缓存，不是权限——每次列举仍然过 `resolveInRoot`，越界照拒。
