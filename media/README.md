# media — 前端资源

面板的全部前端代码，两个形态共用。插件形态由 [../src/shells/vscode/webviewHtml.ts](../src/shells/vscode/webviewHtml.ts) 生成 HTML 加载（侧边栏 / 编辑器标签页），独立形态由 [../src/shells/standalone/page.ts](../src/shells/standalone/page.ts) 加载。两份页面的 pane 结构来自同一处：[../src/shells/shared/panes.ts](../src/shells/shared/panes.ts)。

## 仓库里只有源码，产物在 `dist/media/`

`media/` 下入库的只有 `src/`（TypeScript 与 CSS 片段）、`icon.svg` 与本文件。`view.js` / `editor.js` / `explorer.js` / `bridge.js` / `view.css` / `standalone.css` 由 [`../scripts/build-media.js`](../scripts/build-media.js) 生成到 **`dist/media/`**——和 `dist/extension.js` 同一个去处，整个 `dist/` 都不入库。

```
npm run media          # 构建一次（→ dist/media/）
npm run compile        # 连同扩展主体一起构建（F5 调试前跑这个）
npm run watch          # 监听重建
npm run typecheck      # 含 media/tsconfig.json，前端与协议对不上会报错
```

`embed-media.js`、`standalone`、`dist` 都会先跑一次构建，所以克隆下来直接 `npm run standalone` 不会撞上「找不到 view.js」。**没跑过构建就按 F5，webview 会 404 一片白**——两个宿主的 `localResourceRoots` 里现在有 `dist/media/`，那儿空着就什么都加载不到。

产物是 IIFE 格式的 classic script，不是 ES module：webview 的 CSP 用 nonce 放行脚本，而 nonce 不传递给 `import` 进来的模块——原生模块要么得开 `strict-dynamic`，要么就打包，这里选打包。顺带 jsdom 的 `window.eval` 也只吃得下 classic script。

独立版的 `/media/*` 是**路由名不是路径**：字节全部来自 `embed-media.js` 内嵌进 `mediaAssets.ts` 的表，URL 不必跟着产物目录改。

## 目录

| 路径 | 产物（在 `dist/media/`） | 加载于 | 职责 |
|---|---|---|---|
| `src/view/` | view.js | 两者 | 面板主体：渲染 `ViewState`、tabbar 切页、消息流、工程页、日志页、设置页、右键菜单 |
| `src/editor/` | editor.js | 仅独立版 | 内置文件编辑器：两块编辑区、多标签、乐观锁保存、Markdown 预览、主题与拖拽调宽 |
| `src/explorer/` | explorer.js | 仅独立版 | 侧栏「文件」页的资源管理器 |
| `src/bridge/` | bridge.js | 仅独立版 | 把 WebSocket 伪装成 webview API |
| `src/css/view/` | view.css | 两者 | 面板样式，全部走 `--vscode-*` 变量 |
| `src/css/standalone/` | standalone.css | 仅独立版 | 主题变量（深/浅两套）+ 工作台布局 |
| `src/protocol.ts` | — | — | 从 `core/protocol` 转出全部消息类型 |
| `src/globals.ts` | — | — | 三个产物之间的全部交集（就三样，见下） |
| `src/dom.ts` / `src/vscodeApi.ts` | — | — | 建 DOM 的小工具、取 webview API 与收消息 |
| [icon.svg](icon.svg) | —（静态文件，不经构建） | 两者 | 活动栏与编辑器标签页图标。`stroke="currentColor"`，跟随主题色 |

各子目录的划分：

- **`src/view/`** —— `refs`（页面上固定 id 的节点）、`store`（运行时状态与草稿存取）、`format` / `buttons` / `toast` / `menu`（通用件）、`tabs` / `state` / `messages` / `composer` / `history` / `tasks` / `logs` / `prompt`（各块）、`pipeline` / `workbench` / `commands`（创作页的三块：流水线条与下一步、当前产物卡、`/` 命令面板），外加 `project/`（工程页：`actions` `treeState` `rows` `groups` `summaryTip` `detailTip` `errorTip`）与 `settings/`（设置页：`presets` `draft` `fields` `modelList` `providerList` `providerModal`）两个子目录。`index.ts` 只做装配与消息分发。
- **`src/editor/`** —— `paneElements`（一块编辑区的类型与 DOM）、`pane`（工厂，两块编辑区是它的两个实例）、`store`（两块之间共享的状态与 localStorage）、`shell`（主题/拖拽/窄屏）、`preview` / `clipboard` / `words`。
- **`src/explorer/`** —— `state`（展开集合、剪贴板、高亮）、`actions`（发消息）、`rows`（建行与菜单）。

