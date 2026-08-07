# media — 前端资源

面板的全部前端代码，两个形态共用。插件形态由 [../src/vscode/webviewHtml.ts](../src/vscode/webviewHtml.ts) 生成 HTML 加载（侧边栏 / 编辑器标签页），独立形态由 [../src/standalone/html.ts](../src/standalone/html.ts) 加载。

| 文件 | 加载于 | 职责 |
|---|---|---|
| [view.js](view.js) | 两者 | 前端逻辑（原生 JS，无框架）：渲染 `ViewState`、tabbar 切页、流式文本追加、回复就地编辑、上下文明细折叠展示、@ 引用标签、工程页的多层目录树、长任务进度条、日志页、右键菜单、设置页表单。顶部取 `acquireVsCodeApi()` 后以 `postMessage` 发 `InMessage`、监听 `message` 收 `OutMessage`，加载完自报 `{ type: 'ready' }`。 |
| [view.css](view.css) | 两者 | 面板样式，全部走 `--vscode-*` 变量。**不写死颜色**——插件里这些变量由 VS Code 注入，独立版由 standalone.css 提供。 |
| [icon.svg](icon.svg) | 两者 | 活动栏与编辑器标签页图标。`stroke="currentColor"`，跟随主题色。 |
| [bridge.js](bridge.js) | 仅独立版 | 把 WebSocket 伪装成 webview API：`postMessage` / `message` 事件 / `getState`+`setState`（落 localStorage）。检测到 `acquireVsCodeApi` 已存在（即在 webview 里）就直接退出。断线时插入重连提示条。 |
| [standalone.css](standalone.css) | 仅独立版 | ① 补齐 view.css 依赖的全部 `--vscode-*` 变量（深/浅两套，对齐 VS Code Dark/Light Modern）；② 把单列页面重排为工作台：标题栏 + 竖排活动栏 + 侧栏 + 编辑区（可并列两块）+ 拖拽分隔条，并含窄屏（≤900px）适配。 |
| [editor.js](editor.js) | 仅独立版 | 内置文件编辑器：**两块编辑区**（正文 / 草稿并列），每块各有多标签、脏标记、`Ctrl+S` 保存、还原、冲突取舍、字数/行列状态栏、Markdown 预览；另含主题切换、两条分隔条的宽度拖拽、刷新后恢复未保存草稿。切换/关闭标签页时广播 `nf-editor-active` 事件，资源管理器据此高亮。 |
| [explorer.js](explorer.js) | 仅独立版 | 侧栏「文件」页的资源管理器：磁盘目录的原样结构（**含 `.novelforge/` 等点开头的文件夹**），按目录懒展开、折叠状态存 localStorage、当前编辑的文件高亮、点文件开进内置编辑器。数据走 `listDir` / `dirListings`。 |

## 关键约定

- **前端无状态**：一切数据来自 `ViewState` / `ProjectTree` 全量推送，前端只保留 UI 状态（草稿、展开/折叠、正在编辑的回复）。webview 销毁重建后一条 `ready` 就能完整恢复。
- **进度与日志各有一条推送路径**：长任务用 `tasks`（**全量替换**，列表最多两三项，增量协议不值得），日志用 `log`（增量一条）+ `logs`（全量，切到日志页或清空后）。两者都在 `resendFullState` 里补推，刷新页面时正在跑的任务不会凭空消失。
  - **计时由前端自己走**：后端只在有进度时才推快照，一次模型调用能安静一分钟，那期间计时停住会让人以为卡死。收到快照时记下 `Date.now() - elapsedMs` 当基线，之后每秒**只改计时文本**——重建 DOM 会打断「停止」按钮上的点击。
  - **日志增量不重画整表**：长任务每秒好几条，重画会让滚动位置乱跳。只在原本就贴着底时才跟着滚，用户翻上去看东西时不该被拽回来。
