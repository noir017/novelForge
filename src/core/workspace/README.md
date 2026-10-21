# workspace — 工程的唯一读写网关

`list` / `read` / `write` / `edit` / `move` / `copy` / `mkdir` / `remove` / `search` 九个方法（外加一批收领域对象的写入器，
见末尾「领域写入器」），是整个工程**唯一**允许写盘的地方。网关之外还剩的写盘都是按设计不走这里的（见「历史版本」一节
末尾那张清单），`tests/contract/gatewayWrites.test.js` 逐个文件数着，多出一处就红。

## 为什么要有这一层

写盘从前散在六处，每处各带一部分保护，谁也不认识谁：

| 位置 | 管什么 | 带哪些保护 |
|---|---|---|
| `model/project.ts` | 所有产物的读写 | 路径推导、frontmatter 渲染、伴生搬迁 |
| `features/creation.ts` 的 `acceptArtifact` | 五条落盘路径 | `confirmOverwrite`、记 `upstreamHash` |
| `files/fileOps.ts` | 三区类文件操作 | 区界限、同名不覆盖、`.trash` |
| `files/fileEditing.ts` | 内置编辑器读写 | 工程根包含、扩展名白名单、大小上限、乐观锁 |
| `files/projectFiles.ts` | 文件页的移动/复制/改名 | 工程根包含、`isProtectedPath`、同名不覆盖 |
| 拆章（已删） | 拆分 | 章号接在最后一章之后、把落点记回段的 frontmatter |

既有落盘路径背着一批不变量，绕过任何一条都会**安静地**损坏工程：

- 细纲镜像正文在章节根下的相对路径：正文改名/移动时细纲要跟着搬；还没有正文时文件名由「章号 + 标题」决定，改标题要清掉旧文件名
- 写细纲要记 `upstreamHash`（大纲里覆盖本章那一节的指纹），写正文要在细纲上记
  `writtenFrom`（正文据以写成的细纲指纹），定稿要在同一份细纲上记 `sourceHash`（正文的指纹）
  并刷新 `writtenFrom`，漏了新鲜度链就断
- 删除一律进 `.trash/`；同名目标一律报错退出——**会话删除的落点也是同一套**（`trashPathFor`：保留原相对路径，会话落在
  `.trash/.novelforge/sessions/<id>.json`，同名加序号），不真删不是文件独有的行为（AGENTS 第 6 条）。会话不走网关的写入
  （它是内部文件，网关本来就拒写 `sessions/`），只共用落点规则：`trashPathFor` 实现在 `model/project.ts`，这里重新导出
  （`model/` 不能反过来依赖网关）。定稿改写细纲之前，旧版也照这一套复制一份进去
- 覆盖一份已有的创作产物之前，旧内容先存一版历史（`history.ts`，见下面「历史版本」）

所以 **`write` 不是「往这个路径写字节」**，而是「按这个路径**应有的种类**写一份
合法产物」——种类判定、渲染、记账、伴生搬迁、覆盖审阅全在这一层做一次。

## 新代码不许绕过 guard 直接 `fs.writeFile`

八条守卫只在这条路上做。绕过去等于给自己开一个后门，**而后门在界面上看不出来**。

功能层自己已经问过作者的覆盖（更新角色卡、提取角色合并已有卡的审阅采纳，批量更新时的「全部直接采纳」，章节改名时
同步正文的 `# 标题` 行，全书替换——预览就是那一问）也走 `write`，传 `mode: 'overwrite', review: false`：网关不再问第二次，
但守卫照过、覆盖之前旧内容照样存一版历史。新建（如手动新建设定条目）传 `mode: 'create'`，同名报错退出。

**全书替换**（`features/bookReplace.ts`）是这条路上一次写得最多的调用方，每一份都照这几条写：编辑器里有未保存修改的跳过；
`write` 之前先 `snapshotNow`（**跳过节流**强制存一版——跨文件没有一步撤销，退路就是每份的替换前那一版；存不下就不换这一份），
再 `write`（`overwrite`、`review: false`、带预览时读到的 `baseHash`：预览之后被改过就拒，不拿旧的盖新的）；章节传 `deferAfter`，
manifest 最后同步一次。指纹链的收尾走 `restampPlotChain`（见下面「领域写入器」与 `features/README.md`）。

