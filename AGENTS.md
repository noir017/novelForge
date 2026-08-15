# AGENTS.md

Novel Forge 帮作者**把一个脑洞养成一本完整的书**：从一句念头开始，逐层填成大纲、剧情、场景，最后写成正文。三种壳（独立 Web 服务 / 桌面 App / VS Code 插件）共用同一套核心。

实现上分两条主线：**往下展开**——按**创作阶段**（大纲 / 剧情 / 细节 / 正文）分别装配上下文并透明展示，把上一层产物展开成下一层（排细纲、拆场景、写正文，流式预览、采纳才落盘）；**往回记住**——单章/全书摘要、角色卡与设定整合，让「记忆」有限且可人工校正。所有数据是工作区里的普通 Markdown（`.novelforge/` 目录），可 Git、可手改。

**管理的单位是「章」，但生成时不按章硬切**：`chapters/` 是唯一真相（摘要从它生成、上下文从它取正文）；`manuscripts/` 是**中转站**——模型写多长由剧情决定，不必为了凑一章而强行收束，正文写完后作者在编辑器里用单独一行 `---` 标断点，点「拆成章节」切成 `chapters/` 下的发布章，中转站那份随即删掉。所以老工程的 99 章天生就是「已完成的 99 章」，不需要迁移，新建的就是第 100 章。

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
| `src/core/` | 核心逻辑层入口（含协议 `protocol/`、文件能力 `files/`、只读聚合与界面快照 `views/`、运行时设施 `runtime/`）。`views/pipeline.ts` 是磁盘 I/O 聚合器；`model/pipeline.ts` 仍是纯领域模型与状态机，绝不搬进 `views/`。 | [src/core/README.md](src/core/README.md) |
| `src/core/model/` | 数据层：NovelProject、Markdown 解析、章节文件名规则、**创作流水线领域模型 pipeline.ts**、细纲 plotFile.ts、场景 sceneFile.ts、服务商配置、会话存储 | [src/core/model/README.md](src/core/model/README.md) |
| `src/core/context/` | ★ 分阶段装配（配方 × 层）+ 身份化提示词 + 可替换的 token 计数器 | [src/core/context/README.md](src/core/context/README.md) |
| `src/core/features/` | 功能编排：创作（四层产物）、批量流水线、摘要、角色卡、设定、文风提取 | [src/core/features/README.md](src/core/features/README.md) |
| `src/core/llm/` | LlmProvider 接口、OpenAI / Anthropic 实现、注册表与 API Key | [src/core/llm/README.md](src/core/llm/README.md) |
| `src/shells/` | ★ 三个壳并排放这里，外加 `shared/panes.ts`（所有 pane 的 DOM 唯一来源）。**壳的契约在这份 README 里**：壳只做实现 Host、传输与生命周期、平台专属入口三件事 | [src/shells/README.md](src/shells/README.md) |
| `src/shells/vscode/` | VS Code 壳：extension 入口、命令、两个 webview 宿主、vscode-lm | [src/shells/vscode/README.md](src/shells/vscode/README.md) |
| `src/shells/standalone/` | 独立 Web 服务壳（Bun）：HTTP/WS 服务、FileHost、页面装配、CLI 的 TerminalHost | [src/shells/standalone/README.md](src/shells/standalone/README.md) |
| `src/shells/desktop/` | 桌面壳（Windows / Linux，Rust）。**一层纯壳**：把独立版的单文件可执行当 sidecar 起起来，窗口导航过去。这个目录本身就是 Tauri 工程根 | [src/shells/desktop/README.md](src/shells/desktop/README.md) |
| `media/` | 前端资源（原生 TS/CSS，无框架）。**仓库里只有源码 `media/src/` 与 `icon.svg`，构建产物在 `dist/media/`**；`standalone.css` / `editor.js` / `explorer.js` 只在独立版加载 | [media/README.md](media/README.md) |
| `tests/` | 自动化测试，按类型分目录（也是理解核心行为的最佳入口） | [tests/README.md](tests/README.md) |
| `scripts/` | 构建与诊断工具（build-media / embed-media / build-sidecar / verify-css / diag-stream） | [scripts/README.md](scripts/README.md) |
| `sample-novel/` | 示例工程 / 测试夹具，勿随手改正文（hash 断言会挂） | [sample-novel/README.md](sample-novel/README.md) |