- **工程页的树是扁平渲染的**：`renderNodes` 递归遍历 `ProjectNode`，但产出的是**扁平的行数组**，层级靠 `paddingLeft` 缩进表达而非嵌套 DOM。折叠状态存在模块级的 `openFolders`（relPath 集合）与 `openGroups` 里；切换折叠只用最近一次收到的树重画（`rerenderProject`），不往后端要数据。文件夹默认折叠，四个顶层分组默认展开。
- **摘要浮窗按需取、事件委托**：鼠标停在章节行上约半秒后弹出该章摘要。摘要正文**不在** `ProjectTree` 里（那棵树每次文件变动都全量重推，塞进去等于每保存一次就推几百 KB），悬停时发 `requestSummary{order}` 单章去要，回来的 `summary` 进 `summaryCache`。**缓存只在收到 `project` 消息时清**——那说明磁盘变过；折叠文件夹走 `rerenderProject()` 不经那条分支，缓存留着。监听用事件委托挂在 `#projectBody` 上（行每次重渲染都换掉，逐行 `addEventListener` 会堆积），浮窗与右键菜单同样是挂在 `body` 上的 `position: fixed`。
  - **浮窗是可以进去的**：摘要有六个小节、可能上千字，一瞥看不完。鼠标移上去就一直留着，能滚动、能选中复制，移开才收。所以**不能**给它 `pointer-events: none`，收起也**必须有宽限期**（`CLOSE_DELAY_MS`）——从行挪到浮窗要跨过一道缝，那一两帧鼠标既不在行上也不在浮窗上，立刻收会让浮窗永远够不着。进浮窗（`mouseenter`）撤销待执行的收起，出浮窗重新排一次。
  - **收起要分清是谁在滚**：页面滚动会让 fixed 的浮窗和目标行脱节，得收；但**浮窗自己内部的滚动不算**，一滚就收等于那个滚动条形同虚设。捕获阶段的 `scroll` 监听里用 `hoverTip.box.contains(e.target)` 区分。Esc 与右键仍然立刻收（右键菜单也是 fixed，会叠在一起）。
  - **定位必须夹进视口**：`placeSummaryTip` 横向左对齐目标行、右边溢出往左收；纵向优先放下方，放不下翻上方，**两边都放不下时选空间大的一侧并压行内 `max-height`**——只翻转不压高度的话，一份长摘要在矮窗口里会有一截永远够不到。量高度前要先清掉上一次的 `maxHeight`，否则会一直沿用之前那个更矮的值；内容后到达（`applySummary`）把浮窗撑高后要重新走一次定位。
- **一套菜单引擎、两个入口**：`buildMenuElement(items, className)` 由 `{ label, run, danger, disabled }`（`{ sep: true }` 是分隔线）建出菜单 DOM。气泡右上角的 ⋯ 用 `.msg-menu` 绝对定位贴在 `.msg-head` 里；右键用 `.ctx-menu` 挂到 `body` 上 `position: fixed` 跟着光标走（工程页有内部滚动，挂在容器里会被裁掉），贴边时翻转。`openMenu` 保证同时只有一个，点别处 / Esc / 滚动都收起。
- **右键菜单靠 WeakMap 登记**：构建某一行时用 `onContextMenu(row, () => items)` 把「这行右键给什么」记在元素上（那一刻上下文最全，不用右键时反查 `lastTree`；行被重渲染丢弃后自动回收）。全局 `contextmenu` 监听从 `e.target` 向上找第一个登记过的祖先，找不到就用兜底的「刷新」。**刷新复用已有的 `projectAction: 'refresh'`**——后端那个分支只是 `pushState()`，会按当前页签推数据，天然适用于所有页面，无需新增协议。
- **右键一律接管**：全局监听里无条件 `preventDefault()`，输入框 / 文本域 / 内置编辑器里也一样，所以**原生的复制/粘贴/剪切菜单不会出现**。这是有意的取舍（菜单风格统一），代价是这几处的编辑项要自己实现——目前还没做，那里只有「刷新」。插件形态另需 [../src/vscode/webviewHtml.ts](../src/vscode/webviewHtml.ts) 的 `<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>`：VS Code 给 webview 右键菜单加的复制/粘贴项由宿主渲染，JS 的 `preventDefault` 压不住，不加会同时冒出两层菜单。
- **消息契约**：收发的消息类型与 [../src/core/protocol.ts](../src/core/protocol.ts) 一一对应。改协议要同时改这里；`smoke-server.js` 覆盖了编辑器的消息往返，其余前端逻辑需手动验证。
- **DOM 结构两处同源**：工程页工具栏等结构在 [../src/vscode/webviewHtml.ts](../src/vscode/webviewHtml.ts) 与 [../src/standalone/html.ts](../src/standalone/html.ts) 各有一份，加按钮要同时改两处。草稿那块编辑区是例外——它的 DOM 由 `editor.js` 的 `createPaneElements()` 克隆主区结构现造，`html.ts` 里只有容器 `#wbEditors` 与分隔条 `#wbDraftResizer`，免得同一套四十行结构要在两个地方对齐。
- **CSP**：webview 的 CSP 只允许本地资源与 nonce 脚本，不引任何 CDN / 外部脚本。独立版同样不引外部资源。
- **两形态隔离**：`standalone.css` 与 `editor.js` / `explorer.js` **只**由独立版加载，插件的 `webviewHtml.ts` 里没有它们，也没有 `#wbEditor` / `#filesBody` 容器。给独立版加样式请只改 `standalone.css`（必要时用 `.workbench` 前缀覆盖 view.css），不要为独立版去动 view.css。
- **能力探测而非环境判断**：`view.js` 里用 `document.getElementById('wbEditor')` 判断有没有内置编辑器，据此决定「打开文件」发 `openEditor` 还是 `openFile`；`editor.js` / `explorer.js` 各自开头探测自己那块容器（`#wbEditor` / `#filesBody`），不在就直接 return。插件里没有这些容器，行为不变。
- **跨文件只经三个全局**：`window.__nfToast`（view.js 出，editor.js / explorer.js 用）、`window.__nfContextMenu`（view.js 出的右键菜单登记函数）、`nf-editor-active` 事件（editor.js 出，explorer.js 用）。别让 explorer.js 直接读 editor.js 的 `panes`——那会把编辑器的内部状态变成两个文件之间的契约，而资源管理器在插件形态里根本不存在。右键菜单尤其**不能各起一套**：全局 `contextmenu` 监听在 view.js 里，另起一个会两层菜单一起弹。
- **不拼 HTML 字符串渲染用户内容**：Markdown 预览全部走 `createElement` + `textContent`，正文里写 `<script>` 也只是普通文字。
- **预览与等宽字体是两件事**：章节可以是 `.txt` / 无扩展名，那时没有 Markdown 可预览（隐藏「预览」按钮），但它仍是正文，该用正文字体；只有 `.json` / `.yml` 这类结构化文件才加 `.mono`。

