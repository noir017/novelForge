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
| `tools/intent.test.js` | 七个工具**自报的意图**：五档归类（读三件 auto、generate costly、write 新建 mutating、**write 覆盖 reviewed**、**edit always**）与确认框上的话——花钱要说、产出之后还会再问一次落盘要说、edit 要写出 old → new。后两档是产品承诺，不是偏好设置 |
| `agent/policy.test.js` | 三种模式 × 五档那张表；`reviewed` 与 `always` 在三种模式下**逐字相同**；说辞原样来自工具、只补一个主语；拒绝之后回给模型的话有信息量（「不要重试同一个动作」）。**这个文件不认识任何一个工具名** |
| `agent/gateAsk.test.js` | 权限询问的收发（`controller/gate.ts`，闸门与产物落盘共用）：卡片的身份与按钮上的字都从后端来、答了才落地、**广播 `gateDone`**（两个视图都要收卡）、答第二次不算数、认不出的 requestId 静默丢弃、**重连时还没答的原样重推**（前端无状态）、取消按「停止」结算、`cancelGates` 收掉没答的那些；**卡片上只有两颗按钮**（调用方能改字，改不出第三颗） |
| `agent/budget.test.js` | 三条上限（回合 / 生成次数 / token）各一条、**无进展检测**的两连（提示）与三连（停）、换参数换工具与「中间隔了别的动作」都不算重复、键序不同但内容相同算重复；以及第 11 条——**日志只有工具名与参数键名，没有参数值** |
| `agent/context.test.js` | agent 上下文压缩：装得下就一个字不动、超预算时 system 与最后 6 轮完整保留而更早的工具结果只剩第一行、压缩时打 warn、压不下去时给停下的信号且**用户最初那句要求还在** |
| `workspace/kind.test.js` | 路径 → 种类的一张表：架构三件（带 `doc`）/大纲/细纲/章节/摘要/角色/设定/草稿各自的判定；**细纲平铺**（`plots/` 下的卷子目录判 `other`）；**章节不认扩展名**（无扩展名、`.txt` 都算，`.png` 不算）而角色/细纲仍只认 `.md`；章节不带创作目标；`summaries/global.md` 不被当成第 0 章的摘要；**老工程留下的 `scenes/`、`volumes/`、`manuscripts/` 判成 `other`**（磁盘不动、代码不认）；越界一律 `other` 且 `rel: undefined`、绝不抛；`pathOfTarget` 与 `kindOfPath` 往返，正文落点不走 `pathOfTarget` |
| `model/markdown.test.js` | frontmatter 解析（行内/块状数组、畸形行不抛错）、小节抽取、`extractH1`/`stripH1` 互逆、序列化往返 |
| `model/chapterFile.test.js` | 章节文件名规则：任意非二进制扩展名 / 无扩展名算章节、二进制黑名单被挡、`extractH1` 只看首行 |
| `model/project.test.js` | `cast` 条目的序列化往返（含全角括号、别名去重）、小节文本反解出场人物 |
| `model/fs.test.js` | 磁盘与字符串小工具：hash 统一 CRLF、中英文计数、文件名净化、slug 冲突追加；`readTextIfExists` 读不到给 undefined（不存在与同名目录对调用方是同一件事——这一章没有这份产物），权限之类的错误照常上抛 |
| `model/providers.test.js` | 模型引用解析（含嵌套斜杠 `openrouter/z-ai/glm-4.6`）、服务商配置容错、按模型覆盖窗口、0.1.x 单服务商兜底；默认模型列表的归一化与旧配置升级；`concurrency` / `fallbackAttempts` 的默认值与 clamp |
| `model/turnSegments.test.js` | 一轮 assistant 排下来的段（`serializeTurn`）：新会话原样带过去（含 `generate` 产出的正文）、**老会话只有 `toolCalls` 时归一成「工具们 + 正文」并不再带着 `toolCalls`**（界面只认段一条路）、那一轮没说话时不补空的文字段、普通一问一答**没有段** |
| `model/tiers.test.js` | 模型分档的配置容错：三档各自归一化、非对象不崩、裸字符串收成单元素、认不出的任务名与非法档位名回落内置默认，以及「每个任务都有内置默认档位与中文名」 |
| `model/pipeline.test.js` | 四个阶段（架构/大纲/细纲/正文）与三个能力（`split` 删了，`settle` **只有细纲层有**）、输出形态、老会话里 `volume` / `scene` / `split` 的回落（**split 回落到讨论，不替作者按花钱的按钮**）、`CreationTarget`（含 `setting` + `doc`）的稳定键与描述、`chapterLabel`；`plotFile.ts` 的 D3 格式——三节、规划字段往返、`isPlotFilled` 只认「关键事件」、**老四节细纲读进来不崩**；单章状态机（空文件按没写算、到八成算写够、**定稿过的章细纲改了也不拉回**、老工程只有正文时待定稿）与下一步文案；全书状态机（架构四件按序、大纲 1–20 与续写区间、拆细纲一批 5 章且不越过覆盖与总章数、**在第一份已有细纲之前收住**、写满即完成、散文式大纲不拦）；每一档的调用次数与 `form: 'idea'`，写正文三种下一步都报「1 次，最多 8 次」并说清为什么、带写法（接着写 continue / 重写 rewrite）；批量拆细纲的切分（跳过已有、断开区间、≤5 一批、上限 3n）；「定稿第 N 章」报「预计 1–2 次」并说清两次各做什么；批量写章的切分（已写跳过、无细纲收住、最多 10 章、两种模式按件加总） |
| `model/continuity.test.js` | 连续性事实（四期，D18）：挂上的证据是正文里的原句、人名不算命中、含人名的句子里没有时在全部句子里按更严的门槛找、找不到依据的丢掉并报出来、最多 12 条；渲染与读回往返、手改的写法都认；写正文时定位原文取前后各一段、相邻窗口合并、空白不计、正文改过时报找不到 |
| `model/characterState.test.js` | 角色卡「当前状态」归谁（四期，D15）：空的与指纹对得上归机器、改过一个字或从没盖过章的非空内容归作者、首尾空白不算改过；`replaceSection` 只换那一节（连同它下面的三级标题）、没有就追加、CRLF 保留、空值写占位 |
| `model/structureGuide.test.js` | 六种故事结构在 3 / 11 / 20 / 30 / 100 / 1000 章下的章号区间都连续、从第 1 章起到最后一章止；章数够分时每段至少一章；三幕与上游切法一致；英雄之旅与节拍表有逐段章号；给了区间就点明本批落在哪几段 |
| `model/settingFile.test.js` | 架构三件：配置 frontmatter 各字段（枚举认中文标签、写坏的数字与非正整数退化成缺席、整份大白话不抛）、渲染往返、**模板的占位不算填过、读回来是空串**、各件「填过没有」看主体小节 |
| `model/outlineFile.test.js` | 大纲按章号区间切片：各种区间写法与不是区间的标题、`###` 子节、CRLF、不抛；覆盖到第几章（**散文式大纲是 Infinity、只有模板脚手架是 0**）、`isOutlineFilled` 不把 `>` 说明与括号提示当内容、`outlineSliceFor` 重叠时取先出现的；`mergeOutline` 按区间合并（替换重叠的节、续写接在最后一节之后与附注之前、插在前后两节之间、保留前言） |
| `llm/fakeProvider.test.js` | 假模型本身：字符串应答照旧、对象应答在正文之后发 `stop`、思考先于正文、分片拼回去一字不差；`filler` 恰好 n 字、可复现、不同 seed 无公共 8-gram |
| `context/tokenizer.test.js` | token 估算（中英文比例）、`takeTail`/`takeHead` 的预算与截断标记（样本取 `manuscripts/` 里的真实正文） |
| `llm/stopSignal.test.js` | 收尾原因（`StopSignal`）：喂一段**照抄现场**的 SSE——兼容网关说了 `stop_reason: "tool_use"` 却把 `tool_use` 块整个漏掉——断言 provider 交出 `stop: toolUse` 且零个 `toolCall`（循环据此重发）；正常那一份两者都在；`stop` **排在所有 `toolCall` 之后**；上游不发这一条时**一个 stop 都不交**（`undefined` 意为「它没说」）；认不出的原因归 `other`、截断归 `maxTokens` |
| `context/replay.test.js` | 重演检测：整段搬了上一章结尾（改过标点空白、全角半角）一定报、零星撞词与一句呼应的台词不报、只查开头 1200 字、太短不判不抛；报出的 `quote` 是新稿里的原文；上一章结尾取最后约 1000 字并对齐到句子边界 |
| `generation/continuation.test.js` | 续写的纯函数：被截断就续（哪怕字数够了）、不到八成就续、别的原因停了不续、没有目标不续、7 轮封顶；续写开头复述了已写末尾（≥48 字）那一截去掉、整段一字不差的重复去掉（短对白不算）、「未完待续」一类话术去掉 |
| `context/tokenCounter.test.js` | 可替换计数器的注册/切换、`prepare` 抛错时不带崩、用量校准统计只收真实用量 |
| `features/creation.test.js` | 模型输出清洗（去代码块/开场白/标题/字数统计，正文不误伤）、标题推断 |
| `features/structured.test.js` | 结构化产物的解码：语法修复只许补闭合括号与改标点（改一个字就拒收）；细纲批次缺字段给带路径的诊断、超长截断不作废、新角色必须在出场名单里、覆盖检查；角色图谱清单的关系闭合与宽松说明、详情以冻结清单为准、关系写到双方卡上；小说配置英文键映射、「全局要求」合同、保留作者原文、规范化草稿读回来时文风单独拿出 |
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
| `agent/stateBrief.test.js` | 状态注入：**label 与 hint 与状态机一字不差**（第 20 条的硬断言），把一本书从零走一遍（生成小说配置 → 大纲 → 拆细纲 → 写 / 接着写 / 定稿 → 做完转去报全书下一步 → 写完照实说）；**target 是还没落盘的下一章细纲时也报「写第 N 章细纲」**（与主按钮一致）；老工程（99 章成品、没有架构）全书下一步推回「生成小说配置」、选中的章按章号认；⟳ 超 5 章写「等 N 章」 |
| `agent/loop.test.js` | agent 循环（脚本化假 provider）：不调工具时一个回合结束、tool 消息形状、连续两次同工具同参数收到提示且**不真跑**、三次停下并仍给一轮总结、预算触顶时最后一轮**不带 tools**、取消停在工具边界且已产出的 draft 保留、工具抛异常变成 error 回给模型、**工具产出的正文走 `onToolDelta`（带 callId）而 `onDelta` 里只剩模型自己说的话**、**上游说要调工具却没把调用发过来时原样重发这一回合**（同一份上下文、气泡里留一句解释、额度按回合归零；连着几次都缺就停在 `stopReason: 'protocol'` 并说清是接口丢了这一段，而「上游没说收尾原因」照旧当成最终回答）、日志里没有 prompt 全文/参数值/正文 |
| `generation/structuredChain.test.js` | 生成链经对话页走到落盘：配置截断整份重来、「全局要求」只重写这一节、一句话与规模按弹窗、文风只写进没动过的 `style.md`、保留原文追加生成；角色图谱两段式、截断拆半、关系写到双方卡上；细纲批次截断对半拆且后一半看得见前一半、卡片列出新建的角色卡与降级说明、**漏章 fail-closed**、只改标点的修复收下而改了内容的拒收、单章缺字段紧凑重建；大纲续写只并进那一段、不弹审阅 |
| `generation/blueprintChain.test.js` | **二期验收**：跟着主按钮从空工程走「一句话 → 配置 → 前提 → 角色图谱 → 世界观 → 大纲第 1–20 章 → 第 1–5 章细纲」，钉住按钮顺序、每一步的装配里有前面几步的产物、一共 7 次调用、一张审阅都不弹、最后转到「写第 1 章」 |
| `generation/manuscriptChain.test.js` | **三期验收**：跟着主按钮从空工程一路写完前 3 章（二期那六步 → 写 / 定稿 / 写 / 定稿 / 写），第 2 章被截断自动续写一轮、第 3 章开头重演了第 2 章结尾；钉住按钮顺序、写正文那几步报「最多 8 次」、两套法则、第 2 章的装配（不许重演、后几章边界、执行卡的钩子、全局要求）、重演时卡片标红与两段式、一共 13 次调用、一张覆盖审阅都不弹 |
| `generation/continuation.test.js` | 正文续写链的每个分支：一次写够、截断后续写（气泡里只空一行）、不到八成续写、低增长丢弃后恢复一次（气泡退回、恢复那一轮开头说清）、恢复也失败时保留已写的、**思考耗尽报错不出 Draft**、最终未写够照样出 Draft、续写那一轮调用失败保留已写的、重演写进 Draft、接着写只含新增且字数连已有的算、重写带上一版作底稿 |
| `generation/writeCard.test.js` | 写正文那张卡片：「x / y 字 · 已达标 / 未写够」、续写了几轮一共调了几次、接着写说「追加」并写明已有与新写、重演时 gate 带红色块与两段式确认；写的过程中推 `writeProgress`，丢弃一轮时推 `streamReset` |
| `generation/chapterWorkbench.test.js` | 章节工作台后端：`openChapter` 正文开主区、宿主能并排时细纲开旁边（没有 `openBeside` 只开正文、没有正文只开细纲、两样都没有说找不到）；`chapterAction` 接着写等于对这一章按主按钮、没有正文时定稿说无法定稿 |
| `generation/accept.test.js` | 产物落盘走的是**当场问的那张卡片**（写正文：新写说写入、接着写说追加且不审阅、不带写法再写一次说覆盖并审阅、标题行留着）：卡片说得出写到哪、只有两颗按钮、**没答时磁盘没动静**；落点从 draft 取（答之前切了一章也写对）、落盘的是气泡里当下那份（先 `editTurn` 再点写入）、答「不采纳」一个字不写且气泡上留一行；讨论型回复不问；刷新网页时没答的卡片重推、面板销毁时按「未采纳」结算；并发控制那三条 |
| `agent/gate.test.js` | 闸门串起来之后：默认模式下 write 弹一句且**说清写到哪**、两个选项（确认 / 跳过）、跳过则不执行而循环接着跑、**没回答当停止**且仍给最后一轮总结、放手模式新建不问、**覆盖审阅任何模式都在**、读工具从不打断、瞎编的工具名不问；**有 `onGate` 时不弹宿主的框**（面板那条路把这一句画进对话）；以及**产出之后当场问一句落盘**——三种模式都问（第 19 条，不是偏好设置）、结论回给模型、那一问没人答就停下且仍给最后一轮总结、没实现 `onArtifact` 就不问 |
| `workspace/guard.test.js` | **八条入口守卫**各至少一条：越界（含归一化后仍逃出去的）、工程根包含、固定目录保护、回收站不可改（但读得到）、2MB 上限、同名不覆盖、覆盖审阅（两种宿主 + 文案逐字）、内容 hash 乐观锁 |
| `workspace/basic.test.js` | `Workspace` 门面：write 的三种 mode、审阅拒绝时一字未改、乐观锁冲突、read 的 `truncated`（不静默截断）、edit 的「old 不唯一就报错」与「要么全成要么全不成」、remove 进 `.trash/` 且同名加序号、move 不覆盖、list 带 `kind` |
| `workspace/hashChain.test.js` | **记账下沉**：改大纲后直接 `write` / `edit` 细纲文本，`upstreamHash` 跟着更新；**大纲改了哪一节，只标脏那一节覆盖的章**（续写新一节、只改第二幕、改区间标题）；`writtenFrom` 只改细纲 frontmatter、正文字节不动、编辑器改细纲不抹掉它；`plotContentHash` 只哈希三个小节、标 done 不动指纹；**手写的产物永不标脏**；删细纲不碰 `chapters/` 与摘要；摘要 `sourceHash` 记正文、`createChapter` 同名报错且同步 manifest |
| `workspace/search.test.js` | 全文检索：单章命中带章号、跨章按**章号**升序、`kinds`/`path` 限定、回收站与二进制不命中、`perFile`/`limit` 超限时 `dropped > 0`、正则与坏正则降级 |
| `files/fileOps.test.js` | 层级目录与类文件操作：递归扫描（含 `.trash/` 排除）、`ProjectTree` 折叠、路径越界守卫、新建/重命名（保留序号前缀、H1 同步）/移动（跨区/自嵌套/同名拒绝）/删除（搬回收站、不覆盖）；**细纲走另一条路**——改名/删除不动同号章节与摘要、改名带着 `writtenFrom`（正文不标脏），且没有「移动到…」；摘要按**章节**名镜像（同号不同名互不覆盖）；`buildPlotSummaryView` |
| `files/projectFiles.test.js` | 工程根范围的文件操作：重命名/移动/复制、固定目录保护、同名拒绝、垃圾箱豁免、章节联动 |
| `files/chapters.test.js` | 非 markdown 章节不解析 H1、角色区仍只认 `.md`、`isEditablePath` 放行无扩展名章节 |
| `files/listCache.test.js` | 章节与**细纲**两份列表缓存的并发语义：并发调用只扫一遍全书、`invalidate` 后重扫、**扫描途中失效的那一轮不回填缓存**（否则界面会停在变更之前的字数与过期标记）；外加 `writePlot`/`deletePlot` 自己让缓存失效（否则新建的章不出现在工程页上，且不报错） |
| `views/projectTreeReads.test.js` | 工程页刷新的**读盘次数**：同一个文件一次刷新至多读一次（含 `config.md`）、每章 fs 调用不超过 4 次（细纲 + 章节 + 摘要各一次，再加全书常数的余量）、章数翻倍不超过线性增长。这条路由文件监听触发，作者每存一次盘就跑一次，重复读盘不报错只变慢，只能靠断言守 |
| `files/drafts.test.js` | 草稿路径镜像、按需创建且第二次不覆盖、不混进章节树与 manifest、`@` 引用、跟随改名/移动、删章节不删草稿 |
| `context/manuscriptRecipe.test.js` | 正文层的装配（三期）：全局要求单独强制带且不在架构那几条里重复、后 5 章细纲按章号窗口作边界（空壳不带）、边界在本章细纲之后、执行卡压在最末（必需事件 / 章节钩子 / 作者本章指导）、篇幅合同 ±20%；第 1 章黄金第一章法则、后续章连载法则、D8 禁令与作者事实都在系统提示里；接着写带本章已写末尾、不带上一章结尾、只要新增的那一段；续写那几轮用精简配方、恢复那一轮说清上一轮已丢弃 |
| `context/evidence.test.js` | 正文层的 `evidence` 层（四期，D18）：前 5 章的事实全取、更早的只取涉及本章角色的；带证据所在那一段与前后各一段；正文改过、定位不到的换成事实原句并标 degraded；整章正文进来的章不再单独带片段；上一章没定稿时明细里写明（D23）；一共 6000 字、最多 12 章；「注入完整原文章数」为 0 时一章全文都不带 |
| `context/builder.test.js` | 完整上下文装配：优先级、预算、降级链、手动排除、附件截断、多轮历史封顶、四阶段配方与身份（**架构层三件 P0 force**、大纲按章号区间分节、细纲可写具体场面、正文层本章细纲与文风 P0 force）、provider 配额压缩；**`settle` 时历史保得住**（cap 60% + P0，且输出契约与 `generate` 一字不差）、**没写正文的章退化成只带「本章目的」并注明原因**、**挑角色卡先看本章细纲的 `characters`**（不进出场统计）、前一章没写时不让模型从更早那一章结尾接；**二期的四层与移植的契约**（大纲带结构指导且点明本批范围、角色图谱一览、细纲批次没有「本章」而由前序细纲一览全包、拆半后看得见前一半、角色详情带冻结清单、紧凑重建写明上次哪里不合格、角色图谱带上设计原则）；工程页快照（「故事架构」五行、全书阶段）与出场人物索引。**写入类用例跑夹具的临时副本**，`sample-novel/` 只读 |
| `features/creation.test.js` | 创作编排层：产物解析的三层降级与 `parsePlotStrict` 的不兜底版本（架构层按 target 分辨是哪一件；角色图谱三种写法，**单人裸数组也认**）；各条落盘路径——配置的 frontmatter 合并、**覆盖空模板不审阅、已有内容先问且拒绝时一字不写**；角色图谱新卡直接建、**同名的先审阅**（名字与别名撞上同一张卡只审一次，保留原样时一字不动，同意时空着的节沿用旧卡）；细纲新建（占位路径按标题落盘）与**再按占位路径采纳要按章号认出那一份、先审阅**；正文落同号章节、记 `writtenFrom`、接着写追加只空一行、**重写覆盖前先问**（保留原样一字不改也不记指纹、覆盖时标题行沿用原文件）、老会话没记写法的按覆盖审阅；没有细纲也没有同号章节时按号新建章节、不造细纲 |
| `features/pipelineData.test.js` | 细纲的解析/渲染往返与平铺扫描（卷子目录不扫、老四节细纲三节全空）、新工程不建 `volumes/` 与 `manuscripts/`、架构空模板不算填过；**新鲜度链**（没定稿的章细纲改了退回重写，定稿过的只挂 ⟳）、**手写的产物永不标脏**；索引按章号一行、撞号取第一份；全书事实从空工程推到「在写」（连续才算、空文件不算写过）与 `chapterTargetOf` 的三种落点；工作区卡（正文卡摊细纲三节、架构卡） |
| `features/selectPlot.test.js` | 「选中一章」这个入口：三种路径形状（工程页的主路径 / 下拉框那个**并不存在**的细纲路径 / 真实细纲路径）都按章号认到同一章，目标一律归到细纲那一侧；只有正文的章不报「这一章不存在」，也不被倒回「待写细纲」；两边都没有时才提示；状态机仍决定落在哪一层且不预置花钱的能力 |
| `features/pipelineRefresh.test.js` | `pushState` 连流水线条一起推：单章四格各走一遍（编辑器里写细纲 → 手贴正文 → 改细纲 → 写摘要），每一格主按钮都跟上；这一章做完之后转去问全书的下一步 |
| `features/pipelineBatch.test.js` | 工程页的批量拆细纲：跳过已有细纲的章并把区间断开、确认框报批数与预计 / 最多调用次数、后一批读得到前一批刚写好的、**一批失败就停**（降级链走到头、后一批不跑、失败挂在那一批第一章上）、弹窗确认过的不再弹确认框；**只补不改**、缺上游不生成下游、标题与作者定的字数不被模型顶掉；用户取消时一次模型都不调（批量写章也是）；装配走同一个 `buildContext` |
| `features/writeBatch.test.js` | 批量写章（四期）：确认框报区间、模式与上限，弹窗确认过的不再问；一章一章串行、不看并发设置，后一章的装配里有前一章的结尾；已有正文的跳过、第一章没细纲的在它前面收住；写完即定稿的顺序（写 → 摘要 → 角色状态 → 下一章）；**失败即停**（红 ❗ 挂在那一章）；重演、没写够八成的写进去然后停（黄 ❗）；「写完这一章就停」与「停止」；一章之内续写那几轮不换模型；完成提示带「打开第 N 章」 |
| `features/finalize.test.js` | 定稿（四期）：摘要的连续性事实每条带一句正文原句、找不到依据的丢掉并报出来；机器的卡换上新状态、只动那一节、作者自加的小节还在；作者改过的卡不写、挂黄 ❗、对比后采用 / 放弃；名单外的名字忽略；出场了没变的推「写到第几章」；不回退到更早的章；没人有卡时只调 1 次；角色状态失败时摘要照样在、黄 ❗ 挂在章节上 |
| `features/serialBatch.test.js` | ★ **四期验收**：批量写章第 1–3 章、写完即定稿，经 controller 发出；三章正文与摘要都在、连续性事实带证据；**第 3 章写正文那一次的装配里是第 2 章更新过的角色状态、定稿原文片段里有第 2 章证据所在的那一段**；作者手改过的状态两次定稿都没覆盖、挂黄 ❗；调用次数不超过确认框的上限；主按钮转去第 4 章 |
| `features/settingsBatch.test.js` | 工程页「补齐设定」：没有一句话时不调模型；确认框报缺哪几件、预计与上限；按 配置 → 前提 → 角色图谱 → 世界观 的顺序、后一件读得到前一件；**作者写过的节原样留着、不弹审阅**；一件失败就停并挂在那一行上 |
| `features/cast.test.js` | 别名的泛称过滤；同一人聚类——**同章共现的两人绝不合并**；出场索引的正式名优先与 `conflicts`；维护命令（清理别名不动正文、合并重复卡、水位线退回） |
| `features/characterCard.test.js` | 更新角色卡：分批与「预计调用 M 次」、只装该角色的出场章、增量无新章时**一次模型都不调**、部分失败时**水位线停在第一个失败章之前**、取消/放弃不落盘；**并发**下模型请求重叠但 **diff 审阅仍一次只弹一张** |
| `features/lore.test.js` | 自动生成设定：逐章识别次数、跨章合并、分类目录落盘、已有设定必须经审阅 |
| `storage/errorLog.test.js` | 工程库与失败记录：驱动适配层、**关库之后删得掉目录**、纯读取不建库、失败记录生命周期、日志持久化与挂 sink 前的补写、**库不可用时全线静默降级** |
| `storage/session.test.js` | 会话读写往返（含 agent 那一轮的**段**：顺序原样、`generate` 产出的正文也留得住）、损坏文件容错、列表排序、重命名/删除、id 唯一性、`.novel` → `.novelforge` 迁移 |
| `llm/streaming.test.js` | 起本地假服务器模拟 SSE：流式解析（跨块切分、CRLF、心跳、非 JSON 行）、取消、超时、**流式还在吐字时不超时**、HTTP 401/404/429，Anthropic 的 system 提取与消息合并，以及**思考深度落成请求字段**（两家各自的 effort 字段、思考开着时不带 temperature）与**上游拒了就换写法**（降一档 / 换一代写法，结论记住不再重试） |

