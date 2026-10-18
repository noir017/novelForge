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
| `src/editor/` | editor.js | 仅独立版 | 内置文件编辑器：两块编辑区、多标签、乐观锁保存、磁盘上的改动同步到已开的标签、关标签时问「保存 / 不保存 / 取消」、保存状态与自动保存、冲突时对比合并、历史版本面板、自己管的撤销 / 重做、Tab 缩进、回车按分段格式另起一段、成对符号、段落快捷键、一键排版、查找替换（画在高亮镜像层上）、Markdown 预览、主题与拖拽调宽 |
| `src/explorer/` | explorer.js | 仅独立版 | 侧栏「文件」页的资源管理器 |
| `src/bridge/` | bridge.js | 仅独立版 | 把 WebSocket 伪装成 webview API |
| `src/css/view/` | view.css | 两者 | 面板样式，全部走 `--vscode-*` 变量 |
| `src/css/standalone/` | standalone.css | 仅独立版 | 主题变量（深/浅两套）+ 工作台布局 |
| `src/protocol.ts` | — | — | 从 `core/protocol` 转出全部消息类型 |
| `src/globals.ts` | — | — | 三个产物之间的交集（toast、右键菜单、自定义事件） |
| `src/dom.ts` / `src/vscodeApi.ts` | — | — | 建 DOM 的小工具、取 webview API 与收消息 |
| [icon.svg](icon.svg) | —（静态文件，不经构建） | 两者 | 活动栏与编辑器标签页图标。`stroke="currentColor"`，跟随主题色 |

各子目录的划分：

- **`src/view/`** —— `refs`（页面上固定 id 的节点）、`store`（运行时状态与草稿存取）、`format` / `buttons` / `toast` / `menu` / `menubar` / `welcome` / `folderPicker` / `tip`（通用件；`menubar` / `welcome` / `folderPicker` 探测不到 `#wbMenubar` 就 return，插件不受影响）、`paragraphMenu`（标题栏「编辑」菜单里段落那一组：段落格式 ▸、成对符号开关、一键排版、半角标点转全角——经 `MenuEntry.run` 接进 `menubar`，不往它的 `run` 分支表里加）、`versionsMenu`（「文件」菜单「另存为…」后面那一项「历史版本…」，同一个做法；置灰时原因挂在 `MenuEntry.detail` 的提示上）、`tabs` / `state` / `messages` / `composer` / `history` / `tasks` / `logs` / `prompt`（各块）、`form` / `forms`（通用表单弹窗与一句话、拆细纲、批量写章三个具体弹窗——复用 `providerModal` 那层遮罩，两种形态都能用；调用次数的说明用的是 core 的 `describeCalls` / `planPlotBatches` / `planWriteBatch`，与后端确认框同源；表单支持 `select` 字段，`confirm` 让提交键两段式——「写完即定稿」第一下只换字、第二下才发，改了任何一个值退回第一段）、`pipeline` / `workbench` / `commands`（创作页的三块：流水线条与下一步、当前产物浮窗、`/` 命令面板），外加 `project/` 与 `settings/` 两个子目录（`settings/skills.ts` 是设置页第三个子页「技能」：阶段绑定、从 GitHub 检查与安装、技能库；那一页改了当场生效，不进 `draft`，切过去时藏起「保存设置」）。`index.ts` 只做装配与消息分发。
- **`src/editor/`** —— `paneElements`（一块编辑区的类型与 DOM）、`pane`（工厂，两块编辑区是它的两个实例）、`store`（两块之间共享的状态与 localStorage，`Pane` 接口也在这里）、`api`（给编辑器里的功能模块用的公共接口：当前编辑区与文件、`isProse` / `indentUnit`、`isImeComposing`、`addKeyHandler`、`onEditorChange`）、`history`（每个文件一份的撤销历史，纯逻辑）、`indent`（Tab / Shift+Tab 缩进，纯函数）、`highlight`（高亮镜像层：按命名图层画 `<mark>`，顺带精确滚到某个字）、`find`（查找替换条）与 `findCore`（它的纯函数，零 DOM）、`paragraph`（下面五个的装配入口，`index.ts` 只调它一次）+ `paragraphState`（分段格式与编辑器偏好）/ `enter`（回车）/ `pairs`（成对符号）/ `lines`（段落快捷键）/ `layout`（一键排版、半角标点转全角、「排版」按钮）、`safety`（「不丢稿」那几样的装配入口，`index.ts` 同样只调一次）+ `diskSync`（磁盘上的改动同步到已开的标签）/ `saving`（保存本身：同一份只有一个在路上、状态栏的保存状态、磁盘上没了先问、自动保存的闸）/ `closing`（关标签时三选一、批量合成一次）/ `dialog`（页内对话框）/ `autosave`（自动保存）、`conflictMerge`（冲突条上的「对比合并…」）/ `replace`（`editorReplace` 的接收端：认 requestId、`rebase` + `applyEdit`）/ `versions`（工具栏「历史」与历史版本抽屉）、`shell`（主题/拖拽/窄屏）、`chapterBar`（章节工作台的章节条，W6；五期加「审稿」）、`preview` / `clipboard` / `words`。
- **`src/explorer/`** —— `state`（展开集合、剪贴板、高亮）、`actions`（发消息）、`rows`（建行与菜单）。

## 类型是真的会被检查的

`src/protocol.ts` 用 `import type` 直接从 [../src/core/protocol/](../src/core/protocol/index.ts) 转出 `InMessage` / `OutMessage` 等全部类型（只有类型跨过这条边界，一行运行时代码都不会被打包进来）。**改协议后端加了字段、改了名字，前端对不上会直接编译不过**——这以前只是一句「记得同时改 view.js」的注释约定。

`media/tsconfig.json` 是独立的一份（`lib` 带 DOM，`moduleResolution: Bundler`），`npm run typecheck` 会连它一起跑。

## 关键约定

- **前端无状态**：一切数据来自 `ViewState` / `ProjectTree` 全量推送，前端只保留 UI 状态（草稿、展开/折叠、正在编辑的回复）。webview 销毁重建后一条 `ready` 就能完整恢复。
- **输入框旁那三个下拉框各归各的真相**（`view/composer.ts` + `view/state.ts`）：**模型**是全局设置（`ViewState.model`，选一下等于把它提到默认模型列表首位），**思考深度**与**当前章**是**会话的属性**（`SerializedSession.thinking` / `.target`）。所以思考深度的 change 只 `postMessage({type:'setThinking'})`、不改本地状态——值由回来的那条 `session` 消息回填（`syncThinkingSelect`）。五个档位的说法直接打包后端那份零 import 的 `model/thinking.ts`，界面上写的和跑起来的必然一致。
- **进度与日志各有一条推送路径**：长任务用 `tasks`（**全量替换**，列表最多两三项，增量协议不值得），日志用 `log`（增量一条）+ `logs`（全量，切到日志页或清空后）+ `logHistory`（**只有点「加载更早」才发**，那是唯一会查工程库的路径，默认进日志页零开销）。两者都在 `resendFullState` 里补推，刷新页面时正在跑的任务不会凭空消失。
  - **任务条在页头**（W8，四期）：`#taskList` 由 `shells/shared/panes.ts` 的 `taskBar()` 给出，插件放在标签栏下、独立版放在侧栏顶上——所有页签都看得见，从对话页点的定稿、批量不会跑起来就没了影。`pausable` 的任务多一颗「写完这一章就停」（发 `stopAfterItem`），点过换成一句说明。任务说完那一句时后端推 `taskDone`，`view/toast.ts` 出一条带按钮的提示（「打开第 3 章」发 `openChapter`；批量写完即审稿是「打开审稿报告」，发 `openSession`，五期补遗 §4），多留一会儿。
  - **计时由前端自己走**（`view/tasks.ts`）：后端只在有进度时才推快照，一次模型调用能安静一分钟，那期间计时停住会让人以为卡死。收到快照时记下 `Date.now() - elapsedMs` 当基线，之后每秒**只改计时文本**——重建 DOM 会打断「停止」按钮上的点击。
  - **日志增量不重画整表**（`view/logs.ts`）：长任务每秒好几条，重画会让滚动位置乱跳。只在原本就贴着底时才跟着滚，用户翻上去看东西时不该被拽回来。
  - **对话页流式输出同样只在贴着底才跟滚**（`view/messages.ts` 的 `scrollToBottom`）：每来一段 delta / 思考 / 工具行都会调它，翻上去看前面的气泡时不该被拽回底部。切会话与主动发送仍强制贴底。`.messages` 关掉了浏览器默认的 `overflow-anchor`，避免末气泡变高时视口自己挪。
