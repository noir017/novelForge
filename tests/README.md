# tests — 自动化测试

不依赖 VS Code、也不需要真实 API Key。运行器是 Node 自带的 **`node:test`**（零新增依赖），
独立版服务那一组由 **Bun** 跑同一套 `node:test` API。

```bash
npm test                 # typecheck + 全部
npm run test:unit        # 只跑快的（毫秒级）
npm run test:integration
npm run test:dom         # 会先构建 dist/media
npm run test:contract
npm run test:e2e         # 需要 Bun
npm run test:verbose     # 出问题时看 node 原样输出
```

单跑一个文件或一条用例：

```bash
node --test tests/unit/model/markdown.test.js
node --test --test-name-pattern="stripH1" "tests/unit/**/*.test.js"
```

> **glob 必须带引号**——`node --test <目录>` 在当前 Node 版本会把目录当成模块入口报
> `MODULE_NOT_FOUND`。引号让 glob 交给 node 自己展开，PowerShell 与 sh 下行为一致。

## 输出：只报失败

四组 `node --test` 都走 `reporters/quiet.mjs`——**只吐失败与一行总计**。全绿时输出就一行：

```
✓ 通过 2197，2197 条，30.5s
```

有失败时每条三行：位置、用例全名（含祖先套件）、期望与实际。

```
✗ tests/unit/model/markdown.test.js:84
  markdown.ts › H1 处理 › stripH1 去掉标题
  实际 "\n雨下了三天。"
  期望 "雨下了三天。"（strictEqual）
```

默认 reporter 每条失败带十几行 YAML（`duration_ms`、`location`、完整 stack），全量跑一轮
接近 400 KB；换掉之后全绿 36 字节，一条失败也就百来字节。**人往回翻不动、塞进 agent
上下文更是纯浪费**，这是换掉它的唯一理由——判定逻辑一点没动，退出码照旧。

想看原样输出用 `npm run test:verbose`。三个开关按需加：

| 环境变量 | 作用 |
|---|---|
| `NF_TEST_LOGS=1` | 连带打印失败文件里的 `console` 输出（默认丢弃） |
| `NF_TEST_STACK=1` | 每条失败附一行仓库内的调用位置 |
| `NF_TEST_MAX_FAILS=n` | 最多展开几条，超出只计数（默认 25，`0` 表示不限） |

两处刻意的取舍：**套件层的失败不报**（`failureType: 'subtestsFailed'` 只是子用例失败的回声，
叶子那条已经报过），所以总计里的失败数是**叶子数**，与展开的条数对得上，不等于
`counts.failed`；**两个长字符串只报第一处分歧**的位置与前后文，不把两份全文都印出来。

e2e 那组归 Bun 管，`bun test` 没有自定义 reporter 的接口——但它本来就只有一千多字节，不用管。

## 按测试类型分目录

| 目录 | 跑什么 | 依赖 |
|---|---|---|
| `unit/` | 纯函数，零 I/O | 无 |
| `integration/` | 真临时工程 + 假模型，跨模块编排 | 临时目录、SQLite |
| `dom/` | jsdom 跑 `dist/media/` 的前端产物 | jsdom、前端构建产物 |
| `e2e/` | 真 HTTP/WS 服务 | Bun |
| `contract/` | 架构不变式与夹具自洽 | 无 |

`helpers/` 放公共 harness，不是用例（不匹配 `*.test.js`，不会被收集）。

## 覆盖范围

### `unit/`

