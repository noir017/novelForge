# AGENTS.md

Novel Forge 是一个 VS Code 插件，为长篇小说写作做 LLM 上下文管理：按 token 预算自动装配「文风指南 + 全书摘要 + 角色卡 + 近章原文」并透明展示、纲要扩写成稿（流式预览、采纳才落盘）、章节/全书摘要与角色卡整合。所有数据是工作区里的普通 Markdown（`.novelforge/` 目录），可 Git、可手改。

产品文档（面向作者的完整使用说明）见根目录 [README.md](README.md)。本文件面向代码代理：先读模块 README 再动手。

## 常用命令

shell 为 PowerShell（不支持 `&&`，用 `;` 分隔），均在仓库根目录执行：

```powershell
npm install              # 依赖
npm run compile          # esbuild 打包到 dist/extension.js + dist/media/ 的前端产物（F5 调试前必须有）
npm run watch            # 监听构建（两边都监听）
npm run media            # 只构建前端资源（media/src → dist/media/）
npm run typecheck        # tsc --noEmit，含 media/tsconfig.json，必须零错误
npm run smoke             # 十五个离线冒烟测试，不需要 API Key
npm test                 # typecheck + smoke
```

改了 `src/core/**` 后必须跑 `npm run smoke`；改了任何 TS（含 `media/src/**`）都要过 `npm run typecheck`。手动验证 UI 时按 `F5` 启动 Extension Development Host（自动打开 `sample-novel/`）。

## 模块地图

改动前先读对应模块的 README：

| 模块 | 一句话职责 | README |
|---|---|---|
| `src/` | 三层架构总览与一条续写请求的完整链路 | [src/README.md](src/README.md) |
| `src/core/` | 核心逻辑层入口（含协议 protocol.ts、工程页快照 projectView.ts、出场人物索引 cast.ts、资源管理器目录列举 fileTree.ts、三区类文件操作 fileOps.ts、工程根范围文件操作 projectFiles.ts、日志 logger.ts、长任务 progress.ts） | [src/core/README.md](src/core/README.md) |
| `src/core/model/` | 数据层：NovelProject、Markdown 解析、章节文件名规则、服务商配置、会话存储 | [src/core/model/README.md](src/core/model/README.md) |
| `src/core/context/` | ★ 分层预算上下文装配器 + 可替换的 token 计数器 | [src/core/context/README.md](src/core/context/README.md) |
| `src/core/features/` | 功能编排：续写、摘要、角色卡、设定、文风提取 | [src/core/features/README.md](src/core/features/README.md) |
| `src/core/llm/` | LlmProvider 接口、OpenAI / Anthropic 实现、注册表与 API Key | [src/core/llm/README.md](src/core/llm/README.md) |
| `src/ui/` | 宿主无关的面板逻辑：ChatController + @ 引用 | [src/ui/README.md](src/ui/README.md) |
| `src/vscode/` | VS Code 宿主层：extension 入口、webview 宿主、vscode-lm | [src/vscode/README.md](src/vscode/README.md) |
| `src/standalone/` | 独立 Web 服务壳（Bun）：HTTP/WS 服务、FileHost、页面骨架 | [src/standalone/README.md](src/standalone/README.md) |
| `media/` | 前端资源（原生 TS/CSS，无框架）。**仓库里只有源码 `media/src/` 与 `icon.svg`，构建产物在 `dist/media/`**；`standalone.css` / `editor.js` / `explorer.js` 只在独立版加载 | [media/README.md](media/README.md) |
| `scripts/` | 离线冒烟测试（也是理解核心行为的最佳入口） | [scripts/README.md](scripts/README.md) |
| `sample-novel/` | 示例工程 / 测试夹具，勿随手改正文（hash 断言会挂） | [sample-novel/README.md](sample-novel/README.md) |

其他关键位置：

- [package.json](package.json) —— 命令 / 菜单 / 快捷键 / 全部 `novel.*` 配置项的声明。
- [esbuild.js](esbuild.js) —— 构建脚本，入口 `src/vscode/extension.ts` → `dist/extension.js`；同时调 [scripts/build-media.js](scripts/build-media.js) 把前端资源打进 `dist/media/`。
- `docs/design/plans/` 与 `docs/design/specs/` —— 「双形态改造」（共享核心 + VS Code 壳 + Bun 独立 Web 服务壳）的实施计划与设计文档，涉及分层调整时先读。

## 架构要点

