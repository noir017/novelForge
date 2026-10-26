# core/model — 数据层

小说工程的数据模型与全部文件读写。所有上层功能（上下文装配、生成、定稿）都通过这一层访问数据，不直接碰磁盘。

核心约定：**数据是工作区里的普通 Markdown / JSON**，作者随时可以在编辑器里手改。因此本层的一切解析都以「容错优先」——手改文件不该让插件崩掉。

## 文件

| 文件 | 职责 |
|---|---|
| [types.ts](types.ts) | 全部数据结构（`Chapter` / `SummaryCast` / `CharacterCard` / `LoreEntry` / `ProjectManifest` / `NovelConfig`）与角色卡的固定小节定义。 |
| [chapterFile.ts](chapterFile.ts) | ★ 「什么文件算章节」的唯一定义（第 9 条）。纯函数，扫描器、编辑器、独立版文件监听共用。 |
| [naming.ts](naming.ts) | ★ 称呼学（纯函数）：判泛称、过滤别名；只过滤 aliases、不过滤 name，剧作称谓（`主角`、`反派`）例外。 |
| [identity.ts](identity.ts) | ★ 同一人聚类（纯函数）：同章共现作硬约束的贪心聚类，不用并查集。 |
| [gender.ts](gender.ts) | 角色卡 `gender` 的归一（`normalizeGender`）与合并口径（`keepGender`：卡上写了的不动）。 |
| [pipeline.ts](pipeline.ts) | ★ **创作流水线的领域模型**：`Stage × Capability × Target`、全书与单章两级状态机（`deriveBookNextStep` / `deriveNextStep` / `deriveStage`）与各动作的调用次数。纯函数。 |
| [settingFile.ts](settingFile.ts) | ★ 架构层三份文档（`config.md`、`premise.md`、`world.md`）的格式与读写。 |
| [plotFile.ts](plotFile.ts) | ★ 一章细纲的格式：镜像正文路径、七节加「设定」一节、梗概的指纹；写之前是计划，定稿后是实际。 |
| [loreFile.ts](loreFile.ts) | ★ 设定的格式与认法：细纲「设定」一节一行一条、条目的一句话与「暗设」、分类就是目录。 |
| [outlineFile.ts](outlineFile.ts) | ★ 情节大纲**一章一条**的认法、按远近带，以及从各章细纲梗概汇总、存时拆回的规矩。 |
| [structureGuide.ts](structureGuide.ts) | 故事结构指导：六种结构按累计百分比切成章号区间。纯函数。 |
| [markdown.ts](markdown.ts) | 轻量 Markdown 工具：frontmatter 与「## 小节」的解析 / 序列化、取值兜底；解析失败忽略该行、不抛。 |
| [fs.ts](fs.ts) | 磁盘与字符串小工具：文本读写、稳定哈希、字数统计、文件名清理、slug 生成与扫描目录忽略规则。 |
| [castParse.ts](castParse.ts) | 出场人物字段的序列化与解析（`pushCast`：称谓换真名、光称谓丢掉）。 |
| [continuity.ts](continuity.ts) | ★ 细纲的「连续性事实」：渲染与读回、定稿时找证据（`attachEvidence`）、写正文时按证据定位（`locateEvidence`）。 |
| [writingSkill.ts](writingSkill.ts) | 写作技能的纯函数：读 `SKILL.md`、不兼容规则、技能 id、阶段绑定文件的格式。 |
| [importText.ts](importText.ts) | 拆书的纯函数：解码、认章标题、切章、抽样与篇幅统计。 |
| [threadFile.ts](threadFile.ts) | ★ 叙事线的格式：一条线一个文件、状态从事件现算、外科式写入、各阶段挑哪几条、判到哪的水位。 |
| [timelineFile.ts](timelineFile.ts) | ★ 故事时间 `threads/时间线.md`：一章一行的认法、历法与日期推算、对账；机器写的行能换，作者的不动。 |
| [characterState.ts](characterState.ts) | ★ 角色卡「当前状态」归谁：空着或 `stateHash` 对得上归机器，其余归作者；`patchCardState` 只换那一节。 |
| [review.ts](review.ts) | ★ 审稿报告：目标冻结、引文归一与定位（`normalizeQuote` / `locateQuote`）、报告的解析。 |
| [plotCheck.ts](plotCheck.ts) | 写前冲突检查的选事实、提示词与校验：只认硬矛盾，每一处都要带两句能在原文里找到的引文。 |
| [preflight.ts](preflight.ts) | ★ 一致性预检：细纲排出场的人在卡上或连续性事实里已经死了 → 一条风险。 |
| [manuscriptCheck.ts](manuscriptCheck.ts) | 写完一章之后的确定性检查（禁用词、停在半句、比喻词计数）与续写回退点。 |
| [sensitiveWords.ts](sensitiveWords.ts) | 自定义敏感词表 `.novelforge/sensitive.txt` 的解析（写作体检用），坏行跳过并记原因。 |
| [trimProse.ts](trimProse.ts) | 删修饰的纯函数：切段编号、读回 `[n] 正文`、只许删的逐段验收（`trimProblem`：新增汉字按字 LCS 算、对白一字不差、删完至少留四成、段尾标点不变）、拼回正文并按八成保底退回删得最多的段（`applyTrim`）。纯函数、零 import。 |
| [paragraphFormat.ts](paragraphFormat.ts) | ★ **正文的分段格式与一键排版**（`paragraphStyle` 三个值，`formatProse` / `layoutProse`）。 |
| [textFind.ts](textFind.ts) | 查找替换的匹配口径（编正则、找全部匹配、`$1` 展开、只换选中的几处），编辑器查找条与全书查找替换共用。 |
| [bookDir.ts](bookDir.ts) | 新建一本书时的文件夹名（`bookDirName`）。纯函数，前端也打包它。 |
| [bookFindScope.ts](bookFindScope.ts) | 全书查找替换的范围表与上限（`BOOK_FIND_LIMIT`）。纯数据，前端也打包它。 |
| [bookFind.ts](bookFind.ts) | 全书查找替换在一份文件上的口径：哪些字不搜不换（`protectionOf`：frontmatter 的机器账、解析器认的小节标题）。 |
| [paragraphDiff.ts](paragraphDiff.ts) | 段级 diff（五期 W11）：按空行切段、段序列 LCS、相邻改动并成一处，`joinMerge` 拼合并结果。独立版的合并视图直接打包它。纯函数、零 import。 |
| [project.ts](project.ts) | ★ `NovelProject`：只读的数据访问层（写盘在 `core/workspace/`）：脚手架、章节索引、架构读取、细纲按路径配对、定稿查询、回收站落点。 |
| [providers.ts](providers.ts) | ★ 多服务商 / 多模型的数据模型；引用只在第一个斜杠处切分（第 5 条）。 |
| [tiers.ts](tiers.ts) | ★ **模型分档**：三档与各项后台任务的归属（含 `review`、`transcribe`）。纯数据 + 纯函数。 |
| [transcribe.ts](transcribe.ts) | 转写与具体哪一步无关的那一半：两条消息（`transcribeMessages`）与温度 0；整条走法在 features/transcribe.ts。 |
| [callChoice.ts](callChoice.ts) | 调模型之前那一问的两个下拉框：`CallChoice` / `CallPrompt` / `CallAnswer`。 |
| [thinking.ts](thinking.ts) | ★ **思考深度**的档位表与两家的字段映射；「不思考」不带任何思考参数。 |
| [contextDetail.ts](contextDetail.ts) | ★ **上下文详细度**四级与每一级的全部上限；`contextLimitsOf(config)` 是唯一的取法。 |
| [session.ts](session.ts) | 对话会话存储 `.novelforge/sessions/<id>.json`：创作目标、@ 引用、上下文明细快照的序列化与旧会话归一。 |

