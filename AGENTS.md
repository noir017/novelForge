# AGENTS.md

Novel Forge 帮作者**把一个脑洞养成一本完整的书**：从一句念头开始，先展开成小说配置、故事前提、角色图谱与世界观，再排情节大纲、拆成一章一份的细纲，最后一章一章写成正文。三种壳（独立 Web 服务 / 桌面 App / VS Code 插件）共用同一套核心。

实现上分两条主线：**往下展开**——按**创作阶段**（架构 / 大纲 / 细纲 / 正文）分别装配上下文并透明展示，把上一层产物展开成下一层（流式预览、当场点头才落盘），正文按细纲的目标字数自动续写；**往回记住**——定稿（单章摘要 + 连续性事实 + 出场角色的「当前状态」 + 本章推进了哪几条叙事线）、全书摘要、角色卡与设定整合，让「记忆」有限且可人工校正。审稿是正文层的可选动作：只出报告，作者在报告卡上勾选之后按勾选的条目修稿。作者还可以给每个阶段（规划 / 写正文 / 审稿 / 修稿）绑一份**写作技能**（一份纯提示词的 `SKILL.md`），这个阶段往后的每一次生成都把它放在提示词最前面。已经写了一部分的书走**拆书**：工程里的整本 txt 导入成章节，再「从已写正文补齐」——照正文整理出摘要、角色卡、架构、大纲与细纲（只补空白）；别人的书只学写法（文风进 `style.md`，结构与节奏成一份规划技能），原文不进工程。所有数据是工作区里的普通 Markdown（`.novelforge/` 目录），可 Git、可手改。

**一条轴：细纲号 = 章号。** 往下展开的链是：一句话 ──▶ `config.md` ──▶ `premise.md` / `characters/` / `world.md` ──▶ `outline.md`（按「第 a–b 章」分节，可以只覆盖到一部分章）──▶ `plots/NNN-标题.md`（一章一份，每批 5 章）──▶ `chapters/NNN-标题.md`（正文）──▶ `summaries/`（定稿）。跨章的伏笔与线索另记在 `threads.md`（叙事线，可选，不在链上：工程页从细纲排出，定稿时追加事件，写正文时带最多 6 条有关的）。写作技能也不在链上：本工程的放 `.novelforge/skills/<名字>/SKILL.md`，阶段绑定记在 `.novelforge/skills.json`，我的技能库在工程外的 `~/.novelforge/skills/`。

**细纲与正文之间没有中间层。** 从前这里有过「细节」（`scenes/`）、「卷」（`volumes/`）与「中转站」（`manuscripts/`，写完再按 `---` 拆成章）几层，都删了：「这一幕怎么发生」是写正文时才定的事；大纲按章号区间分节、细纲一章一份，已经解决了卷要解决的跨度问题；正文直接落进 `chapters/`，不必再拆。老工程磁盘上那几个目录**一个字节都不动**（那是作者的文件），但代码里彻底不认它们：`kindOfPath` 判成 `other`，工程页不显示、装配器不读，文件操作也删不掉它们。