### `dom/`

跑的是**构建产物** `dist/media/*.js`（源码在 `media/src/`）。DOM 结构由 helpers 现场**执行页面模板**
得到（`webviewHtml.renderHtml` / `standalonePage`），所以测的就是壳真会发出去的那份 HTML——
从前是拿正则去模板源码里抠，页面骨架收进 `shells/shared/panes.ts` 之后那条路已经不成立了。
**未装 jsdom 时整组跳过**（会出现在汇总的 skipped 里，不再伪装成通过）。

| 文件 | 覆盖 |
|---|---|
| `view/agentTurn.test.js` | agent 那一轮的气泡：`toolCall` 先挂「进行中…」、`toolResult` 就地换成带耗时的最终形态（**不重建气泡**，重建会冲掉正在流的内容）、工具调用打断之后两句话各自成块、重开面板时靠 `turn.segments` 回放（`generate` 画成一张卡，不是一行）、那一行上只有摘要；**直接发送就是 agent**（没挑命令时发 `sendAgent` 且**不带 stage/capability**，挑了 `/命令` 才回到 `send`） |
| `view/agentSegments.test.js` | **说的话与做的事按发生顺序交替**：说 → 查 → 说各自成块、相邻的调用并进同一串、`toolDelta` 只进 generate 那张卡（不进任何一块正文）、卡默认展开、`toolResult` 换掉头与结论而**卡里那份正文不丢**（落盘结论重推一次也不丢）、生成中说「生成中…」、第一段是工具调用时那块空正文占位撤掉、参数收在再一层折叠里、回放（`segments` + `output`）、有段的那一轮只读而一块正文的那一轮照旧可改 |
| `view/agentTools.test.js` | 工具流那一串：花销行实时画出且**留得住**、非正常结束把原因写在同一行、失败那步标红保留、停止按钮全程可用；**详情点得开**——那一行仍只画摘要，参数与返回在折叠里，老会话没明细就不长出三角，进行中就查得到参数、结果到了展开状态跟着走 |
| `view/gate.test.js` | 权限请求卡片**固定在输入框上方（`#gateDock`），既不是遮罩层也不进消息流**：卡片在 `.composer` 里、排在输入框之前、说清动的是哪个文件、参数收在折叠里、按钮的字来自后端且同意贴最右、认不出的 turnId 照样画、叠了两张才编号、点下去发回 `gateResult` 并就地撤卡（消息流里补一行 `.gate-note` 记录，广播回来不补第二行）、重连重推不画两张、`gateDone` 让另一个视图也收卡；**落盘那种只有两颗按钮，那一行记录挂在正文下面** |
| `view/chat.test.js` | 流式逐段显示、生成中不可编辑、结束后可编辑、中断与报错、气泡 ... 菜单、空输入、**产物那一行（气泡上没有任何写文件的按钮**，只有「产出过什么 / 已写入哪儿 / 未采纳」）、思考过程 |
| `view/creation.test.js` | 创作流水线条（架构 / 大纲目标只剩面包屑；章目标是「细纲 / 正文」两格 + 定稿状态）与下一步——**主按钮发的是 `step.target` 与 `step.range`**（会话停在大纲、下一步落在第 1 章细纲；这一章写完、下一步落到下一章），忙碌时禁用；工作区卡、`/` 命令面板（细纲层「落定细纲 / 写细纲」、切层跟着换）、目标下拉（第一项「全书」）、选中一章进入当前阶段、独立版壳上的创作页 |
| `view/forms.test.js` | 一句话弹窗（主按钮打开而不直接发送、默认值来自后端、保留原文的说明、全书字数实时算、Ctrl+Enter 发 send 带 setup 并切到对话页、空脑洞与越界规模不许提交、Esc 关掉什么都不发）；拆细纲弹窗（缺省区间、跳过几章 / 分几批 / 预计与最多几次与后端同源、超出大纲覆盖不许提交、提交带 `confirmed`）；工具栏「补齐设定」；主按钮提示写调用次数；**批量写章弹窗**（四期 W9）：缺省区间与模式、实时说明与 `planWriteBatch` 同源、一次最多 10 章、写完即定稿要点两下（改了值退回第一段）、提交带区间 / 模式 / confirmed |
| `view/characterState.test.js` | 角色行上的当前状态（四期，D15）：说明里写「状态截至第 K 章」；挂着 `cardState` 的卡右键多「对比第 N 章给出的状态…」，点了发 `reviewState`；没挂的没有这一项 |
| `view/projectTree.test.js` | 「故事架构」组五行（x/5、点名字打开、角色图谱进入那一层、没有重命名删除、**第一件没填的那一行有「去生成」**）；章节组一个章号一行（身份是正文或细纲路径、三种徽章、⟳、「写了 / 目标」字数、**只有下一个该写的章有「去写这一章」**且点了只发 `selectPlot`、点行名发 `openChapter`——正文与细纲并排由后端按能力开）；目录树折叠/展开与缩进、空文件夹提示、重推后保持展开；右键菜单按三种行（写完 / 没细纲 / 没正文）增减条目、章节组标题的新建与批量动作、通用行为 |
| `view/writeProgress.test.js` | 写章过程可见（W7）：流式气泡顶上「正在写 / 续写第 k 轮 · 已写 x / 目标 y 字」与进度条（到八成换色、没有目标来回扫）、`streamReset` 退回正文、收尾后进度条消失而字数记录留在气泡上（没写够警示色、重演标红）；写入卡的红色块与**两段式写入**（第一下只换字，第二下才发）；主按钮「接着写」发出的 send 带 `writeMode` |
| `view/cast.test.js` | 角色行的「出场 N 章」与「＋N 待更新」、增量/全量分别发 `updateCard`/`rebuildCard`、「出场人物 · 未建卡」分组、旧后端的树不让前端崩 |
| `view/progress.test.js` | 摘要进度横幅（已总结 N/M + 进度条）、长任务进度条（n/N、计时、停止）；**页头任务条**（四期 W8）：不在工程页里、对话页开着也看得见，批量写章的「写完这一章就停」发 `stopAfterItem`、点过换成说明，完成提示的「打开第 N 章」发 `openChapter` |
| `view/logs.test.js` | 级别与关键字过滤、detail 折叠、增量追加也走过滤；**「加载更早」**——默认不查库、点了才发 `requestLogHistory`、历史不冲掉本次会话 |
| `view/settings.test.js` | 模型分档三档渲染、八行任务表与内置默认标记、只把**改过的项**写进 `taskTiers`、指向已删模型的引用摘掉且摘空了保持为空；「高级设置」折叠开关 |
| `view/hover.test.js` | 三组悬停浮窗（章节摘要 / 行内别名 / 失败标记）：延迟才弹、缓存与作废、可进入（能选中复制）、**夹进视口**（下方放不下翻上方、贴右收左、超长压 `max-height`）、失败标记挂在章节行与架构行上、按最严重的算；**从章节行挪到架构行时浮窗收起**（架构行也带 `.row-plot` 但没有摘要） |
| `standalone/editor.test.js` | 内置编辑器：草稿区惰性创建、`pane` 分派、「草稿」按钮可见性与 `openDraft` 负载、保存回执不冲掉 `draftPath`、右键菜单与标签搬家 |
| `standalone/chapterBar.test.js` | 章节条（W6）：只在开着某一章的正文或细纲时出现、写这一章在哪一步写了多少、四颗按钮按状态亮灭且提示里写调用次数、点了发 `chapterAction`、另一份没开着时「并排看细纲 / 正文」、工程树更新时跟着变 |
| `standalone/explorer.test.js` | 资源管理器：点开头目录列得出来且压暗、目录排在文件前、懒展开、折叠连带子目录、可编辑与否走不同消息、截断如实告知、读失败降级；文件页剪贴板与右键菜单 |
| `standalone/menubar.test.js` | 文件 / 编辑 / 帮助菜单栏：点击打开、hover 隔壁切换、Esc / 点外面关闭；空窗口时部分项 disabled |
| `standalone/welcome.test.js` | 空窗口 Get Started：Start / Recent、打开文件夹与新建工程入口 |
| `standalone/picker.test.js` | 远程风目录选择器：本机列一层、进子目录、新建文件夹；打开文件走工程内 `listDir` |
| `standalone/find.test.js` | 内置编辑器查找条：Ctrl+F、Enter 下一处 / Shift+Enter 上一处 |