其他关键位置：

- [package.json](package.json) —— 命令 / 菜单 / 快捷键 / 全部 `novel.*` 配置项的声明。
- [esbuild.js](esbuild.js) —— 构建脚本，入口 `src/shells/vscode/extension.ts` → `dist/extension.js`；同时调 [scripts/build-media.js](scripts/build-media.js) 把前端资源打进 `dist/media/`。
- [.vscode/README.md](.vscode/README.md) —— 三个壳各自的 F5 启动配置与构建/测试任务。**只有插件壳能打断点**，独立版（Bun 没实现 `node:inspector`）与桌面壳（Rust 那半边要 CodeLLDB）都只是把命令跑在终端里，原因写在那份 README 里。
- `docs/design/plans/` 与 `docs/design/specs/` —— 「双形态改造」（共享核心 + VS Code 壳 + Bun 独立 Web 服务壳）的实施计划与设计文档，涉及分层调整时先读。

## 架构要点

- **两层、单向依赖**：`core/`（数据、逻辑与宿主无关的面板逻辑 `controller/`）→ `shells/`（三个宿主壳 + 它们共用的 `shared/`），反向依赖不允许，**壳与壳之间也不许互相 import**（桌面壳复用独立版靠的是把它当 sidecar 起）。`core/` 零 vscode 依赖，新代码不要给 `core/` 增加 `vscode` import。两条都由测试守着：[tests/contract/corePurity.test.js](tests/contract/corePurity.test.js) 与 [tests/contract/shellPurity.test.js](tests/contract/shellPurity.test.js)。
- **壳只做三件事**：实现 `Host`、传输与生命周期、平台专属入口（命令 / 菜单 / CLI 参数）。业务逻辑、页面内容、以及**任何「我是哪个壳」的分支**都不属于壳——差异一律表达成「宿主有没有这个能力」（`Host` 上的可选方法，或渲染页面时的选项）。详见 [src/shells/README.md](src/shells/README.md)。`Host.name` 只用于日志与诊断，拿它做分支会被契约测试拦下。
- **消息协议是前后端唯一契约**：[src/core/protocol/](src/core/protocol/index.ts) 的 `InMessage` / `OutMessage`（对外入口仍是 `core/protocol`）。前端经 [media/src/protocol.ts](media/src/protocol.ts) 以 `import type` 直接引用同一份定义，所以**改协议后前端对不上会编译不过**（`npm run typecheck` 覆盖 `media/`），不再靠人记得同步改。
- **一个 controller，多个宿主**：侧边栏与编辑器标签页挂同一个 `ChatController`，同一会话双开实时同步。
- **前端无状态**：webview 靠 `ViewState` 全量推送重建，展开/折叠等 UI 状态留在前端。
- **两形态的前端隔离**：`media/src/css/standalone/` 与 `media/src/editor/` `media/src/explorer/` 只由 [src/shells/standalone/page.ts](src/shells/standalone/page.ts) 加载，插件的 `webviewHtml.ts` 里没有它们。改独立版的样式/布局只动那几处，别为独立版去改 `media/src/css/view/`（会连带影响插件）；区分形态用能力探测（`#wbEditor` 存不存在、`maybeById` 取不到就跳过），不要判断环境字符串。
- **页面骨架只有一份**：五个页签（连独立版专属的「文件」页）的 DOM 全在 [src/shells/shared/panes.ts](src/shells/shared/panes.ts)，两个壳只负责布局外壳与 head/CSP/资源 URL。**加按钮改这一处就够**——从前它在两个壳里各有一份，这里立过一条「要同时改两处」的规矩，那条规矩连同它的前提一起没了。jsdom 测试跑的是执行模板函数得到的真实 HTML（[tests/helpers/dom.js](tests/helpers/dom.js)），结构少一个 id 就红。
- **前端源码与产物分离**：仓库里的 `media/` 只有源码（`media/src/`）与 `icon.svg`；`view.js` / `view.css` 等六个产物构建到 **`dist/media/`**，和 `dist/extension.js` 同一个去处，整个 `dist/` 都不入库。加**新产物**要三处同改：`media/src/` 放源码 → [scripts/build-media.js](scripts/build-media.js) 的 entryPoints → [scripts/embed-media.js](scripts/embed-media.js) 的 `built` 数组 → 页面里引用（独立版 [src/shells/standalone/page.ts](src/shells/standalone/page.ts)，插件 [src/shells/vscode/webviewHtml.ts](src/shells/vscode/webviewHtml.ts)）（漏了第三步，`bun build --compile` 出的单文件会 404）。在**已有产物内部**拆模块则不必动任何配置，直接 import。