## 类型是真的会被检查的

`src/protocol.ts` 用 `import type` 直接从 [../src/core/protocol/](../src/core/protocol/index.ts) 转出 `InMessage` / `OutMessage` 等全部类型（只有类型跨过这条边界，一行运行时代码都不会被打包进来）。**改协议后端加了字段、改了名字，前端对不上会直接编译不过**——这以前只是一句「记得同时改 view.js」的注释约定。

`media/tsconfig.json` 是独立的一份（`lib` 带 DOM，`moduleResolution: Bundler`），`npm run typecheck` 会连它一起跑。

## 关键约定

- **前端无状态**：一切数据来自 `ViewState` / `ProjectTree` 全量推送，前端只保留 UI 状态（草稿、展开/折叠、正在编辑的回复）。webview 销毁重建后一条 `ready` 就能完整恢复。
- **进度与日志各有一条推送路径**：长任务用 `tasks`（**全量替换**，列表最多两三项，增量协议不值得），日志用 `log`（增量一条）+ `logs`（全量，切到日志页或清空后）+ `logHistory`（**只有点「加载更早」才发**，那是唯一会查工程库的路径，默认进日志页零开销）。两者都在 `resendFullState` 里补推，刷新页面时正在跑的任务不会凭空消失。
  - **计时由前端自己走**（`view/tasks.ts`）：后端只在有进度时才推快照，一次模型调用能安静一分钟，那期间计时停住会让人以为卡死。收到快照时记下 `Date.now() - elapsedMs` 当基线，之后每秒**只改计时文本**——重建 DOM 会打断「停止」按钮上的点击。
  - **日志增量不重画整表**（`view/logs.ts`）：长任务每秒好几条，重画会让滚动位置乱跳。只在原本就贴着底时才跟着滚，用户翻上去看东西时不该被拽回来。
- **工程页的树是扁平渲染的**（`view/project/rows.ts`）：`renderNodes` 递归遍历 `ProjectNode`，但产出的是**扁平的行数组**，层级靠 `paddingLeft` 缩进表达而非嵌套 DOM。折叠状态存在 `project/treeState.ts` 的 `openFolders`（relPath 集合）与 `openGroups` 里；切换折叠只用最近一次收到的树重画（`rerenderProject`），不往后端要数据。文件夹默认折叠，四个顶层分组默认展开。
- **摘要浮窗按需取、事件委托**（`view/project/summaryTip.ts`）：鼠标停在章节行上约半秒后弹出该章摘要。摘要正文**不在** `ProjectTree` 里（那棵树每次文件变动都全量重推，塞进去等于每保存一次就推几百 KB），悬停时发 `requestSummary{order}` 单章去要。**缓存只在收到 `project` 消息时清**——那说明磁盘变过；折叠文件夹走 `rerenderProject()` 不经那条分支，缓存留着。监听用事件委托挂在 `#projectBody` 上（行每次重渲染都换掉，逐行 `addEventListener` 会堆积），浮窗与右键菜单同样是挂在 `body` 上的 `position: fixed`。
  - **浮窗是可以进去的**：摘要有六个小节、可能上千字，一瞥看不完。鼠标移上去就一直留着，能滚动、能选中复制，移开才收。所以**不能**给它 `pointer-events: none`，收起也**必须有宽限期**（`CLOSE_DELAY_MS`）——从行挪到浮窗要跨过一道缝，那一两帧鼠标既不在行上也不在浮窗上，立刻收会让浮窗永远够不着。
  - **收起要分清是谁在滚**：页面滚动会让 fixed 的浮窗和目标行脱节，得收；但**浮窗自己内部的滚动不算**，一滚就收等于那个滚动条形同虚设。捕获阶段的 `scroll` 监听里用 `hoverTip.box.contains(e.target)` 区分。Esc 与右键仍然立刻收（右键菜单也是 fixed，会叠在一起）。
  - **定位必须夹进视口**：`place()` 横向左对齐目标行、右边溢出往左收；纵向优先放下方，放不下翻上方，**两边都放不下时选空间大的一侧并压行内 `max-height`**——只翻转不压高度的话，一份长摘要在矮窗口里会有一截永远够不到。量高度前要先清掉上一次的 `maxHeight`，否则会一直沿用之前那个更矮的值；内容后到达（`applySummary`）把浮窗撑高后要重新走一次定位。