| 文件 | 覆盖 |
|---|---|
| `tools/registry.test.js` | 工具注册表：`specs()` 只透传 name/description/parameters（`run` / `intent` 漏进去会炸 API）、重名与非法名直接抛、**参数必须扁平**（嵌套对象与对象数组一律拒——那是模型最容易填错的地方）、工具与每个参数都必须有描述、`required` ⊆ `properties`；**`invoke` 绝不抛**（认不出的名字与工具自己炸掉都变成一条模型读得懂的结果）、工具没报意图时兜的那一档 |
| `tools/intent.test.js` | 七个工具**自报的意图**：五档归类（读三件 auto、generate costly、write 新建 mutating、**write 覆盖 reviewed**、**edit always**）与确认框上的话——花钱要说、产出仍要点采纳要说、edit 要写出 old → new。后两档是产品承诺，不是偏好设置 |
| `agent/policy.test.js` | 三种模式 × 五档那张表；`reviewed` 与 `always` 在三种模式下**逐字相同**；说辞原样来自工具、只补一个主语；拒绝之后回给模型的话有信息量（「不要重试同一个动作」）。**这个文件不认识任何一个工具名** |
| `agent/budget.test.js` | 三条上限（回合 / 生成次数 / token）各一条、**无进展检测**的两连（提示）与三连（停）、换参数换工具与「中间隔了别的动作」都不算重复、键序不同但内容相同算重复；以及第 11 条——**日志只有工具名与参数键名，没有参数值** |
| `agent/context.test.js` | agent 上下文压缩：装得下就一个字不动、超预算时 system 与最后 6 轮完整保留而更早的工具结果只剩第一行、压缩时打 warn、压不下去时给停下的信号且**用户最初那句要求还在** |
| `workspace/kind.test.js` | 路径 → 种类的一张表：细纲/场景/中转站/章节/摘要/角色/设定/草稿各自的判定与章号反推；**章节不认扩展名**（无扩展名、`.txt` 都算，`.png` 不算）而角色/细纲/场景仍只认 `.md`；`summaries/global.md` 不被当成第 0 章的摘要；越界一律 `other` 且 `rel: undefined`、绝不抛；`pathOfTarget` 与 `kindOfPath` 四支往返 |
| `model/markdown.test.js` | frontmatter 解析（行内/块状数组、畸形行不抛错）、小节抽取、`extractH1`/`stripH1` 互逆、序列化往返 |
| `model/chapterFile.test.js` | 章节文件名规则：任意非二进制扩展名 / 无扩展名算章节、二进制黑名单被挡、`extractH1` 只看首行 |
| `model/project.test.js` | `cast` 条目的序列化往返（含全角括号、别名去重）、小节文本反解出场人物 |
| `model/fs.test.js` | 磁盘与字符串小工具：hash 统一 CRLF、中英文计数、文件名净化、slug 冲突追加；`readTextIfExists` 读不到给 undefined（不存在与同名目录对调用方是同一件事——这一章没有这份产物），权限之类的错误照常上抛 |
| `model/providers.test.js` | 模型引用解析（含嵌套斜杠 `openrouter/z-ai/glm-4.6`）、服务商配置容错、按模型覆盖窗口、0.1.x 单服务商兜底；默认模型列表的归一化与旧配置升级；`concurrency` / `fallbackAttempts` 的默认值与 clamp |
| `model/tiers.test.js` | 模型分档的配置容错：三档各自归一化、非对象不崩、裸字符串收成单元素、认不出的任务名与非法档位名回落内置默认，以及「每个任务都有内置默认档位与中文名」 |
| `model/pipeline.test.js` | 四个阶段（大纲/剧情/细节/正文）的可用/默认能力（`settle` **只有剧情层有**）、输出形态判定、`CreationTarget` 的稳定键（同章号不同文件不撞）、action/target 容错归一、`plotLabel`/`chapterLabel`、单章（含「待拆分」）与全书两个状态机、命令表；以及 `splitByMark` 按 `---` 切分（连续标记、首尾标记、无标记、只有标记）；以及 `plotFile.ts` 的文件名规则与解析/渲染往返——**四个小节、不再有「开头」「结尾」**，`isPlotFilled` 只认「剧情脉络」 |
| `context/tokenizer.test.js` | token 估算（中英文比例）、`takeTail`/`takeHead` 的预算与截断标记（样本取 `manuscripts/` 里的真实正文） |
| `context/tokenCounter.test.js` | 可替换计数器的注册/切换、`prepare` 抛错时不带崩、用量校准统计只收真实用量 |
| `features/creation.test.js` | 模型输出清洗（去代码块/开场白/标题/字数统计，正文不误伤）、标题推断 |
| `features/summarize.test.js` | **摘要解析的三层降级**：JSON → Markdown 小节 → 全文进梗概；不相干的 JSON 不被当成摘要；真实示例摘要（无 `cast` 字段那份）走小节反解 |
| `features/characters.test.js` | 角色 JSON 解析的容错：坏 JSON 返回空数组而非抛错、无 name 条目被丢弃 |
| `runtime/concurrency.test.js` | `runPool`：并发峰值不超 limit、结果按 index 对齐、单项失败不拖累其余、取消后不起新任务、`onSettled` 计数单调不重复；`serialize` 的串行与不卡死 |
| `runtime/pool.test.js` | 模型池：并发轮转均摊、串行恒用首选、失败换人、重试不超 `fallbackAttempts`、取消不 fallback、剔除备选**不弹 API Key 输入框**；**分档**：空档位继承 `models`、**fallback 绝不跨档**、`primaryBudget` 取该档首选窗口 |
| `runtime/logger.test.js` | 脱敏（`sk-`／`Bearer`／`api_key=`／`x-api-key`）、环形缓冲上限、sink 级别过滤、坏 sink 不抛给调用方、detail 截断带说明 |
| `runtime/progress.test.js` | 长任务进度快照、字符串 `report` 只改文案、宿主进度带 `（n/N）`、取消、抛异常继续上抛且进日志、并发两个任务、结束后清表 |

