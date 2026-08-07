# scripts — 离线冒烟测试

十个不依赖 VS Code、也不需要真实 API Key 的测试脚本，`npm run smoke` 依次执行（末尾的 `smoke-server.js` 需要 bun），`npm test` = typecheck + core 纯度检查 + smoke。

| 脚本 | 覆盖范围 |
|---|---|
| [smoke.js](smoke.js) | Markdown 解析、tokenizer、模型输出清洗、摘要/角色 JSON 解析的容错，以及 `sample-novel/` 的 hash 一致性 |
| [smoke-providers.js](smoke-providers.js) | 模型引用解析（含嵌套斜杠 `openrouter/z-ai/glm-4.6`）、服务商配置容错、按模型覆盖窗口、0.1.x 单服务商配置兜底 |
| [smoke-view.js](smoke-view.js) | 用 jsdom 跑真正的 `media/view.js`（DOM 结构从 `webviewHtml.ts` 里抠出来，保证与真实渲染一致）：流式过程中逐段显示、生成中不可编辑、结束后可编辑，以及气泡右上角的 ... 菜单；工程页目录树——折叠/展开、缩进层级、空文件夹提示、重推后保持展开状态；以及右键菜单——各类行给出的菜单项（含按 `hasDraft` 切换的「打开草稿 / 新建草稿」）、点击后发出的消息负载（`fileAction`、带 `dir` 的 `projectAction`、`openDraft`）、行上不再有行内按钮、其它页面只给「刷新」、点空白/Esc 关闭。**未装 jsdom 时自行跳过**，不算失败。另有几节：① 摘要进度显示——横幅上的「已总结 N/M + 百分比 + 进度条」、同步进行中撤掉「立即同步」、全同步后横幅消失；② 长任务进度条——n/N、计时、不定量条、点「停止」发 `cancelTask`、任务清空后收起；③ 日志页——级别过滤、关键字过滤、detail 折叠、增量追加也走过滤、清空发 `clearLogs`；④ 独立版内置编辑器：用 `html.ts` 的 body 起 `media/editor.js`（插件形态没有 `#wbEditor`，那份 body 跑不到它），验证草稿区惰性创建、`pane` 分派、「草稿」按钮的可见性与 `openDraft` 负载、保存回执不冲掉 `draftPath`、同一路径只属于一块编辑区；⑤ 独立版资源管理器（`media/explorer.js`，同样要 `html.ts` 的 body）：点开头的目录列得出来且压暗、目录排在文件前、懒展开只请求展开的那些、折叠连带子目录、载入中占位、可编辑与否分别走 `openEditor` / `openExternal`、编辑器打开谁就高亮谁、截断如实告知、读失败降级成一行提示、右键复用 view.js 的菜单引擎；⑥ 章节摘要的悬停浮窗——延迟后才弹（划过时不闪、行内微动不重置延迟）、只对章节行、发 `requestSummary` 并先显示「读取中」、缓存命中不重复请求、收到新树后缓存作废、过期打标、未总结时给说明、滚动/Esc/右键都收起，以及摘要正文走 `textContent` 不当 HTML 解析。**⑥ 必须留在文件末尾**：悬停有半秒延迟只能等真定时器，整块是异步的，收尾与 `process.exit` 都在它的 `.then()` 里。 |
| [smoke-builder.js](smoke-builder.js) | 用真实文件系统的 vscode 桩跑完整上下文装配：优先级、预算、降级链、手动排除、附件截断、多轮历史封顶、discuss 模式、provider 配额压缩；另含工程页快照（含 `staleCount + summarizedCount === chapterCount`） |
| [smoke-fileops.js](smoke-fileops.js) | ★ 层级目录与类文件操作：递归扫描（含 `.trash/` 排除）、`ProjectTree` 折叠与每层内章节正序、路径越界守卫、新建文件夹/在文件夹内新建、重命名（保留序号前缀、H1 同步策略）、移动（跨区/自嵌套/同名拒绝）、删除（搬回收站、不覆盖）、挪动章节后摘要仍算新鲜；以及 `buildChapterSummaryView`（悬停浮窗的数据源）——只给非空小节、滤掉「（待补充）」占位、改正文后标过期、未总结/章节不存在时退化为空视图、作者删光小节标题时退回全文 |
| [smoke-chapters.js](smoke-chapters.js) | ★ 章节文件名规则与草稿。前半：任意非二进制扩展名 / 无扩展名算章节、二进制黑名单被挡、非 markdown 章节不解析 H1（正文中段的 `# xxx` 不当标题也不被剥）、`extractH1` 只看首行、角色区仍只认 `.md`、`isEditablePath` 放行无扩展名章节。后半：草稿路径镜像、按需创建且**第二次不覆盖**、`.md` 有模板 `.txt` 留空、不混进章节树与 manifest、`@` 引用只列已存在的草稿、跟随章节改名/移动（目标已有则拒绝）、删章节不删草稿 |
| [smoke-logging.js](smoke-logging.js) | ★ 日志与长任务。日志：脱敏（`sk-`／`Bearer`／`api_key=`／JSON 里的 `x-api-key` 都被抹，普通文本不受影响，message 与 detail 两条路径都过）、环形缓冲上限与「丢最旧的」、sink 级别过滤只作用于 sink（缓冲始终收全量）、**坏 sink 不抛给调用方也不影响别的 sink**、sink 内部再打日志不炸栈、detail 超长截断带说明、耗时/单行格式化。长任务：进度快照字段、字符串 `report` 只改文案而 current/total 沿用、宿主进度带 `（n/N）`、取消（任务体看得到 aborted）、抛异常时继续上抛且进日志、并发两个任务、结束后一律清表 |
| [smoke-llm.js](smoke-llm.js) | 起本地假服务器模拟 SSE：流式解析（跨块切分、CRLF、心跳、非 JSON 行）、取消、超时、HTTP 401/404/429 错误信息，Anthropic 的 system 提取与消息合并 |
| [smoke-session.js](smoke-session.js) | 会话读写 round-trip、损坏文件容错、列表排序、重命名/删除、id 唯一性，`.novel` → `.novelforge` 迁移 |
| [smoke-server.js](smoke-server.js) | 独立版服务（需 Bun）：静态资源、WS 首条消息、`Origin` 校验，内置编辑器的消息往返——打开、保存落盘、过期 hash 触发冲突且不覆盖、强制保存、越界路径与非文本扩展名被拒、无扩展名章节可打开，`openDraft` 的按需创建与 `pane: 'draft'` 并列打开；以及资源管理器的 `listDir` → `dirListings` 往返——`.novelforge` 这类点开头的目录列得出来、目录排在文件前、`editable` 标注与 `fileEditing.ts` 一致、一次列多个目录、越界与不存在的目录降级成带 `error` 的空结果 |