### `e2e/` 与 `contract/`

| 文件 | 覆盖 |
|---|---|
| `e2e/standalone/server.test.js` | 独立版服务（**需 Bun**）：静态资源、WS 首条消息、`Origin` 校验；`selectPlot` 由后端算落在哪一层（已完成的章落正文层，**下一步转到全书的下一步**「拆细纲（第 4–8 章）」），且切层不预置花钱的能力；内置编辑器的消息往返——保存落盘、过期 hash 触发冲突且不覆盖、强制保存、越界路径与非文本扩展名被拒；`openDraft` 的按需创建与并列打开；资源管理器的 `listDir` → `dirListings` 往返；**空窗口** ready 后无假工程、`openFolder` 热换、`mode: 'add'` 仍一份工作区、`closeFolder` 卸掉 |
| `contract/layerBoundary.test.js` | 工具层与 agent 层的边界：`tools/` 一行都不 import `agent/`、`agent/` 引用工具契约一律 `import type`、agent 不 import 任何一个具体工具、工具体里不出现 `ctx.budget`。这条守的是「工具能端出去做 MCP」与「循环可换」两件事，**能悄悄长回来**，只能靠断言守 |
| `contract/corePurity.test.js` | `src/core/` 零 vscode 依赖——分层架构的硬约束，也是 `external: ['vscode']` 成立的前提 |
| `contract/shellPurity.test.js` | 壳的契约（[src/shells/README.md](../src/shells/README.md)）：`shells/shared/` 零宿主依赖（不碰 vscode / node: / bun:）、三个壳互不 import、全仓库没有 `host.name ===` 这类按身份分支的写法。三条都是**能悄悄长回来**的东西，只能靠断言守 |
| `contract/sampleNovel.test.js` | `sample-novel/` 自洽：manifest 章数与磁盘一致（v1 结构，索引的是 `chapters`）、每章 `contentHash` / `summaryHash` / 摘要 `sourceHash` 对得上、摘要 frontmatter 指回章号、**细纲号 = 章号**、细纲的 `upstreamHash` / `writtenFrom` 都新鲜、架构三件都填过且配置解析得出规模参数、大纲覆盖到总章数、没有 `volumes/` 与 `manuscripts/`、示例纲要能命中 3 个角色 |

