# core/features — 功能编排

面向用户动作的编排层：每个文件对应一类「点一下发生什么」。负责组合数据层（model）、装配器（context）与模型层（llm），并把结果以回调形式交回宿主，不直接操作 UI。

## 文件

| 文件 | 职责 |
|---|---|
| [creation.ts](creation.ts) | 设置页的连接测试（`testConnection`——严格用指定的那个模型，不走分档池）+ 两个纯文本工具：`cleanOutput`（**只对正文层用**，在 JSON 产物上跑会切坏结构）与 `suggestTitle`。从前的 `CreationSession` 类没了，四件事各自搬了家，见下表。 |
| [artifact.ts](artifact.ts) | ★ 模型输出 → 可采纳的结构化产物。三层降级（JSON → Markdown 小节 → 全文兜底），前两层的写法与定稿（`summarize.ts` 的 `parseSummaryResponse`）一致，定稿不做全文兜底；**细纲给了区间就是一批**，按批次合同严格解码、不做全文兜底。单章细纲第九节里 `isNew` 的另记一份 `newLore`（采纳时建空条目，完善设定 §3）。单条设定目标（展开）解析成 `loreEntries`（`{ entries, questions }`，第一项是目标条目、按 `relPath` 认，其余是子条目），**不做全文兜底**：解析不了就是空的、没有落盘卡片。**只解析，一个字都不写盘。** |
| [blueprint.ts](blueprint.ts) | 细纲批次（章节蓝图）的严格解码：`title` / `synopsis` 缺了、`keyEvents` 一条都没有或 `characters` 一个人都没有给出带路径的诊断（`keyEvents` 是一条一件事的列表，最多 8 条；给成一段字就按换行与分号拆开照收），时间地点、看点、新增伏笔、状态变更可以空着、形状不对照收；超长截断不作废，新角色必须逐字出现在出场名单里；覆盖检查（漏章 / 重复 / 越界）。`blueprintToPlot` 把一章蓝图落成细纲的八节（连续性事实空着，定稿时才有）。合同移植自 AI-Novel-Writer。 |
| [roster.ts](roster.ts) | 角色图谱两段式的解码：身份清单 → 按冻结清单补详情 → 拼成角色卡，「人物关系」由清单生成到双方卡上。性别也在清单那一步定（一班人马男女怎么配是排人时的事），跟着冻结清单进详情、落进卡的 `gender`。比上游宽松：只有一个能用的人都没有才算失败。 |
| [loreExpand.ts](loreExpand.ts) | 展开一条设定（完善设定，2026-10-19）的解码：`{brief, keywords, body:{概要, 规则与边界, 现状, 暗设}, children, questions}`。程序校验不加调用：明面三节按上限截（合计 600，`normalizeLoreBody` 给 600 的那一版）、暗设截 200、一句话截 40，截了都写进说明；关键词与子条目给了 `known`（磁盘上的条目、角色卡、名录里另记着的名字）时过滤——关键词过 `cleanLoreKeywords`（拆出去的子条目也算别的条目），子条目丢掉名字已有条目的、人名、重名、与本条同名的，最多 3 条；问题最多 5 条、每条 60 字。明面三节一节都没有、不是 JSON 的都算解析不了（`]` `}` 前多出来的逗号自己修，不调模型）。`renderLoreExpansion` / `parseLoreExpansion` 是气泡往返（与合同同一个形状，`questions` 也在，往返不丢字段）。 |
| [loreSettle.ts](loreSettle.ts) | 落定设定（完善设定二期）的解码：`{entries:[{title, category, keywords, brief, body:{概要, 规则与边界, 现状, 暗设}}], questions}`（裸数组也认）。每一条照展开那一套截（`decodeLoreBody`、`decodeLoreQuestions`、`loreJsonObject` 从 loreExpand.ts 共用），截了说是哪一条；没名字、同批重名、人名、明面一节都没有的丢掉；最多 12 条（`LORE_SETTLE_LIMITS`）；关键词过 `cleanLoreKeywords`（这一批里别的条目的名字也不收）。`findSettledEntry` 认已有条目：路径 → 同名（同名不同分类的按分类挑）→ 关键词；生成链里认出来的换成那一条的标题、分类、路径，同一条被认两次只留第一次。`renderLoreSettle` / `parseLoreSettle` 是气泡往返（改已有的带 `relPath`），`renderNothingSettled` 是一条都没定下来时的那段人话。 |
| [loreList.ts](loreList.ts) | 设定清单（架构第五件，设定名录）两段式的解码：清单（按这本书的题材排的分类目录树 + 12–30 条：标题、分类、关键词、一句话；已有目录照用，已有条目照抄名字）→ 每 6 条补正文三节（初稿每节有上限、合计 300 字，没写的节写「（未交代）」）。调用次数 `loreListCalls()` 低 3 / 高 6 / 上限 12，链里调到 12 次就停手，剩下的条目只按清单建。落盘在 `generation/accept.ts`：先建分类目录（空的也建），新条目建在分类目录里、记 `bodyHash`；撞上已有条目的走覆盖审阅（关键词合并、一句话新的优先、正文新的为空就保留旧的）。已经写了正文的书这一件算填过，不走这条链。 |
| [novelConfig.ts](novelConfig.ts) | 小说配置的 JSON 合同：上游英文键 → `config.md` 八节与 frontmatter，「全局要求」4–8 条 600 字的质检，一句话弹窗时「保留原文，追加生成」的合并，规范化草稿（`config.md` 全文 + 一节文风）。 |
| [structuredJson.ts](structuredJson.ts) | 结构化输出的 JSON 小工具：认出「语法坏了但值得修」的输出；校验修过的那份只改了标点（标量逐个一致，只许在末尾补闭合括号）；「唯一一个完整对象」。 |
| [parse.ts](parse.ts) | 模型输出解析小工具：剥代码围栏、提取 JSON、字符串与数字去重、字符串数组归一。 |
| [pipelineBatch.ts](pipelineBatch.ts) | ★ 工程页的三条批量动作，**都严格串行、一件失败就停**：**补齐架构**（配置 → 前提 → 角色图谱 → 世界观 → 设定清单，只补空白）、**批量拆细纲**（区间里没有细纲的章每批 5 章走生成链）、**批量写章**（四期，D10：区间里还没有正文的章一章一章写；没细纲但在大纲覆盖之内的章「边写边拆」——写到那一批的第一章时先拆这一批（与批量拆细纲同一个 `runPlotBatch`），拆的时候前面各章已经写完定稿，细纲看得见既成事实；预检之后、写之前跑一次写前冲突检查（`plotCheck.ts`）；续写链与重演检测与对话页同一份，一章之内续写那几轮钉住同一个模型；「写完即定稿」模式写一章定稿一章；重演命中、后面几章才登场的人提前写了进来（五期补遗 §1.2）、没写够八成或结尾停在半句上的照样落盘、不定稿、挂黄 ❗ 并停下；「写完即审稿」（五期补遗 §4）写 → 审 → 定稿，审稿走与对话页同一条链与 `review` 档，报告一章一轮放进新会话「批量审稿 · 第 a–b 章」，审出问题、审稿失败都不停，完成提示的按钮打开那个会话；能「写完这一章就停」；切分与调用上限走 `planWriteBatch`；五期起开跑之前做一致性预检、有问题先问一句「仅本次忽略」，跑的中途新冒出来的停在那一章前面、挂黄 ❗；细纲里记过永久放行的不算；开跑之前先给定稿过的细纲里出场两章以上、还没有卡的人补建角色卡——`characterCard.ts` 的 `planCastCards` / `createCastCards`，与「全部建卡」同一份，调用次数并进确认框，卡没建成不挡写章）。**只补不改**，失败挂在那一行上，返回实际调用次数。批量拆细纲可选「拆完展开本批新设定」（完善设定三期，缺省否）：`runPlotBatch` 交回这一批顺带新建的设定空条目路径，拆完交给 `lore.ts` 的 `expandLoreEntries` 再问一次次数（几条要拆完才知道）；中途取消就不问；批量写章「边写边拆」不顺带。批量写章的确认框多一行写前提醒（`views/lore.ts` 的 `thinLoreFor`，零调用、不拦）。批量那条路的 `poolIO` 与补齐架构的 `settingRaw` 也给「从已写正文补齐」（derive.ts）与批量展开设定（lore.ts）用。 |
| [askCall.ts](askCall.ts) | ★ 调模型之前的那一问（2026-10-20）：每个调模型之前的确认框都经 `askCall` 问（`Host.confirmCall`），两个下拉框（模型：「按分档」+ 所有配好的模型；上下文详细度：只在 `contextDetail: true`、这一次的上下文看它时给）的选项与缺省、「按分档」时各项活交给谁（`tasks` → `describeTaskModels`，从前各处手抄进 `detail` 的那几行）只拼这一处。缺省取当前这一次（嵌套的那一问跟着外面那一次），再取设置；`preset` 是工程页表单上的选择（批量写章补建角色卡再问时）。问完的活由调用方跑在 `withCallChoice(answer.choice, …)` 里，**确认框之前读的 `config` 不带进去**。确认框之前的那一问（缺章提醒、一致性预检、选范围）与调完模型才问的（采纳、覆盖审阅）照旧是普通 `confirm` |
| [poolIO.ts](poolIO.ts) | 工程页任务那条路的 `ChainIO`（`poolIO`）：每次调用走分档池、装配用干活那个模型的窗口、不带思考深度（第 12、13、26 条）。批量拆细纲、批量展开、从已写正文补齐、分段重写共用；从 `pipelineBatch.ts` 挪出来单放，是为了 `pipelineBatch.ts` 与 `lore.ts` 不互相 import。 |
| [finalize.ts](finalize.ts) | ★ 定稿一章（四期，D17；七期加第三步）：照正文反向更新这一章的细纲（1 次，`summarize.ts` 的 `summarizeChapter`：八节整体替换、带连续性事实与证据，第九节「设定」并进同一次调用，旧版先复制一份进 `.novelforge/.trash/`，记 `sourceHash` / `cast`、刷新 `writtenFrom`）→ 出场角色的当前状态（0–1 次）→ 本章推进了哪几条叙事线（0–1 次）。后两步读的是第一步更新过的细纲。更新细纲失败整个定稿失败、细纲一个字不动（红 ❗）；角色状态、叙事线失败细纲照样算数，黄 ❗ 挂在章节上。`finalizeChapterTask` 是单章入口的外壳（主按钮、工作台、工程页右键、VS Code「定稿这一章」共用）；批量入口各走各的档（更新细纲与叙事线 `plotSummary`、角色状态 `characterCard`）。 |
| [finalizeSteps.ts](finalizeSteps.ts) | 定稿的后两步（角色状态、叙事线，`updateStateAndThreads`）与 `ModelRunner`。单章定稿与黄条上的「立即同步」共用；单放是为了 `summarize.ts` 与 `finalize.ts` 不互相 import（定稿的第一步在 `summarize.ts`，同步更新完细纲又要接着走这两步）。 |
| [threads.ts](threads.ts) | 叙事线（七期，移植 `narrative-thread-candidate-generator.ts`）：`generateThreads` 是工程页「从细纲排出」（与 MCP 的 `extract threads`），干活的是不弹框、不开任务的 `planThreads`——批量拆细纲拆完、批量写章「边写边拆」每拆一批也接着调它（各算 1 次，进确认框；没排成不挡后面的事，失败挂在 `threads.md` 上）；一次调用、走 `plotOutline` 档，从前提、大纲与**全部**已排细纲排 3–8 条，只追加到 `threads.md` 末尾，同名跳过，写之前重读一遍；`recordThreadEvents` 是定稿第三步——还没收的线（最多 12 条，随上下文详细度）连同整章正文送去判，证据按审稿那套归一化逐字校验，找得到的才追加到那条线的事件末尾。上游两处都要作者逐条点按钮确认；这里排线走第 19 条的批量路径（只补不改），记事件与 D15 角色状态同一个理由自动做、只追加。系统提示词在 [threadsPrompt.ts](threadsPrompt.ts)。 |
| [threadsPrompt.ts](threadsPrompt.ts) | 排叙事线、定稿时判事件两条系统提示。 |
| [plotCheck.ts](plotCheck.ts) | 写前冲突检查的取数与调用（百章实验复盘）：本章细纲（梗概、关键事件、看点）+ `NovelProject.finalizedFacts`，1 次调用（解析不出来按合同重来 1 次），走 `plotSummary` 档（界面名「定稿 · 照正文更新细纲」）。只在批量写章里跑（预检之后、写之前），对不上就停在那一章前面、挂黄 ❗；细纲是空的、记了 `factCheckOk`、前面没有定稿过的章时零调用；这一步没做成不挡写章。规则与校验在 `model/plotCheck.ts`。 |
| [preflight.ts](preflight.ts) | 一致性预检的取数（五期）：本章细纲排了谁、他们卡上的「当前状态」、前面定稿过的章留下的连续性事实（`NovelProject.finalizedFacts`；判断在 `model/preflight.ts`）。零调用。两个入口：对话页写第 N 章之前（controller 亮一张卡，可以「仅本次忽略」，或填一句理由「记为刻意安排」——记进这一章细纲的 `preflightOk`，五期补遗 §2）与批量写章。细纲里记过永久放行的那几处在这里分出去（`PreflightResult.exempted`），两个入口都只为剩下的停。 |
| [characterState.ts](characterState.ts) | 定稿时更新本章出场角色的「当前状态」（D15，移植 `update_character_cards`）：按定稿第一步更新过的细纲里的出场人物认卡、一次调用出所有人的；归机器的卡只换那一节并盖章（`model/characterState.ts`），作者改过的不写、挂黄 ❗；`reviewCharacterState` 是那张卡右键「对比第 N 章给出的状态…」。 |
| [summarize.ts](summarize.ts) | 定稿第一步与全文大纲的编排（解析、批量同步、全书 map-reduce）。`summarizeChapter` 照 `chapters/` 的正文反向更新这一章的细纲（正文镜像的那一份，`NovelProject.plotOfChapter`）：手上有细纲就拿它与正文对照着改（`REFINE_SYSTEM`：以正文为准，一致的保留原措辞，写偏的改、没写到的删），细纲是空的（拆书导入、作者手写的正文）就照正文从头整理（`SUMMARY_SYSTEM`）；1 次调用，落盘走 `Workspace.finalizePlot`（旧版先复制一份进 `.novelforge/.trash/`，八节整体替换）。细纲里的「连续性事实」在这里挂证据：模型只给陈述，证据句用 bigram 在整章正文里找（`model/continuity.ts`，零调用），找不到依据的丢掉并记日志。工程页黄条上的「立即同步」（`syncSummaries`，任务名「同步章节细纲」）把没定稿、或定稿之后正文又改过的章逐章定稿，三步与单章定稿相同：先并发照正文更新细纲（`summarizeChapters`，不弹框、不开任务，从已写正文补齐也用它），再按章号串行走角色状态与叙事线（`finalizeSteps.ts`：卡上的「当前状态」要一章一章往后推，`threads.md` 按章追加）；确认框按每章 `FINALIZE_CALLS` 报次数。中途取消时，细纲已更新、后两步没走到的章挂黄 ❗（它们不再「待定稿」，黄条不会再提醒），重新定稿那一章就补上。`updateGlobalSummary` 是全文大纲的增量更新：旧摘要 + 之后定稿过的各章细纲（遇到第一章没定稿的就停）1 次调用出新版，批量写章「写完即定稿」落后 `GLOBAL_SUMMARY_EVERY`（10）章就调一次（`planWriteBatch` 的 `globalSummaryAt`，算进确认框；没更新成不挡写章）；`rebuildGlobalSummary` 收所有定稿过的细纲重建。系统提示词在 [summarizePrompt.ts](summarizePrompt.ts)。 |
| [summarizePrompt.ts](summarizePrompt.ts) | 定稿（`SUMMARY_SYSTEM` 照正文整理细纲；`REFINE_SYSTEM` 是它加一段怎么对待「当前细纲」）/ 阶段摘要 / 全文大纲四条系统提示。 |
| [characters.ts](characters.ts) | 从选定的几段正文**批量**提取/更新角色卡（缺省勾最近几章随上下文详细度，缺省 3 章，作者可改）。系统提示词在 [charactersPrompt.ts](charactersPrompt.ts)。 |
| [charactersPrompt.ts](charactersPrompt.ts) | 批量提取角色卡的系统提示。 |
| [lore.ts](lore.ts) | ★ 设定条目的四件维护（设定名录，2026-10-18；批量展开是完善设定三期）：**建条目**（`buildLoreEntries`：名录里出现过、还没有条目的名字，「全部」只建出现 ≥2 章的；原料是定稿细纲里提到它的记录——第九节那一句、连续性事实、提到它的句子——**不重读正文**；建在它的分类目录里，记水位与 `bodyHash`）、**整合**（`integrateLore`：条目水位之后的新事实并进条目，水位停在第一处没定稿或定稿后正文又改过的章之前；机器写的可选直接采纳，作者改过的一律先对比；关键词只增不减）、**按目录整理**（`organizeLore`：模型照本书目录树出搬家清单，`checkOrganizePlan` 校验，作者看过才搬、只搬不改，不给外部 agent；新目录不先建，`workspace.move` 落盘前自己补齐父目录，搬不成不留空目录）。每条 / 每批 1 次，走 `loreSynthesis` 档；建条目与整合交回来的解析不了时这一条重来一次（`LORE_ENTRY_CALLS`，确认框按上限报），还不行才算失败，名字留在「出现过 · 未建条目」里。新收的关键词过 `cleanLoreKeywords`，名录里另记着的名字不收。从前这里是「通读全书 → 每条整合」，每跑一次都从第 1 章扫起，删了。**批量展开**（`expandLoreEntries`，完善设定三期）：「待完善」组标题的「全部展开」与批量拆细纲「拆完展开本批新设定」共用——对话页单条设定目标同一份装配与展开链（`poolIO` + `completeLoreExpand`），没有卡片、写完直接落盘，所以只写 `loreBatchExpandable` 的（空的、占位的、机器写的薄条目），作者写过的跳过、确认框与完成提示里说出来；落盘前按磁盘再认一遍（展开期间作者写了字的不写）；还没有条目的先建空条目（`generation/accept.ts` 的 `createPlannedLoreAt`）；子条目照建空条目、不接着展开，`questions` 丢掉；每条 1 次，语法坏了修一次、解析不了重来一次，合计上限 2（`LORE_EXPAND_BATCH_CALLS`），截断不重来；记 `bodyHash`、水位同整合不往回退；走 `setting`（故事架构）档；失败挂在那一条上（`op: 'expandLore'`）。系统提示词在 [lorePrompt.ts](lorePrompt.ts)。原料与水位（`recordsAbout`、`integrationWatermark`、`MATERIAL_TOKENS`）与谁写的（`loreOwnedByMachine`、`loreBatchExpandable`，这里转出一份 `loreOwnedByMachine`）在 [../views/loreMaterial.ts](../views/loreMaterial.ts)：装配器展开一条设定、名录算「待完善」时要同一份，而 context/、views/ 不依赖 features/。 |
| [loreRecord.ts](loreRecord.ts) | 记设定：定稿第一步顺手记进细纲第九节（`loreHint` 给本书的分类表与这一章提到的已有设定，`checkLore` 写盘前校验——名字逐字在正文里、人名不算、已有条目换成标题与目录、说明找不到依据就清空），以及作者定的**单独记一章 / 补记**（`recordLore`：只对定稿过、正文没再改过的章，每章 1 次、串行，只换第九节，走 `loreScan` 档）。 |
| [lorePrompt.ts](lorePrompt.ts) | 「设定」字段说明（定稿与单独记设定一字不差共用）、单独记设定、建条目与整合（字数上限是第 27 条的锚点；600 字只指明面三节）、按目录整理四段提示。建条目与整合的那一段管「暗设」（完善设定，2026-10-19）：现有条目带着就原样留作第四节（≤200 字、不算进 600），记录表明正文已经揭开的挪进前三节、没揭开的一字不改，建条目（没有现有条目）不写，暗设里的东西不进一句话与关键词。整合的解析（`lore.ts` 的 `parseEntryDraft`）整份照收模型给的正文，第四节不会在解析时丢。 |
| [characterCard.ts](characterCard.ts) | ★ **单个角色**的档案更新编排。解析见 [characterCardParse.ts](characterCardParse.ts)，控篇幅提示词见 [characterCardPrompt.ts](characterCardPrompt.ts)。 |
| [characterCardParse.ts](characterCardParse.ts) | 角色卡更新的 JSON 解析（`parseCardResponse`）。 |
| [characterCardPrompt.ts](characterCardPrompt.ts) | 更新角色卡的系统提示（字数上限与「性格 / 语言习惯」优先）；定稿时更新当前状态的系统提示（`STATE_SYSTEM`）。 |
| [characterMaintenance.ts](characterMaintenance.ts) | ★ 两条**不调模型**的整理动作：`cleanCharacterAliases` 删掉不是专属称呼的别名（含被误填成别名的**其他角色的名字**），`mergeDuplicateCharacterCards` 把同一个人的多张卡并成一张。只改 frontmatter（`rewriteFrontmatter`），作者手写的正文一个字节不动；被合并的卡搬进 `.novelforge/.trash/`。写回经 `workspace.write`（`review: false`——动手前的确认框就是那一问，改写之前的旧卡存一版历史），被合并的卡经 `remove`（第 7 条；从前直接 `writeText` / `fs.rename`）。 |
| [style.ts](style.ts) | 从 1~3 章样章归纳文风指南写入 `.novelforge/style.md`（缺省勾前几章随上下文详细度，缺省前 2 章）。系统提示词在 [stylePrompt.ts](stylePrompt.ts)。 |
| [stylePrompt.ts](stylePrompt.ts) | 文风提取的系统提示，与从参考书学文风共用同一段任务边界与小节（只有开头一段不同）；另有从参考书学写法（结构与节奏）的那一份。任务边界并入了 AI-Novel-Writer 文风分析模板的说法：只学技法，不复述情节、角色名、地名，不抄原句。 |
| [bookText.ts](bookText.ts) | 拆书两条路共用的取书：作者点的入口经 `Host.pickHostFile` 在**本机任意位置**挑一本 `.txt`（宿主没有这个能力就退回工程里的清单：章节文件、草稿、隐藏目录除外），读出来、解码；一本上限 64 MiB（网关那道 2 MiB 是给编辑器与上下文的，这里只读、不进上下文、不写回原处）。**agent 给的路径只认工程里那张清单**——外部 agent 不读工程外的文件。 |
| [importManuscript.ts](importManuscript.ts) | ★ **导入原稿**（拆书 A）：挑 txt → 切章（`model/importText.ts`）→ 确认框报章数、区间与丢掉了什么（零调用）→ `Workspace.createChapters` 一批建好（同名报错停下，manifest 最后同步一次）→ 问要不要接着「从已写正文补齐」。接在已有章节之后，章号按顺序重编。 |
| [derive.ts](derive.ts) | ★ **从已写正文补齐**（拆书 A）：第 1 章起连续写好的 N 章，按 细纲 → 配置 → 前提 → 角色卡 → 世界观 → 设定条目 → 情节大纲（每次 20 章，照定稿过的细纲）→ 全文大纲 的顺序来。细纲那一步就是定稿的第一步（`summarizeChapters`）：第 1–N 章里没定稿的、定稿之后正文改过的照正文整理，已经有细纲的拿着它与正文对照着改、旧版进回收站，写出来带 `sourceHash` / `cast`，直接算定稿过，不另排细纲；其余几样**只补空白**。两次确认：细纲没齐时先只报细纲（按钮「先整理细纲」），细纲出来再报其余（建卡次数要读细纲才算得准）。装配走 `BuildRequest.derive` + `written` 层；角色卡走 `createCastCards`（定稿过的细纲里出场两章以上）；设定条目在还一条都没有时走 `features/lore.ts` 的 `createLoreEntries`（名录里出现两章以上的，一个都没有降到一章；没建成只挂黄 ❗、不挡后面几样）。不排叙事线。一件失败就停，失败挂在那一行上。主按钮在「有正文却缺架构 / 大纲没覆盖到」时推它（`model/pipeline.ts` 的 `deriveBookNextStep`）。 |
| [outlineRewrite.ts](outlineRewrite.ts) | **分段重写情节大纲**（工程页「情节大纲」右键「重写…」）：有区间标题的大纲按 20 章一段重写到它现在覆盖的那一章，已写成的那一截照定稿过的细纲整理（`derive`），其余照架构重新规划，段不跨这条线；作者那句要求每段都带；每段经 `BuildRequest.outlineDraft` 看得见前几段刚写好的新版；全部写完一次审阅、整份写入，中途失败已重写的几段照样拿去审阅、没轮到的保留旧版，取消什么都不写。次数写在问要求的那一框里。散文式与空大纲不分段，退回对话页整篇重写。 |
| [reference.ts](reference.ts) | **从参考书学写法**（拆书 B）：挑 txt → 选学文风 / 写法 / 两样 → 确认（各 1 次调用，`extractStyle` 档）→ 文风（均匀抽几章随上下文详细度，缺省 5 章）写 `style.md`、写法写成本工程的写作技能 `<书名>-写法/SKILL.md`（`stage: planning`，不覆盖已有的，同名加后缀）→ 问绑不绑到「规划」。原文不写进工程的任何文件。 |
| [bookReplace.ts](bookReplace.ts) | ★ **全书替换**（独立版「编辑 → 全书查找替换…」→ 预览 → 「替换所选」）：把预览里勾着的那几处经网关逐份写下去。**零调用**。一份文件：编辑器里有未保存修改的跳过；磁盘上那份与预览时的 hash 对不上就跳过（不拿旧的盖新的，第 3 条）；勾着的几处在磁盘上那份里逐处核对（与预览同一个口径 `model/bookFind.ts`），`textFind.replaceSelectedIn` 只换这几处；**先强制存一版历史**（`snapshotNow`，不受节流；存不下就不换——跨文件没有一步撤销，退路就是历史版本）；`workspace.write`（`overwrite`、`review: false`——预览就是那一问（第 19 条）、带 `baseHash`，章节的 manifest 最后同步一次 `deferAfter`）。写的顺序：其他创作文件（大纲）→ 细纲 → 正文 → 草稿 → 角色卡 → 设定。**第 18 条（⚑）**：替换不改变任何一章的新鲜度判断，除了「同一次里细纲与正文都改了、原本对得上」——`writtenFrom` / `sourceHash` 刷成替换后的（`Workspace.restampPlotChain`），不让一次全书改名把几百章挂 ⟳、退回待定稿；细纲的 `upstreamHash` 退回替换前的判断（网关「谁写都记」）；只改细纲 / 只改正文 / 只改大纲的照常，汇总里列章。角色卡「当前状态」的 `stateHash`、设定条目的 `bodyHash` 不刷（替换就是作者的改动，下次机器照规矩先对比）。角色卡的名字 / 别名换了，汇总里提一句文件名没跟着改。不改文件名、不搬文件；派生数据从磁盘现算，controller 替换完 `pushState`。 |
| [pickPlots.ts](pickPlots.ts) | 多章选择：Host.pick 只支持单选，需要选几章时改为输入章号列表（如 `1,2,3`）。 |