- **工程页的树是扁平渲染的**（`view/project/rows.ts`）：`renderNodes` 递归遍历 `ProjectNode`，但产出的是**扁平的行数组**，层级靠 `paddingLeft` 缩进表达而非嵌套 DOM。折叠状态存在 `project/treeState.ts` 的 `openFolders`（relPath 集合）与 `openGroups` 里；切换折叠只用最近一次收到的树重画（`rerenderProject`），不往后端要数据。文件夹默认折叠，顶层分组默认展开。**「故事架构」那一组复用章节行的组件**（同样的 `.row-plot` / `.row-label`），所以按 `.row-plot` 取节点时要排掉 `.row-architecture`，否则「章节有几行」之类的判断会连架构五行一起数。空分组的「下一步：……」与说明行（`view/project/nextSteps.ts`）**不是** `.row`：它们不是树上的一项，没有右键菜单，也不该被「这一组有几行」数进去。
- **细纲浮窗按需取、事件委托**（`view/project/summaryTip.ts`）：鼠标停在**章节行**上约半秒后弹出这一章的细纲（八节，空着的节不画）。没定稿的细纲是计划，头上标「计划」；定稿之后正文又改过的标「已过期」。还没有细纲的章浮窗会照实说，有正文的再提一句可以右键「定稿」照正文整理一份。细纲正文**不在** `ProjectTree` 里（那棵树每次文件变动都全量重推，塞进去等于每保存一次就推几百 KB），悬停时发 `requestSummary{plotRelPath}` 单章去要。**缓存只在收到 `project` 消息时清**——那说明磁盘变过；折叠文件夹走 `rerenderProject()` 不经那条分支，缓存留着。监听用事件委托挂在 `#projectBody` 上（行每次重渲染都换掉，逐行 `addEventListener` 会堆积），浮窗与右键菜单同样是挂在 `body` 上的 `position: fixed`。
  - **浮窗是可以进去的**：细纲有八个小节、可能上千字，一瞥看不完。鼠标移上去就一直留着，能滚动、能选中复制，移开才收。所以**不能**给它 `pointer-events: none`，收起也**必须有宽限期**（`CLOSE_DELAY_MS`）——从行挪到浮窗要跨过一道缝，那一两帧鼠标既不在行上也不在浮窗上，立刻收会让浮窗永远够不着。
  - **收起要分清是谁在滚**：页面滚动会让 fixed 的浮窗和目标行脱节，得收；但**浮窗自己内部的滚动不算**，一滚就收等于那个滚动条形同虚设。捕获阶段的 `scroll` 监听里用 `hoverTip.box.contains(e.target)` 区分。Esc 与右键仍然立刻收（右键菜单也是 fixed，会叠在一起）。
  - **定位必须夹进视口**：`place()` 横向左对齐目标行、右边溢出往左收；纵向优先放下方，放不下翻上方，**两边都放不下时选空间大的一侧并压行内 `max-height`**——只翻转不压高度的话，一份长细纲在矮窗口里会有一截永远够不到。量高度前要先清掉上一次的 `maxHeight`，否则会一直沿用之前那个更矮的值；内容后到达（`applySummary`）把浮窗撑高后要重新走一次定位。
- **三只浮窗，各有取舍**（`view/project/` 下的 `summaryTip` / `detailTip` / `errorTip`）：定位（`view/tip.ts` 的 `placeTip`）与事件委托是同一套（挂 `body`、`position: fixed`、委托在 `#projectBody` 上），区别只在**要不要让鼠标进去**。`detailTip` 只复读一行被截断的副标题，`pointer-events: none` 收起不留宽限；`summaryTip` 与 `errorTip` 的内容是多行、要能滚动与选中复制，所以必须留宽限期。`errorTip` 还有一点不同：**数据不必向后端单取**——失败记录随 `ProjectTree.failures` 一起推来了（一条几十字，且只有出错的目标才有），直接读 `treeState.lastTree` 即可。
- **失败标记是「解析失败只有日志、用户看不见」的界面出口**（`view/project/rows.ts` 的 `failureMark`）：出错的行在文件名之前插一个感叹号，红色 = 整体失败、目标一字未改，黄色 = 部分完成、下次会重来；同一目标混着两种时**按最严重的算**。感叹号还带原生 `title` 兜底（浮窗要等 300ms）。旧后端推来的树没有 `failures` 字段，`lastTree?.failures?.[relPath]` 的可选链是有意的，别把它简化掉。
- **一套菜单引擎、两个入口**（`view/menu.ts`）：`buildMenuElement(items, className)` 由 `{ label, run, danger, disabled }`（`{ sep: true }` 是分隔线）建出菜单 DOM。气泡右上角的 ⋯ 用 `.msg-menu` 绝对定位贴在 `.msg-head` 里；右键用 `.ctx-menu` 挂到 `body` 上 `position: fixed` 跟着光标走（工程页有内部滚动，挂在容器里会被裁掉），贴边时翻转。同时只有一个菜单，点别处 / Esc / 滚动都收起。
- **创作页只推荐一个动作，其余走 `/`**（`view/pipeline.ts` + `view/commands.ts`）：主按钮来自后端状态机算出的 `next`，**点了就跑**，输入框可留空——「写第 N 章细纲」本来就不需要作者再说什么。**发送时用 `next.target` 与 `next.range`，不用会话当下的 target**：全书层的下一步常常落在另一份产物上（会话停在大纲，下一步是给第 1 章拆细纲），从前只覆盖 stage 与 capability，按钮上写着一件事、落盘时写到了另一处。其余命令收在 `/` 面板里——**只有会写文件的**（生成，细纲层多一条 `/落定细纲`）；讨论不是命令，打字就是。挑中变成输入框里的一枚待执行 chip，用完即清。命令表来自 core 的 `commandsFor`（零 import 的纯函数，前端直接打包），**前端不自己维护一份**——否则界面上会出现后端不认的命令，点了什么都不发生。
  - **`/` 就是输入框里的一个普通字符**，面板只是浮在它上方的候选列表（挂在 `#composerInput` 上，`bottom: 100%`）。从前 `/` 由 keydown 拦下来**不落进输入框**，过滤串自己攒在模块变量里——那等于在输入框旁边又造了一个隐形的输入框：光标在哪、退格退的是谁全靠猜，**输入法打的中文一个都收不到**（composition 期间不发可打印键的 keydown）。现在过滤串由 `slashQuery()` 从输入框的值算出来，面板的开合挂在 `input` 事件上（不是 keydown），中文/退格/粘贴/Ctrl+A 全都自动对。键盘只接管 ↑↓ / Enter·Tab / Esc，可打印字符一律放行。
  - **判据是「整个输入框只有一个 `/词`」**（`/^\/(\S*)$/`）：`/` 在中文正文里是普通字符（日期、比值、网址），`子时 3/4 刻` 与 `/ 这是一句话` 都不该弹面板。这条判据同时管着「要不要开面板」与「挑中后要不要把那几个字从输入框里抹掉」，所以只写一次。
  - **Esc 关过要记一笔**（`dismissed`）：输入框里那个 `/` 还在（那是用户的字，不替他删），而面板是由输入框的值驱动的——不记的话下一次按键又把它弹出来。删掉 `/` 或往后打出别的形状时这一笔自动清掉。