## 关键设计

- **每次读盘，不缓存正文**：`read*` 方法每次调用都重新读文件（作者可能刚手改完），只有章节列表做一层缓存，由 FileSystemWatcher 主动失效。
- **目录是任意深度的**：`chapters/`、`characters/`、`lore/` 都递归扫描，作者可以按卷、按阵营分子目录整理（`summaries/` 也递归扫：细纲跟着正文的子目录走）。隐藏目录（含 `.trash/`）与 `node_modules` 一律跳过，深度上限 8 层。
- **章节认任意扩展名，角色/设定只认 `.md`**：章节的判定在 `chapterFile.ts`——数字前缀 + 非二进制扩展名，所以 `001-楔子.txt`、`001-楔子`（无扩展名）、`004.json` 都是章节，`001-封面.png` 不是，`047 细纲.txt`、`048 作话.txt` 这种整个标题就是笔记词的也不是。角色卡与设定条目是插件自己的数据格式（frontmatter + 固定小节），不跟着放宽；`listFilesDeep` 收 accept 回调，两类各传各的。
- **顺序只看序号，一条轴**：章节顺序由文件名数字前缀决定，与所在层级无关；`卷一/003-x.md` 与 `003-x.md` 都是「第 3 章」。细纲号就是章号，但配对按路径：有正文的章只认正文镜像的那份细纲（`NovelProject.plotFor`），还没有正文的章按号认计划。序号撞车时两条都留在树上，让作者看见冲突，流水线认路径排序第一份正文。
- **只有 markdown 家族解析 H1**：`.md`/`.markdown` 的章节标题取自正文首行的 `# 标题`（`readChapterText` 会剥掉），其余格式一律取文件名、正文一个字节不动。`extractH1` 与 `stripH1` **都只看首行、互为逆运算**——早先 `extractH1` 带 `m` 标志扫全文，会把 `.txt` 正文中段的一行 `# xxx` 认成标题却不剥掉它。改这两个函数时务必保持互逆。（副作用：角色卡/设定条目里 `# 名字` 不在首行时，标题现在回落 `frontmatter.name` → 文件名。）
- **草稿与细纲都按章节路径镜像**：`chapters/第一卷/012-夜入.txt` → `drafts/第一卷/012-夜入.txt`（文件名原样）、`.novelforge/summaries/第一卷/012-夜入.md`（扩展名换成 `.md`），不落索引——没有索引就没有会漂移的第二份真相。章节（文件或整个卷目录）经网关改名/移动时草稿与细纲跟着搬（`workspace/handlers/chapter.ts` 的 `carryDraft` / `carryPlot`；移出 `chapters/` 就留在原处），单章改名时细纲里的标题也跟着改成新名（`Workspace.retitlePlot`，只改标题两行；作者在细纲上另起过的不动），删章节两样都不删（第 10 条；细纲退回这一章的计划）；在外面直接给正文改名，旧细纲不被新路径冒认（那是一章新的）。细纲改名改的是标题：没有正文时文件名跟着标题，有正文时文件名跟着正文不动；正文从不跟着细纲改名（作者的文件）。照细纲新写正文时正文落在细纲所在的子目录，纯序号的细纲（`030.md`）配上有标题的正文会跟着改名（`Workspace.createChapterAt`）。目标已存在时**不动**（不静默覆盖）。
- **`deletePlot` 不碰 `chapters/`**：删细纲只是放弃这一章的规划稿（定稿过的连同档案一起进回收站），正文是作者的东西，不该被顺手带走。
- **新建只出序号名**：`writePlot` / `createChapter` 的 `title` 允许为空，那时落成 `007.md` 且不写 H1——手工新建一章时还没有标题可言，凭空塞一个「第7章」进文件名只是个假标题，而它会进上下文。为此有个 `safeStem`：**空标题给空串，不给 `sanitizeFileName` 的兜底名「未命名」**，否则会得到 `007-未命名.md`。标题回落链（`extractH1` → 文件名词干 → `第 N 章`）本来就认这种名；界面上的说法统一走 `pipeline.ts` 的 `chapterLabel`，未命名时只报序号。写 H1 时用的是**清洗后的词干**而不是原样 `title`，两者一致，改名时 `renamedBody` 才认得出「这个 H1 是跟着文件名走的」。
- **正文依据的细纲指纹记在细纲上**：章节可以是 `.txt` / 无扩展名 / `.json`，是作者的东西、没有 frontmatter，所以「这份正文依据的是哪一版细纲」记在细纲自己的 frontmatter（`writtenFrom`），由正文落盘那一步写（`workspace.recordWrittenFrom`），定稿时刷成反向更新之后的指纹——之后再改细纲，正文才挂 ⟳。定稿时正文的 `contentHash` 记在同一份 frontmatter 的 `sourceHash` 上。从没记过（作者手写的正文）就永不标脏。老工程 `manuscripts/` 里的中转站正文、`plots/` 里的老细纲一个字节都不动，代码不再读。
- **草稿是纯推导出来的**：`draftRelPathFor` 把章节在**章节根之下**的那段相对路径镜像到 `draftsDir` 下，文件名含扩展名原样沿用。`ensureDraft` 按需创建、已存在原样返回（不静默覆盖）；`listDraftPaths` 一次遍历给出全部已存在的草稿，供工程页与 `@` 引用共用（每章一次 stat 会把工程页刷新的 syscall 翻一倍）。`draftsDir` 是 `chaptersDir` 的兄弟目录、不从它派生，因此改 `chaptersDir` 不影响草稿落点；`chapterSkipDirs()` 兜住 `chaptersDir` 被配成 `.` 的极端情况。
- **出场人物只认定稿过的细纲**：有 `sourceHash` 的细纲，它的 `cast` 是**实际出场**，也是唯一的真相（AGENTS.md 第 14 条）。没定稿的细纲里「出场人物」一节是**计划**出场：只给装配器挑角色卡（`context/layers/render.ts` 的 `selectCharacters`）、算「后几章才出场的人」与一致性预检用，不进 `castIndex`——混进去会污染出场章统计与角色卡语料（D13）。
- **角色/设定的 slug 是路径**：根目录下的文件 slug 就是文件名（与改造前一致），子目录里的形如 `主角/林昭`——上下文明细里的 `character:<slug>` 因此仍然唯一。
- **定稿对不对得上按章算**：`chapters/` 里的成品写盘后重算 `contentHash`，与正文镜像那份细纲 frontmatter 里的 `sourceHash` 比对（`finalizedPlotOf`），不一致就回到待定稿。**空章不算没定稿**——没有正文就无从定稿，混进来会让同步细纲的确认框报一个虚高的调用次数。不自动重新定稿，只提示。manifest 只是章节索引，不记任何定稿的账。
- **出场人物有两种形态，一份信息**：定稿过的细纲 frontmatter 的 `cast: [林昭, 年轻守卫(那个年轻人)]` 给程序用（角色页聚合、角色卡关联），`## 出场人物` 小节给人看。定稿时从结构化 cast 渲染出小节，保证两者一致；**读的时候以 frontmatter 为准，字段缺席才从小节文本反解**（见 [castParse.ts](castParse.ts) 的 `castFromText`）——老工程的摘要与作者手写的细纲没有这个字段，不该因此在角色页上凭空少一批人。用括号而不是嵌套 YAML 是因为本层的 frontmatter 解析器刻意只支持字符串与字符串数组，为一个字段引入真正的 yaml 依赖不值得，而括号形式作者也能直接手改。
  `castFromText` 的两条判据（名字 ≤ 8 字、不含「的了是在不没」这类虚词）是为了挡住模型把这一节写成句子的情况——按标点切开会得到一串句子碎片，全都会跑进角色页的「未建卡」组里。宁可漏掉一两个长称呼，也不能让那一组塞满垃圾；漏掉的重新定稿就有了（定稿走结构化 cast，根本不经过这个函数）。计划名单（`plannedNames`）不套这两条：那是作者与排细纲的模型写的名单，「沈从文」不该因为带个「从」就漏掉。
- **角色卡的 `stateThrough` / `stateHash` 是「当前状态」的归属账**（四期，D15）：前者是这一节写到第几章（0 = 开篇，角色图谱建卡时写的），后者是机器最后一次写它时的指纹。`renderCharacterCard` 原样带着它们走——清理别名、合并重复卡这些维护动作不重新盖章，作者改过的那一节不会因为换了个别名就变成「机器写的」。
- **角色卡的 `appearsIn` / `updatedThrough` 是缓存**：前者是该角色出场的章号，后者是上次「更新角色卡」读到了第几章（增量更新的依据）。真相永远是各章定稿过的细纲，落在卡里只为两件事——不读全部细纲就能在角色页显示「出场 12 章」，以及日后按人物检索章节。
- **会话用 JSON 而不是 Markdown**：会话是机器记录（含 token 明细、附件快照），不期待人工编写，但仍是纯文本、可 Git。
- **选区引用存快照**：`Attachment.text` 对 selection 存当时的快照，历史对话不因原文修改而变；整文件引用每次读盘取最新。

## 依赖关系

本层只依赖 Node API 与 core 内更底层模块；`context/`、`features/`、`llm/` 依赖本层，反向不允许。
