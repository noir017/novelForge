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
```

单跑一个文件或一条用例：

```bash
node --test tests/unit/model/markdown.test.js
node --test --test-name-pattern="stripH1" "tests/unit/**/*.test.js"
```

> **glob 必须带引号**——`node --test <目录>` 在当前 Node 版本会把目录当成模块入口报
> `MODULE_NOT_FOUND`。引号让 glob 交给 node 自己展开，PowerShell 与 sh 下行为一致。

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
| `model/markdown.test.js` | frontmatter 解析（行内/块状数组、畸形行不抛错）、小节抽取、`extractH1`/`stripH1` 互逆、序列化往返 |
| `model/chapterFile.test.js` | 章节文件名规则：任意非二进制扩展名 / 无扩展名算章节、二进制黑名单被挡、`extractH1` 只看首行 |
| `model/project.test.js` | `cast` 条目的序列化往返（含全角括号、别名去重）、小节文本反解出场人物 |
| `model/providers.test.js` | 模型引用解析（含嵌套斜杠 `openrouter/z-ai/glm-4.6`）、服务商配置容错、按模型覆盖窗口、0.1.x 单服务商兜底；默认模型列表的归一化与旧配置升级；`concurrency` / `fallbackAttempts` 的默认值与 clamp |
| `model/tiers.test.js` | 模型分档的配置容错：三档各自归一化、非对象不崩、裸字符串收成单元素、认不出的任务名与非法档位名回落内置默认，以及「每个任务都有内置默认档位与中文名」 |
| `model/pipeline.test.js` | 四个阶段的可用/默认能力、输出形态判定、`CreationTarget` 的稳定键（同序号不同文件不撞）、action/target 容错归一 |
| `context/tokenizer.test.js` | token 估算（中英文比例）、`takeTail`/`takeHead` 的预算与截断标记 |
| `context/tokenCounter.test.js` | 可替换计数器的注册/切换、`prepare` 抛错时不带崩、用量校准统计只收真实用量 |
| `features/creation.test.js` | 模型输出清洗（去代码块/开场白/标题/字数统计，正文不误伤）、标题推断 |
| `features/summarize.test.js` | **摘要解析的三层降级**：JSON → Markdown 小节 → 全文进梗概；不相干的 JSON 不被当成摘要 |
| `features/characters.test.js` | 角色 JSON 解析的容错：坏 JSON 返回空数组而非抛错、无 name 条目被丢弃 |
| `runtime/concurrency.test.js` | `runPool`：并发峰值不超 limit、结果按 index 对齐、单项失败不拖累其余、取消后不起新任务、`onSettled` 计数单调不重复；`serialize` 的串行与不卡死 |
| `runtime/pool.test.js` | 模型池：并发轮转均摊、串行恒用首选、失败换人、重试不超 `fallbackAttempts`、取消不 fallback、剔除备选**不弹 API Key 输入框**；**分档**：空档位继承 `models`、**fallback 绝不跨档**、`primaryBudget` 取该档首选窗口 |
| `runtime/logger.test.js` | 脱敏（`sk-`／`Bearer`／`api_key=`／`x-api-key`）、环形缓冲上限、sink 级别过滤、坏 sink 不抛给调用方、detail 截断带说明 |
| `runtime/progress.test.js` | 长任务进度快照、字符串 `report` 只改文案、宿主进度带 `（n/N）`、取消、抛异常继续上抛且进日志、并发两个任务、结束后清表 |

### `integration/`

| 文件 | 覆盖 |
|---|---|
| `files/fileOps.test.js` | 层级目录与类文件操作：递归扫描（含 `.trash/` 排除）、`ProjectTree` 折叠、路径越界守卫、新建/重命名（保留序号前缀、H1 同步）/移动（跨区/自嵌套/同名拒绝）/删除（搬回收站、不覆盖）、挪动章节后摘要仍算新鲜；`buildChapterSummaryView` |
| `files/projectFiles.test.js` | 工程根范围的文件操作：重命名/移动/复制、固定目录保护、同名拒绝、垃圾箱豁免、章节联动 |
| `files/chapters.test.js` | 非 markdown 章节不解析 H1、角色区仍只认 `.md`、`isEditablePath` 放行无扩展名章节 |
| `files/drafts.test.js` | 草稿路径镜像、按需创建且第二次不覆盖、不混进章节树与 manifest、`@` 引用、跟随改名/移动、删章节不删草稿 |
| `context/builder.test.js` | 完整上下文装配：优先级、预算、降级链、手动排除、附件截断、多轮历史封顶、四阶段配方与身份、provider 配额压缩；工程页快照与出场人物索引。**写入类用例跑夹具的临时副本**，`sample-novel/` 只读 |
| `features/creation.test.js` | 创作编排层：产物解析的三层降级与 `parsePlanStrict` 的不兜底版本；六条采纳落盘路径——覆盖前必须审阅且**拒绝时一字不写**、二次拆场景不动原有场景、目标不存在时抛错 |
| `features/pipelineData.test.js` | 细纲与场景的解析/渲染往返、场景文件名规则、四套镜像路径与改名跟随、**四段新鲜度链**（改大纲→细纲脏→场景脏→正文脏）、**手写的产物永不标脏** |
| `features/pipelineBatch.test.js` | 工程页批量流水线：**只补不改**、缺上游不生成下游、解析不出**不写盘**、失败挂 errorLog 且继续跑完、用户取消时一次模型都不调；装配走同一个 `buildContext` |
| `features/cast.test.js` | 别名的泛称过滤；同一人聚类——**同章共现的两人绝不合并**；出场索引的正式名优先与 `conflicts`；维护命令（清理别名不动正文、合并重复卡、水位线退回） |
| `features/characterCard.test.js` | 更新角色卡：分批与「预计调用 M 次」、只装该角色的出场章节、增量无新章时**一次模型都不调**、部分失败时**水位线停在第一个失败章节之前**、取消/放弃不落盘；**并发**下模型请求重叠但 **diff 审阅仍一次只弹一张** |
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
| `view/chat.test.js` | 流式逐段显示、生成中不可编辑、结束后可编辑、中断与报错、气泡 ... 菜单、空输入、产物采纳卡片、思考过程 |
| `view/creation.test.js` | 创作流水线条与下一步、工作区卡、`/` 命令面板、选中章节进入当前阶段、独立版壳上的创作页 |
| `view/projectTree.test.js` | 目录树折叠/展开与缩进、空文件夹提示、重推后保持展开；右键菜单的菜单项与消息负载、通用行为 |
| `view/cast.test.js` | 角色行的「出场 N 章」与「＋N 待更新」、增量/全量分别发 `updateCard`/`rebuildCard`、「出场人物 · 未建卡」分组、旧后端的树不让前端崩 |
| `view/progress.test.js` | 摘要进度横幅（已总结 N/M + 进度条）、长任务进度条（n/N、计时、停止） |
| `view/logs.test.js` | 级别与关键字过滤、detail 折叠、增量追加也走过滤；**「加载更早」**——默认不查库、点了才发 `requestLogHistory`、历史不冲掉本次会话 |
| `view/settings.test.js` | 模型分档三档渲染、八行任务表与内置默认标记、只把**改过的项**写进 `taskTiers`、指向已删模型的引用摘掉且摘空了保持为空；「高级设置」折叠开关 |
| `view/hover.test.js` | 三组悬停浮窗（章节摘要 / 行内别名 / 失败标记）：延迟才弹、缓存与作废、可进入（能选中复制）、**夹进视口**（下方放不下翻上方、贴右收左、超长压 `max-height`）、失败标记按最严重的算 |
| `standalone/editor.test.js` | 内置编辑器：草稿区惰性创建、`pane` 分派、「草稿」按钮可见性与 `openDraft` 负载、保存回执不冲掉 `draftPath`、右键菜单与标签搬家 |
| `standalone/explorer.test.js` | 资源管理器：点开头目录列得出来且压暗、目录排在文件前、懒展开、折叠连带子目录、可编辑与否走不同消息、截断如实告知、读失败降级；文件页剪贴板与右键菜单 |

### `e2e/` 与 `contract/`

| 文件 | 覆盖 |
|---|---|
| `e2e/standalone/server.test.js` | 独立版服务（**需 Bun**）：静态资源、WS 首条消息、`Origin` 校验；内置编辑器的消息往返——保存落盘、过期 hash 触发冲突且不覆盖、强制保存、越界路径与非文本扩展名被拒；`openDraft` 的按需创建与并列打开；资源管理器的 `listDir` → `dirListings` 往返 |
| `contract/corePurity.test.js` | `src/core/` 零 vscode 依赖——分层架构的硬约束，也是 `external: ['vscode']` 成立的前提 |
| `contract/shellPurity.test.js` | 壳的契约（[src/shells/README.md](../src/shells/README.md)）：`shells/shared/` 零宿主依赖（不碰 vscode / node: / bun:）、三个壳互不 import、全仓库没有 `host.name ===` 这类按身份分支的写法。三条都是**能悄悄长回来**的东西，只能靠断言守 |
| `contract/sampleNovel.test.js` | `sample-novel/` 自洽：manifest 章节数与磁盘一致、每章 `contentHash` / `summaryHash` / 摘要 `sourceHash` 对得上、示例纲要能命中 3 个角色 |

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