- **写正文时气泡顶上一条进度（W7）**（`view/index.ts` 的 `showWriteProgress`）：收 `writeProgress` 就地更新「正在写 / 续写第 k 轮 · 已写 x / 目标 y 字」与一条进度条，到了目标的八成换色，没有目标字数时来回扫；续写丢弃一轮时收 `streamReset`，把正文块退回那一份。收尾的 `turnDone` 整条重建气泡，进度条随之消失——那时落盘卡片与气泡上的 `.artifact-length`（`describeWriteLength`，与后端同一句）已经写着最后的字数，重演过的另挂一枚红色 `.artifact-replay`。
- **命令类消息的气泡不能是空的**（`view/messages.ts` 的 `fillUserBody`）：命令（写细纲、写正文）一律不要求输入，作者一个字都不必打，于是 user 轮的 `content` 是空串。气泡里画一枚 `/写细纲` 标签（数据来自 `SerializedTurn.command`，后端记的是**按阶段具体化过的标签**），有补充要求就跟在下面。**命令名不写进 `content`**——那句话会被当成作者的要求装进 prompt，与旧界面逼他手打一句「请生成细纲」是同一个毛病。assistant 那一支**刻意保持成纯文本节点**：流式增量走 `body.textContent += delta`，里面有子元素的话第一片增量就会把它们冲掉。
- **有段的那一轮按发生顺序画**（外部 agent 经 MCP 留下的气泡：角色名「外部 Agent」旁一枚 `.msg-tag` MCP）（`view/messages.ts` 的 `buildSegments`，实时那条路在 `view/index.ts`）：画的是 `SerializedTurn.segments`——一段文字一块 `.msg-body[data-seg=text]`，一次调用一条 `.tool-row`，**相邻的调用并进同一个 `.tools` 串**（连着五次 list/read 仍然是一串流水账，散成五块反而更乱），文字与 generate 卡打断它。实时那条路就地追加、绝不重建气泡：`delta` 接在**末尾那块**文字上（末尾不是文字就新开一块，那就是交替本身），`toolCall` 接在**末尾那一串**上（中间说过一句话就另起一串），插入位置一律取 `segmentAnchor()`（上下文明细 / 行内动作之前）。**有段的那一轮不给就地编辑**：`editTurn` 换的是整轮内容，多块之间没法映射；单步创作那条路（一块正文）照旧可改完再采纳。一轮刚开始那块空正文是给「它在想」留的位（推理模型常常先想几十秒），第一段是工具调用时由 `dropEmptyText()` 就地撤掉。
- **`generate` 产出的正文自成一张卡**（`view/messages.ts` 的 `buildGenCard`）：它走的是 `toolDelta` 而不是 `delta`（后端按 callId 贴的标签），流进 `.gen[data-call=…] .gen-body`，**只在卡内滚**——那几千字正在往下涨，让它把消息流一路往下顶的话，作者连上面刚说的那句话都看不成了。默认展开、限高 260px：`read` 回来的是它查资料的过程，而这是**产物本身**，作者接着就要判断「这份要不要落盘」。头两行（在做什么 / 结论如何）长在 `<summary>` 里，所以收起来之后还在，折叠只藏正文。`toolResult` 到了要**把卡里当下那份正文带过去**——它是一段段攒起来的，那条消息里根本没有它（落盘的结论随后还会重推一次同样的 `toolResult`，那时同样不能抹掉）。
- **审稿报告卡（五期 W10，`view/review.ts`）**：有 `turn.review` 的那一轮画报告卡，不画那段可就地编辑的正文（报告不落盘，改它的文字没有意义；「复制」取 `turn.content` 里那一份给人读的文字）。目标核对在前，严重 / 建议分组，通过、丢掉的意见、说明折叠；点引文发 `revealQuote`。缺省勾选来自后端（`review.picks`：严重、建议、未完成勾上，待核实不勾），勾选状态按 turnId 记在前端——气泡随 `turnDone` 整体重建时不丢。底部「按勾选的 n 条修稿」写调用次数（`REVISE_CALLS`），0 条或 `busy` 时禁用，点了发 `reviseChapter`。修稿那一轮的用户气泡在 `/按审稿修稿` 下面列出勾了哪几条（`turn.revise.items`）。**编辑模式**（五期补遗 §3）：底部「编辑问题」把问题那几组换成一张可改的表（分类、严重度、说明、引文），「新增问题」加一条作者补充的（引文可以空着）；作者加的能删、模型给的不能删；编辑中的表按 turnId 记在前端，重建不丢；「保存」发 `editReview`（整张表，新加的不带 id），后端校验引文、接着编号再推回；编辑期间修稿按钮收起。推回之后没见过的新条目按后端的缺省勾上，作者加的标「作者补充」、改过的标「已改」，没有引文的不画引文那一行。
- **覆盖审阅的合并视图（五期 W11，仅独立版，`view/merge.ts`）**：收 `prompt kind: 'merge'` 画进 `#mergeModal`（骨架在 `shells/shared/panes.ts` 的 `mergeModal()`，只有独立版的页面放它——插件用 VS Code 自己的 diff 编辑器；页面上没有这一块时当取消回话，不让后端死等）。按段对齐用 core 的 `paragraphDiff.ts`，相同的段一行带过、连着超过 3 段折起来，每一处改动原文 / 新版两栏 + 一格可以手改的结果（缺省是新版）+「采用新版 / 保留原文」，顶上「已处理 k / n 处」与「全部采用新版 / 全部保留原文」。**手改过的那一格谁都不动**（上游 ThreeWayMerge 点采用会冲掉手改的内容）：逐格按钮禁用、整体按钮跳过它，要重来先点「撤销手改」。一处都没动过（或全部采用新版、没手改）时回 `{"verdict":"apply"}`，原样用新版、不经段拼接；否则回 `{"verdict":"apply","merged":…}`。只读模式（`mergeable: false`）只有两栏与「采纳 / 放弃」。**两栏叫什么由消息说**：带 `sides`（内置编辑器冲突时的「磁盘上的 / 编辑器里的」、历史版本的「快照 / 编辑器里的」）时两栏、逐处与整体按钮、状态一律换成「用……」的说法，`applyLabel` 换掉「写入合并结果」（那两处不写盘，是「放回编辑器」）；不带就是从前那一套，一字不改。样式在 `css/standalone/merge.css`。
- **要动磁盘之前那一句问固定在输入框上方**（`view/gate.ts`）：`gate` 到了就往 `#gateDock`（`.composer` 的第一格，紧贴输入框上沿）挂一张卡片——要做什么、动的是哪个文件、这一次的参数（折叠着），加上按钮；点下去发回 `gateResult`。**两种问法共用这一张卡**：agent 动手前的闸门，以及**产物落盘前那一句**（后者从前是气泡末尾那颗「采纳写入」——一颗可以永远不点的按钮；它的拒绝那颗写「不采纳」而不是「跳过」，答完那一行也补在正文**下面**，靠 `msg.callId` 在不在判断）。**不复用 `providerModal` 那个遮罩层**：作者要判断的上下文（它前几步读了什么、正要写哪个文件）就在被遮罩盖住的消息流里，而且模态框期间连翻一眼那个文件都做不到。**也不再挂在气泡上**：那样它会跟着内容滚——agent 随后还在说话、还在调工具，几行之后卡片就滚出视野了，而循环正卡在它上面等回答，界面看起来像「卡住不动」。**只有两颗按钮**——叫停整轮是输入框旁边那颗「停止」，不在这张卡上（摆进闸门只会被误当成「跳过」，而两者的后果差着一整轮）。按钮上的字全部来自消息（前端不写死），同意贴最右（离「发送」最近的那一侧就是「继续」），拒绝挨着它压成次级按钮。消息带 `danger` 时（正文开头重演了上一章结尾）整张卡标红、多一块红色说明；带 `confirm` 时「同意」要点两下——第一下只把字换成 `confirm`，第二下才发（按钮文案两段式，不叠弹窗）。带 `remember` 时（一致性预检，五期补遗 §2）按钮行上面多一格理由输入框与第三颗按钮「记为刻意安排，照写」，填了理由才能点，点了发 `gateResult { verdict: 'proceed', remember }`。答完卡片就撤（后端回话之前不撤的话，两颗都点得着，而只有第一下算数），消息流里补一行 `.gate-note` 当记录——紧跟着的工具条只说「未执行」，「因为我按了跳过」只有那一行讲得出。那一行不进 `SerializedTurn`：这一轮结束时气泡按会话重建，它自然消失，决定本身已经记在工具条上了。
- **工作区卡是一只悬停浮窗**（`view/workbench.ts`）：流水线条上留一个一行高的入口（`#workbench`），悬停浮出这一层的产物，**点一下钉住**（照着细纲写正文时鼠标要回输入框），Esc / 再点一次 / 点别处收起。从前它是消息流顶部一张 `position: sticky` 的卡片——滚不出视野，代价是永远占着消息流最上面那一块，而且**既关不掉也藏不起来**（只能折叠成一条标题栏，那条标题栏还在），侧边栏只有三百来像素宽，一份细纲能吃掉半屏对话。改成浮窗之后 `renderSession` 不必再把卡片节点放回 `#messages` 了。
  - **类名用 `wbt-` 而不是 `wb-`**：`wb-` 是**独立版工作台外壳**的命名空间（`css/standalone/workbench.css` 的 `.wb-title` 是那条 38px 高的标题栏、`.wb-side` 是侧栏）。改造前这张卡的标题也叫 `.wb-title`，于是在独立版里被标题栏那条规则套上了 38px 高度与标题栏底色。
  - **不监听 scroll**，这是它与另外三只浮窗唯一的不同：那三只的目标是工程页里会滚动的行，页面一滚就得收；这个入口长在不滚的流水线条上（`.pipeline` 是 `flex: 0 0 auto`），消息流滚动时它一动不动。照抄那条会让「滚上去看前一轮对话，同时对着这一段的细纲」变得不可能——而那正是钉住要解决的情形。