### `integration/`

| 文件 | 覆盖 |
|---|---|
| `tools/readTools.test.js` | 只读三件套：list 的 60 项上限与「还有 N 项未列出」、read 的行号与「第 X–Y 行未读」（含接着读的 offset）、search 的章号升序与 `dropped > 0` 时那行 ⚠；**越界与不存在一律给 `error` 不抛**（模型看得到才换得了路）；跑完三个工具磁盘 mtime 一个都不变 |
| `tools/generateTool.test.js` | `generate` 工具：draft 落进 store 而**返回文本里没有正文**（三千字塞回循环，每走一步重烧一遍）、层与能力的组合问 `STAGE_CAPABILITIES`、`settle` 明确不支持并指路对话页、认不出的路径给 error 且一次模型都不调、`history` 恒为空、正文层走 `config.active`、**失败也照样报一次账**（请求发出去钱就花了）、**工具自己不提上限**（「已用 1/10」那句是调用方的） |
| `agent/stateBrief.test.js` | 状态注入：**label 与 hint 与 `deriveNextStep` 一字不差**（第 20 条的硬断言）、老工程说「已发布 99 章」而不说「待写剧情」、成品路径与细纲路径认到同一章、⟳ 超 5 章写「等 N 章」、状态机不催时明说「不要自己挑一章开工」 |
| `agent/loop.test.js` | agent 循环（脚本化假 provider）：不调工具时一个回合结束、tool 消息形状、连续两次同工具同参数收到提示且**不真跑**、三次停下并仍给一轮总结、预算触顶时最后一轮**不带 tools**、取消停在工具边界且已产出的 draft 保留、工具抛异常变成 error 回给模型、日志里没有 prompt 全文/参数值/正文 |
| `workspace/guard.test.js` | **八条入口守卫**各至少一条：越界（含归一化后仍逃出去的）、工程根包含、固定目录保护、回收站不可改（但读得到）、2MB 上限、同名不覆盖、覆盖审阅（两种宿主 + 文案逐字）、内容 hash 乐观锁 |
| `workspace/basic.test.js` | `Workspace` 门面：write 的三种 mode、审阅拒绝时一字未改、乐观锁冲突、read 的 `truncated`（不静默截断）、edit 的「old 不唯一就报错」与「要么全成要么全不成」、remove 进 `.trash/` 且同名加序号、move 不覆盖、list 带 `kind` |
| `workspace/hashChain.test.js` | **记账下沉**：改大纲后直接 `write` / `edit` 细纲文本，`upstreamHash` 跟着更新（修的那个缺陷）；场景同理；`plotContentHash` 只哈希四个小节、标 done 不动指纹；`beatsHashFor` 排除 `status`；**手写的产物永不标脏**；细纲改名带走场景与中转站、目标已存在时不覆盖；删细纲不碰 `chapters/` 与摘要 |
| `workspace/split.test.js` | 正文追加插 `---` 与记 `beatsHash`、章节新建与 manifest、章节改名带草稿而删章节不删草稿、草稿按需创建不覆盖、摘要 `sourceHash` 记成品；**拆分先移号再落盘**（后面待写的细纲连同场景目录与中转站正文整体顺延） |
| `workspace/search.test.js` | 全文检索：单章命中带章号、跨章按**章号**升序、`kinds`/`path` 限定、回收站与二进制不命中、`perFile`/`limit` 超限时 `dropped > 0`、正则与坏正则降级 |
| `files/fileOps.test.js` | 层级目录与类文件操作：递归扫描（含 `.trash/` 排除）、`ProjectTree` 折叠、路径越界守卫、新建/重命名（保留序号前缀、H1 同步）/移动（跨区/自嵌套/同名拒绝）/删除（搬回收站、不覆盖）；**细纲走另一条路**——改名/删除连带搬走场景目录与中转站正文，且没有「移动到…」；摘要按**章节**名镜像（同号不同名互不覆盖）；`buildPlotSummaryView` |
| `files/projectFiles.test.js` | 工程根范围的文件操作：重命名/移动/复制、固定目录保护、同名拒绝、垃圾箱豁免、章节联动 |
| `files/chapters.test.js` | 非 markdown 章节不解析 H1、角色区仍只认 `.md`、`isEditablePath` 放行无扩展名章节 |
| `files/listCache.test.js` | 章节与**细纲**两份列表缓存的并发语义：并发调用只扫一遍全书、`invalidate` 后重扫、**扫描途中失效的那一轮不回填缓存**（否则界面会停在变更之前的字数与过期标记）；外加 `writePlot`/`deletePlot` 自己让缓存失效（否则新建的章不出现在工程页上，且不报错） |
| `views/projectTreeReads.test.js` | 工程页刷新的**读盘次数**：同一个文件一次刷新至多读一次、每章 fs 调用有上限、章数翻倍不超过线性增长。这条路由文件监听触发，作者每存一次盘就跑一次，重复读盘不报错只变慢，只能靠断言守 |
| `files/drafts.test.js` | 草稿路径镜像、按需创建且第二次不覆盖、不混进章节树与 manifest、`@` 引用、跟随改名/移动、删章节不删草稿 |
| `context/builder.test.js` | 完整上下文装配：优先级、预算、降级链、手动排除、附件截断、多轮历史封顶、四阶段配方与身份、provider 配额压缩；**`settle` 时历史保得住**（cap 60% + P0，且输出契约与 `generate` 一字不差）、**没写正文的章退化成只带「目标」并注明原因**、**正文优先读 `chapters/`**；工程页快照与出场人物索引。**写入类用例跑夹具的临时副本**，`sample-novel/` 只读 |
| `features/creation.test.js` | 创作编排层：产物解析的三层降级与 `parsePlotStrict` 的不兜底版本；六条采纳落盘路径——覆盖前必须审阅且**拒绝时一字不写**、二次拆场景不动原有场景、目标不存在时抛错；大纲拆章**不建空章节** |
| `features/pipelineData.test.js` | 细纲与场景的解析/渲染往返、场景文件名规则、伴生文件的镜像与改名跟随、**新鲜度链**（改大纲→细纲脏→场景脏→中转站正文脏）、**已发布的章不被拉回「待写正文」**、**手写的产物永不标脏** |
| `features/splitChapter.test.js` | 拆成章节：按 `---` 切出 N 章落进 `chapters/`、中转站原件进 `.trash/`、第一章沿用原标题其余留纯序号名、后面待写的细纲号顺延且**场景目录跟着改名**、N===1 时不弹确认也不重编号、**零次模型调用** |
| `features/selectPlot.test.js` | 「选中一章」这个入口：三种路径形状（工程页的主路径 / 下拉框那个**并不存在**的细纲路径 / 真实细纲路径）都认到同一章，目标一律归到细纲那一侧；**拆分出来的、只有成品的章不再报「这一章不存在」**，也不被倒回「待写剧情」；两边都没有时才提示；状态机仍决定落在哪一层且不预置花钱的能力 |
| `features/pipelineBatch.test.js` | 工程页的三条批量流水线（写剧情 / 拆场景 / 写正文）：**只补不改**、缺上游不生成下游、解析不出**不写盘**、失败挂 errorLog 且继续跑完、用户取消时一次模型都不调；装配走同一个 `buildContext` |
| `features/cast.test.js` | 别名的泛称过滤；同一人聚类——**同章共现的两人绝不合并**；出场索引的正式名优先与 `conflicts`；维护命令（清理别名不动正文、合并重复卡、水位线退回） |
| `features/characterCard.test.js` | 更新角色卡：分批与「预计调用 M 次」、只装该角色的出场章、增量无新章时**一次模型都不调**、部分失败时**水位线停在第一个失败章之前**、取消/放弃不落盘；**并发**下模型请求重叠但 **diff 审阅仍一次只弹一张** |
| `features/lore.test.js` | 自动生成设定：逐章识别次数、跨章合并、分类目录落盘、已有设定必须经审阅 |
| `storage/errorLog.test.js` | 工程库与失败记录：驱动适配层、**关库之后删得掉目录**、纯读取不建库、失败记录生命周期、日志持久化与挂 sink 前的补写、**库不可用时全线静默降级** |
| `storage/session.test.js` | 会话读写往返、损坏文件容错、列表排序、重命名/删除、id 唯一性、`.novel` → `.novelforge` 迁移 |
| `llm/streaming.test.js` | 起本地假服务器模拟 SSE：流式解析（跨块切分、CRLF、心跳、非 JSON 行）、取消、超时、HTTP 401/404/429，Anthropic 的 system 提取与消息合并 |

