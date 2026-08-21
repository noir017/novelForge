# core/model — 数据层

小说工程的数据模型与全部文件读写。所有上层功能（上下文装配、生成、摘要）都通过这一层访问数据，不直接碰磁盘。

核心约定：**数据是工作区里的普通 Markdown / JSON**，作者随时可以在编辑器里手改。因此本层的一切解析都以「容错优先」——手改文件不该让插件崩掉。

## 文件

| 文件 | 职责 |
|---|---|
| [types.ts](types.ts) | 全部数据结构：`Chapter` / `ChapterSummary` / `SummaryCast` / `CharacterCard` / `LoreEntry` / `NovelConfig`，以及摘要与角色卡的**固定小节**定义（`SUMMARY_SECTION_KEYS`、`CHARACTER_SECTION_KEYS`）。 |
| [chapterFile.ts](chapterFile.ts) | ★ 「什么文件算章节」的唯一定义：数字前缀 + 扩展名不在二进制黑名单里。纯函数无 I/O，扫描器、编辑器可编辑判定、独立版文件监听三处共用。 |
| [naming.ts](naming.ts) | ★ 称呼学（纯函数、零 I/O）：`isGenericAppellation` 判断一个词是不是泛称（代词、亲属称谓、`少女`/`丫头` 这类谁都能用的词、带修饰语的描述短语），`sanitizeAliases` 据此过滤别名。**只过滤 aliases，绝不过滤 name**——`店小二`、`家老`、`房东` 这类以泛称当正式名的角色确实存在。 |
| [identity.ts](identity.ts) | ★ 同一人聚类（纯函数）：把摘要里散落的称呼归并成人。判据是**同章共现作硬约束的贪心聚类**——同一章 cast 里各自出场的两个称呼永不合并，候选链接按「多少章这么写过」计票贪心处理。朴素并查集在这里是错的：一条幻觉别名会顺着传递闭包把主角和她孪生弟弟并成一个人。 |
| [pipeline.ts](pipeline.ts) | ★ **创作流水线的领域模型**：`Stage × Capability × Target` 三元组（阶段仍是四个：大纲/剧情/细节/正文——**卷不是一个阶段**，`CreationTarget` 多一个 `volume` 而 `stageOfTarget` 把它归到 `outline`）、每阶段的身份与可用能力（`settle` 只有剧情层有）、`CreationTarget` 与它的稳定字符串键、界面说法的三份口径（`chapterLabel` / `segmentLabel` / `volumeLabel`）与位次推导 `segmentDisplayNo`、单段流水线状态的推导（`deriveStage` / `deriveProgress`，含「待拆分」那一档）与全书状态机（`deriveBookStage` / `deriveBookNextStep`，四档：大纲 → 卷 → 段 → 按段推进），以及界面直接吃的两样——`commandsFor`（`/` 命令面板的命令表，**按 target 具体化**：同一个「拆分」在全书大纲上叫「拆成卷」、在一卷上叫「拆出剧情段」）与 `deriveNextStep`（状态机 → 主按钮上那一个动作，判据与 `deriveStage` 同源）。**纯类型 + 纯函数，零 import**，所以前端可以直接 import 同一份表。它继续留在 `model/`；读磁盘的聚合器是 [`../views/pipeline.ts`](../views/pipeline.ts)，不要混为一处。 |
| [volumeFile.ts](volumeFile.ts) | ★ 一卷的卷纲（`.novelforge/volumes/NN-卷名.md`）的格式：**四个固定小节**（目标 / 剧情走向 / 关键转折 / 伏笔与回收）+ frontmatter 的 `upstreamHash`，卷号来自文件名前缀（**两位数**——一本书几百章是常态，几百卷不是，而这个词干还要当 `plots/` 下的目录名用）。`isVolumeFilled` **只认「剧情走向」**。小节名刻意与细纲不同：两层同名会让装配出来的上下文里两层长得一模一样。纯函数无 I/O，**只认 `.md`**。 |
| [plotFile.ts](plotFile.ts) | ★ 一个剧情段的细纲（`.novelforge/plots/<卷词干>/NNN-段名.md`）的格式：**四个固定小节**（目标 / 剧情脉络 / 冲突与转折 / 伏笔与回收）+ frontmatter 的 `upstreamHash`（上游是**它所属那一卷**）与 `chapters`（这一段交付到了哪几章）。段号来自文件名前缀，它只是 `plots/` 里的**排序键**——一段可以拆成三章。`isPlotFilled` **只认「剧情脉络」**——只写了目标等于什么都没排，流水线该停在剧情层。纯函数无 I/O。**只认 `.md`**。 |
| [markdown.ts](markdown.ts) | 轻量 Markdown 结构工具：YAML frontmatter 与「## 小节」的解析/序列化，以及四个 frontmatter 取值兜底（`asString` / `asArray` / `asNumber` / `asNumberArray`）。刻意不引入 yaml 依赖，解析失败退化为忽略该行而非抛错。 |
| [fs.ts](fs.ts) | 磁盘与字符串小工具：文本读写、稳定哈希、字数统计、文件名清理、slug 生成与扫描目录忽略规则。 |
| [castParse.ts](castParse.ts) | 出场人物字段的序列化、frontmatter 解析与旧摘要小节文本反解。 |
| [project.ts](project.ts) | ★ `NovelProject`：数据访问层，所有 read*/write* 都在这里。含初始化模板、**章节**索引（manifest v1）、卷的查询（`listVolumes` / `readVolume` / `nextVolumeNo` / `listPlotsOfVolume`）、中转站正文按**段在 `plots/` 之下的整段路径**镜像的路径推导、摘要与草稿按章节路径镜像、`nextPlotNo()`（跨两个目录取最大号 +1）与 `nextChapterNo()`（只看 `chapters/`——章号自己一条轴，必须连续）、`.novel` → `.novelforge` 迁移检测，以及各区目录的**递归扫描**。 |
| [providers.ts](providers.ts) | ★ 多服务商/多模型的数据模型。「前缀/模型名」引用只在**第一个**斜杠处切分（OpenRouter 的模型名本就含斜杠）；含 0.1.x 单服务商配置的兼容兜底。 |
| [tiers.ts](tiers.ts) | ★ **模型分档**：三档（快速 / 均衡 / 精标）与十项后台任务的归属。纯数据 + 纯函数（`tierOf` / `refsForTask` / `describeTaskModels`），无 I/O 也无 Node 依赖——所以设置页可以直接 import 同一份标签与默认映射，界面上写的和跑起来的必然一致。 |
| [thinking.ts](thinking.ts) | ★ **思考深度**（不思考 / 浅 / 中 / 深 / 极限）的类型、可选值、界面说法，以及两家的字段映射（`responsesEffort` / `anthropicEffort` / `thinkingBudget`）。与 `tiers.ts` 同一套理由：纯数据 + 纯函数、零 import，所以对话页那个下拉框与两个 provider 共用同一份档位表。**「不思考」是不带任何思考参数**（不是显式关掉）——显式关的写法两家都只有部分模型认，而「不带」在所有模型上都合法，且恰好是这个功能出现之前的行为。 |
| [agentPolicy.ts](agentPolicy.ts) | ★ **Agent 的确认策略**（谨慎 / 默认 / 放手）的类型、可选值与界面说法。与 `tiers.ts` 同一套理由：纯数据 + 纯函数，所以 `config.ts`、`protocol/` 与设置页可以共用同一份，不必依赖 agent 层。**策略只管「要不要先问」，管不着保护**——八条守卫、覆盖前审阅、批量动作的「预计调用 N 次」在任何模式下都在（判定在 [agent/policy.ts](../agent/policy.ts)）。 |
| [session.ts](session.ts) | 对话会话存储：`.novelforge/sessions/<id>.json`。含当前创作目标（`target` / `stage` / `capability`）、`Attachment`（@ 引用）、`ContextDigest`（上下文明细快照）的序列化，以及旧会话的容错归一。`ChatTurn.command` 记这一轮下的是哪个命令（**按阶段具体化过的标签**，只在不是「讨论」时记），`turnPreview()` 是「这一轮说了什么」的唯一口径——命令类的轮次 `content` 本来就是空的（该说的都在产物里），气泡与历史列表都拿它，否则一片空白配一排「新对话」。 |

