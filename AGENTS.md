# AGENTS.md

Novel Forge 帮作者**把一个脑洞养成一本完整的书**：从一句念头开始，逐层填成大纲、剧情、场景，最后写成正文。三种壳（独立 Web 服务 / 桌面 App / VS Code 插件）共用同一套核心。

实现上分两条主线：**往下展开**——按**创作阶段**（大纲 / 剧情 / 细节 / 正文）分别装配上下文并透明展示，把上一层产物展开成下一层（排细纲、拆场景、写正文，流式预览、当场点头才落盘）；**往回记住**——单章/全书摘要、角色卡与设定整合，让「记忆」有限且可人工校正。所有数据是工作区里的普通 Markdown（`.novelforge/` 目录），可 Git、可手改。

**规划的单位是「剧情段」，管理的单位是「章」，两者是两条轴。** 往下展开的链是五环：`outline.md` ──拆卷──▶ `volumes/` ──拆段──▶ `plots/` ──拆场景──▶ `scenes/` ──▶ `manuscripts/` ──拆章──▶ `chapters/`。

- **卷**是一条完整的中等弧线（`.novelforge/volumes/NN-卷名.md`）。大纲直接拆成一章章的细纲跨度太大——全书大纲那一两千字里没有足够的信息去决定第 7 章该发生什么，模型只能一次吐五章骨架，而那五章彼此的因果薄得像一份目录。**卷不是一个创作阶段**，只做收纳（段按卷落进 `plots/<卷词干>/`）与拆分。
- **剧情段**从卷纲里拆，**一次只拆一段**：有了卷纲这个中等尺度的参照，「接下来该发生什么」才答得准。
- **`chapters/` 是唯一真相**（摘要从它生成、上下文从它取正文）；`manuscripts/` 是**中转站**——模型写多长由剧情决定，不必为了凑一章而强行收束，正文写完后作者在编辑器里用单独一行 `---` 标断点，点「拆成章节」切成 `chapters/` 下的发布章，中转站那份随即删掉，落点记进这一段的 frontmatter（`chapters:`）。
- 因此**段号与章号是两条独立的轴**：段号只是 `plots/` 里的排序键，章号必须连续。界面上剧情段称「剧情 N」，那个 N 是**推导出来的位次**（最新章号 + 在未交付的段里排第几）。所以老工程的 99 章天生就是「已完成的 99 章」，不需要迁移。

产品文档（面向作者的完整使用说明）见根目录 [README.md](README.md)。本文件面向代码代理：先读模块 README 再动手。

## 常用命令

shell 为 PowerShell（不支持 `&&`，用 `;` 分隔），均在仓库根目录执行：

```powershell
npm install              # 依赖
npm run compile          # esbuild 打包到 dist/extension.js + dist/media/ 的前端产物（F5 调试前必须有）
npm run watch            # 监听构建（两边都监听）
npm run media            # 只构建前端资源（media/src → dist/media/）
npm run typecheck        # tsc --noEmit，含 media/tsconfig.json，必须零错误
npm test                 # typecheck + 全部测试（node:test），不需要 API Key
npm run test:unit        # 只跑纯函数那档，毫秒级
npm run test:integration # 真临时工程 + 假模型
npm run test:dom         # jsdom 跑 dist/media 前端产物
npm run test:e2e         # 独立版服务（需 Bun）
```

改了 `src/core/**` 后必须跑 `npm test`；改了任何 TS（含 `media/src/**`）都要过 `npm run typecheck`。手动验证 UI 时按 `F5` 启动 Extension Development Host（自动打开 `sample-novel/`）；独立版与桌面壳也各有 F5 配置，见 [.vscode/README.md](.vscode/README.md)。

测试按类型分目录放在 [`tests/`](tests/README.md)（`unit` / `integration` / `dom` / `e2e` / `contract`），运行器是 Node 自带的 `node:test`，零新增依赖。单跑一条：`node --test --test-name-pattern="关键字" "tests/unit/**/*.test.js"`——**glob 要带引号**，`node --test <目录>` 会把目录当模块入口报错。

## 模块地图

改动前先读对应模块的 README：