## 创作的四层与两条路

创作按 `Stage × Capability × Target` 展开（定义在 [../model/pipeline.ts](../model/pipeline.ts)）：架构 → 大纲 → 细纲 → 正文。同一层可以被讨论（默认动作，挑刺、检查设定都靠直接打字说），也可以被生成；细纲层另有一个 `settle`（落定细纲），把刚才那段讨论里**已经达成的结论**沉淀成细纲。改写不是独立能力：目标已有内容时的生成就是改写，作者那句话就是修改意见。从前还有 `split`（大纲拆卷、卷拆剧情段）与拆章，卷那一层删掉之后都没了。

**创作编排本身已经不在本层了**——它是 [../generation/](../generation/README.md)：`generate.ts` 无状态地装配 → 调模型 → （需要时接 `structured.ts` 的生成链）→ 解析成 `Draft`，`accept.ts` 按产物分派到八条落盘路径，`drafts.ts` 让草稿活过一次刷新。并发控制在 `controller/`（那是调度的责任）。本层留下的是 `artifact.ts`（解析）与 `pipelineBatch.ts`（工程页批量）。

**生成与落盘是两步**，这是这条路上最要紧的一条：

1. `generate()` 只把文本交回调用方，**一个字都不写盘**，产出一份带 `artifact` 的 `Draft`；
2. `acceptArtifact()` 才写，且只在用户在那张落盘卡片上点了「写入」之后（`controller/chat.ts` 的 `askArtifact`，产出的当下就问）——**落盘时拿气泡里当下的文本重新解析**（用户可能改过），`draft.artifact` 只是生成那一刻的展示快照。