- **`chapters/` 是唯一真相**：摘要从它生成、上下文从它取正文、工程页的字数也报它。正文的上游指纹记在同号细纲 frontmatter 的 `writtenFrom` 上——章节是作者的文件（可以是 `.txt`、没有 frontmatter），这条链只能从细纲指过去。
- **主按钮只推一个下一步**：全书那一档（架构四件 → 情节大纲 → 拆细纲）由 `deriveBookNextStep` 算，进入「在写」之后由单章的 `deriveNextStep` 算（写细纲 → 写正文 / 接着写 / 重写 → 定稿）。批量动作（补齐设定、批量拆细纲、批量写章）都在工程页，只补空白；排叙事线也在工程页，不进主按钮。
- **定稿是唯一的人工闸口**：单章写完不自动定稿；定稿过的章即使细纲后来改了也不被拉回「待写」，只挂 ⟳。

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
| `src/core/model/` | 数据层：NovelProject（**只剩领域查询**，写盘全在 workspace/）、Markdown 解析、章节文件名规则、**创作流水线领域模型 pipeline.ts**（全书与单章两级状态机、调用次数）、架构三件 settingFile.ts、情节大纲 outlineFile.ts、细纲 plotFile.ts、连续性事实 continuity.ts、角色当前状态 characterState.ts、叙事线 threadsFile.ts、写作技能 writingSkill.ts、拆书的切章与抽样 importText.ts、审稿报告 review.ts、一致性预检 preflight.ts、段级 diff paragraphDiff.ts、服务商配置、思考深度 thinking.ts、会话存储 | [src/core/model/README.md](src/core/model/README.md) |
| `src/core/workspace/` | ★ **工程的唯一读写网关**：路径 → 种类（`kind.ts`）→ 八条守卫（`guard.ts`）→ 解析/渲染/记账/伴生（`handlers/`）。写盘从前散在六处、各带一部分保护，现在收成一处；`upstreamHash` 与 `writtenFrom` 的记账下沉到写入路径本身，谁写都记 | [src/core/workspace/README.md](src/core/workspace/README.md) |
| `src/core/context/` | ★ 分阶段装配（配方 × 层）+ 身份化提示词 + 可替换的 token 计数器。每张配方都带一层 `skill`（这个阶段绑的写作技能，P0 那一组的最后，整份带或整份不带）；架构、大纲、细纲三张另挂一层 `written`（已写正文，只在「从已写正文补齐」时有内容） | [src/core/context/README.md](src/core/context/README.md) |
| `src/core/generation/` | ★ 创作的一次单步：**无状态**地装配 → 调模型 → 解析成 `Draft`（收 signal，并发控制在 controller），外加几条链：结构化产物的降级修复（`structured.ts`）、正文自动续写（`continuation.ts`）、审稿（`review.ts`）、按勾选修稿（`revision.ts`）；六条落盘分派、Draft store（随会话落盘，`write draftId=…` 认它） | [src/core/generation/README.md](src/core/generation/README.md) |
| `src/core/tools/` | ★ **工具层**：契约（`ToolDef` / `ToolIntent` / `ToolInvoker`）、schema 校验、注册表（执行 + 兜异常 + 记日志），以及 `novel/` 那七个工具：读三件 + `generate` + `write` / `edit` / `run`（写作技能的查 / 检查 / 安装 / 绑定也是 `run` 的动作），**没有删除/改名/移动**。**不认识 `mcp/` 与 `controller/`**（形状照 MCP 的 `tools/list` + `tools/call` 摆） | [src/core/tools/README.md](src/core/tools/README.md) |
| `src/core/mcp/` | ★ **把工具端给外部 agent**（Claude Code、Codex……）：MCP 协议（`initialize` / `tools/list` / `tools/call` / 取消）与 Streamable HTTP 传输，独立版挂在 `/mcp`。只认 `tools/` 的契约；执行端在 `controller/mcp.ts`（生成锁、对话页上的 MCP 气泡、两问）。多步调度交给外部 agent，本项目没有自己的循环 | [src/core/mcp/README.md](src/core/mcp/README.md) |
| `src/core/features/` | 功能编排：批量流水线（补齐设定 / 批量拆细纲 / 批量写章）、定稿（摘要 + 角色当前状态 + 叙事线事件）、叙事线（从细纲排出）、一致性预检、摘要、角色卡、设定、文风提取、拆书（导入原稿 / 从已写正文补齐 / 从参考书学写法） | [src/core/features/README.md](src/core/features/README.md) |
| `src/core/skills/` | 写作技能（移植自 AI-Novel-Writer 的阶段 Skill）：三个来源（内置 / 我的技能库 / 本工程）、从 GitHub **先检查再安装**、卸载进回收站、工程的阶段绑定。纯函数（`SKILL.md` 解析与兼容检查、绑定文件格式、`skillStageOf`）在 `model/writingSkill.ts`；注入在 `context/` 的 `skill` 层 | [src/core/skills/README.md](src/core/skills/README.md) |
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
- `docs/design/plans/` 与 `docs/design/specs/` —— 「双形态改造」（共享核心 + VS Code 壳 + Bun 独立 Web 服务壳）、agent 重构与「生成链路重构」（`blueprint-pipeline-*`：总计划与逐期实施计划）的设计文档，涉及分层调整或链路行为时先读。

## 架构要点

以下每条的完整理由与实现细节都在对应模块 README 里，这里只列断言：