- **三层、单向依赖**：`core/`（数据与逻辑）→ `ui/`（面板逻辑，宿主无关）→ `vscode/`（宿主壳），反向依赖不允许。`core/` 的目标是零 vscode 依赖（双形态改造前提），新代码不要给 `core/` 增加 `vscode` import。
- **消息协议是前后端唯一契约**：[src/core/protocol.ts](src/core/protocol.ts) 的 `InMessage` / `OutMessage`。前端经 [media/src/protocol.ts](media/src/protocol.ts) 以 `import type` 直接引用同一份定义，所以**改协议后前端对不上会编译不过**（`npm run typecheck` 覆盖 `media/`），不再靠人记得同步改。
- **一个 controller，多个宿主**：侧边栏与编辑器标签页挂同一个 `ChatController`，同一会话双开实时同步。
- **前端无状态**：webview 靠 `ViewState` 全量推送重建，展开/折叠等 UI 状态留在前端。
- **两形态的前端隔离**：`media/src/css/standalone/` 与 `media/src/editor/` `media/src/explorer/` 只由 [src/standalone/html.ts](src/standalone/html.ts) 加载，插件的 `webviewHtml.ts` 里没有它们。改独立版的样式/布局只动那几处，别为独立版去改 `media/src/css/view/`（会连带影响插件）；区分形态用能力探测（`#wbEditor` 存不存在），不要判断环境字符串。
- **前端源码与产物分离**：仓库里的 `media/` 只有源码（`media/src/`）与 `icon.svg`；`view.js` / `view.css` 等六个产物构建到 **`dist/media/`**，和 `dist/extension.js` 同一个去处，整个 `dist/` 都不入库。加**新产物**要三处同改：`media/src/` 放源码 → [scripts/build-media.js](scripts/build-media.js) 的 entryPoints → [scripts/embed-media.js](scripts/embed-media.js) 的 `built` 数组 → `html.ts` 里引用（漏了第三步，`bun build --compile` 出的单文件会 404）。在**已有产物内部**拆模块则不必动任何配置，直接 import。

## 必须遵守的行为约束

这些是产品承诺，改动时不可破坏（对应测试在 `scripts/`）：