中间那一步是用户看着产物决定要不要的机会——少了它，「不静默覆盖」无从谈起。

`generation/`（创作页，一次一份）与 `pipelineBatch.ts`（工程页，一次几十份）的失败模型完全不同，所以是两条路：

| | `generation/` | `pipelineBatch.ts` |
|---|---|---|
| 一次处理 | 一份产物 | 几十章 |
| 覆盖已有产物 | 走 `reviewReplace` 逐份审阅 | **一律跳过**——一次弹 63 个 diff 没人看得完。补齐架构连一节都不覆盖：作者写过的节原样留着（`onlyBlank`） |
| 解析失败 | 单份文档全文兜底（产物摊在屏幕上，用户看得见它是什么）；细纲批次不兜底 | **不兜底**——没人逐份过目，兜底会把「这次失败了」变成「这一章已排好」，紧接着的批量写章还会照着它写出一整章 |
| 出错 | 报错，用户重来 | 记进 errorLog 挂在那一行上，**就此停下**——后一件、后一批、后一章要吃前面的产出 |
| 写出来但有问题（重演、没写够） | 卡片上标出来，作者当场判断 | 照样落盘（钱已经花了，D6），不定稿，黄 ❗ 挂在那一章上，**停下**——接着往下写等于踩着一个有问题的结尾 |