- **四只浮窗共用一份定位**（`view/tip.ts` 的 `placeTip`）：挂 `body`、`position: fixed`、横向左对齐目标（右溢出往左收）、纵向优先下方（放不下翻上方、两边都不够就压 `max-height`）。从前这套几何在 `summaryTip` / `detailTip` / `errorTip` 里各抄了一遍。`minHeight: 0` 关掉压高度那一步，只有 `detailTip` 用它——那只浮窗只有一行、`pointer-events: none`、滚不动，压出来的 `max-height` 等于把字截掉。
- **右键菜单靠 WeakMap 登记**：构建某一行时用 `onContextMenu(row, () => items)` 把「这行右键给什么」记在元素上（那一刻上下文最全，不用右键时反查最近那棵树；行被重渲染丢弃后自动回收）。全局 `contextmenu` 监听从 `e.target` 向上找第一个登记过的祖先，找不到就用兜底的「刷新」。**刷新复用已有的 `projectAction: 'refresh'`**——后端那个分支只是 `pushState()`，会按当前页签推数据，天然适用于所有页面，无需新增协议。
- **右键一律接管**：全局监听里无条件 `preventDefault()`，输入框 / 文本域 / 内置编辑器里也一样，所以**原生的复制/粘贴/剪切菜单不会出现**。这是有意的取舍（菜单风格统一），代价是这几处的编辑项要自己实现（编辑器正文区与文件页已经做了，见 `editor/clipboard.ts` 与 `explorer/rows.ts`；输入框里目前只有「刷新」）。插件形态另需 [../src/shells/vscode/webviewHtml.ts](../src/shells/vscode/webviewHtml.ts) 的 `<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>`：VS Code 给 webview 右键菜单加的复制/粘贴项由宿主渲染，JS 的 `preventDefault` 压不住，不加会同时冒出两层菜单。**监听挂在 `window` 的捕获阶段**，并额外接管副键的 `auxclick`：冒泡阶段的监听会被中途任何一处 `stopPropagation()` 挡掉，而触控板双指点击在部分浏览器/驱动上只发 `auxclick`、不发 `contextmenu`——两种漏法的现象都是「弹出原生右键菜单」。同一次点击的尾巴（落点没动、300ms 内）只挡不弹，免得一下点击弹两遍。`pointerdown` / `mousedown` 的默认行为**不碰**：按规范取消它们拦不住 `contextmenu`，却会把 `mousedown` 一起吃掉，于是文本域里右键不再挪光标，菜单里的「粘贴」会贴到上一次光标的位置去。触摸长按的原生 callout 走的不是 `contextmenu`，在 CSS 里用 `-webkit-touch-callout: none` 关（`css/view/base.css`）。
- **DOM 结构只有一份**：工程页工具栏等结构在 [../src/shells/shared/panes.ts](../src/shells/shared/panes.ts)，两个壳都从那里取，**加按钮只改那一处**。（从前两个壳各存一份，这条规矩是「要同时改两处」；现在前提没了。）两处例外：一是工作台外壳与编辑器容器只在独立版的 `page.ts` 里——那是布局，本该按宿主分叉；二是草稿那块编辑区的 DOM 由 `editor/paneElements.ts` 的 `createPaneElements()` 克隆主区结构现造，`page.ts` 里只有容器 `#wbEditors` 与分隔条 `#wbDraftResizer`。编辑区里由脚本现造的几样（章节条 `chapterBar.ts`、查找替换条 `find.ts`、高亮镜像层 `highlight.ts`、状态栏上「自动保存」那一枚 `saving.ts`）**两边模板里都没有**，各自只有一个生成函数，两块编辑区共用；编辑器的页内对话框（`dialog.ts`）挂在 `body` 上、现造现拆。
- **宿主差异用能力探测，不判断环境**：只有 VS Code 有原生设置界面，所以「在 VS Code 设置中打开」这颗按钮**在独立版的页面里根本不存在**（`settingsPane({ nativeSettings })`），前端用 `maybeById` 取不到就跳过。别改回「渲染出来再 hidden 掉」或「看 state 里的某个环境位」——那条路走过，界面文案会跟着腐烂（见 [../src/shells/README.md](../src/shells/README.md)）。
- **CSP**：webview 的 CSP 只允许本地资源与 nonce 脚本，不引任何 CDN / 外部脚本。独立版同样不引外部资源。
- **两形态隔离**：`standalone.css` 与 `editor.js` / `explorer.js` **只**由独立版加载，插件的 `webviewHtml.ts` 里没有它们，也没有 `#wbEditor` / `#filesBody` 容器。给独立版加样式请只改 `src/css/standalone/`（必要时用 `.workbench` 前缀覆盖 view 的规则），不要为独立版去动 `src/css/view/`。
- **能力探测而非环境判断**：`view/store.ts` 里用 `document.getElementById('wbEditor')` 判断有没有内置编辑器，据此决定「打开文件」发 `openEditor` 还是 `openFile`；`editor/index.ts` 与 `explorer/index.ts` 各自开头探测自己那块容器（`#wbEditor` / `#filesBody`），不在就直接 return（连 `acquireVsCodeApi()` 都不调——webview 里那个函数只允许调一次）。插件里没有这些容器，行为不变。
- **跨文件只经三样东西**（全在 `src/globals.ts`）：`window.__nfToast`（view 出，editor / explorer 用）、`window.__nfContextMenu`（view 出的右键菜单登记函数）、几个自定义事件——`nf-editor-active`（editor → explorer，高亮当前文件）、`nf-files-moved`（explorer → editor，改名后搬标签），以及标题栏与编辑器之间的 `nf-editor-query` / `nf-editor-command`（保存、撤销那一组，外加「文件 → 自动保存」：`query` 里的 `autoSave`、`command` 的 `toggleAutoSave`）与 `nf-paragraph-query` / `nf-paragraph-command`（「编辑」菜单段落那一组）、`nf-versions-query` / `nf-versions-command`（「文件 → 历史版本…」）。别让 explorer 直接读 editor 的 `panes`——那会把编辑器的内部状态变成两个文件之间的契约，而资源管理器在插件形态里根本不存在。右键菜单尤其**不能各起一套**：全局 `contextmenu` 监听在 view 里，另起一个会两层菜单一起弹。
- **不拼 HTML 字符串渲染用户内容**：一律 `createElement` + `textContent`（`src/dom.ts` 的 `el()` 就是干这个的），正文里写 `<script>` 也只是普通文字。
- **一排控件共用一套尺寸，主按钮靠颜色跳出来**（`css/view/buttons.css` 的 `--nf-ctl-height` / `--nf-ctl-padding-x` / `--nf-ctl-radius`）：`.primary` / `.secondary` / `.danger` / `.chip-btn` / `.composer-tool` 与 composer、日志页工具栏里的下拉框、数字框同高。从前主次按钮是 `5px 12px` + 13px 字号，在一排 0.8em 的小控件中间粗一号——「写第 N 章」「保存」「发送」于是成了三块各占一角的色斑。要改高度只动那三个变量。
  - **尺寸挂在变体类上，不挂在裸 `button` 上**：页面上大半的 `button` 不是「一排控件里的一颗」——菜单项、页签、标签页的关闭叉、chip 上的 ×、命令面板的每一项、流水线条上的那几层，各有各的高度。`min-height` 写在裸 `button` 上会把它们全拽到 24px（`min-height` 压得过它们自己的 `height`，而它们都没声明 min-height 来挡）。裸 `button` 只留字体、光标、圆角这类人人都要的。
  - **`forms.css` 的 `width: 100%` 要在工具栏里收回来**：那条规则是给设置页那种「一列一个字段」定的；工具栏一行摆好几颗控件，不写 `width: auto` 的话下拉框会独占一整行，把后面的按钮挤到第二行（日志页曾是这样）。
