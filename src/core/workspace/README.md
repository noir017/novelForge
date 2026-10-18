# workspace — 工程的唯一读写网关

`list` / `read` / `write` / `edit` / `move` / `remove` / `search` 七个方法，
是整个工程**唯一**允许写盘的地方。

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
- 删除一律进 `.trash/`；同名目标一律报错退出——**会话删除走的是同一套**（`trashPathFor`），不真删不是文件独有的行为（AGENTS 第 6 条）；定稿改写细纲之前，旧版也照这一套复制一份进去
- 覆盖一份已有的创作产物之前，旧内容先存一版历史（`history.ts`，见下面「历史版本」）

所以 **`write` 不是「往这个路径写字节」**，而是「按这个路径**应有的种类**写一份
合法产物」——种类判定、渲染、记账、伴生搬迁、覆盖审阅全在这一层做一次。

## 新代码不许绕过 guard 直接 `fs.writeFile`

八条守卫只在这条路上做。绕过去等于给自己开一个后门，**而后门在界面上看不出来**。

功能层自己已经问过作者的覆盖（更新角色卡、提取角色合并已有卡的审阅采纳，批量更新时的「全部直接采纳」，章节改名时
同步正文的 `# 标题` 行）也走 `write`，传 `mode: 'overwrite', review: false`：网关不再问第二次，但守卫照过、覆盖之前
旧内容照样存一版历史。新建（如手动新建设定条目）传 `mode: 'create'`，同名报错退出。

## 八条守卫（`guard.ts`）

| # | 守卫 | 触发时 |
|---|---|---|
| 1 | 路径规范化（绝对路径 / `..` 逃逸 / 空串） | `WsError('outOfRoot')` |
| 2 | 工程根包含检查（解析成绝对路径再比一次） | `WsError('outOfRoot')` |
| 3 | 固定目录保护（改名/删除） | `WsError('protected')` |
| 4 | `.trash/` 内容不可改（**读得到**，作者要能找回东西） | `WsError('inTrash')` |
| 5 | 大小上限 2MB（读、写各一次） | `WsError('tooLarge')` |
| 6 | 同名不覆盖（`mode: 'create'`） | `WsError('exists')` |
| 7 | 覆盖前审阅（`reviewReplace` 或确认框）。请求合并（`opts.merge`），独立版的合并视图交回作者挑过、改过的那一份时写它（五期 W11） | 用户拒绝 → `{ skipped: true }` |
| 8 | 内容 hash 乐观锁（给了基线、文件却不在：不算冲突，当新建写——内置编辑器那条路比这严一档，停下来问作者，见 `files/fileEditing.ts` 的 `FileGoneError`） | `WsConflictError(diskText, diskHash)` |

**区界限不在这里**：`fileOps` 的三区约束（章节挪不进角色目录）是**工程页的
产品承诺**，比这里的工程根约束更严。那一层留在 `fileOps` 里，先判区再调网关。

## 种类表（`kind.ts`）

`kindOfPath(project, relPath)` —— **纯函数、零 I/O、绝不抛**（它会被前端传上来的
路径调用）。认不出、越界一律 `{ kind: 'other' }`，越界时连 `rel` 都不给。

| 种类 | 判定 | 解析 / 渲染 | 上游指纹 | 伴生 |
|---|---|---|---|---|
| `setting` | `config.md` / `premise.md` / `world.md`（带 `doc`） | `settingFile.ts`；配置的 frontmatter 产物没给就沿用磁盘那份 | — | — |
| `outline` / `style` / `globalSummary` / `threads` | 固定路径 | 纯文本 | — | — |
| `skill` | `.novelforge/skills.json` 与 `.novelforge/skills/**` | 纯文本（`plain`，不加 frontmatter） | — | — |
| `plot` | `summaries/` 下（各级子目录都算，镜像正文的路径）+ 数字前缀 + markdown | `plotFile.ts`（八节） | 写入记大纲里覆盖本章那一节的指纹（`outlineUpstreamHash`）；定稿记的 `sourceHash` / `cast` 由 `finalizePlot` 写，重写细纲时原样沿用 | — |
| `chapter` | 章节根下 + 数字前缀 + 扩展名不在黑名单 | `chapterFile.ts` | —（正文依据的细纲指纹记在细纲的 `writtenFrom` 上） | 改名/移动带草稿与细纲（整个卷目录也带）；写后 `syncManifest` |
| `character` / `lore` | 各自区 + `.md` | frontmatter | — | — |
| `draft` | `drafts/` 下 | 纯文本 | — | **永不自动进上下文** |
| `other` | 其余工程内文本（含老工程的 `plots/` 与历史版本 `.novelforge/history/`） | 纯文本 | — | — |