### `dom/`

跑的是**构建产物** `dist/media/*.js`（源码在 `media/src/`）。DOM 结构由 helpers 现场**执行页面模板**
得到（`webviewHtml.renderHtml` / `standalonePage`），所以测的就是壳真会发出去的那份 HTML——
从前是拿正则去模板源码里抠，页面骨架收进 `shells/shared/panes.ts` 之后那条路已经不成立了。
**未装 jsdom 时整组跳过**（会出现在汇总的 skipped 里，不再伪装成通过）。

| 文件 | 覆盖 |
|---|---|
| `view/agentTurn.test.js` | agent 那一轮的气泡：`toolCall` 先挂「进行中…」、`toolResult` 就地换成带耗时的最终形态（**不重建气泡**，重建会冲掉正在流的正文）、工具条排在正文上方、重开面板时靠 `turn.toolCalls` 回放、气泡里只有摘要没有工具的完整返回值；Agent 开关缺省关着、开着时发 `sendAgent` 且**不带 stage/capability** |
| `view/chat.test.js` | 流式逐段显示、生成中不可编辑、结束后可编辑、中断与报错、气泡 ... 菜单、空输入、产物采纳卡片、思考过程 |
| `view/creation.test.js` | 创作流水线条与下一步、工作区卡、`/` 命令面板（剧情层**八条**，含 `/落定剧情`）、选中一章进入当前阶段、独立版壳上的创作页 |
| `view/projectTree.test.js` | 目录树折叠/展开与缩进、空文件夹提示、重推后保持展开；右键菜单——**章节行按三种状态（已发布 / 只有规划 / 待拆分）增减条目**、章节组标题的四个批量动作、通用行为 |
| `view/cast.test.js` | 角色行的「出场 N 章」与「＋N 待更新」、增量/全量分别发 `updateCard`/`rebuildCard`、「出场人物 · 未建卡」分组、旧后端的树不让前端崩 |
| `view/progress.test.js` | 摘要进度横幅（已总结 N/M + 进度条）、长任务进度条（n/N、计时、停止） |
| `view/logs.test.js` | 级别与关键字过滤、detail 折叠、增量追加也走过滤；**「加载更早」**——默认不查库、点了才发 `requestLogHistory`、历史不冲掉本次会话 |
| `view/settings.test.js` | 模型分档三档渲染、八行任务表与内置默认标记、只把**改过的项**写进 `taskTiers`、指向已删模型的引用摘掉且摘空了保持为空；「高级设置」折叠开关 |
| `view/hover.test.js` | 三组悬停浮窗（章节摘要 / 行内别名 / 失败标记）：延迟才弹、缓存与作废、可进入（能选中复制）、**夹进视口**（下方放不下翻上方、贴右收左、超长压 `max-height`）、失败标记挂在章节行上、按最严重的算 |
| `standalone/editor.test.js` | 内置编辑器：草稿区惰性创建、`pane` 分派、「草稿」按钮可见性与 `openDraft` 负载、保存回执不冲掉 `draftPath`、右键菜单与标签搬家 |
| `standalone/explorer.test.js` | 资源管理器：点开头目录列得出来且压暗、目录排在文件前、懒展开、折叠连带子目录、可编辑与否走不同消息、截断如实告知、读失败降级；文件页剪贴板与右键菜单 |
| `standalone/menubar.test.js` | 文件 / 编辑 / 帮助菜单栏：点击打开、hover 隔壁切换、Esc / 点外面关闭；空窗口时部分项 disabled |
| `standalone/welcome.test.js` | 空窗口 Get Started：Start / Recent、打开文件夹与新建工程入口 |
| `standalone/picker.test.js` | 远程风目录选择器：本机列一层、进子目录、新建文件夹；打开文件走工程内 `listDir` |
| `standalone/find.test.js` | 内置编辑器查找条：Ctrl+F、Enter 下一处 / Shift+Enter 上一处 |

