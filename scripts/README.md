# scripts — 离线冒烟测试

十四个不依赖 VS Code、也不需要真实 API Key 的测试脚本，`npm run smoke` 依次执行（末尾的 `smoke-server.js` 需要 bun），`npm test` = typecheck + core 纯度检查 + smoke。

| 脚本 | 覆盖范围 |
|---|---|
| [smoke.js](smoke.js) | Markdown 解析、tokenizer、**可替换 token 计数器**（注册/切换/`prepare` 抛错时不带崩/用量校准统计）、模型输出清洗、**摘要 JSON 解析的三层降级**（JSON → Markdown 小节 → 全文进梗概）与 `cast` 字段的序列化往返，角色 JSON 解析的容错，以及 `sample-novel/` 的 hash 一致性 |
| [smoke-providers.js](smoke-providers.js) | 模型引用解析（含嵌套斜杠 `openrouter/z-ai/glm-4.6`）、服务商配置容错、按模型覆盖窗口、0.1.x 单服务商配置兜底；**默认模型列表**——归一化（去空/去重/保序）、旧配置只有 `model` 时升级成单元素列表、`model` 恒等于首项、解析不出的引用留在列表里不静默丢弃，以及 `concurrency` / `fallbackAttempts` 的默认值与 clamp |
| [smoke-view.js](smoke-view.js) | 用 jsdom 跑构建产物 `dist/media/view.js`（DOM 结构从 `webviewHtml.ts` 里抠出来，保证与真实渲染一致）：流式过程中逐段显示、生成中不可编辑、结束后可编辑，以及气泡右上角的 ... 菜单；工程页目录树——折叠/展开、缩进层级、空文件夹提示、重推后保持展开状态；以及右键菜单——各类行给出的菜单项（含按 `hasDraft` 切换的「打开草稿 / 新建草稿」）、点击后发出的消息负载（`fileAction`、带 `dir` 的 `projectAction`、`openDraft`）、行上不再有行内按钮、其它页面只给「刷新」、点空白/Esc 关闭。**未装 jsdom 时自行跳过**，不算失败。另有几节：① 摘要进度显示——横幅上的「已总结 N/M + 百分比 + 进度条」、同步进行中撤掉「立即同步」、全同步后横幅消失；② 长任务进度条——n/N、计时、不定量条、点「停止」发 `cancelTask`、任务清空后收起；③ 日志页——级别过滤、关键字过滤、detail 折叠、增量追加也走过滤、清空发 `clearLogs`；④ 独立版内置编辑器：用 `html.ts` 的 body 起 `dist/media/editor.js`（插件形态没有 `#wbEditor`，那份 body 跑不到它），验证草稿区惰性创建、`pane` 分派、「草稿」按钮的可见性与 `openDraft` 负载、保存回执不冲掉 `draftPath`、同一路径只属于一块编辑区；⑤ 独立版资源管理器（`dist/media/explorer.js`，同样要 `html.ts` 的 body）：点开头的目录列得出来且压暗、目录排在文件前、懒展开只请求展开的那些、折叠连带子目录、载入中占位、可编辑与否分别走 `openEditor` / `openExternal`、编辑器打开谁就高亮谁、截断如实告知、读失败降级成一行提示、右键复用 view.js 的菜单引擎；⑥ **角色的出场统计与更新菜单**——角色行的「出场 N 章」副标题与「＋N 待更新」标记、增量/全量分别发 `updateCard` / `rebuildCard`、未在摘要中出现的角色不给更新入口并说明原因、「出场人物 · 未建卡」分组（只给建卡、没有类文件操作、点名字即建卡、空列表时整组不出现），以及**旧后端推来的树（无 `cast` / `castByCard`）不能让前端崩**；⑦ 章节摘要的悬停浮窗——延迟后才弹（划过时不闪、行内微动不重置延迟）、只对章节行、发 `requestSummary` 并先显示「读取中」、缓存命中不重复请求、收到新树后缓存作废、过期打标、未总结时给说明，以及摘要正文走 `textContent` 不当 HTML 解析；另有两组行为验证：**可进入**（移开有宽限期、鼠标停在浮窗上不消失、浮窗内部滚动不收起、离开后才收，而页面滚动 / Esc / 右键仍立刻收）与**夹进视口**（用 `defineProperty` 钉住 `innerWidth/Height` 与 `offsetWidth/Height`、给 `.row-chapter` 装可控 `getBoundingClientRect`，验证下方够放就放下方、贴底翻上方、贴右收左、超长摘要压 `max-height` 而非溢出、内容后到达撑高后重新定位）。**⑦ 必须留在文件末尾**：悬停有半秒延迟只能等真定时器，整块是异步的，收尾与 `process.exit` 都在它的 `.then()` 里。 |
| [smoke-builder.js](smoke-builder.js) | 用真实文件系统的 vscode 桩跑完整上下文装配：优先级、预算、降级链、手动排除、附件截断、多轮历史封顶、discuss 模式、provider 配额压缩；另含工程页快照（含 `staleCount + summarizedCount === chapterCount`、`castByCard` 出场统计与未建卡清单）与**出场人物索引**（新旧两种摘要格式并存、别名归并、未建卡排序、`describeChapters` 折叠） |
| [smoke-fileops.js](smoke-fileops.js) | ★ 层级目录与类文件操作：递归扫描（含 `.trash/` 排除）、`ProjectTree` 折叠与每层内章节正序、路径越界守卫、新建文件夹/在文件夹内新建、重命名（保留序号前缀、H1 同步策略）、移动（跨区/自嵌套/同名拒绝）、删除（搬回收站、不覆盖）、挪动章节后摘要仍算新鲜；以及 `buildChapterSummaryView`（悬停浮窗的数据源）——只给非空小节、滤掉「（待补充）」占位、改正文后标过期、未总结/章节不存在时退化为空视图、作者删光小节标题时退回全文 |
| [smoke-projectFiles.js](smoke-projectFiles.js) | 工程根范围的类文件操作（独立版「文件」页）：重命名/移动/复制、固定目录保护、同名拒绝、垃圾箱豁免、章节联动（草稿跟随与 manifest 同步） |
| [smoke-chapters.js](smoke-chapters.js) | ★ 章节文件名规则与草稿。前半：任意非二进制扩展名 / 无扩展名算章节、二进制黑名单被挡、非 markdown 章节不解析 H1（正文中段的 `# xxx` 不当标题也不被剥）、`extractH1` 只看首行、角色区仍只认 `.md`、`isEditablePath` 放行无扩展名章节。后半：草稿路径镜像、按需创建且**第二次不覆盖**、`.md` 有模板 `.txt` 留空、不混进章节树与 manifest、`@` 引用只列已存在的草稿、跟随章节改名/移动（目标已有则拒绝）、删章节不删草稿 |
| [smoke-characterCard.js](smoke-characterCard.js) | ★ **更新角色卡**：假 provider（经 `registerProviderFactory` 注入，不碰 SecretStore）跑完整流程。分批（小窗口撑出多批）、确认框里写明「通读 N 章、分 M 批、预计调用 M 次」、只装该角色的出场章节、后续批次带上当前档案、提示词含控篇幅与「性格/语言习惯优先」；增量只读新章且没有新章时**一次模型都不调**；解析失败——部分失败仍写回成果但**水位线停在第一个失败章节之前**（越过去那几章就永久跳过了）、全部失败则一字不改并报错；用户取消/审阅放弃都不落盘；摘要里没出现的角色直接拒绝；给未建卡人物建卡（新卡带 `appearsIn`、不走 diff、建完离开未建卡列表）；**并发**——批量更新时模型请求确实重叠且不超过配置值，而 **diff 审阅仍一次只弹一张**，「预计调用 N 次」在并发下依然对得上账；**「全部建卡」**——确认框报清人数/章数/调用次数、取消时不留下空卡、并发建卡后全部离开未建卡列表 |
| [smoke-lore.js](smoke-lore.js) | ★ **自动生成设定**：逐章识别调用次数、同一设定的跨章合并、分类目录落盘，以及已有设定必须经过审阅后才更新 |
| [smoke-pool.js](smoke-pool.js) | ★ **并发与模型池**。`runPool`：并发峰值不超过 limit、结果按 index 对齐（完成顺序打乱也不影响）、单项失败不拖累其余、`limit=1` 严格串行、取消后不再起新任务且未启动的项占位为 `CancelledError`、`onSettled` 的计数单调不重复（进度条不会倒退）。`serialize`：同一时刻只跑一个、按入队顺序、前一个抛错不卡死后面的。模型池：并发轮转均摊到每个模型、串行恒用首选、首选失败后**换成别的**模型重试、同一模型不试两遍、重试不超过 `fallbackAttempts`、单模型池不重试、取消不 fallback、解析不出/构造不出的模型被剔除并留下 warn，且**剔除备选模型时不弹 API Key 输入框** |
| [smoke-logging.js](smoke-logging.js) | ★ 日志与长任务。日志：脱敏（`sk-`／`Bearer`／`api_key=`／JSON 里的 `x-api-key` 都被抹，普通文本不受影响，message 与 detail 两条路径都过）、环形缓冲上限与「丢最旧的」、sink 级别过滤只作用于 sink（缓冲始终收全量）、**坏 sink 不抛给调用方也不影响别的 sink**、sink 内部再打日志不炸栈、detail 超长截断带说明、耗时/单行格式化。长任务：进度快照字段、字符串 `report` 只改文案而 current/total 沿用、宿主进度带 `（n/N）`、取消（任务体看得到 aborted）、抛异常时继续上抛且进日志、并发两个任务、结束后一律清表 |
| [smoke-llm.js](smoke-llm.js) | 起本地假服务器模拟 SSE：流式解析（跨块切分、CRLF、心跳、非 JSON 行）、取消、超时、HTTP 401/404/429 错误信息，Anthropic 的 system 提取与消息合并 |
| [smoke-session.js](smoke-session.js) | 会话读写 round-trip、损坏文件容错、列表排序、重命名/删除、id 唯一性，`.novel` → `.novelforge` 迁移 |
| [smoke-server.js](smoke-server.js) | 独立版服务（需 Bun）：静态资源、WS 首条消息、`Origin` 校验，内置编辑器的消息往返——打开、保存落盘、过期 hash 触发冲突且不覆盖、强制保存、越界路径与非文本扩展名被拒、无扩展名章节可打开，`openDraft` 的按需创建与 `pane: 'draft'` 并列打开；以及资源管理器的 `listDir` → `dirListings` 往返——`.novelforge` 这类点开头的目录列得出来、目录排在文件前、`editable` 标注与 `fileEditing.ts` 一致、一次列多个目录、越界与不存在的目录降级成带 `error` 的空结果 |