另有两个非测试脚本：

| 脚本 | 用途 |
|---|---|
| [embed-media.js](embed-media.js) | 把 `media/` 下的资源 base64 内嵌成 `src/standalone/mediaAssets.ts`（生成文件，已 gitignore），供 `bun build --compile` 的单文件可执行使用。`typecheck` / `smoke` / `dist` 前会自动跑。**在 `media/` 新增文件后要把它加进这里的 `files` 数组。** |
| [check-core-purity.js](check-core-purity.js) | 断言 `src/core/` 里没有任何 `vscode` 依赖——双形态架构的硬约束。 |

## 技术要点

- 不用测试框架：每个脚本自带 `check(name, cond, detail)`，失败计数非零即非零退出码。
- 跑的是 **TypeScript 源码**：用 esbuild 把单个 TS 文件 bundle 成 CJS 后 `require`，并用 `Module._load` 打 `vscode` 模块桩。两个例外：`smoke-server.js` 由 Bun 直接跑 TS，`smoke-view.js` 跑的是浏览器侧的 `media/view.js`（其余 smoke 都碰不到它）。
- 数据目录用 `sample-novel/` 或临时目录，测试后自清理（对 `sample-novel` 只读——`smoke.js` 有 hash 断言，写入类用例一律另开临时工程）。
- **要用 Host 的模块得打进同一个 bundle**（见 `smoke-fileops.js` 的 `loadBundle`）：分开 bundle 会让每份产物各带一份 `host.ts` 的模块级状态，`initHost` 只作用于其中一份。交互（input/confirm/pick）用可编程的假宿主，按队列取答案。

改动 `src/core/` 后务必跑一遍 `npm run smoke`——这是 CI 之外唯一的回归防线。