两条路共用同一个 `buildContext` 与同两条生成链（`generation/structured.ts`、`generation/continuation.ts`），因此批量与单次产出的是同一个质量、同一套降级与续写。

## 定稿走 JSON

定稿第一步的提示词要求模型输出 JSON：细纲的八个字段（梗概 / 出场人物 / 时间地点 / 关键事件 / 看点 / 新增伏笔 / 状态变更 / 连续性事实），其中 `出场人物: [{name, aliases}]`、`连续性事实: [...]`。`parseSummaryResponse` 解析成 `SummaryData`。落盘是 `Workspace.finalizePlot`，写回同一份细纲，仍是 Markdown（作者要翻、要手改）：结构化的出场人物额外写进 frontmatter 的 `cast`；连续性事实挂上证据之后写成最后一节（`- 陈述 〔证据：「原文」〕`，格式在 [../model/continuity.ts](../model/continuity.ts)）。

解析分**两层**，两层都不中就什么都不收——能解析的一定要解析出来（解析失败意味着这一章的连续性事实与出场人物进不了上下文），解析不了的一个字都不写：

1. **JSON**：字段缺失、类型不对（字符串/数组混用）都逐字段兜住，不整体作废；多出来的尾逗号（模型最常见的语法错）先自己去掉再解析一次（`parse.ts` 的 `stripTrailingCommas`）。判据是「梗概或关键事件至少有一个非空」——模型偶尔吐出语法合法但不相干的 JSON，认下来会得到一份空细纲，比解析失败更糟。
2. **Markdown 小节**：模型忽略 JSON 要求、照着细纲的样子写回来时走这条。