**先写后搬的调用方先问 `checkMove`**：章节改名要先改正文的 `# 标题` 行、再 `move`（`files/fileOps.ts`）。新名字被占用时
`move` 被拒，标题却已经改了——正文被悄悄改掉（第 3 条）。所以写标题之前先 `checkMove(from, to, { plot: true })`：与 `move`
同一套守卫（来源在、不是固定目录 / 内部文件 / 回收站；落点在工程内、没有同名），外加细纲那一侧——正文镜像的细纲在、新镜像
的位置上已经有东西（`move` 本身遇到这种情况照样搬正文、细纲留在原处说一句；先改了标题的这条路把它当成搬不成）。只读，
搬不成抛 `WsError`，什么都不动。预检过了 `move` 仍可能失败（中间别处刚建了同名文件）：调用方把正文改回原样（经 `write`，
`review: false`，带写下去那一份的 hash 当乐观锁——这期间又被改过就不盖），改不回去就在 toast 与日志里照实说。

## 八条守卫（`guard.ts`）

| # | 守卫 | 触发时 |
|---|---|---|
| 1 | 路径规范化（绝对路径 / `..` 逃逸 / 空串） | `WsError('outOfRoot')` |
| 2 | 工程根包含检查（解析成绝对路径再比一次） | `WsError('outOfRoot')` |
| 3 | 固定目录保护（改名/删除） | `WsError('protected')` |
| 4 | `.trash/` 内容不可改（**读得到**，作者要能找回东西）；历史版本 `.novelforge/history/` **写不进去**（同样读得到）——往里写、搬进去、复制进去、在里面建目录都拒 | `WsError('inTrash')` / `WsError('inHistory')` |
| 5 | 大小上限 2MB（读、写各一次） | `WsError('tooLarge')` |
| 6 | 同名不覆盖（`mode: 'create'`） | `WsError('exists')` |
| 7 | 覆盖前审阅（`reviewReplace` 或确认框）。请求合并（`opts.merge`），独立版的合并视图交回作者挑过、改过的那一份时写它（五期 W11） | 用户拒绝 → `{ skipped: true }` |
| 8 | 内容 hash 乐观锁（给了基线、文件却不在：不算冲突，当新建写——内置编辑器那条路比这严一档，停下来问作者，见 `files/fileEditing.ts` 的 `FileGoneError`） | `WsConflictError(diskText, diskHash)` |

**区界限不在这里**：`fileOps` 的三区约束（章节挪不进角色目录）是**工程页的
产品承诺**，比这里的工程根约束更严。那一层留在 `fileOps` 里，先判区再调网关。

**写不进去的三处**（`guardWrite`、`guardCreate` 共用一道）：Novel Forge 自己的内部文件（会话 `sessions/`、工程库，`protected`）、
回收站（`inTrash`）、历史版本（`inHistory`）。`write`、`move` 的落点、`copy` 的落点、`mkdir` 都过它。历史版本那一条是后补的：
从前守卫只拦前两处，作者的操作能往「历史」面板里塞一份从没存过的「旧版」。回收站与历史版本都**读得到**（会话读当不存在）。

## 复制与建目录（`copy` / `mkdir`）

从前「文件」页粘贴的复制直接 `fs.cp`、新建文件夹直接 `fs.mkdir`，都不过守卫：能把文件复制进回收站、会话目录、历史版本，
也能把会话文件、工程库复制出来。现在两条都在网关里。

**`mkdir(rel)`**：可以一次建几层。落点过 `guardCreate`——工程内、不在写不进去的三处、**落点上有什么都算同名**（目录或文件，
报 `exists`，什么都不动）。只建目录，没有种类、没有记账。工程页 / 文件页的「新建文件夹」走它（区界限仍由 `fileOps` 先判）。
设定区的分类目录另有 `ensureLoreFolders`（锁在 `lore/` 里，设定清单落盘时建）；「按目录整理」不先建目录——`move` 落盘前自己补齐
父目录，新目录只在真有条目搬进去时出现，搬不成不留空目录。

**`copy(from, to)`**——文件页的「复制 → 粘贴」：