- **三只浮窗，各有取舍**（`view/project/` 下的 `summaryTip` / `detailTip` / `errorTip`）：定位算法与事件委托是同一套（挂 `body`、`position: fixed`、委托在 `#projectBody` 上），区别只在**要不要让鼠标进去**。`detailTip` 只复读一行被截断的副标题，`pointer-events: none` 收起不留宽限；`summaryTip` 与 `errorTip` 的内容是多行、要能滚动与选中复制，所以必须留宽限期。`errorTip` 还有一点不同：**数据不必向后端单取**——失败记录随 `ProjectTree.failures` 一起推来了（一条几十字，且只有出错的目标才有），直接读 `treeState.lastTree` 即可。
- **失败标记是「解析失败只有日志、用户看不见」的界面出口**（`view/project/rows.ts` 的 `failureMark`）：出错的行在文件名之前插一个感叹号，红色 = 整体失败、目标一字未改，黄色 = 部分完成、下次会重来；同一目标混着两种时**按最严重的算**。感叹号还带原生 `title` 兜底（浮窗要等 300ms）。旧后端推来的树没有 `failures` 字段，`lastTree?.failures?.[relPath]` 的可选链是有意的，别把它简化掉。
- **一套菜单引擎、两个入口**（`view/menu.ts`）：`buildMenuElement(items, className)` 由 `{ label, run, danger, disabled }`（`{ sep: true }` 是分隔线）建出菜单 DOM。气泡右上角的 ⋯ 用 `.msg-menu` 绝对定位贴在 `.msg-head` 里；右键用 `.ctx-menu` 挂到 `body` 上 `position: fixed` 跟着光标走（工程页有内部滚动，挂在容器里会被裁掉），贴边时翻转。同时只有一个菜单，点别处 / Esc / 滚动都收起。
- **创作页只推荐一个动作，其余走 `/`**（`view/pipeline.ts` + `view/commands.ts`）：主按钮来自后端状态机算出的 `next`，**点了就跑**，输入框可留空——「生成细纲」本来就不需要作者再说什么。其余六个命令收在 `/` 面板里，挑中变成输入框里的一枚待执行 chip，用完即清。命令表来自 core 的 `commandsFor`（零 import 的纯函数，前端直接打包），**前端不自己维护一份**——否则界面上会出现后端不认的命令，点了什么都不发生。
  - **`/` 就是输入框里的一个普通字符**，面板只是浮在它上方的候选列表（挂在 `#composerInput` 上，`bottom: 100%`）。从前 `/` 由 keydown 拦下来**不落进输入框**，过滤串自己攒在模块变量里——那等于在输入框旁边又造了一个隐形的输入框：光标在哪、退格退的是谁全靠猜，**输入法打的中文一个都收不到**（composition 期间不发可打印键的 keydown）。现在过滤串由 `slashQuery()` 从输入框的值算出来，面板的开合挂在 `input` 事件上（不是 keydown），中文/退格/粘贴/Ctrl+A 全都自动对。键盘只接管 ↑↓ / Enter·Tab / Esc，可打印字符一律放行。
  - **判据是「整个输入框只有一个 `/词`」**（`/^\/(\S*)$/`）：`/` 在中文正文里是普通字符（日期、比值、网址），`子时 3/4 刻` 与 `/ 这是一句话` 都不该弹面板。这条判据同时管着「要不要开面板」与「挑中后要不要把那几个字从输入框里抹掉」，所以只写一次。
  - **Esc 关过要记一笔**（`dismissed`）：输入框里那个 `/` 还在（那是用户的字，不替他删），而面板是由输入框的值驱动的——不记的话下一次按键又把它弹出来。删掉 `/` 或往后打出别的形状时这一笔自动清掉。