从前还有第三层「全文进梗概」。定稿写回的就是这一章的细纲，那一层等于拿一段没解析开的原文换掉作者的计划、还记上 `sourceHash` 让这一章看起来已经定稿（真实模型试跑撞上过：尾逗号让 JSON 解析失败，整段 JSON 进了梗概）。所以两层都不中就报失败、挂红，细纲一个字不动。

只有第 1 条有结构化 `cast`，第 2 条从「出场人物」小节的文本反解（见 [../model/castParse.ts](../model/castParse.ts) 的 `castFromText`）。

## 两条角色流程的分工

| | `characters.ts` · 提取角色 | `characterCard.ts` · 更新角色卡 |
|---|---|---|
| 面向 | 「刚写完几章，把新出现的人补上」 | 「这个人出场三十章了，把他的档案重新过一遍」 |
| 作用对象 | 一批章里的**所有**角色 | **一个**角色（另有按卡并发的批量版） |
| 章从哪来 | 作者手输序号列表 | 出场索引（定稿过的细纲）自动给出该角色的出场章 |
| 上下文 | 一次装完（超预算就截断并 warn） | 按预算分批，逐批精炼同一张卡 |
| 入口 | 「角色」分组右键「提取/更新角色卡（挑几章正文）…」 | 角色行右键；角色分组右键的批量更新；「未建卡」分组右键的「全部建卡」 |

