# AGENTS.md

Novel Forge 首先是一个**写长篇小说的编辑器**（编辑器的功能优先做），其次**照正文自动整理这本书**（细纲、角色卡、设定、叙事线由机器维护，作者改过的机器不覆盖），最后才是往下写（一句念头 → 架构 → 情节大纲 → 细纲 → 正文）。四种壳（独立 Web 服务 / 桌面 / Android / VS Code 插件）共用一套核心。数据是工作区 `.novelforge/` 下的普通 Markdown，app 不读写 `.git`。产品文档见 [README.md](README.md)。

**一条轴：细纲号 = 章号。** `config.md` → `premise.md` / `characters/` / `world.md` / `lore/` → 情节大纲（**不是文件**，是各章细纲梗概的汇总）→ `summaries/…/NNN-标题.md`（细纲，**镜像正文的相对路径**）→ `chapters/…/NNN-标题.txt`（正文，唯一真相）→ 定稿（界面上叫「同步」，照正文反向更新细纲、设定、角色状态、叙事线 `threads/`、故事时间）。`scenes/`、`volumes/`、`manuscripts/`、`plots/` 已删，代码不认、磁盘上不动。详见 [src/core/model/README.md](src/core/model/README.md)。

## 代理工作约定

- **文档只写断言**：本文件的约束一条一句；模块 README 的文件表一个文件一句话；机制、例外与理由写进代码注释。

## 常用命令

shell 为 PowerShell（不支持 `&&`，用 `;` 分隔），均在仓库根目录执行：

```powershell
npm run compile          # 打包 dist/extension.js 与 dist/media/（F5 调试前必须有）
npm run typecheck        # 含 media/，必须零错误
npm test                 # typecheck + 全部测试，不需要 API Key
npm run test:unit        # 也有 test:integration / test:dom / test:e2e（需 Bun）
```

改了 `src/core/**` 必须跑 `npm test`；改了任何 TS 都要过 `npm run typecheck`。单跑一条：`node --test --test-name-pattern="关键字" "tests/unit/**/*.test.js"`（**glob 要带引号**）。F5 配置见 [.vscode/README.md](.vscode/README.md)。

## 模块地图

每个模块目录下都有 `README.md`（★ 是改动前最该查的）：

| 模块 | 职责 |
|---|---|
| `src/` | 两层架构总览与一条创作请求的完整链路 |
| `src/core/` | 核心层入口：协议 `protocol/`、文件能力 `files/`、`controller/` |
| `src/core/model/` | 数据层：领域查询（不写盘）、各类文件的格式与认法、流水线状态机与调用次数 |
| `src/core/workspace/` | ★ 工程的唯一读写网关：守卫、指纹记账、历史版本、存档点 |
| `src/core/context/` | ★ 分阶段装配（配方 × 层）+ 提示词 + token 计数 |
| `src/core/generation/` | ★ 一次单步：装配 → 调模型 → `Draft`；转写、续写、审稿、修稿、落盘分派 |
| `src/core/features/` | 功能编排：批量流水线、定稿、叙事线与故事时间、角色卡、设定名录、拆书、存档点…… |
| `src/core/tools/` · `mcp/` | ★ 工具层（`novel/` 十三个工具）与把它端给外部 agent 的 MCP 层，互不 import |
| `src/core/views/` | 只读聚合与界面快照（`model/pipeline.ts` 是纯领域状态机，不搬进来） |
| `src/core/runtime/` | 日志、SQLite 痕迹库、失败记录、长任务、并发、`callScope.ts` |
| `src/core/llm/` · `skills/` | 模型服务商；写作技能 |
| `src/shells/` | ★ 四个壳 + `shared/panes.ts`（所有 pane 的 DOM 唯一来源）；壳的契约在这份 README |
| `media/` | 前端（原生 TS/CSS），源码 `media/src/`，产物 `dist/media/` |
| `tests/` · `scripts/` | 测试（按类型分目录）；构建与诊断脚本 |
| `sample-novel/` | 测试夹具，勿随手改正文（hash 断言会挂） |

设计稿在 `docs/design/`，涉及分层或链路行为时按需查。

## 架构要点

- **两层、单向依赖**：`core/` → `shells/`，`core/` 零 vscode 依赖，壳间不互相 import（`tests/contract/` 守着）。
- **壳只做三件事**：实现 `Host`、传输与生命周期、平台专属入口；差异表达成「宿主有没有这个能力」。
- **消息协议是前后端唯一契约**：`src/core/protocol/` 的 `InMessage` / `OutMessage`。
- **前端无状态**：靠 `ViewState` 全量推送重建；加新前端产物改 `build-media.js`、`embed-media.js`、`page.ts` 三处。