- **两层、单向依赖**：`core/` → `shells/`，反向与壳间互相 import 都不允许，`core/` 零 vscode 依赖。测试见 [tests/contract/corePurity.test.js](tests/contract/corePurity.test.js) 与 [shellPurity.test.js](tests/contract/shellPurity.test.js)；细节见 [src/shells/README.md](src/shells/README.md)。
- **壳只做三件事**：实现 `Host`、传输与生命周期、平台专属入口。任何「我是哪个壳」的分支都不属于壳——差异表达成「宿主有没有这个能力」。详见 [src/shells/README.md](src/shells/README.md)。
- **工具层与 MCP 层互不缠绕**：能对工程做什么（[tools/](src/core/tools/README.md)）与怎么端给外部 agent（[mcp/](src/core/mcp/README.md)）是两层，由 [tests/contract/layerBoundary.test.js](tests/contract/layerBoundary.test.js) 守着。
- **消息协议是前后端唯一契约**：[src/core/protocol/](src/core/protocol/index.ts) 的 `InMessage` / `OutMessage`，前端 `import type` 同一份定义，改协议后前端对不上会编译不过。
- **一个 controller，多个宿主**：侧边栏与编辑器标签页挂同一个 `ChatController`，同一会话双开实时同步。见 [src/core/README.md](src/core/README.md)。
- **前端无状态**：webview 靠 `ViewState` 全量推送重建，UI 状态留在前端。见 [media/README.md](media/README.md)。
- **两形态的前端隔离**：独立版专属样式/脚本只由 [src/shells/standalone/page.ts](src/shells/standalone/page.ts) 加载，区分形态用能力探测不判断环境字符串。见 [media/README.md](media/README.md)。
- **页面骨架只有一份**：全部页签的 DOM 都在 [src/shells/shared/panes.ts](src/shells/shared/panes.ts)，加按钮改这一处就够。见 [src/shells/README.md](src/shells/README.md)。
- **前端源码与产物分离**：`media/` 只有源码，产物构建到 `dist/media/`，不入库。加新产物先写源码入口，再改三处（`build-media.js` 的入口清单、`embed-media.js` 的 `built`、`page.ts` 的引用；插件也要加载时再改 `webviewHtml.ts`），细节见 [media/README.md](media/README.md)。

## 必须遵守的行为约束

这些是产品承诺，改动时不可破坏（对应测试在 [`tests/`](tests/README.md)）。**编号是固定锚点**——代码注释与模块 README 大量以「第 N 条」引用这些规则，改动时只精简文字、不重排不合并。每条只留断言本身，机制与理由见链接：