- **预览与等宽字体是两件事**：章节可以是 `.txt` / 无扩展名，那时没有 Markdown 可预览（隐藏「预览」按钮），但它仍是正文，该用正文字体；只有 `.json` / `.yml` 这类结构化文件才加 `.mono`。
- **两处 `countWords` 口径不同，别合并**：`editor/words.ts` 的与 core 一致（中文按字、英文按词），状态栏上的字数要与工程页上后端算的对得上；`view/format.ts` 的统计模型回复长度（去空白后的字符数），是另一件事。

## 内置编辑器的行为约束

对应「不静默覆盖」这条产品承诺（见 [../AGENTS.md](../AGENTS.md)）：

- 保存带**内容 hash 乐观锁**。磁盘上的 hash 与编辑器基线不一致（作者在别处改过、或插件写入过）时保存被拒，前端弹冲突条，由用户在「对比合并…」「用磁盘版本覆盖编辑器」和「用编辑器内容强制保存」之间选。
- 只有用户明确点了「强制保存」（页内对话框里再确认一次），才会发不带 `baseHash` 的 `saveFile`。
- **「对比合并…」不写盘**（`editor/conflictMerge.ts` + `replace.ts`）：发 `mergeWithDisk`（带编辑器里的这一份与 requestId），后端读磁盘上此刻的那一份开合并视图（左磁盘、右编辑器），采纳后回 `editorReplace` 带 `base`。前端**先 `Pane.rebase`**（乐观锁基线换成磁盘那份、收起冲突条）**再 `applyEdit`** 换内容——顺序反过来的话，换内容那一刻的脏标记是对着旧基线算的。结果是一步撤销、仍是未保存，作者照常 `Ctrl+S`，不必强制保存。放弃 / 关掉合并视图后端什么都不回，什么都不变。按钮由模块在每块编辑区第一次重画时插进冲突条（说明文字之后），`page.ts` / `createPaneElements` 里没有它；冲突条的显隐与说明文字仍归 `pane.ts`。
- **`editorReplace` 只认本页发的 requestId**（`replace.ts` 的 `newRequestId` / `claimRequest`）：回复是广播，同一个工程开着两个窗口时，另一个窗口里那份不该被换掉。
- **历史版本面板只换编辑区，从不写盘**（`editor/versions.ts`；快照由网关存，见 `src/core/workspace/README.md`）：工具栏「历史」（每块编辑区一颗，第一次重画时插到「保存」前面）与「文件 → 历史版本…」打开 `.ed-stage` 里右侧的抽屉 `.ed-versions`，开着时 `.ed-stage` 加 `ed-stage-versions` 让出那一截宽度（正文区同时看得见，高亮镜像层按 textarea 的实际宽度排，跟得上）。抽屉跟着这块编辑区的当前文件走：换了文件重发 `listVersions`，保存回执到了（`hash` 变了）也重拉；标签全关了就收起。选中一版先 `readVersion` 要全文给预览，「恢复这一版」拿那份全文直接 `applyEdit`（一步撤销，成为未保存，基线不变），「对比…」发 `compareVersion`、收 `editorReplace`（不带 `base`）。能不能用看 `unavailableReason`：没开文件、没给 `kind`（没打开工程）、`ViewState.initialized === false`（还不是小说工程）、`kind === 'other'` 时按钮与菜单项置灰、提示里写原因——与 `isProse` 同一条原则，**前端不拿路径猜**，后端也会再判一次（`versions.unavailable`）。
- 刷新页面后恢复未保存草稿时，同样比对 hash：磁盘变过就丢弃草稿并提示，不拿旧草稿盖新内容。
- 关闭有未保存修改的标签页会先问「保存 / 不保存 / 取消」（页内对话框）；带未保存内容离开页面问的是浏览器原生那一句（`beforeunload`，页面改不了）。

**不丢稿**（`safety.ts` 装配的那几个模块；`pane.ts` 只认 `saving` / `closing` / `dialog` 的几个函数）：

- **磁盘上的改动同步到已开的标签**（`diskSync.ts`）：每收到一条 `state` / `init` 去抖 400ms、窗口拿回焦点 / 页面重新可见时，把两块编辑区里**所有开着的文件**的 `{ path, hash }` 发给后端（`checkEditorFiles`）。`hash` 取 `Pane.knownDiskHash`：标成已删除的给空串（磁盘上又出现了后端就会回话），见过一份还没载入的磁盘新版就给那一份的（`pane.ts` 的 `diskSeen`；冲突条因为接着打字收起了，同一个新版也不再报第二次），否则是保存基线；正在保存的那几份不带。后端回 `editorDiskChanged`（磁盘上的新版）或 `editorDiskGone`，经 `paneOwning` 交给那一块：
  - **没改过的标签**就地换成新内容（`Pane.applyDiskChange`：走 `replaceAll`，记一步撤销，与「再次打开时磁盘有新版」同一处理），**不切标签、不抢焦点**，光标与滚动夹进新长度；是当前正看着的就在状态栏说一句「磁盘上有新版本，已载入」，几秒后退回保存状态。不弹 toast。
  - **改过的标签**一个字不动，挂冲突条（`reopen` 那句文案），标签上挂一个 `.ed-tab-flag`「!」（`.ed-tab.conflict`），弹一条 toast（同一个新版只弹一次）；不切标签；这一份的自动保存停下。磁盘上的正好就是编辑器里那一份时认下来，不算冲突。
  - **不复用 `editorOpen`**：那条把标签切成当前的、抢焦点，只留给「打开」这件事（生成落盘后 `openFile` → `editorOpen` 那条路不变）。