| | 规则 |
|---|---|
| 来源（`guardCopySource`） | 工程内、存在、不是符号链接、不是固定目录（整个 `chapters/`、`.novelforge/` 不收，与文件页从前一样）、不是内部文件（会话、工程库复制不出来）。**⚑ 回收站与历史版本里的东西复制得出来**：复制只读来源，读得到就复制得出来，原件一个字节不动——这是在工程里找回一份的入口（搬出来仍然不行，那是改回收站，`guardMutate`） |
| 落点（`guardCreate`） | 写不进去的三处一律拒；**同名不覆盖、不加序号**（第 3 条，与文件页从前的粘贴一样：粘回原目录报「已经在这个目录里」，目标已有报「同名」）；目录不能复制进它自己里面（`intoSelf`）；父目录不在就补齐（与 `move` 一样） |
| 目录 | 先把整棵树列出来、**逐个文件**过一遍落点守卫，全过了才动手——拦下一份就整个不复制，不留半棵树。目录里的符号链接不跟进去，跳过并在 `side` 里说出来 |
| 字节 | 原样拷贝（`COPYFILE_EXCL`，竞态里也不盖掉别处刚建的文件）：GBK 的章节、图片都不转码。没有大小上限——与 `move` 一样，复制不把内容读进编辑器或模型 |
| 章节 | 复制进 `chapters/` 的最后统一同步一次 manifest，像新建一样 |
| **⚑ 伴生** | **没有**：复制一章不带草稿、也不带细纲（「移动」带）。副本是一章新的——第 8 条细纲按路径认，作者在外面复制出来的正文也是一章新的、旧细纲不冒认；草稿是作者对原章的笔记，细纲是原章的计划与档案，跟着复制会变成两份各自漂移的东西，带着定稿指纹的那份还会让出场统计、设定名录多数一章 |
| **细纲副本**（`handlers/plot.ts` 的 `afterCopy`，第 18 条） | 去掉定稿那一侧的账：`writtenFrom` / `sourceHash` / `cast`——副本没写过、没定稿过，带着它们镜像位置上要是有正文，会被说成「定稿之后正文改过」或「细纲在正文之后改过」。`upstreamHash` **原样不重算**：内容一字没变、章号没变，它据以生成的仍是大纲里同一节——原件挂 ⟳ 的副本照样挂，不被复制顺手刷成新鲜（所以复制不走 `after`，`after` 会按大纲此刻的指纹重记）；**章号变了**（网关直接复制成另一个文件名）就去掉。作者定的（标题、目标字数、`status: done`、预检放行）与九节原样；没有 frontmatter 的手写细纲一个字节不碰 |
| 历史版本 | 不存（没覆盖任何东西）；原件的快照也不抄过去 |

## 种类表（`kind.ts`）

`kindOfPath(project, relPath)` —— **纯函数、零 I/O、绝不抛**（它会被前端传上来的
路径调用）。认不出、越界一律 `{ kind: 'other' }`，越界时连 `rel` 都不给。

| 种类 | 判定 | 解析 / 渲染 | 上游指纹 | 伴生 |
|---|---|---|---|---|
| `setting` | `config.md` / `premise.md` / `world.md`（带 `doc`） | `settingFile.ts`；配置的 frontmatter 产物没给就沿用磁盘那份 | — | — |
| `outline` / `style` / `globalSummary` | 固定路径 | 纯文本 | — | — |
| `threads` | `threads/` 这一层的 `.md`（叙事线重做：一条线一个文件，「未归属的伏笔.md」也是；子目录里的、别的扩展名、目录本身、七期的 `threads.md` 判 `other`）；`threads/` 是受保护的固定目录 | 纯文本（格式与外科式写入在 `model/threadFile.ts`） | —（链外） | — |
| `skill` | `.novelforge/skills.json` 与 `.novelforge/skills/**` | 纯文本（`plain`，不加 frontmatter） | — | — |
| `sensitive` | `.novelforge/sensitive.txt`（自定义敏感词表，内置编辑器的写作体检用） | 纯文本（`plain`） | —（链外：没有创作阶段、不进装配器，改了它不让任何一章挂 ⟳） | — |
| `plot` | `summaries/` 下（各级子目录都算，镜像正文的路径）+ 数字前缀 + markdown | `plotFile.ts`（七节加「设定」一节） | 写入记大纲里覆盖本章那一节的指纹（`outlineUpstreamHash`）；定稿记的 `sourceHash` / `cast` 由 `finalizePlot` 写，重写细纲时原样沿用 | — |
| `chapter` | 章节根下 + 数字前缀 + 扩展名不在黑名单 | `chapterFile.ts` | —（正文依据的细纲指纹记在细纲的 `writtenFrom` 上） | 改名/移动带草稿与细纲（整个卷目录也带，连同它们的历史版本）；写后 `syncManifest` |
| `character` / `lore` | 各自区 + `.md`（设定条目另给 `stage: 'setting'` 与单条设定目标 `{ kind: 'lore', relPath }`，完善设定：MCP 的 `generate` 给条目路径就是展开它；设定目录、角色目录本身仍是 `other`，设定清单、角色图谱只在 `generate` 里认） | frontmatter | — | — |
| `draft` | `drafts/` 下 | 纯文本 | — | **永不自动进上下文** |
| `other` | 其余工程内文本（含老工程的 `plots/` 与历史版本 `.novelforge/history/`——后者读得到、写不进，守卫 4） | 纯文本 | — | — |

三条判定上的取舍：

