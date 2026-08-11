# core/model — 数据层

小说工程的数据模型与全部文件读写。所有上层功能（上下文装配、生成、摘要）都通过这一层访问数据，不直接碰磁盘。

核心约定：**数据是工作区里的普通 Markdown / JSON**，作者随时可以在编辑器里手改。因此本层的一切解析都以「容错优先」——手改文件不该让插件崩掉。

## 文件

| 文件 | 职责 |
|---|---|
| [types.ts](types.ts) | 全部数据结构：`Chapter` / `ChapterSummary` / `SummaryCast` / `CharacterCard` / `LoreEntry` / `NovelConfig`，以及摘要与角色卡的**固定小节**定义（`SUMMARY_SECTION_KEYS`、`CHARACTER_SECTION_KEYS`）。 |
| [chapterFile.ts](chapterFile.ts) | ★ 「什么文件算章节」的唯一定义：数字前缀 + 扩展名不在二进制黑名单里。纯函数无 I/O，扫描器、编辑器可编辑判定、独立版文件监听三处共用。 |
| [pipeline.ts](pipeline.ts) | ★ **创作流水线的领域模型**：`Stage × Capability × Target` 三元组、每阶段的身份与可用能力、`CreationTarget` 与它的稳定字符串键、章节流水线状态的推导（`deriveStage` / `deriveProgress`），以及界面直接吃的两样——`commandsFor`（`/` 命令面板的命令表）与 `deriveNextStep`（状态机 → 主按钮上那一个动作，判据与 `deriveStage` 同源）。**纯类型 + 纯函数，零 import**，所以前端可以直接 import 同一份表。 |
| [planFile.ts](planFile.ts) | 章节细纲（`.novelforge/plans/<镜像章节路径>.md`）的格式：五个固定小节 + frontmatter 的 `upstreamHash`。纯函数无 I/O。 |
| [sceneFile.ts](sceneFile.ts) | 场景卡（`.novelforge/scenes/<镜像章节路径>/NN-标题.md`）的格式：七个固定小节 + 场号来自文件名前缀。纯函数无 I/O。**只认 `.md`**——它是插件自己的数据格式，与「章节不认扩展名」相反。 |
| [markdown.ts](markdown.ts) | 轻量 Markdown 结构工具：YAML frontmatter 与「## 小节」的解析/序列化，以及四个 frontmatter 取值兜底（`asString` / `asArray` / `asNumber` / `asNumberArray`）。刻意不引入 yaml 依赖，解析失败退化为忽略该行而非抛错。 |
| [project.ts](project.ts) | ★ `NovelProject`：数据访问层，所有 read*/write* 都在这里。含初始化模板、章节索引、草稿/摘要/细纲/场景四套镜像路径推导、摘要与场景的新鲜度指纹（`beatsHashFor`）、`.novel` → `.novelforge` 迁移检测，以及三个区目录的**递归扫描**。 |
| [providers.ts](providers.ts) | ★ 多服务商/多模型的数据模型。「前缀/模型名」引用只在**第一个**斜杠处切分（OpenRouter 的模型名本就含斜杠）；含 0.1.x 单服务商配置的兼容兜底。 |
| [tiers.ts](tiers.ts) | ★ **模型分档**：三档（快速 / 均衡 / 精标）与十项后台任务的归属。纯数据 + 纯函数（`tierOf` / `refsForTask` / `describeTaskModels`），无 I/O 也无 Node 依赖——所以设置页可以直接 import 同一份标签与默认映射，界面上写的和跑起来的必然一致。 |
| [session.ts](session.ts) | 对话会话存储：`.novelforge/sessions/<id>.json`。含当前创作目标（`target` / `stage` / `capability`）、`Attachment`（@ 引用）、`ContextDigest`（上下文明细快照）的序列化，以及旧会话的容错归一。 |

## 关键设计