## 内置编辑器的行为约束

对应「不静默覆盖」这条产品承诺（见 [../AGENTS.md](../AGENTS.md)）：

- 保存带**内容 hash 乐观锁**。磁盘上的 hash 与编辑器基线不一致（作者在别处改过、或插件写入过）时保存被拒，前端弹冲突条，由用户在「用磁盘版本覆盖编辑器」和「用编辑器内容强制保存」之间选。
- 只有用户明确点了「强制保存」，才会发不带 `baseHash` 的 `saveFile`。
- 刷新页面后恢复未保存草稿时，同样比对 hash：磁盘变过就丢弃草稿并提示，不拿旧草稿盖新内容。
- 关闭有未保存修改的标签页、以及带未保存内容离开页面，都会先问一句。

## 两块编辑区

- `createPane(id, refs)` 是工厂，两块编辑区是它的两个实例，各自持有 `files` / `conflicts` / `activePath` / `previewMode`。主区绑页面上固定 id 的节点，草稿区在首次收到 `editorOpen{pane:'draft'}` 时惰性创建。
- **一个路径同一时刻只属于一块**。`editorSaved` / `editorConflict` / `editorError` 都只带 `path`，靠这条不变量才认得出该送给谁（`paneOwning`）。因此收到 `editorOpen` 时会先让另一块 `closeSilently` 掉同路径，未保存内容一并搬过来——不是关闭，是搬家。破坏这条会导致从错的那块保存时用错 `baseHash`，触发假冲突。
- `activePane` 靠两块根元素上的 `focusin` / `pointerdown` 跟踪，`Ctrl+S` / `Ctrl+W` 作用于它，`beforeunload` 则扫两块。
- 「草稿」按钮的可见性由后端给的 `file.draftPath` 决定，前端不自己判断什么算章节。点它发 `openDraft{path}`，**传的是章节路径**，草稿路径由后端推导并按需创建。
- localStorage 的 `novelforge.editor.v1` 从 `{ open, active }` 升为 `{ v: 2, panes: { main, draft }, activePane }`；`restore()` 兼容旧形状（认得 `saved.open` 就当主区），老用户的标签页不会在升级后消失。
- `activePane` 每次易主都要跟一句 `announceActive()`（`activate` / `upsertFile` / 两块之间的 `focusin`·`pointerdown` 切换、`dropFile` 关掉当前标签），资源管理器的高亮才不会停在上一个文件上。`upsertFile` 末尾那句读的是 `activePane`，所以 `editorOpen` 分支必须**先**认下目标块再 `upsertFile`。

## 资源管理器（「文件」页）

- **与「工程」页是两件事**：工程页是按语义整理过的视图（章节按序号倒序、摘要新鲜度、角色别名），只看得见三个可管理区里的文件；这一页是磁盘上真实的目录结构，一个都不藏。`.novelforge/` 里的摘要、会话、`project.json` 只有这里进得去——这就是它存在的理由，别为了「干净」把点开头的目录过滤掉（`fileTree.ts` 的 `HIDDEN_DIR_NAMES` 只挡 `node_modules` 与 `.git`）。
- **懒加载，按目录**：展开哪个目录才列哪个。每次展开/折叠都把**当前展开着的全部目录**发给后端（`listDir{dirs}`），不是增量——折叠因此不必再发一条撤销消息，后端也据此记住该关注哪些目录，工程有变动时原样重推。
- **先 `requestDirs()` 再 `render()`**：请求那一步会把还没数据的目录记进 `pending`，顺序反了刚展开的那一层会显示「（未载入）」而不是「载入中…」。
- **能不能编辑由后端算**（`FsEntry.editable`，与 `fileEditing.ts` 同一份规则）。前端不复刻扩展名白名单，也就不会去撞一个必然失败的 `openEditor`——不可编辑的文件点击直接走 `openExternal`。
- **树是扁平渲染的**，与工程页同一套取舍：层级靠 `paddingLeft` 缩进表达，折叠只是重画一遍。展开集合存 localStorage 的 `novelforge.files.open`。
- **截断要说出来**：目录条目超过上限时后端给 `truncated`（真实总数），树尾多一行「另有 N 项未列出」。