1. **`chapter` 不看是不是 `.md`**（AGENTS 第 9 条：章节不认扩展名）。
   `001-楔子.txt`、`001-楔子`（无扩展名）、`004.json` 都算章节；
   角色 / 设定 / 细纲**不**跟着放宽，它们是插件自己的数据格式。
2. **章节路径不带创作目标**：正文就是章节，第 N 章的细纲是正文路径在 `summaries/` 下的镜像
   （`NovelProject.plotPathForChapter`），配对要读盘，不在这里做；还没有正文的章，正文落点由细纲
   反推（`views/pipeline.ts` 的 `chapterTargetOf`）。
   `pathOfTarget` 对正文 target 直接抛，提示调用方改用它。
3. **`summaries/global.md` 排在细纲之前判**：它是全文大纲（`globalSummary`），不是一份细纲。
4. **老工程留下的 `scenes/`、`volumes/`、`manuscripts/`、`plots/` 都判成 `other`**：那几层已经删掉
   （见 `model/pipeline.ts` 的文件头），细纲从 `plots/` 搬进了 `summaries/`、与单章摘要并成一份
   （见 `model/plotFile.ts` 的文件头）。那些文件
   是作者的东西，磁盘上一个字节都不动，但代码里彻底不认——`guard.ts` 的
   `isProtectedPath` 仍然把那几个目录列为受保护目录，免得哪条文件操作把它们整棵删掉。
5. **敏感词表单列一种 `sensitive`，不落 `other`**：它与 `other` 一样在指纹链之外、装配器不读，但它是作者手维护的词表，改坏了要找得回来——`other` 不存历史版本，`sensitive` 存。新建经「编辑敏感词表…」（`controller/check.ts`：`write` 的 `mode: 'create'`，同名报错、不覆盖；作者点的那一下就是那一问，文件本来不在，没有可审阅的），保存走内置编辑器那条路（乐观锁，`review: false`），都不弹覆盖审阅。
6. **`.novelforge/history/` 下的东西都判成 `other`**：那是一份份旧稿（历史版本），装配器只按种类与固定目录读，
   碰不到它（与第 10 条「草稿不进上下文」同一个道理）；它们自己也就不会再被存历史版本。

## 历史版本（`history.ts`）

网关**覆盖一份已存在的创作产物之前**，把磁盘上的旧内容存成一个快照。「不静默覆盖」（第 3 条）管的是落盘之前
那一问；问过了、写下去了，作者回头想要刚才那一版，从前只有定稿写回细纲会在回收站里留一份旧的。

**布局**——每份文件一个目录，每个快照一个以时间命名的文件：

```
.novelforge/history/
├── .gitignore                                第一次建这个目录时放进来，内容 `*`
├── chapters/第一卷/003-深处.txt/              目录名 = 原文件的相对路径（连扩展名，`003.md` 与 `003.txt` 不撞车）
│   ├── 2026-10-18_14-32-05+0800.txt          被覆盖那一刻的本地时间 + 时区
│   └── 2026-10-18_14-32-05+0800-2.txt        同一秒里的第二个
└── .novelforge/summaries/第一卷/003-深处.md/  `.novelforge/` 里的文件同样原样镜像
```

- 快照**字节原样拷贝**（不转码，GBK 的旧稿存下来还是 GBK），扩展名一律 `.txt`：插件壳的监听吃 `.novelforge/**/*.md`，
  不是 `.md` 就不会每存一版多跑一轮全量重扫；内置编辑器与「文件」页照样打得开。
- 时间从文件名读（`parseSnapshotFileName`），不看 mtime——拷来拷去 mtime 会变；带时区，换了时区也排得对。

**存不存**（`decideSnapshot`，纯函数）：

| 情形 | 存不存 |
|---|---|
| `kindOfPath` 是 `other`（工程根的随手记、`README`、老工程的 `plots/`……）、还不是小说工程（没有 `.novelforge/`） | 不存——不替作者凭空建出一个工程目录（敏感词表是 `sensitive`，存） |
| 新内容与旧内容一样（什么都没覆盖）、旧内容与最新一个快照一样 | 不存 |
| 最新快照不到 10 分钟，且「旧内容 ↔ 最新快照」「旧内容 ↔ 新内容」两处改动都在 300 字以内（公共前后缀粗算，`changedChars`） | 不存——自动保存每两秒存一次时攒不出几百个快照 |
| 其余（第一次、隔了 10 分钟以上、整章重写 / 修稿 / 一键排版 / 定稿这类大改） | 存 |
| 「现在存一版」（`snapshotNow`，编辑器面板上的按钮） | 跳过节流；与最新快照一字不差时仍不重复存 |