- **磁盘上没了**（`editorDiskGone` → `Pane.markGone`）：`OpenFile.gone`，标签 `.ed-tab.gone`（名字划掉 + 红色「!」），冲突条那一格说「磁盘上已经没有这个文件（被删或改名）」、藏起「用磁盘版本覆盖编辑器」（没有磁盘版本），打字不让它收起。按保存（含冲突条上的强制保存）先问「要不要在原路径重建」，答应了才发 `saveFile { recreate: true }`（仍带基线）；**绝不静默在原路径重建**——网关对「带了基线、文件却不在」是当新建处理的，后端编辑器这条路因此收紧成回 `editorDiskGone`、什么都不写（`files/fileEditing.ts` 的 `FileGoneError`）。自动保存跳过它。
- **自己保存之后不误报**：`editorSaved` 先到（基线换成新 hash）、`state` 后到（WebSocket 保证顺序），之后核对带的就是新 hash；自己那次保存还在路上时收到的 `editorDiskChanged` 不认（多半读到的就是自己刚写下去的那份，回执会说清楚）。
- **别的窗口存了同一份**：回执是广播的。这边没有保存在路上时收到的 `editorSaved` / `editorConflict` 当成「磁盘上变了」处理（`applyDiskChange`），**不把基线悄悄换成别人的那一份**——从前那样做，下一次保存就把别人的改动盖掉了。
- **编辑器里不用 `window.confirm`**（`dialog.ts`）：关标签的三选一、「还原」与「用编辑器内容强制保存」的确认、「要不要在原路径重建」都是页内对话框，外观复用 `css/view/modal.css`（`.modal-overlay` / `.modal` / `.modal-foot`，按钮 `.primary` / `.secondary` / `.danger`），DOM 现造现拆。焦点进对话框、缺省落在主按钮上；`Enter` 按焦点所在的那颗、`Esc` 取消、`Tab` 不出对话框；开着时 `Ctrl` / `Cmd` 组合键不往下传；同一时刻只开一个，后来的排队。
- **关标签**（`closing.ts`）：一份有修改时「保存」（主按钮）/「不保存」/「取消」；几份一起关（关闭其它 / 左侧 / 右侧）合成一个对话框问一次，列出是哪几份——「全部保存」/「全部不保存」/「取消」。「保存」**等这一份的回执**才关，撞上冲突、磁盘上没了、出错就不关（冲突条留着），等回执的工夫里又改了的也不关。Ctrl+W、「文件 → 关闭编辑器」、标签上的叉与中键都走这一条（`Pane.closeFile`）；问过之后真正关掉用 `Pane.discard`。
- **保存本身**（`saving.ts`）：所有保存（Ctrl+S、工具栏、全部保存、关标签时的保存、自动保存）都经 `requestSave`。**同一份同一时刻只有一个保存在路上**，回执回来之前又要存只记一笔，回执是「存成了」而还有没存上的修改再存一次；撞上冲突、出错就不接着存。状态栏那一格：「● 未保存」→「保存中…」→「已保存 14:32」（本次会话里最后一次存成的时刻），发出去 10 秒没回音说「还没收到回音，连上后会自动发出」（断线时消息在 bridge 的 outbox 里等重连）。**存成了不弹 toast**，冲突、出错照样弹。回执由 pane 认领之后调 `settleSave`；落到已经不开着的文件上的，`saving.ts` 自己兜底结掉；换工程时清空。
- **自动保存**（`autosave.ts`，缺省关）：标题栏「文件 → 自动保存」（紧跟「全部保存」，开着打 ✓），开着时状态栏挂一枚 `.ed-autosave`。停笔 2 秒（组字中途不算，上屏重新计时）、切走一个标签、窗口失去焦点 / 页面藏起来时保存，一律带 `baseHash`。闸在 `saving.autoSaveAllowed`：撞过冲突（或核对磁盘时发现改过的标签在磁盘上变了）的那一份记下当时的基线，基线没动之前不碰它（那一枚写「自动保存已暂停」），绝不强制保存；磁盘上没了的不碰；点了「还原」、磁盘版还没回来的不碰（`holdSave`）；有对话框开着不碰。

编辑区里的几条硬规矩（`editor/api.ts` 文件头同一份，后来的功能模块——回车自动缩进、成对标点、一键排版、查找替换——都照这几条写）：