### `e2e/` 与 `contract/`

| 文件 | 覆盖 |
|---|---|
| `e2e/standalone/server.test.js` | 独立版服务（**需 Bun**）：静态资源、WS 首条消息、`Origin` 校验；`selectPlot` 由后端算落在哪一层（已完成的章落正文层、不给下一步），且切层不预置花钱的能力；内置编辑器的消息往返——保存落盘、过期 hash 触发冲突且不覆盖、强制保存、越界路径与非文本扩展名被拒；`openDraft` 的按需创建与并列打开；资源管理器的 `listDir` → `dirListings` 往返；**空窗口** ready 后无假工程、`openFolder` 热换、`mode: 'add'` 仍一份工作区、`closeFolder` 卸掉 |
| `contract/layerBoundary.test.js` | 工具层与 agent 层的边界：`tools/` 一行都不 import `agent/`、`agent/` 引用工具契约一律 `import type`、agent 不 import 任何一个具体工具、工具体里不出现 `ctx.budget`。这条守的是「工具能端出去做 MCP」与「循环可换」两件事，**能悄悄长回来**，只能靠断言守 |
| `contract/corePurity.test.js` | `src/core/` 零 vscode 依赖——分层架构的硬约束，也是 `external: ['vscode']` 成立的前提 |
| `contract/shellPurity.test.js` | 壳的契约（[src/shells/README.md](../src/shells/README.md)）：`shells/shared/` 零宿主依赖（不碰 vscode / node: / bun:）、三个壳互不 import、全仓库没有 `host.name ===` 这类按身份分支的写法。三条都是**能悄悄长回来**的东西，只能靠断言守 |
| `contract/sampleNovel.test.js` | `sample-novel/` 自洽：manifest 章数与磁盘一致（v1 结构，索引的是 `chapters`）、每章 `contentHash` / `summaryHash` / 摘要 `sourceHash` 对得上、摘要 frontmatter 指回章号、**每一章都有同号的细纲**、**拆分之后中转站是空的**、示例纲要能命中 3 个角色 |