另有两个非测试脚本：

| 脚本 | 用途 |
|---|---|
| [build-media.js](build-media.js) | 把 `media/src/` 下的前端源码（TS + CSS 片段）用 esbuild 打包成 `dist/media/` 的四个 `.js` 与两个 `.css`（IIFE，classic script；`dist/` 整个不入库）。`compile` / `watch` / `embed-media` / `typecheck` / `smoke` 前都会跑到。**加新产物**要在 `JS_ENTRIES` / `CSS_ENTRIES` 里加一条；在已有产物内部拆模块不必动它。 |
| [embed-media.js](embed-media.js) | 把前端资源 base64 内嵌成 `src/standalone/mediaAssets.ts`（生成文件，已 gitignore），供 `bun build --compile` 的单文件可执行使用。`.js` / `.css` 从 `dist/media/` 取（构建产物），`icon.svg` 从 `media/` 取（仓库静态文件）。会先跑一次 `build-media`，所以内嵌的永远不是过期产物。`typecheck` / `smoke` / `dist` 前会自动跑。**新增产物后要把它加进这里的 `built` 数组。** |
| [verify-css.js](verify-css.js) | 比对两份 CSS 是否等价：规则集合一条不多一条不少，且「同选择器 + 同属性」的相对顺序没被改变（那才影响层叠）。拆分或重排 `media/src/css/` 的片段后拿它对着旧产物验一遍。用法 `node scripts/verify-css.js <旧> <新>`。 |
| [check-core-purity.js](check-core-purity.js) | 断言 `src/core/` 里没有任何 `vscode` 依赖——双形态架构的硬约束。 |

## 技术要点

- 不用测试框架：每个脚本自带 `check(name, cond, detail)`，失败计数非零即非零退出码。
- 跑的是 **TypeScript 源码**：用 esbuild 把单个 TS 文件 bundle 成 CJS 后 `require`，并用 `Module._load` 打 `vscode` 模块桩。两个例外：`smoke-server.js` 由 Bun 直接跑 TS，`smoke-view.js` 跑的是浏览器侧的**构建产物** `dist/media/view.js` 等（源码在 `media/src/`，`presmoke` 会先构建；其余 smoke 都碰不到它们）。
- 数据目录用 `sample-novel/` 或临时目录，测试后自清理（对 `sample-novel` 只读——`smoke.js` 有 hash 断言，写入类用例一律另开临时工程）。
- **要用 Host 的模块得打进同一个 bundle**（见 `smoke-fileops.js` 的 `loadBundle`）：分开 bundle 会让每份产物各带一份 `host.ts` 的模块级状态，`initHost` 只作用于其中一份。交互（input/confirm/pick）用可编程的假宿主，按队列取答案。

改动 `src/core/` 后务必跑一遍 `npm run smoke`——这是 CI 之外唯一的回归防线。