**保留**：每份文件最多留最近 50 个（`HISTORY_KEEP`），多的删掉最旧的。**这些是网关自己存的副本，不是作者的文件**，
删它们不违背第 6 条「不真删」——第 6 条护的是作者的东西，这里删的是网关为了「找得回来」额外抄的那几份，作者自己的
文件一个字节都没动。

**`.gitignore`**：只在建出 `.novelforge/history/` 的那一次放（内容 `*`，Git 默认不收快照）。作者删掉它就是想让 Git
收这些快照，之后不再补回来。

**哪些写入存**：`write`（`overwrite` 与 `append`；编辑器保存、生成落盘、`edit`、`setParagraphStyle`，以及功能层审阅过的
覆盖——更新角色卡、提取角色合并已有卡、章节改名时同步正文的 `# 标题` 行——都走它）、`writePlot`
（换掉的是这一章原来那份，改标题时它在旧路径上）、`finalizePlot`、`writeCharacter` / `writeLore` / `writeStyleGuide` /
`writeGlobalSummary` / `updateThreads` / `writeSkillBindings`（经私有的 `overwrite`）。**只改 frontmatter 一个键的记账**
（`recordWrittenFrom` / `recordPreflightOk` / `restampPlotChain`）不存——它们不吞任何内容。全书替换在 `write` 之前另外
`snapshotNow` 一次（跳过节流），之后 `write` 自己那一次与它一字不差、不重复存。覆盖创作产物的写入都经网关（角色卡的清理别名、
合并重复卡也是：`write` 传 `review: false`，动手前的确认框就是那一问；被合并的卡经 `remove` 进回收站）。只新建、不覆盖的
（`copy`、`mkdir`、`createChapter`、新工程的空模板 `initializeProject`）没有旧内容可存。

**网关之外剩下的写盘**都不是作者的创作产物、按设计不走这里（`tests/contract/gatewayWrites.test.js` 逐个文件数着）：会话文件
（`model/session.ts`，内部文件，网关拒写 `sessions/`；删会话只共用 `trashPathFor` 落点）、新工程的固定目录与 manifest
（`model/project.ts` 的 `scaffold` / `createManifest`）、`.novel/` → `.novelforge/` 迁移、工程库（SQLite，第 17 条）、
工程外的配置（`stores.ts`，`~/.novelforge/`）与我的技能库（`skills/library.ts`）。它们都不存历史版本。

**快照跟着改名、搬家走**（`moveHistory`）：快照按路径存，所以网关 `move` 成功之后，把搬的那一份（或整个目录）在
`.novelforge/history/` 下的快照目录也挪到新路径下——在新路径上打开「历史」面板，看得到改名之前存的版本（章节改名时同步
标题行存下的那一版也在里面）。

- **覆盖面**：单个文件；整个目录（分卷目录改名，下面每份文件的快照整棵跟着走）；伴生搬家——章节改名、移动时草稿与细纲
  跟着搬，它们不经 `move`（`handlers/chapter.ts` 的 `carryMirror` 直接 rename），快照在那里各自跟上；没搬动的伴生（目标已有、
  移出了 `chapters/`）快照也留在原处。`writePlot` 改标题（还没有正文）、改章号换了文件名，细纲的快照同样跟过去。
- **新路径下已经有快照目录**（以前那里有过同名文件）：两边合并，文件名撞了按存快照时的去重规矩加序号（同一刻，序号往上
  加；拷贝用 `COPYFILE_EXCL`，绝不盖掉已有的那一个），合并完按保留上限（50 个）修剪。
- **搬快照失败不挡搬家**：新位置被一个文件占了、磁盘满、权限……都只记一条 warn（「没能把 … 的历史版本搬到 …，搬家照常」），
  `moveHistory` 不抛，搬家本身不失败也不回滚（与「存快照失败不挡保存」同一个口径）；没搬过去的快照留在旧路径下，一个不丢。
- **删除不搬**：`remove` / `deletePlot` 进回收站时快照留在原路径。作者从 `.trash/` 把文件搬回原处，历史也就回来了。
- 搬进、搬出 `.novelforge/history/` 本身的东西不搬快照（那里的东西本来就不存历史）。

**定稿写回两份都留**：`.trash/` 那一份照旧（永不裁剪，定稿完成提示里说的就是它），历史版本里也存一版——编辑器的
「历史」面板里找得到、对比得了；七节整体换掉，节流拦不住它。

**绝不挡住保存**：存快照的任何一步失败都只记一条 warn（「没能给 … 存历史版本，照常写盘」），`snapshotBeforeWrite`
不抛，调用方照常写盘（第 1 条）。