- **命令类消息的气泡不能是空的**（`view/messages.ts` 的 `fillUserBody`）：`needsText` 为 false 的命令（生成细纲、拆成场景）作者一个字都不必打，于是 user 轮的 `content` 是空串。气泡里画一枚 `/生成细纲` 标签（数据来自 `SerializedTurn.command`，后端记的是**按阶段具体化过的标签**），有补充要求就跟在下面。**命令名不写进 `content`**——那句话会被当成作者的要求装进 prompt，与旧界面逼他手打一句「请生成细纲」是同一个毛病。assistant 那一支**刻意保持成纯文本节点**：流式增量走 `body.textContent += delta`，里面有子元素的话第一片增量就会把它们冲掉。
- **工作区卡钉在消息流里**（`view/workbench.ts`）：`position: sticky` 而不是独立一块——侧边栏分不出两栏，做成常驻会把消息流压扁。代价是 `renderSession` 清空 `#messages` 后必须把卡片节点**放回去**（与 `emptyHint` 同一套路：节点常驻、引用不变，只是重新挂载）。
- **右键菜单靠 WeakMap 登记**：构建某一行时用 `onContextMenu(row, () => items)` 把「这行右键给什么」记在元素上（那一刻上下文最全，不用右键时反查最近那棵树；行被重渲染丢弃后自动回收）。全局 `contextmenu` 监听从 `e.target` 向上找第一个登记过的祖先，找不到就用兜底的「刷新」。**刷新复用已有的 `projectAction: 'refresh'`**——后端那个分支只是 `pushState()`，会按当前页签推数据，天然适用于所有页面，无需新增协议。
- **右键一律接管**：全局监听里无条件 `preventDefault()`，输入框 / 文本域 / 内置编辑器里也一样，所以**原生的复制/粘贴/剪切菜单不会出现**。这是有意的取舍（菜单风格统一），代价是这几处的编辑项要自己实现（编辑器正文区与文件页已经做了，见 `editor/clipboard.ts` 与 `explorer/rows.ts`；输入框里目前只有「刷新」）。插件形态另需 [../src/shells/vscode/webviewHtml.ts](../src/shells/vscode/webviewHtml.ts) 的 `<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>`：VS Code 给 webview 右键菜单加的复制/粘贴项由宿主渲染，JS 的 `preventDefault` 压不住，不加会同时冒出两层菜单。
- **DOM 结构只有一份**：工程页工具栏等结构在 [../src/shells/shared/panes.ts](../src/shells/shared/panes.ts)，两个壳都从那里取，**加按钮只改那一处**。（从前两个壳各存一份，这条规矩是「要同时改两处」；现在前提没了。）两处例外：一是工作台外壳与编辑器容器只在独立版的 `page.ts` 里——那是布局，本该按宿主分叉；二是草稿那块编辑区的 DOM 由 `editor/paneElements.ts` 的 `createPaneElements()` 克隆主区结构现造，`page.ts` 里只有容器 `#wbEditors` 与分隔条 `#wbDraftResizer`。
- **宿主差异用能力探测，不判断环境**：只有 VS Code 有原生设置界面，所以「在 VS Code 设置中打开」这颗按钮**在独立版的页面里根本不存在**（`settingsPane({ nativeSettings })`），前端用 `maybeById` 取不到就跳过。别改回「渲染出来再 hidden 掉」或「看 state 里的某个环境位」——那条路走过，界面文案会跟着腐烂（见 [../src/shells/README.md](../src/shells/README.md)）。
- **CSP**：webview 的 CSP 只允许本地资源与 nonce 脚本，不引任何 CDN / 外部脚本。独立版同样不引外部资源。
- **两形态隔离**：`standalone.css` 与 `editor.js` / `explorer.js` **只**由独立版加载，插件的 `webviewHtml.ts` 里没有它们，也没有 `#wbEditor` / `#filesBody` 容器。给独立版加样式请只改 `src/css/standalone/`（必要时用 `.workbench` 前缀覆盖 view 的规则），不要为独立版去动 `src/css/view/`。
- **能力探测而非环境判断**：`view/store.ts` 里用 `document.getElementById('wbEditor')` 判断有没有内置编辑器，据此决定「打开文件」发 `openEditor` 还是 `openFile`；`editor/index.ts` 与 `explorer/index.ts` 各自开头探测自己那块容器（`#wbEditor` / `#filesBody`），不在就直接 return（连 `acquireVsCodeApi()` 都不调——webview 里那个函数只允许调一次）。插件里没有这些容器，行为不变。
- **跨文件只经三样东西**（全在 `src/globals.ts`）：`window.__nfToast`（view 出，editor / explorer 用）、`window.__nfContextMenu`（view 出的右键菜单登记函数）、两个自定义事件 `nf-editor-active`（editor → explorer，高亮当前文件）与 `nf-files-moved`（explorer → editor，改名后搬标签）。别让 explorer 直接读 editor 的 `panes`——那会把编辑器的内部状态变成两个文件之间的契约，而资源管理器在插件形态里根本不存在。右键菜单尤其**不能各起一套**：全局 `contextmenu` 监听在 view 里，另起一个会两层菜单一起弹。
- **不拼 HTML 字符串渲染用户内容**：一律 `createElement` + `textContent`（`src/dom.ts` 的 `el()` 就是干这个的），正文里写 `<script>` 也只是普通文字。
- **一排控件共用一套尺寸，主按钮靠颜色跳出来**（`css/view/buttons.css` 的 `--nf-ctl-height` / `--nf-ctl-padding-x` / `--nf-ctl-radius`）：`.primary` / `.secondary` / `.danger` / `.chip-btn` / `.composer-tool` 与 composer、日志页工具栏里的下拉框、数字框同高。从前主次按钮是 `5px 12px` + 13px 字号，在一排 0.8em 的小控件中间粗一号——「生成细纲」「保存」「发送」于是成了三块各占一角的色斑。要改高度只动那三个变量。
  - **尺寸挂在变体类上，不挂在裸 `button` 上**：页面上大半的 `button` 不是「一排控件里的一颗」——菜单项、页签、标签页的关闭叉、chip 上的 ×、命令面板的每一项、流水线条上的层与场景，各有各的高度。`min-height` 写在裸 `button` 上会把它们全拽到 24px（`min-height` 压得过它们自己的 `height`，而它们都没声明 min-height 来挡）。裸 `button` 只留字体、光标、圆角这类人人都要的。
  - **`forms.css` 的 `width: 100%` 要在工具栏里收回来**：那条规则是给设置页那种「一列一个字段」定的；工具栏一行摆好几颗控件，不写 `width: auto` 的话下拉框会独占一整行，把后面的按钮挤到第二行（日志页曾是这样）。