## helpers/

| 模块 | 提供 |
|---|---|
| `load.js` | `loadModule(relPath)` / `loadBundle(entries)`——用 esbuild 把 **TS 源码** bundle 成 CJS 后 require，结果带缓存。**要用 Host 的模块必须打进同一个 bundle**：分开 bundle 会让每份产物各带一份 `host.ts` 的模块级状态，`initHost` 只作用于其中一份 |
| `tmpProject.js` | `makeTempProject()`（建工程并删掉 initialize 撒的示例文件）、`copyFixture()`（需要写盘时复制 `sample-novel/`）、`rel/write/read/has/remove` |
| `fakeHost.js` | 可编程假宿主：input/confirm/pick/reviewReplace 按**队列**取答案，没排队就当用户取消；录制 toasts/confirms/reviewed/opened，并能观察 `reviewReplace` 的并发峰值 |
| `fakeProvider.js` | 假模型，一律经 `registerProviderFactory` 且 `kind: 'vscode-lm'`——那是唯一不碰 SecretStore 的路径（其余 kind 会去要 API Key）。支持应答队列、函数应答、按模型注入 `unavailable`/`fail`/`cancel`、并发峰值观察；应答可以是 `{ text, stop, reasoning, chunks }`（测续写要靠 `stop: 'maxTokens'`），`filler(n, seed)` 造恰好 n 字、不同 seed 之间无公共 8-gram 的正文 |
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