**不进上下文、不触发重扫、删不掉、写不进**：`kindOfPath` 判 `other`；全文检索跳过它（`isInHistory`，与 `.trash/` 同一个理由：
搜出来的不是现在的书）；`watchPolicy.shouldIgnoreChange` 挡掉它的变动；`isProtectedPath` 把 `.novelforge/history`
列为固定目录（类文件操作搬不走、删不掉整个目录；工程页的三个区本来就够不着它）；守卫 4 拒绝作者的操作往里写、搬、复制、
建目录（`inHistory`——快照只由这一层自己存）。「文件」页照常看得见、点得开，单份快照也**复制得出来**。

读的一半（列出快照、读全文、现在存一版）由 `controller/versions.ts` 接给内置编辑器的「历史」面板；恢复与对比都只换
编辑区里的内容，从不直接写盘。**放回编辑区之前**（对比放回、冲突时的对比合并、「恢复这一版」发的 `saveVersion { quiet }`）
磁盘上那一份先 `snapshotNow` 一次：放回的内容一存盘就盖掉它，而按节流它可能因为「改动小」不存——作者是在版本之间跳，
跳走之前那一版得留住。

## 记账下沉（网关收拢那一期唯一有意的行为变化）

`upstreamHash` 从前**只在采纳路径上记**（`features/creation.ts` 的
`acceptPlot` / `acceptManuscript`）。作者在
内置编辑器里改一份细纲，指纹链就断了——那一章从此再也不挂 ⟳。

下沉到写入路径本身之后，**任何一次 `workspace.write` 到 plot 路径都记**。细纲的
上游是**大纲里覆盖本章的那一节**（`plotUpstreamHash` → `outlineUpstreamHash`，大纲
没有区间标题时退回全书的指纹）——大纲一段一段续写，续写第 21–40 章不该让前 20 章
的细纲挂 ⟳。正文那一环（`writtenFrom`）由正文落盘那一步记（`recordWrittenFrom`），
作者在编辑器里手改正文不动它——chapter handler 写后只同步 manifest，所以任何一次 `write` 到章节路径（编辑器保存、
章节改名时同步 `# 标题` 行）都不会把一章挂着的 ⟳ 刷掉。三条配套约束一条没变：

- **手写的产物永不标脏**：`upstreamHash` / `writtenFrom` 为空 = 不是这条链生出来的，不给它补一个
- **`plotContentHash` 只哈希七个小节**（定义在 `model/plotFile.ts`），不含 frontmatter——
  `upstreamHash` / `writtenFrom` / `sourceHash` 自己就在 frontmatter 里，算进去会让「排一次细纲」
  「定稿一次」立刻使这一章的正文过期
- **不哈希状态位**——作者把某一章标成 `done`（`status: done` 在 frontmatter 里），
  那一次写入不该让刚写好的正文立刻显示「上游已变更」

## 定稿写回（`finalizePlot`）

定稿照正文反向更新细纲，落盘不走 `write`，而是 `Workspace.finalizePlot(chapter, sections, cast)`
（渲染在 `handlers/plot.ts` 的 `renderFinalizedPlot`）。它不记大纲指纹——反向更新的依据是正文，不是大纲。

- **旧版先复制一份进 `.trash/`**（`trashPathFor`：保留原相对路径，同名加序号）。定稿按钮本身就是
  作者的确认，所以不弹覆盖审阅；但改的是一份作者可能逐字推敲过的计划，旧的那一版要找得回来。历史版本里也照常
  存一版（见「历史版本」），编辑器的「历史」面板里对比得了。
- **七节整体换掉**，「设定」一节换成这一次定稿记下的（校验过的）；frontmatter 里 `no` / `title` / `targetWords` / `upstreamHash` / `status` /
  `preflightOk` / `factCheckOk` 原样留着。
- **写 `sourceHash`（正文的 `contentHash`）与 `cast`，并把 `writtenFrom` 刷成更新后的内容指纹**：
  不刷的话定稿刚改完细纲，正文立刻挂 ⟳；刷了之后，作者定稿后再改细纲，正文才挂 ⟳。指纹按
  「渲染 → 解析回来」的样子算，与流水线判脏同一个口径。
- 写回的永远是**正文镜像的那一份**（`plotOfChapter`）；还没有细纲的章（拆书导入、作者手写的正文）就在镜像位置新建一份（`plotPathForChapter`），不在根下另起一份。

反过来，重写一份定稿过的细纲（`write` 到 plot 路径）时 `sourceHash` 与 `cast` 沿用磁盘那份：
定稿过的章不被拉回「待写」，只让正文挂 ⟳（第 18 条）。