- **预览与等宽字体是两件事**：章节可以是 `.txt` / 无扩展名，那时没有 Markdown 可预览（隐藏「预览」按钮），但它仍是正文，该用正文字体；只有 `.json` / `.yml` 这类结构化文件才加 `.mono`。
- **两处 `countWords` 口径不同，别合并**：`editor/words.ts` 的与 core 一致（中文按字、英文按词），状态栏上的字数要与工程页上后端算的对得上；`view/format.ts` 的统计模型回复长度（去空白后的字符数），是另一件事。

## 内置编辑器的行为约束

对应「不静默覆盖」这条产品承诺（见 [../AGENTS.md](../AGENTS.md)）：

- 保存带**内容 hash 乐观锁**。磁盘上的 hash 与编辑器基线不一致（作者在别处改过、或插件写入过）时保存被拒，前端弹冲突条，由用户在「用磁盘版本覆盖编辑器」和「用编辑器内容强制保存」之间选。
- 只有用户明确点了「强制保存」，才会发不带 `baseHash` 的 `saveFile`。
- 刷新页面后恢复未保存草稿时，同样比对 hash：磁盘变过就丢弃草稿并提示，不拿旧草稿盖新内容。
- 关闭有未保存修改的标签页、以及带未保存内容离开页面，都会先问一句。

## 两块编辑区

- `createPane(id, refs, post)`（`editor/pane.ts`）是工厂，两块编辑区是它的两个实例，各自持有 `files` / `conflicts` / `activePath` / 预览开关。主区绑页面上固定 id 的节点，草稿区在首次收到 `editorOpen{pane:'draft'}` 时惰性创建。
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

## 测试

- [`../tests/dom/`](../tests/dom/) 用 jsdom 跑**构建产物**（`dist/media/*.js`，不是源码），从两个 html 模板里抠 body 保证结构与真实渲染一致，按页面分成十个文件：消息流、创作页、工程页、角色出场、进度、日志页、设置页、悬停浮窗、两块编辑区、资源管理器。改了 `media/src/**` 先 `npm run media` 再跑它，否则测的是上一次的产物（`npm run test:dom` / `npm test` 会自动先构建）。
- [`../scripts/verify-css.js`](../scripts/verify-css.js) 比对两份 CSS 是否等价：规则集合一条不多一条不少，且「同选择器 + 同属性」的相对顺序没被改变。拆分或重排样式片段后可以拿它对着旧产物验一遍。

## 新增产物

加一个新的 `.js` / `.css` 产物要四处同改（比改造前多一处，就是第一步）：

1. `media/src/<名字>/index.ts`（或 `src/css/<名字>.css`）放源码；
2. [`../scripts/build-media.js`](../scripts/build-media.js) 的 `JS_ENTRIES` / `CSS_ENTRIES` 加一条；
3. [`../scripts/embed-media.js`](../scripts/embed-media.js) 的 `built` 数组加一条——漏了这步，`bun build --compile` 出的单文件会 404；
4. 页面里引用：独立版 `standalone/page.ts`，需要时插件 `vscode/webviewHtml.ts`。

**在已有产物内部拆模块不用改任何配置**，直接 import 即可——这正是这次改造要换来的东西。