- **每次读盘，不缓存正文**：`read*` 方法每次调用都重新读文件（作者可能刚手改完），只有章节列表做一层缓存，由 FileSystemWatcher 主动失效。
- **目录是任意深度的**：`chapters/`、`characters/`、`lore/` 都递归扫描，作者可以按卷、按阵营分子目录整理。隐藏目录（含 `.trash/`）与 `node_modules` 一律跳过，深度上限 8 层。
- **章节认任意扩展名，角色/设定只认 `.md`**：章节的判定在 `chapterFile.ts`——数字前缀 + 非二进制扩展名，所以 `001-楔子.txt`、`001-楔子`（无扩展名）、`004.json` 都是章节，`001-封面.png` 不是。角色卡与设定条目是插件自己的数据格式（frontmatter + 固定小节），不跟着放宽；`listFilesDeep` 收 accept 回调，两类各传各的。
- **顺序只看序号**：章节顺序由文件名数字前缀决定，与所在层级无关；`卷一/003-x.md` 与 `003-x.md` 都是「第 3 章」。序号撞车时两条都留在树上，让作者看见冲突。
- **只有 markdown 家族解析 H1**：`.md`/`.markdown` 的章节标题取自正文首行的 `# 标题`（`readChapterText` 会剥掉），其余格式一律取文件名、正文一个字节不动。`extractH1` 与 `stripH1` **都只看首行、互为逆运算**——早先 `extractH1` 带 `m` 标志扫全文，会把 `.txt` 正文中段的一行 `# xxx` 认成标题却不剥掉它。改这两个函数时务必保持互逆。（副作用：角色卡/设定条目里 `# 名字` 不在首行时，标题现在回落 `frontmatter.name` → 文件名。）
- **四套镜像路径，一条规则**：草稿、摘要、细纲、场景都按章节在**章节根之下**的那段相对路径镜像到各自的目录下（`chapters/卷一/012-夜入.md` → `plans/卷一/012-夜入.md`、`scenes/卷一/012-夜入/`），不落任何索引——没有索引就没有会漂移的第二份真相。章节改名/移动时四套一并跟着走（`fileOps.ts` 的 `carryMirror`），少一套就会出现「界面上一切正常，但写好的细纲凭空消失」。四者共用 `underChapters()` 判断「这一章在不在 chapters/ 下」。
- **正文文件永远不带 frontmatter**：章节可以是 `.txt` / 无扩展名 / `.json`，所以正文所依据的场景指纹 `beatsHash` 落在 `manifest.chapters[].beatsHash` 里，与既有的 `summaryHash` 并排——不能像细纲/场景那样写进文件自己的 frontmatter。
- **草稿是纯推导出来的**：`draftRelPathFor` 把章节在**章节根之下**的那段相对路径镜像到 `draftsDir` 下，文件名含扩展名原样沿用。`ensureDraft` 按需创建、已存在原样返回（不静默覆盖）；`listDraftPaths` 一次遍历给出全部已存在的草稿，供工程页与 `@` 引用共用（每章一次 stat 会把工程页刷新的 syscall 翻一倍）。`draftsDir` 是 `chaptersDir` 的兄弟目录、不从它派生，因此改 `chaptersDir` 不影响草稿落点；`chapterSkipDirs()` 兜住 `chaptersDir` 被配成 `.` 的极端情况。
- **场景的 `characters` 不进出场统计**：frontmatter 里那份是**计划出场**，摘要里的 `cast` 才是**实际出场**。混进 `castIndex` 会污染出场章节统计与角色卡语料（AGENTS.md 第 14 条）。这条看起来很诱人，写在 `sceneFile.ts` 的文件头是为了别让人手滑。
- **角色/设定的 slug 是路径**：根目录下的文件 slug 就是文件名（与改造前一致），子目录里的形如 `主角/林昭`——上下文明细里的 `character:<slug>` 因此仍然唯一。
- **摘要新鲜度**：章节保存后重算 `contentHash`（哈希的是**整份正文含标题行**，口径不能改，否则所有既有摘要一夜之间全部过期），与摘要 frontmatter 里的 `sourceHash` 比对，不一致即过期。摘要不自动生成，只提示。`syncManifest` 按路径匹配不上时会按 order 兜底，因此把章节挪进子目录（或改扩展名）不会丢掉「已总结」的记录。
- **出场人物有两种形态，一份信息**：摘要 frontmatter 的 `cast: [林昭, 年轻守卫(那个年轻人)]` 给程序用（角色页聚合、角色卡关联），`## 出场人物` 小节给人看。写的时候从结构化 cast 渲染出小节，保证两者一致；**读的时候以 frontmatter 为准，字段缺席才从小节文本反解**（`castFromText`）——0.2.x 之前的摘要与作者手写的摘要没有这个字段，不该因此在角色页上凭空少一批人。用括号而不是嵌套 YAML 是因为本层的 frontmatter 解析器刻意只支持字符串与字符串数组，为一个字段引入真正的 yaml 依赖不值得，而括号形式作者也能直接手改。
  `castFromText` 的两条判据（名字 ≤ 8 字、不含「的了是在不没」这类虚词）是为了挡住模型把这一节写成句子的情况——按标点切开会得到一串句子碎片，全都会跑进角色页的「未建卡」组里。宁可漏掉一两个长称呼，也不能让那一组塞满垃圾；漏掉的重新生成摘要就有了（新摘要走结构化 cast，根本不经过这个函数）。
- **角色卡的 `appearsIn` / `updatedThrough` 是缓存**：前者是该角色出场的章节序号，后者是上次「更新角色卡」读到了第几章（增量更新的依据）。真相永远是各章摘要，落在卡里只为两件事——不读全部摘要就能在角色页显示「出场 12 章」，以及日后按人物检索章节。
- **会话用 JSON 而不是 Markdown**：会话是机器记录（含 token 明细、附件快照），不期待人工编写，但仍是纯文本、可 Git。
- **选区引用存快照**：`Attachment.text` 对 selection 存当时的快照，历史对话不因原文修改而变；整文件引用每次读盘取最新。

## 依赖关系

本层是依赖的最底层，只依赖 Node API（`fs` / `path` / `crypto`）与 `vscode`（仅用于读配置与消息提示）。`context/`、`features/`、`llm/`、`ui/` 都依赖本层，反向不允许。