- **程序改写只走 `Pane.applyEdit(start, end, text, selection?, opts?)`**，不许直接写 `textarea.value`（`setRangeText`、`execCommand('insertText')` 也不行）。它换掉一段文字、落选区、记**一步**撤销，同时更新 `file.draft`、脏标记、状态栏、标签圆点与 localStorage 草稿，清掉过期的冲突条，再发一条 `onEditorChange`。位置按 `area.value` 的下标算（与 `selectionStart` 同一套），`selection` 按新文字算、缺省是光标落在插入文字末尾；`opts.join` 把这一处并进刚记下的那一步（成对标点的后半个随前半个一起退）。绕过它的改动不进撤销记录——下一次 Ctrl+Z 核对不上，整份历史作废。右键「剪切 / 粘贴」、Tab 缩进、「还原」「用磁盘版本覆盖编辑器」、磁盘新版就地换进没改过的标签都已经走它。
- **撤销 / 重做是编辑器自己记的**（`editor/history.ts`），不用浏览器原生的：一块区的所有标签共用一个 textarea，切标签整份换 `value`，原生记录随之作废，而它在各浏览器 / 桌面 WebView 里跨元素、跨程序改写的行为又没法统一实测。每个打开的文件一份（挂在 `OpenFile.history` 上），记差异不记快照、上限 500 步；切标签不丢，关标签丢弃，刷新不恢复。用户的输入在 `input` 里拿 `file.draft` 与 textarea 当前值求差异；连续打字 / 删除在 1 秒内且位置相邻时并成一步，换行断开；粘贴、拖放、程序改写各自一步。Ctrl/Cmd+Z、Ctrl+Y、Ctrl/Cmd+Shift+Z 在编辑区的 keydown 里拦下，`beforeinput` 的 `historyUndo` / `historyRedo` 也拦下；标题栏「编辑 → 撤销 / 重做」在焦点落在编辑区时经 `nf-editor-command`（`undo` / `redo`）交给编辑器（`nf-editor-query` 的 `areaFocused` 告诉标题栏焦点在不在），焦点在别的输入框时照旧 `execCommand`。标题栏的菜单按钮按下时不夺焦点（`menubar.ts` 的 `keepFocus`），否则 Chromium 里一点菜单焦点就离开了输入框，编辑那几项永远置灰。
- **输入法保护**：编辑区里所有 keydown 处理先过 `isImeComposing(e)`（`e.isComposing || e.keyCode === 229`），组字时的 Tab、回车、Ctrl 组合键一律放行给输入法；全局的 Ctrl+S / F / W 同样。组字期间的 `input` 只刷新显示、不记撤销，`compositionend` 之后整段记一步。用 `addKeyHandler` 挂的处理函数不会收到组字中途的按键。
- **正文与否由后端说**：`editorOpen` / `editorSaved` 带 `kind`（`kindOfPath` 算的），`chapter` / `draft` 是正文（`isProse`），其余不是；没给（没打开工程）当非正文。与 `draftPath` 同一条原则，前端不拿路径或扩展名猜。Tab 的缩进单位就看它：正文两个全角空格，其余两个半角空格（`indentUnit`）。
- **Tab 不吞字**：有选区时给碰到的每一行行首加一级（空行跳过），选中的字一个不删、选区跟着平移；Shift+Tab 每行最多去一级（认两个全角、单个全角、两个半角、一个半角、`\t`）。规则在 `editor/indent.ts`。
- **高亮镜像层是共用设施**（`editor/highlight.ts`，样式在 `css/standalone/highlight.css`）：textarea 自己画不了高亮，于是在每块编辑区的 textarea 背后叠一层镜像 div（`.ed-mirror`，第一次用到时现造在 `.ed-stage` 里），文字排得与 textarea 一模一样但颜色透明，只有 `<mark>` 的底色看得见。
  - **为什么 textarea 背景透明**：镜像在下、textarea 在上（`.ed-area` 是 `position: relative; z-index: 1; background: transparent`，`.ed-stage` 用 `isolation: isolate` 把这层叠关系关在格子里，底色由 `.wb-editor` 给），底色才透得上来；光标、选区、输入法、点击、右键仍然全是 textarea 的，镜像 `pointer-events: none`、`aria-hidden`。
  - **排得一模一样**靠每次渲染时从 textarea 的**计算样式**抄（字体、字号、行高、字距、内边距、`white-space` / 断行规则、`tab-size`……，`.mono` 文件换了字体也跟得上），宽度取 textarea 的内容区（扣掉竖滚动条，用 `getBoundingClientRect` 的小数宽度），滚动用 `transform` 跟着平移。CSS 里**不许**给 `<mark>` 加内边距、边框、字重——任何一样都会让两层排得不一样。
  - **接口按命名图层**：`setHighlights(pane, layer, ranges)` / `clearHighlights(pane, layer)`，`ranges` 是 `{ start, end, cls }`（`area.value` 的下标，`cls` 是那一段 `<mark>` 的 class，颜色写在 `highlight.css`）；几层叠在同一段字上时那一段带上几层的 class。查找用 `find` 这一层，禁用词高亮、段落聚焦另起图层名即可，**别另起一层镜像**（各抄一遍排版，对不齐的地方会翻倍）。
  - **什么时候重画**：`setHighlights` / `clearHighlights` 当场画；换了文件所有图层清空（范围是给上一个文件算的）；内容变了各层先按这一处改动平移（压在改动上的丢掉）、下一帧重画——调用方自己下一帧重算再 `setHighlights` 的话那一帧只画一次；切预览当场藏；尺寸变了只重摆位置（`ResizeObserver`，没有就不管）。超过 `HIGHLIGHT_LIMIT`（30 万字符）不画，要不要告诉人由调用方定（`tooLargeToHighlight`，查找条会说一句）。
  - **顺带的精确定位**：`scrollToOffset(pane, offset, { onlyIfHidden })` 在一份看不见的镜像（`.ed-mirror-probe`）里排出这个字之前的文字与它所在那一行、把这个字包进标记量 `offsetTop`，把它滚到视口偏上三分之一。审稿引文定位（`Pane.reveal`）与查找跳转（`onlyIfHidden`：已经看得见就不滚）都用它；从前按字符位置占全文的比例估，段落长短不一时能差出好几屏。量不了（太大、textarea 藏着）时退回按比例估。
- **查找替换条**（`editor/find.ts`，纯函数在零 DOM 的 `editor/findCore.ts`）：每块编辑区一条，只作用于这一块的当前文件。
  - **结构约定**：DOM 只由 `find.ts` 的 `buildFindDom()` 生成，两块编辑区都在第一次用到时现造、插在 `.ed-stage` 前面；`page.ts` 与 `createPaneElements()` 里都没有它（`tests/dom/standalone/find.test.js` 守着：渲染出来的页面模板里不许出现 `ed-find`）。从前查找条两边各写一份、靠人对齐，加了替换行与两颗开关之后再抄两份只会越抄越歪。节点没有 id（两块各一条），按 class 取：第一行 `.ed-find-toggle` / `.ed-find-input` / `.ed-find-case` / `.ed-find-regex` / `.ed-find-count` / `.ed-find-prev` / `.ed-find-next` / `.ed-find-close`，第二行 `.ed-replace-row` 里的 `.ed-replace-input` / `.ed-replace-one` / `.ed-replace-all`，底下一行提示 `.ed-find-note`。
  - **改写只走 `applyEdit`**：替换一处一步撤销；全部替换由 `findCore.replaceAllIn` 算出「第一处到最后一处那一段」的新文字，一次 `applyEdit`、只记一步。
  - **不夺焦点**：打字时从光标往后找、选中匹配，但焦点留在查找框（人还在打字）；textarea 没焦点时原生选区看不见，当前那一处靠高亮层的另一种颜色（`ed-hl-find-current`）标出来。`Esc` 关掉时焦点才回编辑区。
  - **快捷键**由 `installFind()` 挂在 document 上：`Ctrl+F` / `Ctrl+H` / `F3` 给焦点所在的那一块（焦点在页面上、按钮上时给当前那一块）；焦点在编辑区之外的输入框 / 文本框（对话输入框之类）时**不拦**，留给浏览器；那一块没开文件也不拦。编辑区里的 `Esc` 收起查找条。标题栏「编辑 → 查找 / 替换」经 `nf-editor-command`（`find` / `replace`）。
- **对「用户刚输入了什么」做反应，只认 `onEditorChange` 里带 `change` 的那一下，不认 keydown**（`editor/pairs.ts`）：中文标点几乎都是输入法打出来的，keydown 里看不到那个字，有的输入法还走一遍组字、`compositionend` 才上屏。`typing` 与 `composition` 两种来源都带 `change`（被替换掉的选区也在 `change.removed` 里），成对符号就靠它包选区、补右半边；补的那一下 `join: true`，与那次输入算一步撤销。在监听里调 `applyEdit` 会再发一条 `edit`，自己记一个标志跳过它。
- **按键归谁按功能分模块挂 `addKeyHandler`**：回车 / Shift+Enter 在 `enter.ts`，`Alt+↑↓`、`Shift+Alt+↑↓`、`Ctrl/Cmd+Shift+K`、`Ctrl/Cmd+Enter` 在 `lines.ts`；彼此不重叠，挂的顺序无所谓。没得可做（到顶、全是空行）也返回 true 接下这一下——这几个组合键浏览器的缺省动作在编辑区里没有用。
- **分段格式是工程的设置，前端只读**（`editor/paragraphState.ts`）：从 `init` / `state`（`ViewState.paragraphStyle`，哪个页签都推）与 `project`（工程树，只在「工程」页签开着时推）里取，缺省 `blank`。切换是标题栏「编辑 → 段落格式」发 `setParagraphStyle`，后端只改 `config.md` frontmatter 的这一个键再 `pushState`，新值随下一条 `state` 回来——前端不先改本地的值。回车插什么、一键排版排成什么样都打包 core 的 `model/paragraphFormat.ts`，与后端同一份。
- **编辑器偏好按浏览器记**：localStorage `novelforge.editor.prefs`（不按工程分键，那是作者的手感，不是这本书的设置），两项：成对符号自动补全（缺省开）、自动保存（缺省关，只认明明白白的 `true`）；写不进去时只在内存里生效。
- **只对正文出现的工具栏按钮由功能模块自己插**（「排版」，`editor/layout.ts`）：在每块编辑区第一次 `render` 时插到「预览」后面、之后跟着当前文件显隐，`page.ts` 与 `createPaneElements` 里没有它——两块编辑区走同一条路，`pane.ts` 不必知道它。