## 全文检索（`search.ts`）

**零模型调用的朴素扫描**。作者问「主角前面说过他没去过北境吗」，从前只能靠手动
`@` 引用几章原文；把它做成 AI 功能等于每问一句烧一次钱，而且会给出看起来很像但
没有依据的答案——与「新鲜度只靠 hash 传播，不调模型」是同一条取舍。

四条实现约束：

1. **跳过 `.trash/`、历史版本与二进制**——回收站里躺着刚删掉的东西，搜出来等于没删；`.novelforge/history/`
   是一份份被覆盖掉的旧稿，同理。
2. **单文件读入有上限**（复用 `MAX_EDITABLE_BYTES`），超了跳过并计入 `dropped`。
3. **`dropped > 0` 必须在返回值里说出来**（第 2 条）——agent 的工具会把它转述给
   模型，模型不知道自己只看了一半会拿半份证据下结论。
4. **默认按章号排序**，不按文件系统顺序：作者问「他前面说过吗」，时间线顺序才有意义。

坏正则**不抛**，降级成字面量并在 `note` 里说明。缺省就是字面量——作者搜的是人名
地名，不是正则。

## 目录

```
workspace/
├── index.ts        Workspace 门面：list / read / write / edit / move（另有只读预检 checkMove）/ copy / mkdir / remove / search，外加领域写入器与新工程的 initializeProject
├── kind.ts         ★ 路径 → 种类（纯函数，零 I/O，绝不抛）
├── guard.ts        ★ 统一入口守卫（八条；写、建、复制的落点共用「写不进去的三处」，复制的来源另有 guardCopySource）
├── history.ts      历史版本：覆盖之前存旧内容（布局、节流、保留；绝不挡住保存）；搬家时快照跟着走（moveHistory，绝不挡住搬家）
├── search.ts       全文检索（朴素扫描，零模型调用）
└── handlers/
    ├── index.ts    种类 → handler 注册表（认不出落 plain，绝不抛）
    ├── types.ts    Handler 的五件事：render / resolve / after / companions / afterCopy（另有 onRemove）
    ├── setting.ts  架构三件（小节换新、配置 frontmatter 合并）
    ├── plot.ts     渲染 + 记 upstreamHash；定稿写回的渲染（renderFinalizedPlot）；副本去掉定稿那一侧的指纹（afterCopy）
    ├── chapter.ts  草稿与细纲跟随（carryDraft / carryPlot，连同它们的快照）+ manifest 同步（删章节不删草稿、不删细纲）
    ├── doc.ts      outline / style / globalSummary / threads / character / lore
    └── plain.ts    other / draft（纯文本，无记账）
```

## 领域写入器

上面九个方法收的是**路径**。另有一批收**领域对象**：