| 模块 | 一句话职责 | README |
|---|---|---|
| `src/` | 两层架构总览与一条创作请求的完整链路 | [src/README.md](src/README.md) |
| `src/core/` | 核心逻辑层入口（含协议 `protocol/`、读写网关 `workspace/`、文件能力 `files/`、只读聚合与界面快照 `views/`、运行时设施 `runtime/`）。`views/pipeline.ts` 是磁盘 I/O 聚合器；`model/pipeline.ts` 仍是纯领域模型与状态机，绝不搬进 `views/`。 | [src/core/README.md](src/core/README.md) |
| `src/core/model/` | 数据层：NovelProject（**只剩领域查询**，写盘全在 workspace/）、Markdown 解析、章节文件名规则、**创作流水线领域模型 pipeline.ts**、卷纲 volumeFile.ts、细纲 plotFile.ts、场景 sceneFile.ts、服务商配置、思考深度 thinking.ts、会话存储 | [src/core/model/README.md](src/core/model/README.md) |
| `src/core/workspace/` | ★ **工程的唯一读写网关**：路径 → 种类（`kind.ts`）→ 八条守卫（`guard.ts`）→ 解析/渲染/记账/伴生（`handlers/`）。写盘从前散在六处、各带一部分保护，现在收成一处；`upstreamHash` / `beatsHash` 的记账下沉到写入路径本身，谁写都记 | [src/core/workspace/README.md](src/core/workspace/README.md) |
| `src/core/context/` | ★ 分阶段装配（配方 × 层）+ 身份化提示词 + 可替换的 token 计数器 | [src/core/context/README.md](src/core/context/README.md) |
| `src/core/generation/` | ★ 创作的一次单步：**无状态**地装配 → 调模型 → 解析成 `Draft`（收 signal，并发控制在 controller）、六条落盘分派、Draft store（随会话落盘，`write draftId=…` 认它） | [src/core/generation/README.md](src/core/generation/README.md) |
| `src/core/tools/` | ★ **工具层**：契约（`ToolDef` / `ToolIntent` / `ToolInvoker`）、schema 校验、注册表（执行 + 兜异常 + 记日志），以及 `novel/` 那七个工具：读三件 + `generate` + `write` / `edit` / `run`，**没有删除/改名/移动**。**不认识 `agent/`**（形状照 MCP 的 `tools/list` + `tools/call` 摆，将来能单独端出去） | [src/core/tools/README.md](src/core/tools/README.md) |
| `src/core/agent/` | ★ 多步调度：对话循环、状态注入、预算闸门与无进展检测、**策略与确认闸门**（`policy.ts`）。手上只有一个 `ToolInvoker`，**不认识 `Workspace` / `DraftStore` / 具体工具**；「下一步该做什么」由 `deriveNextStep` 每回合注入，agent 拿着它去执行而不是另做判断 | [src/core/agent/README.md](src/core/agent/README.md) |
| `src/core/features/` | 功能编排：创作（四层产物）、批量流水线、摘要、角色卡、设定、文风提取 | [src/core/features/README.md](src/core/features/README.md) |
| `src/core/llm/` | LlmProvider 接口、OpenAI / Anthropic 实现、注册表与 API Key | [src/core/llm/README.md](src/core/llm/README.md) |
| `src/shells/` | ★ 三个壳并排放这里，外加 `shared/panes.ts`（所有 pane 的 DOM 唯一来源）。**壳的契约在这份 README 里**：壳只做实现 Host、传输与生命周期、平台专属入口三件事 | [src/shells/README.md](src/shells/README.md) |
| `src/shells/vscode/` | VS Code 壳：extension 入口、命令、两个 webview 宿主、vscode-lm | [src/shells/vscode/README.md](src/shells/vscode/README.md) |
| `src/shells/standalone/` | 独立 Web 服务壳（Bun）：HTTP/WS、WorkspaceHub 热换工程、本机列目录、页面装配、CLI 的 TerminalHost | [src/shells/standalone/README.md](src/shells/standalone/README.md) |
| `src/shells/desktop/` | 桌面壳（Windows / Linux，Rust）。**一层纯壳**：sidecar 不传工程路径，闪屏只负责起服务；打开文件夹在页面里热换。这个目录本身就是 Tauri 工程根 | [src/shells/desktop/README.md](src/shells/desktop/README.md) |
| `media/` | 前端资源（原生 TS/CSS，无框架）。**仓库里只有源码 `media/src/` 与 `icon.svg`，构建产物在 `dist/media/`**；`standalone.css` / `editor.js` / `explorer.js` 只在独立版加载 | [media/README.md](media/README.md) |
| `tests/` | 自动化测试，按类型分目录（也是理解核心行为的最佳入口） | [tests/README.md](tests/README.md) |
| `scripts/` | 构建与诊断工具（build-media / embed-media / build-sidecar / verify-css / diag-stream） | [scripts/README.md](scripts/README.md) |
| `sample-novel/` | 示例工程 / 测试夹具，勿随手改正文（hash 断言会挂） | [sample-novel/README.md](sample-novel/README.md) |
| `src/core/runtime/` | 宿主无关的运行时设施：日志、SQLite 痕迹库、失败记录、长任务登记、有界并发 | [src/core/runtime/README.md](src/core/runtime/README.md) |
| `src/core/views/` | 只读聚合与界面快照：工程树、单章流水线、出场人物索引 | [src/core/views/README.md](src/core/views/README.md) |