## 必须遵守的行为约束

这些是产品承诺，改动时不可破坏（对应测试在 [`tests/`](tests/README.md)）：

1. **容错优先**：作者会手改任何 Markdown；解析失败退化为忽略，绝不抛崩。
2. **不静默截断**：装配器降级/丢弃任何条目都必须留在明细里并附原因。
3. **不静默覆盖**：角色卡更新走 diff 确认；style.md 覆盖前先问；「采纳写入」前正文只存在会话里；类文件操作遇到同名目标一律报错退出；内置编辑器保存走内容 hash 乐观锁（[src/core/files/fileEditing.ts](src/core/files/fileEditing.ts)），磁盘变过就报冲突让用户取舍。
4. **不偷偷烧 token**：摘要不自动生成，只提示过期。要分多次调模型的动作（更新角色卡可能分十几批、批量建卡可能是几十个人）必须在动手前的确认框里写明预计调用次数。并发不改变总次数，这个数在并发下依然要对得上账。
5. **模型引用只在第一个斜杠处切分**：`openrouter/z-ai/glm-4.6` 中服务商前缀是 `openrouter`。
6. **不真删**：工程页的删除（以及会话删除）一律搬进 `.novelforge/.trash/` 并保留原相对路径。
7. **文件访问不越界**：工程页的类文件操作锁在章节/角色/设定三个区内（`core/files/fileOps.ts` 的 `normalizeRel` / `sectionOf`）；`plots/` **不是**其中之一——细纲的改名/删除走 `NovelProject.writePlot` / `deletePlot`，因为那两件事要**连带**搬走场景目录与中转站正文（`carryPlotCompanions`），当成普通文件搬会把它们变成孤儿。独立版的读写另有一层——路径落在工程根内、大小上限、以及「纯文本扩展名白名单 ∪ 章节文件名规则」，全在 `core/files/fileEditing.ts` 里兜住。独立版「文件」页的写入口只经 `core/files/projectFiles.ts`（重命名/移动/复制锁在工程根内，`chapters/`、`drafts/`、`.novelforge` 及其下 `plots/`、`scenes/`、`manuscripts/`、`summaries/` 等固定目录受 `isProtectedPath` 保护，同名绝不覆盖，`.trash` 内容不可操作），目录列举（`core/files/fileTree.ts`）仍只读。服务无鉴权（只绑 127.0.0.1），别在别处绕过这几处直接读写。
8. **层级只是收纳**：章节顺序永远由文件名数字前缀决定，与所在目录层级无关；分卷不重置编号。细纲（`.novelforge/plots/`）则是**扁平**的，与章同号——`nextPlotNo()` 取 `plots/` 与 `chapters/` 两边的最大号 +1，所以已有 99 章的老工程新建的就是第 100 章，不需要任何迁移。摘要的轴是**章节**（`summaries/` 镜像 `chapters/` 下的相对路径），上下文装配的正文也优先取 `chapters/`，还没拆分的才回落到中转站。草稿按章节在章节根之下的相对路径镜像存放，文件名（含扩展名）原样沿用。
9. **章节不认扩展名**：章节根下「数字前缀 + 扩展名不在二进制黑名单里」的文件都是章节（`001-楔子.txt`、`001-楔子`、`004.json` 都算，`.png/.docx/.zip` 不算），规则只在 [src/core/model/chapterFile.ts](src/core/model/chapterFile.ts) 里定义一次。`.md`/`.markdown` 之外的章节**不解析 `# 标题`**，标题只取文件名——`extractH1` 与 `stripH1` 都只看首行，两者必须保持互逆。角色/设定区不跟着放宽，仍然只认 `.md`。
10. **草稿不进上下文**：`drafts/` 只有作者显式 `@` 引用才进 prompt，装配器永不自动读它。按需创建（首次点「打开草稿」），已存在绝不覆盖；章节改名/移动时草稿跟着走，删章节不删草稿（确认框里会说明）。
11. **不闷着干活**：任何要调模型或跑几十秒的动作都必须看得见——走 [src/core/runtime/progress.ts](src/core/runtime/progress.ts) 的 `runTask`（工程页顶部出进度条：n/N、百分比、计时、可停止），并在 [src/core/runtime/logger.ts](src/core/runtime/logger.ts) 里留下开始/每步/结束与耗时。日志页（第四个页签）是用户唯一能事后复查「刚才那 76 章卡在哪」的地方。**日志里绝不出现 API Key**（统一走 `redact`），也**绝不记 prompt 或正文全文**（只记条数与字数）。并发跑时（[src/core/runtime/concurrency.ts](src/core/runtime/concurrency.ts) 的 `runPool`）`current` **只在一项真正结束时 +1**，message 报「已完成 n/N + 正在跑哪几项」——按启动数递增会让进度条冲到头然后干等。
12. **模型引用只在工程页任务里 fallback，且换人只在档内**：工程页的后台任务经 [src/core/llm/pool.ts](src/core/llm/pool.ts) 取模型，取哪一档由**任务**决定（[src/core/model/tiers.ts](src/core/model/tiers.ts) 的 `DEFAULT_TASK_TIERS`，作者可在设置页逐项覆盖）——串行恒用该档首选、失败随机换**同档**其余，并发在**档内**轮转做负载均衡。**绝不跨档换人**：快速档失败升级到精标档等于绕过作者的成本决定去烧贵 token，而且日志上看不出来。**空档位沿用 `config.models`**，三档都不配则行为与分档前逐字节一致——静默把某些任务降级到便宜模型，等于替作者做了质量取舍。**对话页创作页的单次生成与连接测试严格用用户选定的那个模型**，中途换人会让文风断掉。构造池时只有该档首选能弹 API Key 输入框，备选缺 Key 一律剔除并 warn。
13. **切批与截断用干活那个模型的窗口**：分档后 `config.contextWindow` 只代表**对话页选定的模型**，拿它给快速档的 32k 模型切批会稳定超窗。执行中用 `pool.primaryBudget`；确认框之前就要算的东西（设定生成的扫描片段数、角色卡的批数——它们就是「预计调用 N 次」那个数字）用 `budgetForTask(task)`，它不构造 provider，因此不会在用户点确认前弹 Key 输入框。
14. **摘要是出场人物的唯一真相**：单章摘要让模型输出 JSON，解析后落盘仍是 Markdown（作者要手改），结构化的出场人物写进 frontmatter 的 `cast`。角色卡里的 `appearsIn` / `updatedThrough` 只是缓存，要用就经 [src/core/views/cast.ts](src/core/views/cast.ts) 的 `buildCastIndex()` 从摘要重算。摘要解析必须保留三层降级（JSON → Markdown 小节 → 全文进梗概）——解析失败等于这一章的剧情永远进不了上下文。 **`cast` 的 aliases 只收专属称呼**（经 [src/core/model/naming.ts](src/core/model/naming.ts) 过滤掉代词/亲属称谓/泛称/描述短语）：它是「谁是谁」的判据，`姐姐` 会把三个女角色串成一个。判定两个称呼是同一个人只信**同章共现**这条硬约束（[src/core/model/identity.ts](src/core/model/identity.ts)）——同一章里各自出场的两个人永不合并，一条幻觉别名不该把主角和她孪生弟弟并成一个人。
15. **角色卡不能无限膨胀**：它每次续写都要注入上下文。更新角色卡的提示词给每一节都定了字数上限，并明确「性格 / 语言习惯」优先、外貌与人物关系从简。加字段或改提示词时别把这条抹掉。
16. **失败要留在出错的东西身上**：日志与 toast 都要求用户「恰好在看」——toast 五秒就没，日志页得主动去翻。所以角色卡/章/设定失败时除了打日志，还要经 [src/core/runtime/errorLog.ts](src/core/runtime/errorLog.ts) 记一条，工程页那一行上挂红色感叹号（整体失败、目标未改动）或黄色（部分完成、下次会重来），悬停看原因。**`targetKey` 记的是出错那份文件的路径**：摘要失败挂成品（`chapters/…`），排细纲/拆场景/写正文失败挂细纲（`plots/…`）。工程页一行同时代表一章的两面，渲染时两侧路径都查（`rows.ts` 的 `failureMark`），所以挂在哪一侧都找得到能重试它的入口。**成功路径必须 `clearFailures`**：修好了还挂着标记，用户会学会无视它。新增「可能失败且用户看不出来」的动作时照这条接上。
17. **SQLite 只放可丢弃的痕迹**：工程库在 `.novelforge/novelforge.db`（[src/core/runtime/db.ts](src/core/runtime/db.ts)），目前只有失败记录与日志历史两张表。**内容的唯一真相永远是 Markdown**——作者要手改、要 diff、要进 Git，别把角色卡/摘要/设定的正文往库里搬。库是增强不是新的失败源：打不开就静默降级（只 warn 一次），所有 API 内部吞异常，绝不能出现「因为一张日志表而更新不了角色卡」。另外两条实现约束：两个壳用**两个不同的驱动**（插件/Node 用 `node:sqlite`，独立版 Bun 用 `bun:sqlite`），模块名必须拼接后 `await import`（写成字面量 esbuild 会解析 `bun:sqlite` 失败）；语句一律用完即 finalize（bun 侧不 finalize 的话 Windows 上库文件删不掉），所以 `SqlDatabase` 只暴露 run/all/insertMany，不给 prepare。
18. **上下游新鲜度只靠 hash 传播，不调模型**：产物串成一条指纹链——`outline.md` →（细纲 frontmatter 的 `upstreamHash`）→ `plots/*.md` →（场景 frontmatter 的 `upstreamHash`）→ `scenes/X/*.md` →（正文 frontmatter 的 `beatsHash`）→ `manuscripts/X.md` →（**拆分**）→ `chapters/X.md` →（摘要 frontmatter 的 `sourceHash`）→ `summaries/X.md`。改了大纲，所有细纲标脏；改了某章的细纲，该章场景标脏；改了场景，中转站那份正文标脏。**拆分是这条链上唯一的人工闸口**：中转站那份拆完就删了，所以**已发布的章不会被拉回「待写正文」**（`deriveStage` 先看 `chapterExists`，成品在就短路整条生产链）——把作者已经发出去的文字标成待写是在撺掇他重写；工程页那一行仍会挂 ⟳ 提醒，够了。**代价是零次模型调用、零幻觉、零 token**。把「变更影响」做成 AI 功能，等于每改一行剧情就烧一次钱，而且会给出看起来很像但没有依据的影响清单。三条配套约束：**(a) 手写的产物永不标脏**——`upstreamHash` 为空或 `beatsHash` 从没记录过，说明它不是这条链生出来的，拿凭空的过期标记催作者重做，他会学会无视所有标记；只有「记录过一次、现在对不上」才算变更。**(b) 指纹只哈希内容，不哈希状态**——`beatsHashFor` 排除场景的 `status`（采纳正文时会把场景标成 `written`，那一次写入不该让刚写好的正文立刻显示「上游已变更」），`plotContentHash` 只哈希四个小节、不含 frontmatter，`readManuscript` 的 `contentHash` 只哈希正文本身、不含 frontmatter 与标题行（写一次 `beatsHash` 不该让摘要立刻过期）。**(c) 流水线状态一律从磁盘推导，绝不落盘**（[src/core/model/pipeline.ts](src/core/model/pipeline.ts) 的 `deriveStage`）——存一个 `status: writing` 字段的话，作者手删半段正文之后它就在撒谎，而字数与 hash 永远诚实。
19. **产物落盘前必须过一遍人**：创作页的四层产物（大纲、剧情、场景卡、正文）与摘要/角色卡一样，`generate` 只把文本交回界面，`acceptArtifact` 才写盘，且目标已有内容时先走 `reviewReplace`（插件开 diff，独立版弹确认）。**批量路径反过来：一律跳过已有产物的目标，不问、不覆盖**——一次弹几十个 diff 没有人看得完，跳过是那条路上唯一安全的做法（[src/core/features/pipelineBatch.ts](src/core/features/pipelineBatch.ts) 的三条：批量写剧情 / 批量拆场景 / 批量写正文）。同理，批量路径的解析用不带全文兜底的 `parsePlotStrict`：兜底会把模型的一句「我不太确定这一章写什么」变成一份「已排好」的细纲，紧接着的批量拆场景还会照着它往下拆；创作页保留兜底，因为那里产物摊在屏幕上，用户看得见它是什么。**没有 artifact 的回复不给采纳按钮**——落点由后端算（`describeArtifactOf`），前端猜不出一段讨论该写到哪一层。
20. **界面永远只推荐一个下一步，且由状态机算出来**：创作页的主按钮来自 `deriveNextStep`（[src/core/model/pipeline.ts](src/core/model/pipeline.ts)），与 `deriveStage` **共用同一套判据**——两处各判各的，界面上就会出现「徽章说待拆场景，按钮让你写正文」。全书那一层同理走 `deriveBookStage` / `deriveBookNextStep`，不在 controller 里手写。同理，选中一章走的是 `selectPlot` 而不是前端自己拼 target：只有后端知道那一章处于什么状态。四条配套约束：**(a) 其余命令收进 `/` 面板，不平铺**——一排等重的按钮看不出该点哪个，而任何一刻真正要按的只有一个。**(b) 命令表只有一份**（`commandsFor`，前端直接打包那个零 import 的纯函数模块），前端自己抄一份就会出现后端不认的命令，点了什么都不发生。**(c) 做完了就不给下一步**——造一个假的「下一步」等于逼作者一直有事可做，而写完就是写完了。**(d) 命令的字打在输入框里，界面显示与发给模型的内容分开**——`/` 是输入框里的普通字符，面板只是浮在上方的候选列表（判据、过滤串全从输入框的值算，见 [media/README.md](media/README.md)）；命令名记在 `ChatTurn.command` 上供气泡显示，**绝不塞进 `content`**——那句话会被当成作者的要求装进 prompt，与旧界面逼他手打一句「请生成细纲」是同一个毛病。
21. **细纲是剧情脉络，不是场景**：`plots/*.md` 四节——`目标` / `剧情脉络` / `冲突与转折` / `伏笔与回收`，主体是剧情脉络（[src/core/model/plotFile.ts](src/core/model/plotFile.ts) 的 `PLOT_SECTION_KEYS`）。**不写画面、天气、动作细节或台词**（那是场景层的职责），也**不规定这一章从哪开头、到哪结尾**——这正是「不按章硬切」那半边的落点：写多长由剧情决定，正文出来后作者会自己切成发布章，模型不必为了凑一章而强行收束。提示词里那几句禁令（[src/core/context/prompts.ts](src/core/context/prompts.ts) 的 `STAGE_DUTY.plot` 与 `buildOutputContract`）是这条约束的落点，别在加需求时把它们稀释掉。`isPlotFilled` 只认「剧情脉络」：只写了目标等于什么都没排，流水线该停在剧情层。
22. **细纲有两个入口，讨论那条不许被截断**：`generate`（按作者描述的走向填）与 `settle`（把刚才讨论中**已经达成的结论**沉淀成细纲）。两者的差别在 `CAPABILITY_TASK` 的系统提示，不在输出契约——契约必须一致，否则同一份细纲会因为入口不同长得不一样。配套的装配约束是 `recipeFor('plot', 'settle')` 把历史 cap 抬到 60%、优先级提到 P0（[src/core/context/recipes.ts](src/core/context/recipes.ts)）：`settle` 要沉淀的就是那段对话，按常规 30% 由远及近截掉等于把结论截没了。
23. **拆分是作者的活，工具不猜断点也不起名**：中转站正文拆成发布章走 [src/core/features/splitChapter.ts](src/core/features/splitChapter.ts)，按正文里**单独一行 `---`**（`chapterFile.ts` 的 `splitByMark`）切。**零次模型调用**：第一章沿用原标题，其余落成纯序号名（`101.md`）等作者自己改——让模型给章起名，是拿 token 换一批作者八成要重写的名字。写正文时每次追加之间自动插一行 `---` 当**默认候选**（场景边界最可能就是章节边界），作者删改即可。一章拆成 N 章后，后面**还没发布**的细纲号自动 +（N-1），连同场景目录与中转站正文一起改名（复用 `writePlot` 的 `carryPlotCompanions`）。顺序是**先移号再落盘**：反过来的话，落盘后重编号失败会留下「章节已建但细纲还撞着号」的中间态，先移号失败则什么都没变。

## 提交约定

中文正文可以，前缀用 `feat/refactor/chore/docs`。不要提交 `dist/`（已被 gitignore）。