## helpers/

| 模块 | 提供 |
|---|---|
| `load.js` | `loadModule(relPath)` / `loadBundle(entries)`——用 esbuild 把 **TS 源码** bundle 成 CJS 后 require，结果带缓存。**要用 Host 的模块必须打进同一个 bundle**：分开 bundle 会让每份产物各带一份 `host.ts` 的模块级状态，`initHost` 只作用于其中一份 |
| `tmpProject.js` | `makeTempProject()`（建工程并删掉 initialize 撒的示例文件）、`copyFixture()`（需要写盘时复制 `sample-novel/`）、`rel/write/read/has/remove` |
| `fakeHost.js` | 可编程假宿主：input/confirm/pick/reviewReplace 按**队列**取答案，没排队就当用户取消；录制 toasts/confirms/reviewed/opened，并能观察 `reviewReplace` 的并发峰值 |
| `fakeProvider.js` | 假模型，一律经 `registerProviderFactory` 且 `kind: 'vscode-lm'`——那是唯一不碰 SecretStore 的路径（其余 kind 会去要 API Key）。支持应答队列、函数应答、按模型注入 `unavailable`/`fail`/`cancel`，以及并发峰值观察 |
| `vscodeStub.js` | 四档能力的 `vscode` 模块桩（`minimal`/`config`/`workspace`/`full`），`full` 带真实文件系统支撑的 `workspace.fs`。**返回 `restore()`，请挂到 `after()`** |
| `teardown.js` | `cleanup(dir, db)`——**先关库再删目录**：SQLite 连接开着时 Windows 上删不掉 `.novelforge/novelforge.db`，临时工程会全留在 temp 里 |
| `dom.js` | jsdom 挂载：从 `webviewHtml.ts` / `html.ts` 抠 `<body>`、`window.eval` 加载 `dist/media/*.js`、`acquireVsCodeApi` 桩与消息泵、视图数据的夹具工厂 |
| `ws.js` | e2e 的 WebSocket 客户端（收件箱 + `waitFor(match, label)` 超时） |

## 约定

- **一条断言一个 `test()`**，名字用中文写清「验的是什么行为」——失败时那一行就是报告。
- 用 `assert.equal` / `deepEqual` 而不是 `assert.ok(a === b)`：前者失败时会打印实际值与期望值。
- 同一文件内的用例**默认串行**，多步流程（建文件 → 改名 → 断言）照原样写即可。
- 每个文件一个独立进程，`Module._load` 打的 `vscode` 桩与 `host.ts` 的模块级状态天然隔离。
- 临时目录一律走 `helpers/tmpProject.js`，收尾一律走 `helpers/teardown.js`——**碰过工程库的必须传 `db` 模块**。
- `sample-novel/` **只读**（`contract/sampleNovel.test.js` 对它有 hash 断言）；要写盘的用 `copyFixture()`。

改动 `src/core/` 后务必跑一遍 `npm test`——这是 CI 之外唯一的回归防线。