1. **容错优先**：作者会手改任何 Markdown；解析失败退化为忽略，绝不抛崩。
2. **不静默截断**：装配器降级/丢弃任何条目都必须留在明细里并附原因。
3. **不静默覆盖**：角色卡更新走 diff 确认；style.md 覆盖前先问；「采纳写入」前正文只存在会话里；类文件操作遇到同名目标一律报错退出；内置编辑器保存走内容 hash 乐观锁（[src/core/fileEditing.ts](src/core/fileEditing.ts)），磁盘变过就报冲突让用户取舍。
4. **不偷偷烧 token**：摘要不自动生成，只提示过期。要分多次调模型的动作（更新角色卡可能分十几批、批量建卡可能是几十个人）必须在动手前的确认框里写明预计调用次数。并发不改变总次数，这个数在并发下依然要对得上账。
5. **模型引用只在第一个斜杠处切分**：`openrouter/z-ai/glm-4.6` 中服务商前缀是 `openrouter`。
6. **不真删**：工程页的删除（以及会话删除）一律搬进 `.novelforge/.trash/` 并保留原相对路径。
7. **文件访问不越界**：工程页的类文件操作锁在章节/角色/设定三个区内（`core/fileOps.ts` 的 `normalizeRel` / `sectionOf`）；独立版的读写另有一层——路径落在工程根内、大小上限、以及「纯文本扩展名白名单 ∪ 章节文件名规则」，全在 `fileEditing.ts` 里兜住。独立版「文件」页的写入口只经 `core/projectFiles.ts`（重命名/移动/复制锁在工程根内，`chapters/`、`drafts/`、`.novelforge` 等固定目录受 `isProtectedPath` 保护，同名绝不覆盖，`.trash` 内容不可操作），目录列举（`core/fileTree.ts`）仍只读。服务无鉴权（只绑 127.0.0.1），别在别处绕过这几处直接读写。
8. **层级只是收纳**：章节顺序永远由文件名数字前缀决定，与所在目录层级无关；分卷不重置编号，也不影响上下文装配与摘要新鲜度。草稿按章节在章节根之下的相对路径镜像存放，文件名（含扩展名）原样沿用。
9. **章节不认扩展名**：章节根下「数字前缀 + 扩展名不在二进制黑名单里」的文件都是章节（`001-楔子.txt`、`001-楔子`、`004.json` 都算，`.png/.docx/.zip` 不算），规则只在 [src/core/model/chapterFile.ts](src/core/model/chapterFile.ts) 里定义一次。`.md`/`.markdown` 之外的章节**不解析 `# 标题`**，标题只取文件名——`extractH1` 与 `stripH1` 都只看首行，两者必须保持互逆。角色/设定区不跟着放宽，仍然只认 `.md`。
10. **草稿不进上下文**：`drafts/` 只有作者显式 `@` 引用才进 prompt，装配器永不自动读它。按需创建（首次点「打开草稿」），已存在绝不覆盖；章节改名/移动时草稿跟着走，删章节不删草稿（确认框里会说明）。
11. **不闷着干活**：任何要调模型或跑几十秒的动作都必须看得见——走 [src/core/progress.ts](src/core/progress.ts) 的 `runTask`（工程页顶部出进度条：n/N、百分比、计时、可停止），并在 [src/core/logger.ts](src/core/logger.ts) 里留下开始/每步/结束与耗时。日志页（第四个页签）是用户唯一能事后复查「刚才那 76 章卡在哪」的地方。**日志里绝不出现 API Key**（统一走 `redact`），也**绝不记 prompt 或正文全文**（只记条数与字数）。并发跑时（[src/core/concurrency.ts](src/core/concurrency.ts) 的 `runPool`）`current` **只在一项真正结束时 +1**，message 报「已完成 n/N + 正在跑哪几项」——按启动数递增会让进度条冲到头然后干等。
12. **模型引用只在工程页任务里 fallback，且换人只在档内**：工程页的后台任务经 [src/core/llm/pool.ts](src/core/llm/pool.ts) 取模型，取哪一档由**任务**决定（[src/core/model/tiers.ts](src/core/model/tiers.ts) 的 `DEFAULT_TASK_TIERS`，作者可在设置页逐项覆盖）——串行恒用该档首选、失败随机换**同档**其余，并发在**档内**轮转做负载均衡。**绝不跨档换人**：快速档失败升级到精标档等于绕过作者的成本决定去烧贵 token，而且日志上看不出来。**空档位沿用 `config.models`**，三档都不配则行为与分档前逐字节一致——静默把某些任务降级到便宜模型，等于替作者做了质量取舍。**对话页续写与连接测试严格用用户选定的那个模型**，中途换人会让文风断掉。构造池时只有该档首选能弹 API Key 输入框，备选缺 Key 一律剔除并 warn。
13. **切批与截断用干活那个模型的窗口**：分档后 `config.contextWindow` 只代表**对话页选定的模型**，拿它给快速档的 32k 模型切批会稳定超窗。执行中用 `pool.primaryBudget`；确认框之前就要算的东西（设定生成的扫描片段数、角色卡的批数——它们就是「预计调用 N 次」那个数字）用 `budgetForTask(task)`，它不构造 provider，因此不会在用户点确认前弹 Key 输入框。
14. **摘要是出场人物的唯一真相**：单章摘要让模型输出 JSON，解析后落盘仍是 Markdown（作者要手改），结构化的出场人物写进 frontmatter 的 `cast`。角色卡里的 `appearsIn` / `updatedThrough` 只是缓存，要用就经 [src/core/cast.ts](src/core/cast.ts) 的 `buildCastIndex()` 从摘要重算。摘要解析必须保留三层降级（JSON → Markdown 小节 → 全文进梗概）——解析失败等于这一章的剧情永远进不了上下文。 **`cast` 的 aliases 只收专属称呼**（经 [src/core/naming.ts](src/core/naming.ts) 过滤掉代词/亲属称谓/泛称/描述短语）：它是「谁是谁」的判据，`姐姐` 会把三个女角色串成一个。判定两个称呼是同一个人只信**同章共现**这条硬约束（[src/core/identity.ts](src/core/identity.ts)）——同章各自出场的两个人永不合并，一条幻觉别名不该把主角和她孪生弟弟并成一个。
15. **角色卡不能无限膨胀**：它每次续写都要注入上下文。更新角色卡的提示词给每一节都定了字数上限，并明确「性格 / 语言习惯」优先、外貌与人物关系从简。加字段或改提示词时别把这条抹掉。

## 提交约定

中文正文可以，前缀用 `feat/refactor/chore/docs`。不要提交 `dist/`（已被 gitignore）。