## 关键设计

- **每次读盘，不缓存正文**：`read*` 方法每次调用都重新读文件（作者可能刚手改完），只有章节列表做一层缓存，由 FileSystemWatcher 主动失效。
- **目录是任意深度的**：`chapters/`、`characters/`、`lore/` 都递归扫描，作者可以按卷、按阵营分子目录整理。隐藏目录（含 `.trash/`）与 `node_modules` 一律跳过，深度上限 8 层。
- **章节认任意扩展名，角色/设定只认 `.md`**：章节的判定在 `chapterFile.ts`——数字前缀 + 非二进制扩展名，所以 `001-楔子.txt`、`001-楔子`（无扩展名）、`004.json` 都是章节，`001-封面.png` 不是。角色卡与设定条目是插件自己的数据格式（frontmatter + 固定小节），不跟着放宽；`listFilesDeep` 收 accept 回调，两类各传各的。
- **顺序只看序号**：章节顺序由文件名数字前缀决定，与所在层级无关；`卷一/003-x.md` 与 `003-x.md` 都是「第 3 章」。序号撞车时两条都留在树上，让作者看见冲突。剧情段同理按段号排，但**段号只是排序键**：界面上那个「剧情 N」是位次（最新章号 + 在未交付的段里排第几），与文件名前缀不是一回事。
- **只有 markdown 家族解析 H1**：`.md`/`.markdown` 的章节标题取自正文首行的 `# 标题`（`readChapterText` 会剥掉），其余格式一律取文件名、正文一个字节不动。`extractH1` 与 `stripH1` **都只看首行、互为逆运算**——早先 `extractH1` 带 `m` 标志扫全文，会把 `.txt` 正文中段的一行 `# xxx` 认成标题却不剥掉它。改这两个函数时务必保持互逆。（副作用：角色卡/设定条目里 `# 名字` 不在首行时，标题现在回落 `frontmatter.name` → 文件名。）
- **两条镜像轴，各管一段**：拆分**之前**的伴生文件（中转站正文）按**段在 `plots/` 之下的整段路径**镜像（`plots/01-觉醒/012-夜入.md` → `manuscripts/01-觉醒/012-夜入.md`；未分卷的段镜像出来自然就是扁的，与分卷之前完全一致——老工程一个文件都不用搬）；拆分**之后**的两套（摘要、草稿）按**章节**在章节根之下的相对路径镜像（`chapters/012-夜入.md` → `summaries/012-夜入.md`、`drafts/012-夜入.md`）。都不落索引——没有索引就没有会漂移的第二份真相。改标题会改文件名，所以 `writePlot` 把中转站正文一并搬过去（`carryPlotCompanions`），`deletePlot` 一并搬进 `.trash/`；章节的改名/删除则搬后两套（`fileOps.ts` 的 `carryDraft` / `carrySummary`）。**卷改名要搬两棵目录树**（段、它们的中转站正文——卷词干是两处的第一级目录名，见 `workspace/handlers/volume.ts`）。少一套就会出现「界面上说这一段还没写正文，而那份正文躺在旁边一个孤儿目录里」。目标已存在时**不动**（不静默覆盖）。
- **`deletePlot` / `deleteVolume` 都不碰 `chapters/` 与摘要**：删规划稿只是放弃规划。已经拆出去的正文是作者发布过的东西，不该被顺手带走。
- **段的归属靠目录，不落 frontmatter**：`plots/01-觉醒之日/003-楼道.md` 属于 `volumes/01-觉醒之日.md`。再记一份 `volume:` 字段就会漂移（与「拆出去的章号不另存一份索引」同一条理由）。反过来，「这一段交付到了哪几章」**必须**记在细纲的 frontmatter（`chapters:`）里：`chapters/` 下的文件是作者的东西，拆分之后插件一个字节都不往里改，所以那条链只能从段指向章。
- **新建只出序号名**：`writePlot` / `createChapter` 的 `title` 允许为空，那时落成 `007.md` 且不写 H1——走流水线新建一章时还没有标题可言（它是排完剧情才定得下来的东西），凭空塞一个「第7章」进文件名只是个假标题，而它会进上下文。拆分出来的第 2 章及之后也走这条路（第一章沿用原标题，其余留空等作者改）。为此有个 `safeStem`：**空标题给空串，不给 `sanitizeFileName` 的兜底名「未命名」**，否则会得到 `007-未命名.md`。标题回落链（`extractH1` → 文件名词干 → `第 N 章`）本来就认这种名；界面上的说法统一走 `pipeline.ts` 的 `chapterLabel`，未命名时只报序号，不写成「第 7 章《第 7 章》」。写 H1 时用的是**清洗后的词干**而不是原样 `title`，两者一致，改名时 `renamedBody` 才认得出「这个 H1 是跟着文件名走的」。
- **中转站正文带 frontmatter，发布章节不带**：`manuscripts/*.md` 是插件自己的产物，一定是 `.md`，所以「这份正文依据的是哪一版剧情」那个 `upstreamHash` 就写在它自己的 frontmatter 里。`chapters/` 下的文件可以是 `.txt` / 无扩展名 / `.json`，是作者的东西——拆分时只把切好的文字写进去，之后插件一个字节都不往里改。`readManuscript` 的 `contentHash` **只哈希正文本身**（剥掉 frontmatter 与 H1）——写一次 `upstreamHash` 不该让摘要立刻过期。老工程里这一行叫 `beatsHash`（那时上游是这一段的场景集合），`readManuscript` **两个名字都认**：不认老名字的话，那些正文会一夜之间全部变成「手写的」而永不标脏。
- **草稿是纯推导出来的**：`draftRelPathFor` 把章节在**章节根之下**的那段相对路径镜像到 `draftsDir` 下，文件名含扩展名原样沿用。`ensureDraft` 按需创建、已存在原样返回（不静默覆盖）；`listDraftPaths` 一次遍历给出全部已存在的草稿，供工程页与 `@` 引用共用（每章一次 stat 会把工程页刷新的 syscall 翻一倍）。`draftsDir` 是 `chaptersDir` 的兄弟目录、不从它派生，因此改 `chaptersDir` 不影响草稿落点；`chapterSkipDirs()` 兜住 `chaptersDir` 被配成 `.` 的极端情况。
- **出场人物只有摘要那一份**：`summaries/` 里的 `cast` 是**实际出场**，也是唯一的真相（AGENTS.md 第 14 条）。从前场景卡的 frontmatter 里还有一份 `characters`（**计划**出场），刻意不进 `castIndex`——混进去会污染出场章统计与角色卡语料。场景那一层删掉之后这个坑也没了；细纲**不要**再补一个同类字段回来。
- **角色/设定的 slug 是路径**：根目录下的文件 slug 就是文件名（与改造前一致），子目录里的形如 `主角/林昭`——上下文明细里的 `character:<slug>` 因此仍然唯一。
- **摘要新鲜度按章算**：`chapters/` 里的成品写盘后重算 `contentHash`，与摘要 frontmatter 里的 `sourceHash` 比对，不一致即过期。**还没拆分发布的章不算过期**——没有成品就无从总结，混进来会让同步摘要的确认框报一个虚高的调用次数。摘要不自动生成，只提示。`syncManifest` 按 `file` 匹配不上时会按章号兜底，因此给一章改标题（文件名跟着变）不会丢掉「已总结」的记录。
- **出场人物有两种形态，一份信息**：摘要 frontmatter 的 `cast: [林昭, 年轻守卫(那个年轻人)]` 给程序用（角色页聚合、角色卡关联），`## 出场人物` 小节给人看。写的时候从结构化 cast 渲染出小节，保证两者一致；**读的时候以 frontmatter 为准，字段缺席才从小节文本反解**（见 [castParse.ts](castParse.ts) 的 `castFromText`）——0.2.x 之前的摘要与作者手写的摘要没有这个字段，不该因此在角色页上凭空少一批人。用括号而不是嵌套 YAML 是因为本层的 frontmatter 解析器刻意只支持字符串与字符串数组，为一个字段引入真正的 yaml 依赖不值得，而括号形式作者也能直接手改。
  `castFromText` 的两条判据（名字 ≤ 8 字、不含「的了是在不没」这类虚词）是为了挡住模型把这一节写成句子的情况——按标点切开会得到一串句子碎片，全都会跑进角色页的「未建卡」组里。宁可漏掉一两个长称呼，也不能让那一组塞满垃圾；漏掉的重新生成摘要就有了（新摘要走结构化 cast，根本不经过这个函数）。
- **角色卡的 `appearsIn` / `updatedThrough` 是缓存**：前者是该角色出场的章号，后者是上次「更新角色卡」读到了第几章（增量更新的依据）。真相永远是各章摘要，落在卡里只为两件事——不读全部摘要就能在角色页显示「出场 12 章」，以及日后按人物检索章节。
- **会话用 JSON 而不是 Markdown**：会话是机器记录（含 token 明细、附件快照），不期待人工编写，但仍是纯文本、可 Git。
- **选区引用存快照**：`Attachment.text` 对 selection 存当时的快照，历史对话不因原文修改而变；整文件引用每次读盘取最新。

## 依赖关系

本层只依赖 Node API 与 core 内更底层模块；`context/`、`features/`、`llm/` 依赖本层，反向不允许。