三条判定上的取舍：

1. **`chapter` 不看是不是 `.md`**（AGENTS 第 9 条：章节不认扩展名）。
   `001-楔子.txt`、`001-楔子`（无扩展名）、`004.json` 都算章节；
   角色 / 设定 / 细纲**不**跟着放宽，它们是插件自己的数据格式。
2. **章节路径不带创作目标**：正文就是章节，第 N 章的细纲是正文路径在 `summaries/` 下的镜像
   （`NovelProject.plotPathForChapter`），配对要读盘，不在这里做；还没有正文的章，正文落点由细纲
   反推（`views/pipeline.ts` 的 `chapterTargetOf`）。
   `pathOfTarget` 对正文 target 直接抛，提示调用方改用它。
3. **`summaries/global.md` 排在细纲之前判**：它是全书摘要（`globalSummary`），不是一份细纲。
4. **老工程留下的 `scenes/`、`volumes/`、`manuscripts/`、`plots/` 都判成 `other`**：那几层已经删掉
   （见 `model/pipeline.ts` 的文件头），细纲从 `plots/` 搬进了 `summaries/`、与单章摘要并成一份
   （见 `model/plotFile.ts` 的文件头）。那些文件
   是作者的东西，磁盘上一个字节都不动，但代码里彻底不认——`guard.ts` 的
   `isProtectedPath` 仍然把那几个目录列为受保护目录，免得哪条文件操作把它们整棵删掉。
5. **`.novelforge/history/` 下的东西都判成 `other`**：那是一份份旧稿（历史版本），装配器只按种类与固定目录读，
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
| `kindOfPath` 是 `other`（工程根的随手记、`README`、老工程的 `plots/`……）、还不是小说工程（没有 `.novelforge/`） | 不存——不替作者凭空建出一个工程目录 |
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
（`recordWrittenFrom` / `recordPreflightOk`）不存——它们不吞任何内容。覆盖创作产物的写入都经网关；网关之外剩下的写盘
要么只新建、不覆盖（新工程的空模板、「文件」页的复制、新建文件夹），要么不是创作产物（会话文件、`project.json`、工程库、
工程外的配置与我的技能库），都不存历史版本。

**快照按路径存，不跟着改名走**：章节改名时同步标题行存下的那一版挂在**旧路径**的镜像目录下，在新路径上打开「历史」面板
看不到它（`move` 不搬历史目录）。

**定稿写回两份都留**：`.trash/` 那一份照旧（永不裁剪，定稿完成提示里说的就是它），历史版本里也存一版——编辑器的
「历史」面板里找得到、对比得了；八节整体换掉，节流拦不住它。

**绝不挡住保存**：存快照的任何一步失败都只记一条 warn（「没能给 … 存历史版本，照常写盘」），`snapshotBeforeWrite`
不抛，调用方照常写盘（第 1 条）。

**不进上下文、不触发重扫、删不掉**：`kindOfPath` 判 `other`；全文检索跳过它（`isInHistory`，与 `.trash/` 同一个理由：
搜出来的不是现在的书）；`watchPolicy.shouldIgnoreChange` 挡掉它的变动；`isProtectedPath` 把 `.novelforge/history`
列为固定目录（类文件操作搬不走、删不掉整个目录；工程页的三个区本来就够不着它）。「文件」页照常看得见、点得开。

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
- **`plotContentHash` 只哈希八个小节**（定义在 `model/plotFile.ts`），不含 frontmatter——
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
- **八节整体换掉**，第九节「设定」换成这一次定稿记下的（校验过的）；frontmatter 里 `no` / `title` / `targetWords` / `upstreamHash` / `status` /
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
├── index.ts        Workspace 门面：list / read / write / edit / move / remove / search
├── kind.ts         ★ 路径 → 种类（纯函数，零 I/O，绝不抛）
├── guard.ts        ★ 统一入口守卫（八条）
├── history.ts      历史版本：覆盖之前存旧内容（布局、节流、保留；绝不挡住保存）
├── search.ts       全文检索（朴素扫描，零模型调用）
└── handlers/
    ├── index.ts    种类 → handler 注册表（认不出落 plain，绝不抛）
    ├── types.ts    Handler 的四件事：render / resolve / after / companions
    ├── setting.ts  架构三件（小节换新、配置 frontmatter 合并）
    ├── plot.ts     渲染 + 记 upstreamHash；定稿写回的渲染（renderFinalizedPlot）
    ├── chapter.ts  草稿与细纲跟随（carryDraft / carryPlot）+ manifest 同步（删章节不删草稿、不删细纲）
    ├── doc.ts      outline / style / globalSummary / threads / character / lore
    └── plain.ts    other / draft（纯文本，无记账）