## 必须遵守的行为约束

产品承诺，改动时不可破坏。**编号是固定锚点**（代码注释以「第 N 条」引用），只精简文字、不重排不合并。机制、例外与理由见链接的模块 README。

1. **容错优先**：作者会手改任何 Markdown，解析失败退化为忽略，绝不抛崩。[model](src/core/model/README.md)
2. **不静默截断**：装配器丢掉的条目都要留在明细里并附原因。[context](src/core/context/README.md)
3. **不静默覆盖**：可能吞掉已有内容的动作，落盘前先给作者判断的机会。[workspace](src/core/workspace/README.md)
4. **不偷偷烧 token**：不自动补、不自动定稿；调模型前一律写明预计调用次数，确认框经 `features/askCall.ts`。[features](src/core/features/README.md)
5. **模型引用只在第一个斜杠处切分**。[model](src/core/model/README.md)
6. **不真删**：删除一律搬进 `.novelforge/.trash/`。[workspace](src/core/workspace/README.md)
7. **文件访问不越界**：所有写盘经 `core/workspace/` 这一个网关。[workspace](src/core/workspace/README.md)
8. **细纲号 = 章号，细纲镜像正文的相对路径**：不许平铺、不许只按章号配对。[model](src/core/model/README.md)
9. **章节不认扩展名**：规则只在 `model/chapterFile.ts` 定义一次。[model](src/core/model/README.md)
10. **草稿不进上下文**：`drafts/` 只有作者显式 `@` 才进 prompt。[core](src/core/README.md)
11. **不闷着干活**：要调模型或跑几十秒的走 `runTask`，日志不出现 API Key 与全文。[runtime](src/core/runtime/README.md)
12. **模型引用只在工程页任务里 fallback，且换人只在档内**；转写固定走「转写」那一档。[llm](src/core/llm/README.md)
13. **切批与截断用干活那个模型的窗口**。[llm](src/core/llm/README.md)
14. **定稿过的细纲是出场人物的唯一真相**：角色卡上的出场记录只是缓存，经 `buildCastIndex()` 重算。[model](src/core/model/README.md)
15. **角色卡不能无限膨胀**：每一节都有字数上限。[features](src/core/features/README.md)
16. **失败要留在出错的东西身上**：经 `runtime/errorLog.ts` 挂在目标上，成功路径必须 `clearFailures`。[core](src/core/README.md)
17. **SQLite 只放可丢弃的痕迹**：库打不开就静默降级。[runtime](src/core/runtime/README.md)
18. **上下游新鲜度只靠 hash 传播，不调模型**：(a) 手写的产物永不标脏；(b) 内容指纹只哈希小节、不含 frontmatter；流水线状态从磁盘推导、绝不落盘。[workspace](src/core/workspace/README.md)
19. **产物落盘前必须过一遍人，而且是当场过**：批量路径反过来，一律跳过已有产物。[generation](src/core/generation/README.md)
20. **界面永远只推荐一个下一步，且由状态机算出来**：外部 agent 经 `views/stateBrief.ts` 拿同一份结论。[model](src/core/model/README.md)
21. **细纲是这一章的计划，不是正文**：写够没有看 `targetWords`。[model](src/core/model/README.md)
22. **细纲有两个入口，讨论那条不许被截断**。[context](src/core/context/README.md)
23. **定稿是这条链上唯一的人工闸口**。**叫法**：给作者与外部 agent 看的字（界面、README、MCP 说明、autopilot 技能）一律叫「同步」，代码标识符、设计稿与提示词里仍叫定稿。[features](src/core/features/README.md)
24. **外部 agent 是调度者，不是第二个作者**：本项目不自带循环，`generate` 的产物不回灌。[mcp](src/core/mcp/README.md)
25. **外部 agent 不越过既有的闸门**：不给删除 / 改名 / 移动 / `bash` / 工程根之外的路径。[mcp](src/core/mcp/README.md)
26. **思考深度是会话的属性，只作用于作者选定的那个模型**。[llm](src/core/llm/README.md)
27. **设定条目不能无限膨胀，机器只并不删作者的字**。[features](src/core/features/README.md)
28. **叙事线是剧情线，作者写的字机器不动**：状态从事件现算、不落盘，机器只追加。[model](src/core/model/README.md)

## 提交与发版

提交前缀 `feat/refactor/chore/docs`，正文可用中文，不提交 `dist/`。版本号**只记在根 `package.json`**（`tests/contract/version.test.js` 守着）。发版：`npm version patch|minor|major`（工作区要干净，先跑测试；不用带字母的预发布号）→ `git push --follow-tags`，tag 触发 `release.yml` 出 Release 草稿，作者看过再公开。
