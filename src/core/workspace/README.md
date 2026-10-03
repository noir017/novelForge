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

- 细纲的文件名由「章号 + 标题」决定，改标题要清掉旧文件名
- 写细纲要记 `upstreamHash`（大纲里覆盖本章那一节的指纹），写正文要在细纲上记
  `writtenFrom`（正文据以写成的细纲指纹），漏了新鲜度链就断
- 删除一律进 `.trash/`；同名目标一律报错退出——**会话删除走的是同一套**（`trashPathFor`），不真删不是文件独有的行为（AGENTS 第 6 条）

所以 **`write` 不是「往这个路径写字节」**，而是「按这个路径**应有的种类**写一份
合法产物」——种类判定、渲染、记账、伴生搬迁、覆盖审阅全在这一层做一次。

## 新代码不许绕过 guard 直接 `fs.writeFile`

八条守卫只在这条路上做。绕过去等于给自己开一个后门，**而后门在界面上看不出来**。

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
| 8 | 内容 hash 乐观锁 | `WsConflictError(diskText, diskHash)` |

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
| `plot` | `plots/` **根下** + 数字前缀 + markdown | `plotFile.ts` | 写入记大纲里覆盖本章那一节的指纹（`outlineUpstreamHash`） | — |
| `chapter` | 章节根下 + 数字前缀 + 扩展名不在黑名单 | `chapterFile.ts` | —（正文依据的细纲指纹记在细纲的 `writtenFrom` 上） | 改名/移动带草稿；写后 `syncManifest` |
| `summary` | `summaries/` 镜像 | frontmatter + 小节 | `sourceHash` | 写后 `markSummarized` |
| `character` / `lore` | 各自区 + `.md` | frontmatter | — | — |
| `draft` | `drafts/` 下 | 纯文本 | — | **永不自动进上下文** |
| `other` | 其余工程内文本 | 纯文本 | — | — |

三条判定上的取舍：

1. **`chapter` 不看是不是 `.md`**（AGENTS 第 9 条：章节不认扩展名）。
   `001-楔子.txt`、`001-楔子`（无扩展名）、`004.json` 都算章节；
   角色 / 设定 / 细纲**不**跟着放宽，它们是插件自己的数据格式。
2. **章节路径不带创作目标**：正文就是章节，第 N 章的细纲在哪要按号去 `plots/`
   里认——那一步要读盘，不在这里做（`views/pipeline.ts` 的 `chapterTargetOf`）。
   `pathOfTarget` 对正文 target 直接抛，提示调用方改用它。
3. **`summaries/global.md` 排在单章摘要之前判**，否则会被当成第 0 章的摘要。
4. **老工程留下的 `scenes/`、`volumes/`、`manuscripts/` 与 `plots/` 下的卷子目录
   都判成 `other`**：那几层已经删掉（见 `model/pipeline.ts` 的文件头）。那些文件
   是作者的东西，磁盘上一个字节都不动，但代码里彻底不认——`guard.ts` 的
   `isProtectedPath` 仍然把那几个目录列为受保护目录，免得哪条文件操作把它们整棵删掉。

## 记账下沉（网关收拢那一期唯一有意的行为变化）

`upstreamHash` 从前**只在采纳路径上记**（`features/creation.ts` 的
`acceptPlot` / `acceptManuscript`）。作者在
内置编辑器里改一份细纲，指纹链就断了——那一章从此再也不挂 ⟳。

下沉到写入路径本身之后，**任何一次 `workspace.write` 到 plot 路径都记**。细纲的
上游是**大纲里覆盖本章的那一节**（`plotUpstreamHash` → `outlineUpstreamHash`，大纲
没有区间标题时退回全书的指纹）——大纲一段一段续写，续写第 21–40 章不该让前 20 章
的细纲挂 ⟳。正文那一环（`writtenFrom`）由正文落盘那一步记（`recordWrittenFrom`），
作者在编辑器里手改正文不动它。三条配套约束一条没变：

- **手写的产物永不标脏**：`upstreamHash` / `writtenFrom` 为空 = 不是这条链生出来的，不给它补一个
- **`plotContentHash` 只哈希三个小节**，不含 frontmatter——那两个指纹自己就在
  frontmatter 里，算进去会让「排一次细纲」立刻使这一章的正文过期
- **不哈希状态位**——作者把某一章标成 `done`（`status: done` 在 frontmatter 里），
  那一次写入不该让刚写好的正文立刻显示「上游已变更」

## 全文检索（`search.ts`）

**零模型调用的朴素扫描**。作者问「主角前面说过他没去过北境吗」，从前只能靠手动
`@` 引用几章原文；把它做成 AI 功能等于每问一句烧一次钱，而且会给出看起来很像但
没有依据的答案——与「新鲜度只靠 hash 传播，不调模型」是同一条取舍。

四条实现约束：

1. **跳过 `.trash/` 与二进制**——回收站里躺着刚删掉的东西，搜出来等于没删。
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
├── search.ts       全文检索（朴素扫描，零模型调用）
└── handlers/
    ├── index.ts    种类 → handler 注册表（认不出落 plain，绝不抛）
    ├── types.ts    Handler 的四件事：render / resolve / after / companions
    ├── setting.ts  架构三件（小节换新、配置 frontmatter 合并）
    ├── plot.ts     渲染 + 记 upstreamHash
    ├── chapter.ts  草稿跟随 + manifest 同步（删章节不删草稿）
    ├── summary.ts  manifest 同步
    ├── doc.ts      outline / style / globalSummary / threads / character / lore
    └── plain.ts    other / draft（纯文本，无记账）
```

## 领域写入器

上面七个方法收的是**路径**。另有一批收**领域对象**：

| 方法 | 落点由什么决定 |
|---|---|
| `writePlot` / `deletePlot` | 章号 + 标题（平铺在 `plots/` 根下；改章号要传原路径） |
| `recordWrittenFrom` | 细纲路径（只改 frontmatter 的 `writtenFrom`，正文一个字节不动） |
| `recordPreflightOk` | 细纲路径（只改 frontmatter 的 `preflightOk`：一致性预检的永久放行，一行「名字：理由」，同名换新理由；没有 frontmatter 的手写细纲不补，五期补遗 §2） |
| `createChapter` / `ensureDraft` | 章号 + 标题 / 章节路径的镜像 |
| `createChapters(items)` | 同 `createChapter`，一次好几章（导入原稿）：每章照样过 `write`（同名报错退出、大小上限），只是 chapter handler 的 manifest 同步**延到最后做一次**（`WriteOptions.deferAfter`，只对章节生效）——逐章重扫全部章节是 O(n²) 次读盘，三百章十几秒。撞了同名就抛，前面写好的留着、manifest 照样同步 |
| `writeSummary` | 章节路径的镜像 |
| `writeCharacter` / `writeLore` | slug（可带子目录） |
| `writeStyleGuide` / `writeGlobalSummary` | 固定路径 |
| `writeSkillBindings(text)` | 固定路径（`skills.json`）。设置页「技能」与 `skills bind` 动手前都已经问过作者，这里不再弹覆盖审阅——每换一次下拉框弹一个 JSON 的 diff 只是噪声 |
| `updateThreads(edit)` | 固定路径（`threads.md`）。读**此刻**的原文交给 `edit`、写回它给的新原文：排线、定稿要调几十秒模型，写之前重读，作者这期间的改动才不会被一份旧全文冲掉 |

调用方手里只有对象，让它自己去拼路径等于把命名规则复制一份出去。

它们仍然经同一套 handler 记账与伴生，只是路径由这一层算出来。