其他关键位置：

- [package.json](package.json) —— 命令 / 菜单 / 快捷键 / 全部 `novel.*` 配置项的声明。
- [esbuild.js](esbuild.js) —— 构建脚本，入口 `src/shells/vscode/extension.ts` → `dist/extension.js`；同时调 [scripts/build-media.js](scripts/build-media.js) 把前端资源打进 `dist/media/`。
- [.vscode/README.md](.vscode/README.md) —— 三个壳各自的 F5 启动配置与构建/测试任务。**只有插件壳能打断点**，独立版（Bun 没实现 `node:inspector`）与桌面壳（Rust 那半边要 CodeLLDB）都只是把命令跑在终端里，原因写在那份 README 里。
- `docs/design/plans/` 与 `docs/design/specs/` —— 「双形态改造」（共享核心 + VS Code 壳 + Bun 独立 Web 服务壳）的实施计划与设计文档，涉及分层调整时先读。

## 架构要点

以下每条的完整理由与实现细节都在对应模块 README 里，这里只列断言：

- **两层、单向依赖**：`core/` → `shells/`，反向与壳间互相 import 都不允许，`core/` 零 vscode 依赖。测试见 [tests/contract/corePurity.test.js](tests/contract/corePurity.test.js) 与 [shellPurity.test.js](tests/contract/shellPurity.test.js)；细节见 [src/shells/README.md](src/shells/README.md)。
- **壳只做三件事**：实现 `Host`、传输与生命周期、平台专属入口。任何「我是哪个壳」的分支都不属于壳——差异表达成「宿主有没有这个能力」。详见 [src/shells/README.md](src/shells/README.md)。
- **工具层与 agent 层互不缠绕**：能对工程做什么（[tools/](src/core/tools/README.md)）与谁拿着它做事（[agent/](src/core/agent/README.md)）是两层，由 [tests/contract/layerBoundary.test.js](tests/contract/layerBoundary.test.js) 守着。
- **消息协议是前后端唯一契约**：[src/core/protocol/](src/core/protocol/index.ts) 的 `InMessage` / `OutMessage`，前端 `import type` 同一份定义，改协议后前端对不上会编译不过。
- **一个 controller，多个宿主**：侧边栏与编辑器标签页挂同一个 `ChatController`，同一会话双开实时同步。见 [src/core/README.md](src/core/README.md)。
- **前端无状态**：webview 靠 `ViewState` 全量推送重建，UI 状态留在前端。见 [media/README.md](media/README.md)。
- **两形态的前端隔离**：独立版专属样式/脚本只由 [src/shells/standalone/page.ts](src/shells/standalone/page.ts) 加载，区分形态用能力探测不判断环境字符串。见 [media/README.md](media/README.md)。
- **页面骨架只有一份**：全部页签的 DOM 都在 [src/shells/shared/panes.ts](src/shells/shared/panes.ts)，加按钮改这一处就够。见 [src/shells/README.md](src/shells/README.md)。
- **前端源码与产物分离**：`media/` 只有源码，产物构建到 `dist/media/`，不入库。加新产物要同改三处，细节见 [media/README.md](media/README.md)。

## 必须遵守的行为约束

这些是产品承诺，改动时不可破坏（对应测试在 [`tests/`](tests/README.md)）。**编号是固定锚点**——代码注释与模块 README 大量以「第 N 条」引用这些规则，改动时只精简文字、不重排不合并。每条只留断言本身，机制与理由见链接：