1. **容错优先**：作者会手改任何 Markdown；解析失败退化为忽略，绝不抛崩。见 [src/core/model/README.md](src/core/model/README.md)。
2. **不静默截断**：装配器降级/丢弃任何条目都必须留在明细里并附原因。见 [src/core/context/README.md](src/core/context/README.md)、[src/core/README.md](src/core/README.md)。
3. **不静默覆盖**：任何可能吞掉已有内容的动作，落盘前都要先给用户一个判断的机会——卡片 diff、覆盖前确认、同名报错退出、编辑器内容 hash 乐观锁，形式因场景而异，这条原则不变。见 [src/core/generation/README.md](src/core/generation/README.md)、[src/core/workspace/README.md](src/core/workspace/README.md)、[media/README.md](media/README.md)。
4. **不偷偷烧 token**：摘要不自动生成，只提示过期；单章写完不自动定稿，下一步按钮给「定稿第 N 章」，只有批量的「写完即定稿」模式里自动定稿。要调模型的动作一律在动手之前写明预计调用次数——主按钮、卡片、批量确认框都报，自动续写与修复重试算在上限里，并发不改变这个数。见 [src/core/features/README.md](src/core/features/README.md)。
5. **模型引用只在第一个斜杠处切分**：`openrouter/z-ai/glm-4.6` 中服务商前缀是 `openrouter`。见 [src/core/model/README.md](src/core/model/README.md)。
6. **不真删**：工程页的删除、会话删除、类文件操作的删除，一律搬进 `.novelforge/.trash/` 并保留原相对路径。见 [src/core/workspace/README.md](src/core/workspace/README.md)。
7. **文件访问不越界**：所有写盘经 `core/workspace/` 这一个网关，工程页的类文件操作在此之上再锁章节/角色/设定三个区，细纲的改名删除走专门方法（文件名由章号与标题共同决定，改名只改标题）；独立版的读写另有工程根/大小/白名单一层。见 [src/core/workspace/README.md](src/core/workspace/README.md)、[src/core/README.md](src/core/README.md)。
8. **细纲号 = 章号，只有这一条轴**：`plots/NNN-标题.md` 的号就是章号，细纲与正文只按章号配对（认号只在 `views/pipeline.ts` 的 `chapterOfPlotNo` 一处），摘要跟着章节文件名镜像，界面上一律称「第 N 章」；章节顺序永远由文件名数字前缀决定，与所在目录层级无关。见 [src/core/model/README.md](src/core/model/README.md)、[src/core/views/README.md](src/core/views/README.md)、[src/core/workspace/README.md](src/core/workspace/README.md)。
9. **章节不认扩展名**：章节根下「数字前缀 + 扩展名不在二进制黑名单里」的文件都是章节，规则只在 [src/core/model/chapterFile.ts](src/core/model/chapterFile.ts) 定义一次；角色/设定区仍只认 `.md`。见 [src/core/model/README.md](src/core/model/README.md)。
10. **草稿不进上下文**：`drafts/` 只有作者显式 `@` 引用才进 prompt，装配器永不自动读它；按需创建，删章节不删草稿。见 [src/core/README.md](src/core/README.md)。
11. **不闷着干活**：任何要调模型或跑几十秒的动作都走 `runTask`（进度条 + 日志），日志里绝不出现 API Key 或 prompt/正文全文。见 [src/core/runtime/README.md](src/core/runtime/README.md)。
12. **模型引用只在工程页任务里 fallback，且换人只在档内**：串行恒用该档首选、失败随机换同档其余，绝不跨档换人；对话页创作页的单次生成严格用用户选定的模型，不走池。见 [src/core/llm/README.md](src/core/llm/README.md)。
13. **切批与截断用干活那个模型的窗口**：`config.contextWindow` 只代表对话页选定的模型，走池时用 `pool.primaryBudget`。见 [src/core/llm/README.md](src/core/llm/README.md)。
14. **摘要是出场人物的唯一真相**：角色卡的 `appearsIn` / `updatedThrough` 只是缓存，要用就经 `buildCastIndex()` 从摘要重算；`cast` 的 aliases 只收专属称呼，判定同一个人只信同章共现。细纲 frontmatter 的 `characters:` 是**计划**出场，只给装配器挑角色卡用，不进 `buildCastIndex`。见 [src/core/README.md](src/core/README.md)、[src/core/model/README.md](src/core/model/README.md)。
15. **角色卡不能无限膨胀**：更新角色卡的提示词给每一节都定了字数上限，加字段或改提示词时别把这条抹掉。见 [src/core/features/README.md](src/core/features/README.md)。
16. **失败要留在出错的东西身上**：失败经 [src/core/runtime/errorLog.ts](src/core/runtime/errorLog.ts) 挂在对应目标上（红=整体失败，黄=部分完成），成功路径必须 `clearFailures`。见 [src/core/README.md](src/core/README.md)。
17. **SQLite 只放可丢弃的痕迹**：内容的唯一真相永远是 Markdown，库打不开就静默降级。实现细节（两个驱动、动态 import 写法、finalize 时机）见 [src/core/runtime/README.md](src/core/runtime/README.md)。
18. **上下游新鲜度只靠 hash 传播，不调模型**：产物串成一条指纹链——情节大纲里覆盖这一章的那一节 →（细纲 frontmatter 的 `upstreamHash`）细纲 →（同一份 frontmatter 的 `writtenFrom`，正文落盘时记）正文 →（摘要的 `sourceHash`）摘要。**手写的产物永不标脏**（没有记录过指纹就不算；代码注释里的「第 18a 条」指的就是这一句）。定稿过的章即使上游改了也不被拉回「待写」，只挂 ⟳；流水线状态一律从磁盘推导，绝不落盘。见 [src/core/workspace/README.md](src/core/workspace/README.md)、[src/core/views/README.md](src/core/views/README.md)、[src/core/model/README.md](src/core/model/README.md)。
19. **产物落盘前必须过一遍人，而且是当场过**：`generate` 只把文本交回界面，作者在对话里那张权限卡片上点了「写入」才落盘；外部 agent 经 MCP 调 `generate` 也一样（等作者答了才返回），这一问不交给宿主的权限配置，也不做成一颗可以拖延的按钮。批量路径反过来——一律跳过已有产物的目标，不问、不覆盖（补齐设定只补空白的那几件）。几处有意的例外：细纲带出的新角色随细纲一起建卡（写入卡片上列出会建哪几张）；定稿时角色卡的「当前状态」由机器维护，自上次机器写入之后没人改过才直接更新，作者改过就不写、挂黄 ❗；批量写章写出来但不能往下接的（重演、后面几章的人提前登场、没写够八成、结尾停在半句上）照样落盘，然后停下；批量写章「边写边拆」时没细纲的章先按大纲拆一批细纲、只补空白，写前冲突检查对不上就停在那一章前面；叙事线 `threads.md` 由机器**只追加**——工程页「从细纲排出」在末尾加新线（同名跳过），定稿时把本章推进了哪几条线追加在那条线的事件末尾（证据逐字校验），作者写的字一个都不动。见 [src/core/generation/README.md](src/core/generation/README.md)、[src/core/features/README.md](src/core/features/README.md)、[src/core/mcp/README.md](src/core/mcp/README.md)。
20. **界面永远只推荐一个下一步，且由状态机算出来**：主按钮来自全书那一档的 `deriveBookNextStep`（架构四件 → 情节大纲 → 拆细纲）与单章的 `deriveNextStep`，后者与 `deriveStage` 共用同一套判据；工程页空状态说的「下一步」是同一步、同一句话；审稿是可选动作，不进主按钮。外部 agent 从同一个状态机拿到同一份结论（`views/stateBrief.ts`，贴在 MCP 工具结果末尾、变了才贴），没有 `status` 工具；`selectPlot` 收的是「哪一章」，细纲路径与章节路径都按章号认到同一章。见 [src/core/model/README.md](src/core/model/README.md)、[src/core/mcp/README.md](src/core/mcp/README.md)。
21. **细纲是这一章的计划，不是正文**：`plots/NNN-标题.md` 三节——本章目的、关键事件、章末钩子（必填）；关键事件可以写到具体场面，但不写成段的描写与对白。**「这一章正文写够了没有」看细纲的 `targetWords`**（到八成算写完，不到就自动续写），缺席取小说配置的每章字数，再缺席有字就算——不拿一个猜出来的阈值骗人。见 [src/core/model/README.md](src/core/model/README.md)、[src/core/context/README.md](src/core/context/README.md)。
22. **细纲有两个入口，讨论那条不许被截断**：`generate` 按走向填（单章，或从情节大纲每批 5 章一起拆），`settle` 把讨论结论沉淀成细纲，几条路共用同一份蓝图合同、输出一字不差；`settle` 的历史 cap 抬到 60%。见 [src/core/context/README.md](src/core/context/README.md)。
23. **定稿是这条链上唯一的人工闸口**：一章只有摘要新鲜（或作者在细纲上标了完成）才算写完；单章写完不自动定稿，下一步按钮给「定稿第 N 章」并写明调用次数，只有批量的「写完即定稿」模式里自动定稿。（这一条从前是「拆分是作者的活」，拆分随中转站一起删了，编号原位沿用。）见 [src/core/features/README.md](src/core/features/README.md)、[src/core/model/README.md](src/core/model/README.md)。
24. **外部 agent 是调度者，不是第二个作者**：多步的活交给经 MCP 接进来的通用 agent，本项目不自带循环；创作质量仍来自分阶段装配那一层，领域知识只在那里写一份（工具描述与 MCP 说明里不写）；`generate` 的产物不回灌（返回只有形状与 draftId）、`history` 传空。见 [src/core/mcp/README.md](src/core/mcp/README.md)、[src/core/tools/README.md](src/core/tools/README.md)。
25. **外部 agent 不越过既有的闸门**：它的写入走的是与落盘卡片同一条 `workspace.write`，MCP 这一层没有任何新的保护代码；下游没有 diff 的动作（工具自报 `always`：`edit`、装 / 绑技能）动手前在对话页问一句，覆盖已有内容走覆盖审阅，都不交给宿主的权限配置；明确不给删除/改名/移动/`bash`/工程根之外的路径/裸 `fs`（唯一写到工程外的是 `run installSkill`：固定落进我的技能库，路径不由 agent 给，先问）。见 [src/core/mcp/README.md](src/core/mcp/README.md)、[src/core/tools/README.md](src/core/tools/README.md)。
26. **思考深度是会话的属性，只作用于作者选定的那个模型**：落在 `ChatSession.thinking` 上跟着会话走，缺省是「不思考」；只有对话页的单次生成带它，MCP 的 `generate` 与工程页的后台批量任务一律不带。见 [src/core/model/README.md](src/core/model/README.md)、[src/core/llm/README.md](src/core/llm/README.md)。

## 提交约定

中文正文可以，前缀用 `feat/refactor/chore/docs`。不要提交 `dist/`（已被 gitignore）。