| 方法 | 落点由什么决定 |
|---|---|
| `writePlot` / `deletePlot` | 有正文：正文的镜像（文件名跟着正文，改标题只改 frontmatter 里的标题）；没有正文：已有那份所在的子目录，或调用方给的落点 `at` 的子目录，都没有就跟上一章同一个子目录，文件名按章号 + 标题（改章号要传原路径）。删除进 `.trash/` 的落点与 `remove` 同一套（`trashPathFor`），不会盖掉定稿时复制进去的旧版；删掉之后各条线与「未归属的伏笔」里那一章的计划事件一起删（`dropPlannedThreadEvents`，第 28 条「计划事件随细纲走」，复跑之后加的；同一章还有另一份细纲时不删），改之前存一版历史 |
| `recordWrittenFrom` | 细纲路径（只改 frontmatter 的 `writtenFrom`，正文一个字节不动） |
| `recordPreflightOk` | 细纲路径（只改 frontmatter 的 `preflightOk`：一致性预检的永久放行，一行「名字：理由」，同名换新理由；没有 frontmatter 的手写细纲不补，五期补遗 §2） |
| `restampPlotChain(rel, patch)` | 细纲路径（只改 frontmatter 里给出的指纹键：`upstreamHash` / `writtenFrom` / `sourceHash`，值为空就删掉这个键；别的键与正文一个字节不动，不存历史版本，没有 frontmatter 的手写细纲不补）。只给全书替换的指纹链收尾用（第 18 条，`features/bookReplace.ts`）：同一次里细纲与正文都改了、原本对得上的，`writtenFrom` / `sourceHash` 刷成替换后的；细纲的 `upstreamHash` 退回替换前的判断——`write` 写细纲时总是记下大纲此刻的指纹（「谁写都记」），这一次替换不该顺手把本来挂着的 ⟳ 擦掉、也不该把没记过的手写细纲拉进链 |
| `patchPlotLore` | 细纲路径（只换「设定」一节，没有就加在末尾，另外七节与 frontmatter 一个字不动；单独记设定、补记用。「设定」一节不进内容指纹，正文不会因此挂 ⟳） |
| `createChapter` / `ensureDraft` | 章号 + 标题 / 章节路径的镜像 |
| `createChapterAt(rel, content, plotRelPath)` | 调用方给的路径（照细纲写正文时由 `views/pipeline.ts` 的 `chapterTargetOf` 算：细纲所在的子目录）。细纲路径与新正文的镜像对不上（纯序号的 `030.md`、正文按标题落成 `030-雪夜.md`）就把细纲改名过去；镜像位置已有文件时不动、记 warn |
| `createChapters(items)` | 同 `createChapter`，一次好几章（导入原稿）：每章照样过 `write`（同名报错退出、大小上限），只是 chapter handler 的 manifest 同步**延到最后做一次**（`WriteOptions.deferAfter`，只对章节生效）——逐章重扫全部章节是 O(n²) 次读盘，三百章十几秒。撞了同名就抛，前面写好的留着、manifest 照样同步 |
| `finalizePlot` | 章节：正文镜像的那一份细纲，没有就在镜像位置新建（见上一节「定稿写回」） |
| `writeCharacter` / `writeLore` | slug（可带子目录） |
| `writeStyleGuide` / `writeGlobalSummary` | 固定路径 |
| `markThreadsJudged(no)` | 第 `no` 章的叙事线判过了（叙事线重做四期）：推 `project.json` 里的水位 `threadsThrough`（正好是水位 + 1 就推、顺着后面已经判过的接着推，更靠后的记进 `threadsJudged`；水位以内的不写盘）。同全文大纲的水位：manifest 是链外的索引，没有上游指纹；不放 SQLite（第 17 条） |
| `writeSkillBindings(text)` | 固定路径（`skills.json`）。设置页「技能」与 `skills bind` 动手前都已经问过作者，这里不再弹覆盖审阅——每换一次下拉框弹一个 JSON 的 diff 只是噪声 |
| `createThread(thread)` | 新建一条叙事线 `threads/<线名>.md`（排线、定稿认出新线）：**同名跳过**——文件已经在了就一个字节不动、返回 undefined（第 19、28 条：机器只追加）。链外文件，没有上游指纹 |
| `updateThread(rel, edit)` | 改写一份叙事线文件（一条线，或「未归属的伏笔」，还没有这份文件当空串）：读**此刻**的原文交给 `edit`、写回它给的新原文（覆盖前存一版历史）：排线、定稿要调几十秒模型（拆细纲写计划事件也走它，叙事线二期），写之前重读、只在上面外科式地改，作者这期间的改动才不会被一份旧全文冲掉；种类不是 `threads` 的拒写 |
| `setParagraphStyle(style)` | 固定路径（`config.md`）。内置编辑器「编辑 → 段落格式」：**只改 frontmatter 的 `paragraphStyle` 这一行**（`setConfigParagraphStyle`），别的字节一个不动；没有 `config.md` 就新建一份只有这一段 frontmatter 的（没有小节，「小说配置」仍算没填，主按钮不变）。经 `write` 落盘、不弹覆盖审阅（改的只是作者在菜单里点的那一个键），带读到时的 hash 当乐观锁；已经是这个值时不写 |
| `initializeProject(meta)` | 新工程（`actions.ts` 的 `initProjectFlow`：插件命令、网页按钮、CLI 共用）：固定目录（`model` 的 `scaffold`）→ 几份空模板（架构三件、文风、情节大纲、全文大纲；落点与内容由 `model` 的 `newProjectTemplates` 给，纯数据）→ manifest（`model` 的 `createManifest`，最后写：模板写到一半失败时工程不算建好，再点一次就补齐）。**模板经 `write` 写，`mode: 'create'`，落点上已经有东西（文件或目录）就一个字节不动**——与从前 `model/project.ts` 里的 `writeIfAbsent` 同一个口径，那一处绕过了网关，而 `model/` 不能反过来依赖网关，所以拆成「数据层给脚手架与模板内容、网关写模板」。经网关不多出动作：create 不弹审阅、不存历史；这几种（setting / outline / style / globalSummary）的 handler 不记账，不写细纲，已有细纲不会被补上 `upstreamHash`、没有东西因此挂 ⟳；没有伴生也就不记日志。返回新建了哪几份 |

调用方手里只有对象，让它自己去拼路径等于把命名规则复制一份出去。

它们仍然经同一套 handler 记账与伴生，只是路径由这一层算出来。