## 两块编辑区

- `createPane(id, refs, post)`（`editor/pane.ts`）是工厂，两块编辑区是它的两个实例，各自持有 `files` / `conflicts` / `activePath` / 预览开关。主区绑页面上固定 id 的节点，第二块（`pane: 'draft'`）在首次收到 `editorOpen{pane:'draft'}` 时惰性创建——它放草稿，也放点开一章时并排打开的那份细纲（W6）。
- **章节工作台（W6）**：工程页点章节行名发 `openChapter`，后端按宿主能力开——正文进主区，细纲经 `openBeside` 进第二块（VS Code 壳落在 `ViewColumn.Beside`，前端什么都不用做）。主区顶上的**章节条**（`editor/chapterBar.ts`）在任一块正开着某一章的正文或细纲时出现：这一章在哪一步、写了多少，「写这一章 / 接着写 / 重写 / 审稿 / 定稿」按状态亮灭（提示里写调用次数），另一份没开着时给「并排看细纲 / 正文」。按钮发 `chapterAction`，后端当成对这一章按下主按钮（审稿是正文层的 `review`，只出报告）。数据只取工程树（`project` 消息）与 `nf-editor-active`，不新增推送。
- **点引文定位（五期 W10）**：后端推 `editorReveal { path, quote }`（紧跟在那一份的 `editorOpen` 之后），拥有那份文件的那一块 `Pane.reveal` 选中那一句，用高亮镜像层量出它的位置、滚到视口偏上三分之一（`highlight.ts` 的 `scrollToOffset`）。定位用 core 的 `locateQuote`（`model/review.ts`，与后端校验引文同一个归一化：去空白与标点），按编辑区里**当下**的文字找——有没保存的修改时照样认得出。
- **一个路径同一时刻只属于一块**。`editorSaved` / `editorConflict` / `editorError` / `editorDiskChanged` / `editorDiskGone` 都只带 `path`，靠这条不变量才认得出该送给谁（`paneOwning`）。因此收到 `editorOpen` 时会先让另一块 `closeSilently` 掉同路径，未保存内容与撤销历史一并搬过来（`CarriedDraft`；历史只在接上之后的内容与搬走时一字不差才接，改名搬家 `nf-files-moved` 同理）——不是关闭，是搬家。破坏这条会导致从错的那块保存时用错 `baseHash`，触发假冲突。
- **一块区只有一个 textarea**，所有标签共用，显示的是当前文件（`Pane.area`）。切标签时整份换 `value`，所以光标位置、滚动位置、撤销历史都记在 `OpenFile` 上，而不是指望 textarea 自己记得。别的模块要拿「当前那块区 + 当前文件 + 它的 textarea」，用 `api.ts` 的 `activeEditor()` / `editorOf(pane)`。
- `activePane` 靠两块根元素上的 `focusin` / `pointerdown` 跟踪，`Ctrl+S` / `Ctrl+W` 作用于它，`beforeunload` 则扫两块。标题栏的撤销 / 重做也作用于它（焦点在哪块区，它就是哪块）。
- 「草稿」按钮的可见性由后端给的 `file.draftPath` 决定，前端不自己判断什么算章节。点它发 `openDraft{path}`，**传的是章节路径**，草稿路径由后端推导并按需创建。
- localStorage 的 `novelforge.editor.v1` 从 `{ open, active }` 升为 `{ v: 2, panes: { main, draft }, activePane }`；`restore()` 兼容旧形状（认得 `saved.open` 就当主区），老用户的标签页不会在升级后消失。
- `activePane` 每次易主都要跟一句 `announceActive()`（`activate` / `upsertFile` / 两块之间的 `focusin`·`pointerdown` 切换、`dropFile` 关掉当前标签），资源管理器的高亮才不会停在上一个文件上。`upsertFile` 末尾那句读的是 `activePane`，所以 `editorOpen` 分支必须**先**认下目标块再 `upsertFile`。

## 资源管理器（「文件」页）

- **与「工程」页是两件事**：工程页是按语义整理过的视图（章节一条列表，带流水线状态与定稿状态；角色带别名），只看得见几个可管理区里的文件；这一页是磁盘上真实的目录结构，一个都不藏。`.novelforge/` 里的会话、`project.json`，以及老工程留下、工程页不再认的 `plots/`，只有这里进得去——这就是它存在的理由，别为了「干净」把点开头的目录过滤掉（`fileTree.ts` 的 `HIDDEN_DIR_NAMES` 只挡 `node_modules` 与 `.git`）。
- **懒加载，按目录**：展开哪个目录才列哪个。每次展开/折叠都把**当前展开着的全部目录**发给后端（`listDir{dirs}`），不是增量——折叠因此不必再发一条撤销消息，后端也据此记住该关注哪些目录，工程有变动时原样重推。
- **先 `requestDirs()` 再 `render()`**：请求那一步会把还没数据的目录记进 `pending`，顺序反了刚展开的那一层会显示「（未载入）」而不是「载入中…」。
- **能不能编辑由后端算**（`FsEntry.editable`，与 `fileEditing.ts` 同一份规则）。前端不复刻扩展名白名单，也就不会去撞一个必然失败的 `openEditor`——不可编辑的文件点击直接走 `openExternal`。
- **树是扁平渲染的**，与工程页同一套取舍：层级靠 `paddingLeft` 缩进表达，折叠只是重画一遍。展开集合存 localStorage 的 `novelforge.files.open`。
- **截断要说出来**：目录条目超过上限时后端给 `truncated`（真实总数），树尾多一行「另有 N 项未列出」。

## 测试

- [`../tests/dom/`](../tests/dom/) 用 jsdom 跑**构建产物**（`dist/media/*.js`，不是源码），从两个 html 模板里抠 body 保证结构与真实渲染一致，按页面与组件分文件（`view/` 下是对话页、创作页、工程页、表单、报告卡、合并视图、空状态、日志页、设置页、悬停浮窗……，`standalone/` 下是两块编辑区、撤销与 Tab 缩进、查找替换与高亮镜像层、回车、成对符号、段落快捷键、一键排版与「编辑」菜单段落那一组、磁盘同步、关标签的对话框、保存状态与自动保存、冲突时的对比合并、历史版本面板与「文件 → 历史版本…」、章节条、资源管理器、欢迎页），清单见 [tests/README.md](../tests/README.md)。改了 `media/src/**` 先 `npm run media` 再跑它，否则测的是上一次的产物（`npm run test:dom` / `npm test` 会自动先构建）。
- [`../scripts/verify-css.js`](../scripts/verify-css.js) 比对两份 CSS 是否等价：规则集合一条不多一条不少，且「同选择器 + 同属性」的相对顺序没被改变。拆分或重排样式片段后可以拿它对着旧产物验一遍。

## 新增产物

加一个新的 `.js` / `.css` 产物：先写源码入口，再改三处配置（AGENTS.md 与 `standalone/README.md` 说的「三处」就是下面的 2–4 步）：

1. `media/src/<名字>/index.ts`（或 `src/css/<名字>.css`）放源码；
2. [`../scripts/build-media.js`](../scripts/build-media.js) 的 `JS_ENTRIES` / `CSS_ENTRIES` 加一条；
3. [`../scripts/embed-media.js`](../scripts/embed-media.js) 的 `built` 数组加一条——漏了这步，`bun build --compile` 出的单文件会 404；
4. 页面里引用：独立版 `standalone/page.ts`，需要时插件 `vscode/webviewHtml.ts`。

**在已有产物内部拆模块不用改任何配置**，直接 import 即可——这正是这次改造要换来的东西。