1. **容错优先**：作者会手改任何 Markdown；解析失败退化为忽略，绝不抛崩。见 [src/core/model/README.md](src/core/model/README.md)。
2. **不静默截断**：装配器降级/丢弃任何条目都必须留在明细里并附原因。见 [src/core/context/README.md](src/core/context/README.md)、[src/core/README.md](src/core/README.md)。
3. **不静默覆盖**：任何可能吞掉已有内容的动作，落盘前都要先给用户一个判断的机会——卡片 diff、覆盖前确认、同名报错退出、编辑器内容 hash 乐观锁，形式因场景而异，这条原则不变。见 [src/core/generation/README.md](src/core/generation/README.md)、[src/core/workspace/README.md](src/core/workspace/README.md)、[media/README.md](media/README.md)。
4. **不偷偷烧 token**：摘要不自动生成，只提示过期；要分多次调模型的动作必须在动手前的确认框里写明预计调用次数，并发不改变这个数。见 [src/core/features/README.md](src/core/features/README.md)、[src/core/agent/README.md](src/core/agent/README.md)。
5. **模型引用只在第一个斜杠处切分**：`openrouter/z-ai/glm-4.6` 中服务商前缀是 `openrouter`。见 [src/core/model/README.md](src/core/model/README.md)。
6. **不真删**：工程页的删除、会话删除、类文件操作的删除，一律搬进 `.novelforge/.trash/` 并保留原相对路径。见 [src/core/workspace/README.md](src/core/workspace/README.md)。
7. **文件访问不越界**：所有写盘经 `core/workspace/` 这一个网关，工程页的类文件操作在此之上再锁章节/角色/设定三个区，`plots/`/`volumes/` 的改名删除走专门方法以带走场景目录与中转站正文；独立版的读写另有工程根/大小/白名单一层。见 [src/core/workspace/README.md](src/core/workspace/README.md)、[src/core/README.md](src/core/README.md)。
8. **段号与章号是两条轴，界面上的「剧情 N」是推导出来的**：章节顺序永远由文件名数字前缀决定，与所在目录层级无关；细纲的段号只是 `plots/` 里的排序键，一段可以拆成多章；「段 → 章」唯一的链是细纲 frontmatter 的 `chapters:`。见 [src/core/model/README.md](src/core/model/README.md)、[src/core/views/README.md](src/core/views/README.md)、[src/core/workspace/README.md](src/core/workspace/README.md)。
9. **章节不认扩展名**：章节根下「数字前缀 + 扩展名不在二进制黑名单里」的文件都是章节，规则只在 [src/core/model/chapterFile.ts](src/core/model/chapterFile.ts) 定义一次；角色/设定区仍只认 `.md`。见 [src/core/model/README.md](src/core/model/README.md)。
10. **草稿不进上下文**：`drafts/` 只有作者显式 `@` 引用才进 prompt，装配器永不自动读它；按需创建，删章节不删草稿。见 [src/core/README.md](src/core/README.md)。
11. **不闷着干活**：任何要调模型或跑几十秒的动作都走 `runTask`（进度条 + 日志），日志里绝不出现 API Key 或 prompt/正文全文。见 [src/core/runtime/README.md](src/core/runtime/README.md)。
12. **模型引用只在工程页任务里 fallback，且换人只在档内**：串行恒用该档首选、失败随机换同档其余，绝不跨档换人；对话页创作页的单次生成严格用用户选定的模型，不走池。见 [src/core/llm/README.md](src/core/llm/README.md)。
13. **切批与截断用干活那个模型的窗口**：`config.contextWindow` 只代表对话页选定的模型，走池时用 `pool.primaryBudget`。见 [src/core/llm/README.md](src/core/llm/README.md)。
14. **摘要是出场人物的唯一真相**：角色卡的 `appearsIn` / `updatedThrough` 只是缓存，要用就经 `buildCastIndex()` 从摘要重算；`cast` 的 aliases 只收专属称呼，判定同一个人只信同章共现。见 [src/core/README.md](src/core/README.md)、[src/core/model/README.md](src/core/model/README.md)。
15. **角色卡不能无限膨胀**：更新角色卡的提示词给每一节都定了字数上限，加字段或改提示词时别把这条抹掉。见 [src/core/features/README.md](src/core/features/README.md)。
16. **失败要留在出错的东西身上**：失败经 [src/core/runtime/errorLog.ts](src/core/runtime/errorLog.ts) 挂在对应目标上（红=整体失败，黄=部分完成），成功路径必须 `clearFailures`。见 [src/core/README.md](src/core/README.md)。
17. **SQLite 只放可丢弃的痕迹**：内容的唯一真相永远是 Markdown，库打不开就静默降级。实现细节（两个驱动、动态 import 写法、finalize 时机）见 [src/core/runtime/README.md](src/core/runtime/README.md)。
18. **上下游新鲜度只靠 hash 传播，不调模型**：产物串成一条指纹链（大纲 → 卷纲 → 细纲 → 场景 → 中转站正文 → 摘要），拆分是这条链上唯一的人工闸口——已发布的章不会被拉回「待写正文」；流水线状态一律从磁盘推导，绝不落盘。见 [src/core/workspace/README.md](src/core/workspace/README.md)、[src/core/views/README.md](src/core/views/README.md)、[src/core/model/README.md](src/core/model/README.md)。
19. **产物落盘前必须过一遍人，而且是当场过**：`generate` 只把文本交回界面，作者在对话里那张权限卡片上点了「写入」才落盘；这一问与 agent 的策略无关，三种模式都问，也不做成一颗可以拖延的按钮。批量路径反过来——一律跳过已有产物的目标，不问、不覆盖。见 [src/core/generation/README.md](src/core/generation/README.md)、[src/core/features/README.md](src/core/features/README.md)、[src/core/agent/README.md](src/core/agent/README.md)。
20. **界面永远只推荐一个下一步，且由状态机算出来**：主按钮来自 `deriveNextStep`，与 `deriveStage` 共用同一套判据；agent 每回合从同一个状态机免费拿到同一份结论，没有 `status` 工具；`selectPlot` 按路径认，绝不在段号与章号两条轴之间按号互认。见 [src/core/model/README.md](src/core/model/README.md)、[src/core/agent/README.md](src/core/agent/README.md)。
21. **细纲是剧情脉络，不是场景**：`plots/**/*.md` 四节，主体是剧情脉络，不写画面/天气/动作细节/台词，也不规定这一段从哪开头到哪结尾；卷纲另有四节，刻意与细纲不同名。见 [src/core/model/README.md](src/core/model/README.md)、[src/core/context/README.md](src/core/context/README.md)。
22. **细纲有两个入口，讨论那条不许被截断**：`generate` 按走向填，`settle` 把讨论结论沉淀成细纲，两者输出契约必须一致；`settle` 的历史 cap 抬到 60%。见 [src/core/context/README.md](src/core/context/README.md)。
23. **拆分是作者的活，工具不猜断点也不起名**：按正文里单独一行 `---` 切，零次模型调用，第一章沿用原标题、其余落成纯序号名；章号接在现有最后一章之后，与段号无关，其余段一个文件都不动。见 [src/core/features/README.md](src/core/features/README.md)。
24. **agent 是调度者，不是第二个作者**：循环只做「拿着工具达成一个目标」，创作质量仍来自分阶段装配那一层，领域知识只在那里写一份；四条配套约束（产物不回灌、history 传空、无进展检测、触顶不静默停）见 [src/core/agent/README.md](src/core/agent/README.md)。
25. **agent 不越过既有的闸门**：它的写入走的是与落盘卡片同一条 `workspace.write`，这一层没有任何新的保护代码，`policy.ts` 只决定「动手之前要不要先问一句」；明确不给删除/改名/移动/`bash`/工程根之外的路径/裸 `fs`。见 [src/core/agent/README.md](src/core/agent/README.md)。
26. **思考深度是会话的属性，只作用于作者选定的那个模型**：落在 `ChatSession.thinking` 上跟着会话走，缺省是「不思考」；只有对话页的单次生成与 agent 循环带它，工程页的后台批量任务一律不带。见 [src/core/model/README.md](src/core/model/README.md)、[src/core/llm/README.md](src/core/llm/README.md)。

## 提交约定

中文正文可以，前缀用 `feat/refactor/chore/docs`。不要提交 `dist/`（已被 gitignore）。