```

## 领域写入器

上面七个方法收的是**路径**。另有一批收**领域对象**：

| 方法 | 落点由什么决定 |
|---|---|
| `writePlot` / `deletePlot` | 有正文：正文的镜像（文件名跟着正文，改标题只改 frontmatter 里的标题）；没有正文：已有那份所在的子目录，或调用方给的落点 `at` 的子目录，都没有就跟上一章同一个子目录，文件名按章号 + 标题（改章号要传原路径）。删除进 `.trash/` 的落点与 `remove` 同一套（`trashPathFor`），不会盖掉定稿时复制进去的旧版 |
| `recordWrittenFrom` | 细纲路径（只改 frontmatter 的 `writtenFrom`，正文一个字节不动） |
| `recordPreflightOk` | 细纲路径（只改 frontmatter 的 `preflightOk`：一致性预检的永久放行，一行「名字：理由」，同名换新理由；没有 frontmatter 的手写细纲不补，五期补遗 §2） |
| `patchPlotLore` | 细纲路径（只换第九节「设定」，没有就加在末尾，另外八节与 frontmatter 一个字不动；单独记设定、补记用。第九节不进内容指纹，正文不会因此挂 ⟳） |
| `createChapter` / `ensureDraft` | 章号 + 标题 / 章节路径的镜像 |
| `createChapterAt(rel, content, plotRelPath)` | 调用方给的路径（照细纲写正文时由 `views/pipeline.ts` 的 `chapterTargetOf` 算：细纲所在的子目录）。细纲路径与新正文的镜像对不上（纯序号的 `030.md`、正文按标题落成 `030-雪夜.md`）就把细纲改名过去；镜像位置已有文件时不动、记 warn |
| `createChapters(items)` | 同 `createChapter`，一次好几章（导入原稿）：每章照样过 `write`（同名报错退出、大小上限），只是 chapter handler 的 manifest 同步**延到最后做一次**（`WriteOptions.deferAfter`，只对章节生效）——逐章重扫全部章节是 O(n²) 次读盘，三百章十几秒。撞了同名就抛，前面写好的留着、manifest 照样同步 |
| `finalizePlot` | 章节：正文镜像的那一份细纲，没有就在镜像位置新建（见上一节「定稿写回」） |
| `writeCharacter` / `writeLore` | slug（可带子目录） |
| `writeStyleGuide` / `writeGlobalSummary` | 固定路径 |
| `writeSkillBindings(text)` | 固定路径（`skills.json`）。设置页「技能」与 `skills bind` 动手前都已经问过作者，这里不再弹覆盖审阅——每换一次下拉框弹一个 JSON 的 diff 只是噪声 |
| `updateThreads(edit)` | 固定路径（`threads.md`）。读**此刻**的原文交给 `edit`、写回它给的新原文：排线、定稿要调几十秒模型，写之前重读，作者这期间的改动才不会被一份旧全文冲掉 |
| `setParagraphStyle(style)` | 固定路径（`config.md`）。内置编辑器「编辑 → 段落格式」：**只改 frontmatter 的 `paragraphStyle` 这一行**（`setConfigParagraphStyle`），别的字节一个不动；没有 `config.md` 就新建一份只有这一段 frontmatter 的（没有小节，「小说配置」仍算没填，主按钮不变）。经 `write` 落盘、不弹覆盖审阅（改的只是作者在菜单里点的那一个键），带读到时的 hash 当乐观锁；已经是这个值时不写 |

调用方手里只有对象，让它自己去拼路径等于把命名规则复制一份出去。

它们仍然经同一套 handler 记账与伴生，只是路径由这一层算出来。