`characterCard.ts` 的三条关键设计：

- **自动关联出场章**：来自 [../views/cast.ts](../views/cast.ts) 的索引，作者不必再手输章号。
- **分批时先说要调几次**：主角可能出现在几十章里，一次装不下就切批。动手前的确认框里必须写明「分 N 批，预计调用模型 N 次」——这是「不偷偷烧 token」在本层的落法。后一批看得到前一批的产出，逐批精炼而非各写各的。
- **提示词是为「控篇幅」写的**：同一个角色会被反复调用，每批都往上堆的话角色卡会膨胀成一篇论文，而它每次续写都要注入上下文。所以每一节都给了硬性字数上限，并明确「性格 / 语言习惯」优先（它们决定模型能不能把人写像），外貌与人物关系从简；「未收伏笔」要做减法。

## 关键设计

- **回调而非返回**：生成类操作通过 `GenerateHandlers`（onDelta / onDone / onError / onCancelled）汇报进度，UI 层决定怎么展示流式内容。
- **长任务走 `runTask`，不直调 `Host.progress`**：本层除创作页的单次生成（它在对话页有流式气泡）以外的批量活一律经 [../runtime/progress.ts](../runtime/progress.ts)。`report({ message, current, total })` 里的 `total` 决定网页上画不画进度条——同步过期细纲是 `stale.length`，重建全文大纲是「批数 + 合并那一步」，角色/文风是固定三步/两步，设定生成是「逐章扫描 + 设定整合 + 写入/审阅」，流水线批量是待处理的章数（补齐架构是缺的件数）。
- **无先后依赖的条目并发跑**：各章照正文更新细纲之间、角色卡之间、全文大纲的各阶段批次之间都没有依赖，一律经 [../runtime/concurrency.ts](../runtime/concurrency.ts) 的 `runPool`（并发量取 `config.concurrency`）。**有依赖的绝不并发**——同一张角色卡内部的分批必须串行，后一批要看到前一批的产出；全文大纲的 reduce 合并要等全部 map 到齐。并发下 `current` 只在项结束时 +1，`message` 报「已完成 n/N + 正在跑哪几项」。
- **模型经 `llm/pool.ts` 取，并且要报出档位**：建池时必须传 `task`（如 `createModelPool({ task: 'plotSummary' })`），这样才有分档、「同档失败随机换模型」与并发轮转。唯一的例外是创作页的单次生成（[../generation/generate.ts](../generation/README.md)）与设置页的连接测试（`creation.ts`），两者都必须用用户选定的那个模型。同一个功能里难度不同的阶段要**各建一个池**——`rebuildGlobalSummary` 的分批汇总（`globalSummaryStage`）与最终合并（`globalSummaryMerge`）、`generateLore` 的逐章识别（`loreScan`）与条目整合（`loreSynthesis`）都是两档，串行时也不能图省事复用同一个池（那会把后一阶段悄悄降级到前一阶段的档）。流水线批量同理：`plotOutline`（均衡）与 `manuscript`（均衡）各建各的池；批量写章的「写完即定稿」再为定稿的两步各建一个（`plotSummary`、`characterCard`）。
- **切批与预算用 `pool.primaryBudget`，不用 `config.contextWindow`**：后者是对话页选定模型的窗口，分档后与干活的模型无关。确认框之前就要算的批数/片段数（它们就是「预计调用 N 次」那个数字）用 `budgetForTask(task)`，它不构造 provider，不会在用户点确认前弹 Key 输入框。
- **确认框里的「模型」一行走 `describeTaskModels(config, task)`**：档位、实际清单、会不会换人、是不是继承默认模型，四件事一次说清。**不要再打印 `config.models`**——弹窗写着一个模型、实际跑另一个，是「不偷偷烧 token」的反面。
- **每一步都留痕**：批量任务逐项打一条 `info`（含刚完成的项、用时、平均速度、预计剩余），失败项打 `error`；可以并发的（同步细纲、角色卡批量）**继续跑完剩下的**、结束时汇总说明哪几项失败，流水线那三条就此停下并说清停在哪。日志里绝不出现 API Key（`logger.redact` 统一处理），也不记 prompt 全文。
- **模型输出清洗**：LLM 常把正文包在 code fence 里或加上「好的，以下是续写」之类的前言，写入前统一剥掉（`stripCodeFence` 等）。
- **人工确认优先**：凡是覆盖作者可能手改过的文件（角色卡、style.md），一律先经宿主审阅/弹窗确认。批量更新时分析是并发的，但审阅经 `concurrency.ts` 的 `serialize()` 排队——同时弹三个 diff，用户根本不知道自己在看谁。作者点了采纳（或在批量确认框里选了「全部直接采纳」）之后经 `workspace.write` 写回原文件（`review: false`：不问第二次），覆盖之前旧内容照样进历史版本（第 7 条：写盘经网关）。
- **超预算截断必须打 `warn`**：单章正文、角色提取的语料、文风样文、阶段摘要合并这四处都会按输入预算 `takeHead`。截断本身是对的，但作者选了五章却只读进两章半时必须说出来——这是「不静默截断」在本层的落法。
- **交互全走 Host**：弹窗、进度、文件打开都经 `host.ts` 窄接口，本层零 `vscode` 依赖。
- **定稿与全文大纲温度 0.3**：要稳定、可复现，不用用户设的创作温度。

## 依赖关系

依赖 `model/`、`context/`、`llm/`、`host.ts`。被 `vscode/extension.ts`（命令）与 `core/controller/`（对话面板）调用；插件命令面板与独立版网页共用同一批流程。
