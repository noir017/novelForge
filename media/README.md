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
| `src/editor/` | editor.js | 仅独立版 | 内置文件编辑器：两块编辑区、多标签（类型短标记与同名区分、临时标签、横向滚动与「▾」、右键移到另一侧 / 定位 / 重新打开）、工具栏面包屑、上一章 / 下一章、乐观锁保存、磁盘上的改动同步到已开的标签、关标签时问「保存 / 不保存 / 取消」、保存状态与自动保存、冲突时对比合并、历史版本面板、「转到…」（Ctrl+P 按章号 / 名字 / 路径跳到一章或一个文件）、自己管的撤销 / 重做、Tab 缩进、回车按分段格式另起一段、成对符号、段落快捷键、一键排版、查找替换（画在高亮镜像层上）、Markdown 预览（每个标签各记各的、切换时两边滚到同一处，Ctrl+Shift+V）、外观（字体 / 字号 / 行距 / 版心、护眼主题）与专注（专注模式 / 全屏 / 打字机滚动 / 段落聚焦）、主题与拖拽调宽、码字统计（状态栏字数那一格：全文 / 选中、距目标、本次 / 今日码字，点开是面板）、写作体检（正文里标出敏感词 / 禁用词 / 超限的比喻词 / 英文缩写，状态栏「体检」那一格与面板、一键替换）、名词补全（Alt+/ 与边打边弹：角色名、别名、设定与名录里的名字）、名词高亮（正文里角色名 / 设定名铺淡底色、未建条目画虚下划线，悬停看一句话、Ctrl+点击打开卡或条目）、全书查找替换（Ctrl+Shift+F，压在侧栏上的面板：按范围在全书里找、预览、勾选、经后端逐份替换）、快捷键一览（「帮助 → 快捷键一览」与 Ctrl+/；所有快捷键登记在 `shortcuts.ts` 一张表里） |
| `src/explorer/` | explorer.js | 仅独立版 | 侧栏「文件」页的资源管理器 |
| `src/bridge/` | bridge.js | 仅独立版 | 把 WebSocket 伪装成 webview API |
| `src/css/view/` | view.css | 两者 | 面板样式，全部走 `--vscode-*` 变量 |
| `src/css/standalone/` | standalone.css | 仅独立版 | 主题变量（深 / 浅 / 护眼三套）+ 工作台布局 + 正文排版那组变量（`look.css`） |
| `src/protocol.ts` | — | — | 从 `core/protocol` 转出全部消息类型 |
| `src/globals.ts` | — | — | 三个产物之间的交集（toast、右键菜单、自定义事件） |
| `src/dom.ts` / `src/vscodeApi.ts` | — | — | 建 DOM 的小工具、取 webview API 与收消息 |
| [icon.svg](icon.svg) | —（静态文件，不经构建） | 两者 | 活动栏与编辑器标签页图标。`stroke="currentColor"`，跟随主题色 |

各子目录的划分：

- **`src/view/`** —— `refs`（页面上固定 id 的节点）、`store`（运行时状态与草稿存取）、`format` / `buttons` / `toast` / `menu` / `menubar` / `welcome` / `folderPicker` / `tip`（通用件；`menubar` / `welcome` / `folderPicker` 探测不到 `#wbMenubar` 就 return，插件不受影响）、`paragraphMenu`（标题栏「编辑」菜单里段落那一组：段落格式 ▸、成对符号开关、一键排版、半角标点转全角——经 `MenuEntry.run` 接进 `menubar`，不往它的 `run` 分支表里加）、`versionsMenu`（「文件」菜单「另存为…」后面那一项「历史版本…」，同一个做法；置灰时原因挂在 `MenuEntry.detail` 的提示上）、`quickOpenMenu`（「文件」菜单「打开文件…」后面那一项「转到…」，同一个做法）、`bookFindMenu`（「编辑」菜单「替换」后面那一项「全书查找替换…」，同一个做法：`nf-bookfind-query` / `nf-bookfind-command`）、`viewMenu`（标题栏「视图」菜单，放在「编辑」与「帮助」之间：**一组一个函数**接在 `GROUPS` 里，之后的阶段往里加东西不碰 `menubar.ts` 的分支表；第一组是「单击打开为临时标签」，状态问编辑器 `nf-view-query`、开关发 `nf-view-command`）、`lookMenu`（「视图」里的「外观」「专注」两组，接在 `GROUPS` 的第二、三位）、`statsMenu`（「视图」里「统计」那一组：状态栏显示哪几项的三个开关与「重新开始计时」，状态自己问编辑器 `nf-stats-query`、发 `nf-stats-command`，不往 `ViewPrefsStatus` 里加字段）、`checkMenu`（「视图」里「统计」之后那一组「体检」：体检高亮、状态栏显示体检两个开关与「编辑敏感词表…」，同一个做法：`nf-check-query` / `nf-check-command`）、`namesMenu`（「视图」最后一组「补全」：「名词补全 Alt+/」与「边打边弹名词补全」，同一个做法，问 `nf-names-query`、发 `nf-names-command`）、`shortcutsMenu`（「帮助」菜单「使用说明」后面那一项「快捷键一览」，同一个做法：`nf-shortcuts-query` / `nf-shortcuts-command`）——**菜单上写的键（`MenuEntry.kbd`）一律从 `editor/shortcuts.ts` 取**（`shortcutLabel`，按平台写），不在菜单里写字面量、`tabs` / `state` / `messages` / `composer` / `history` / `tasks` / `logs` / `prompt`（各块；`prompt` 是独立版的后端弹窗：确认框一个 action 一颗按钮、回按钮上的字，带 `call` 的是调模型之前那一问——按钮上面多两个下拉框，回答带 `choice`）、`callFields`（调模型之前那两个下拉框的前端一半：模型「按分档」+ 按服务商分组的模型，详细度四级；批量表单的两个字段与 `call` 的取值、独立版确认框里那一块，2026-10-20）、`form` / `forms`（通用表单弹窗与一句话、拆细纲、批量写章三个具体弹窗——复用 `providerModal` 那层遮罩，两种形态都能用；调用次数的说明用的是 core 的 `describeCalls` / `planPlotBatches` / `planWriteBatch`，与后端确认框同源；表单支持 `select` 字段（`buildSelect`，选项带 `group` 收进 `optgroup`，独立版确认框也用它），拆细纲与批量写章末尾是 `callFields` 那两个下拉框（缺省按分档、`ViewState.contextDetail`），提交带 `call`——带了后端就不再弹确认框；`confirm` 让提交键两段式——「写完即定稿」第一下只换字、第二下才发，改了任何一个值退回第一段；拆细纲弹窗的「拆完展开本批新设定」缺省「否」，选「是」提交带 `expandLore`，那几次不在弹窗的数里、后端拆完再问；批量写章弹窗的说明末尾照工程树的 `loreThin` 提一句区间里要用到、还只有一句话的设定，句子是 core 的 `describeThinLore`，与后端确认框同一句，不拦）、`pipeline` / `workbench` / `commands`（创作页的三块：流水线条与下一步、当前产物浮窗、`/` 命令面板），外加 `project/` 与 `settings/` 两个子目录（`settings/skills.ts` 是设置页第三个子页「技能」：阶段绑定、从 GitHub 检查与安装、技能库；那一页改了当场生效，不进 `draft`，切过去时藏起「保存设置」）。`index.ts` 只做装配与消息分发。
- **`src/editor/`** —— `paneElements`（一块编辑区的类型与 DOM）、`pane`（工厂，两块编辑区是它的两个实例）、`store`（两块之间共享的状态与 localStorage，`Pane` 接口也在这里）、`api`（给编辑器里的功能模块用的公共接口：当前编辑区与文件、`isProse` / `indentUnit`、`isImeComposing`、`addKeyHandler`、`onEditorChange`，以及「编辑区里或页面上」那一档快捷键该给哪一块的 `paneForShortcut`）、`shortcuts`（**快捷键的唯一一张表**：键、做什么、分组、生效范围、浏览器拦不住的说明、菜单上哪一项写着它；纯数据加 `matchesShortcut` / `shortcutLabel` 这几个纯函数、零 DOM，view.js 的菜单也打包它）+ `shortcutsPanel`（「帮助 → 快捷键一览」与 Ctrl+/ 的面板）、`history`（每个文件一份的撤销历史，纯逻辑）、`indent`（Tab / Shift+Tab 缩进，纯函数）、`highlight`（高亮镜像层：按命名图层画 `<mark>`，按行分块、只换变了的那几块，顺带精确滚到某个字、量鼠标底下是哪一段）、`liveLayer`（跟着文字实时重算的图层共用的那一套：什么时候重算、打字 / 输入法 / 撤销时画着的那几段怎么跟上、长文字节流；体检与名词高亮用它）、`find`（查找替换条）与 `findCore`（它的纯函数，零 DOM；匹配口径本身在 core 的 `model/textFind.ts`，原样转出）、`paragraph`（下面五个的装配入口，`index.ts` 只调它一次）+ `paragraphState`（分段格式与编辑器偏好）/ `enter`（回车）/ `pairs`（成对符号）/ `lines`（段落快捷键）/ `layout`（一键排版、半角标点转全角、「排版」按钮）、`safety`（「不丢稿」那几样的装配入口，`index.ts` 同样只调一次）+ `diskSync`（磁盘上的改动同步到已开的标签）/ `saving`（保存本身：同一份只有一个在路上、状态栏的保存状态、磁盘上没了先问、自动保存的闸）/ `closing`（关标签时三选一、批量合成一次）/ `dialog`（页内对话框）/ `autosave`（自动保存）、`conflictMerge`（冲突条上的「对比合并…」）/ `replace`（`editorReplace` 的接收端：认 requestId、`rebase` + `applyEdit`）/ `versions`（工具栏「历史」与历史版本抽屉）、`quickOpen`（「转到…」面板，Ctrl+P）与 `quickOpenCore`（它的匹配与排序，纯函数、零 DOM）、`bookFind`（全书查找替换面板，Ctrl+Shift+F）与 `bookFindCore`（分组、勾选与计数、拼替换请求、状态与汇总的说法、行列 → 下标，纯函数、零 DOM）、`shell`（主题——深 / 浅 / 护眼三套轮着切——、拖拽、窄屏）、`look`（外观：把字体 / 字号 / 行距 / 版心写成 `<html>` 上那组 CSS 变量、编辑区里的字号快捷键、「视图 → 外观」的编辑器那一半）+ `lookPanel`（外观面板，照 `dialog.ts` 的写法、不是模态的）+ `lookCore`（取值表、上下限、偏好读回来的校验，纯函数、零 DOM）、`focus`（专注模式、全屏、「视图 → 专注」的编辑器那一半）+ `typewriter`（打字机滚动）/ `paragraphFocus`（段落聚焦，高亮镜像层的 `focus` 图层）+ `focusCore`（认当前段、算滚动目标，纯函数、零 DOM）、`chapterBar`（章节工作台的章节条，W6；五期加「审稿」；数据来自 `chapterIndex`）、`chapterIndex`（后端 `chapterIndex` 消息的接收端：章节顺序、两份文件的路径、状态、字数）/ `chapterNav`（上一章 / 下一章与 Alt+PageUp / Alt+PageDown）、`tabLabels`（标签上的名字：短标记 + 名字、同名的加最短区分目录，纯函数）/ `tabStrip`（标签条：横向滚动、当前那个滚进视野、「▾」列表）/ `tabMenu`（标签右键里关闭类之后那几项）/ `breadcrumb`（工具栏面包屑）/ `viewPrefs`（标题栏「视图」菜单的编辑器那一半）、`stats`（码字统计的装配：状态栏字数那一格、本次 / 今日码字、「视图 → 统计」的编辑器一半）+ `writingStats`（它的口径，纯函数、零 DOM）/ `statsDaily`（「今日码字」的 localStorage 与多窗口）/ `statsPanel`（点那一格弹出的面板）、`check`（写作体检的装配：高亮镜像层的 `check` 图层、状态栏「体检」那一格、「视图 → 体检」的编辑器一半、「编辑敏感词表…」）+ `checkCore`（四类怎么认、算几个问题、跳转与全部替换，纯函数、零 DOM）/ `checkPanel`（点那一格弹出的面板）、`names`（名词补全：Alt+/、边打边弹、候选框、名词表的收发、「视图 → 补全」的编辑器一半）+ `namesCore`（取查询词、匹配排序、边打边弹的判定、替换范围、正文里哪几段是名字，纯函数、零 DOM）+ `nameMarks`（名词高亮：`names` 图层、悬停浮窗、Ctrl+点击打开卡或条目、「视图 → 名词高亮」的编辑器一半）、`preview`（Markdown 预览的 DOM，每一块记着 `data-line` / `data-line-end`）+ `previewCore`（切块与源行号、编辑区与预览之间的滚动换算，纯函数、零 DOM）+ `previewSync`（切换时两边滚到同一处：编辑区借 `measureOffset` 量，预览按 `data-line` 量）、`clipboard` / `words`。- **`src/explorer/`** —— `state`（展开集合、剪贴板、高亮）、`actions`（发消息）、`rows`（建行与菜单）。

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
- **工程页分四个页签**（`view/project/tabs.ts`，2026-10-20）：概览（定稿进度横幅、「故事架构」「文风与摘要」）/ 章节 / 角色（连同「出场人物 · 未建卡」）/ 设定（连同「待完善」「出现过 · 未建条目」）。四页的内容**每次都全画**，各自装进 `#projectBody` 里一块 `.project-panel[data-project-panel]`，切页签只换哪一块露出来（`hidden`）——不重画、不往后端要数据，分组的右键菜单与三只浮窗挂在 `#projectBody` 上的事件委托都不必知道有页签；按 `#projectBody .group` 找分组的老代码与测试照旧找得到。当前页签只在前端、重推树不换页（`buildPanel` 按当前页签建块）；四页共用 `#projectBody` 这一个滚动容器（它不随重画换掉，重推树时滚动位置才留得住），各页滚到哪由 `tabs.ts` 记，切走时记、切回来放回去。页签条 `#projectTabs` 在 `panes.ts` 里，上面除了四个页签只有「刷新」——从前那五颗按钮（补齐架构、拆细纲、批量写章、＋ 角色卡、＋ 设定）在分组右键里都有，拿掉了；作品名与「N 章 · M 万字」那一块也拿掉了（字数在「章节」组标题上）。每页的主分组（章节 / 角色 / 设定）`buildGroup` 时传 `panel`：分组下面的空白处右键也给这一组的菜单（`.project-panel` 撑满可见高度）。「故事架构」里点已填的角色图谱 / 设定清单切到对应页签（`rows.ts` 的 `revealGroup`）。
- **工程页的树是扁平渲染的**（`view/project/rows.ts`）：`renderNodes` 递归遍历 `ProjectNode`，但产出的是**扁平的行数组**，层级靠 `paddingLeft` 缩进表达而非嵌套 DOM。折叠状态存在 `project/treeState.ts` 的 `openFolders`（relPath 集合）与 `openGroups` 里；切换折叠只用最近一次收到的树重画（`rerenderProject`），不往后端要数据。文件夹默认折叠，顶层分组默认展开。**「故事架构」那一组复用章节行的组件**（同样的 `.row-plot` / `.row-label`），所以按 `.row-plot` 取节点时要排掉 `.row-architecture`，否则「章节有几行」之类的判断会连架构五行一起数。空分组的「下一步：……」与说明行（`view/project/nextSteps.ts`）**不是** `.row`：它们不是树上的一项，没有右键菜单，也不该被「这一组有几行」数进去。
- **设定名录**（`view/project/rows.ts` 的 `buildLoreRow` / `buildLoreUnfiledRows`，筛选框在 `view/project/loreFilter.ts`）：设定行右边多一格出现章（`ProjectTree.loreByEntry[relPath].detail`，「第 3–57 章 · 12 章」，后端从定稿过的细纲第九节算好，前端不自己算），**另起一格、不截断**，不像角色行那样并进副标题——一句话副标题常有二三十字，并进去出现章永远被省略号吃掉；被挤掉的是一句话，`detailTip` 看得全。水位之后还有新内容的挂「＋N」，样子同角色卡（`.cast-pending`），tooltip 分水位是不是 0 两种说法。「设定」组后面紧跟「出现过 · 未建条目」（`loreUnfiled`，有才画）：一行是 名字〔分类〕· 出现章，右键「新建这条设定」发 `projectAction newLore`，带 `name`（后端不再弹框问标题）与建议分类的目录 `dir`（没分类就是设定根目录，目录还没有时后端建）；**点名字不做事**——建出来的是一份空条目，不放在手一滑就点到的地方。一次先画 30 个，点过「显示全部 N 个」记在 `treeState.loreView.showAllUnfiled`，重推树不缩回。
  - **待完善**（完善设定，2026-10-19，`buildLoreThinRows`）：「设定」组与「出现过 · 未建条目」之间一组「待完善 · N 个」（`loreThin`，有才画、默认展开）——往前看的一组（接下来几章要用、却还没有条目或条目还只有一句话），排在往回记的那一组前面。一行是 名字〔分类〕· 后端给的说明（「第 12 章起要用 · 只有一句话」）；有条目的点名字打开，还没有条目的点名字不做事、整行压暗（同未建条目）。右键「展开…（预计 1 次调用）」发 `expandLore`：有条目带 `relPath`，没有带 `name` 与 `category`（后端先按分类建空条目，再问一句要求、在对话页发一轮生成）。**每一条设定行**的右键也有这一项（`buildLoreRow`，有没有待整合都在，跟在「整合这一条」后面）。筛选框按名字 / 分类也筛这一组。组标题右键「全部展开（K 条，预计 K 次调用，最多 2K 次）」（三期）发 `projectAction: 'expandLoreAll'`：K 不算作者写过的（`LoreThinEntry.authored`，后端 `loreBatchExpandable` 算好），次数用 core 的 `loreExpandCalls`，与后端确认框同源；全是作者写过的就没有这一项。
  - **筛选框是纯前端的**：挂在「设定」组标题栏上、折叠开关旁边而不是里面（`buildGroup` 的 `head`；开关是一颗 `<button>`，放进去的话点框、按空格回车都会把组折起来）。筛选串记在 `loreView.filter`，不发后端，重推树照样留着。已建条目按标题 / 一句话 / `loreByEntry[].keywords` 匹配，未建条目按名字 / 分类，不分大小写的子串；筛选时有匹配的文件夹一律展开、没匹配的整个不画（`renderNodes` 的 `match`；`openFolders` 不动，清掉筛选就回到原来的开合），已建条目一个都没匹配上时说「没有匹配的设定」，未建条目一个都没有就整组不画；Esc 与 × 清空，开始筛时组折着就展开。
  - **打一个字整页重画一次，焦点得自己放回去**：`renderProject` 重建前记下筛选框的焦点与光标、建完放回新的那个框——文件监视随时会推树，不放回的话旁边保存一章就把正在打字的人踢出去。**输入法组字期间不重画**：中途的 `input` 不筛，这期间推来的树只记下不画（`loreFilterComposing()`），`compositionend` 那一下按最新的树一起画——组字中途换掉输入框，打了一半的拼音就没了。
- **细纲浮窗按需取、事件委托**（`view/project/summaryTip.ts`）：鼠标停在**章节行**上约半秒后弹出这一章的细纲（八节，空着的节不画）。没定稿的细纲是计划，头上标「计划」；定稿之后正文又改过的标「已过期」。还没有细纲的章浮窗会照实说，有正文的再提一句可以右键「定稿」照正文整理一份。细纲正文**不在** `ProjectTree` 里（那棵树每次文件变动都全量重推，塞进去等于每保存一次就推几百 KB），悬停时发 `requestSummary{plotRelPath}` 单章去要。**缓存只在收到 `project` 消息时清**——那说明磁盘变过；折叠文件夹走 `rerenderProject()` 不经那条分支，缓存留着。监听用事件委托挂在 `#projectBody` 上（行每次重渲染都换掉，逐行 `addEventListener` 会堆积），浮窗与右键菜单同样是挂在 `body` 上的 `position: fixed`。
  - **浮窗是可以进去的**：细纲有八个小节、可能上千字，一瞥看不完。鼠标移上去就一直留着，能滚动、能选中复制，移开才收。所以**不能**给它 `pointer-events: none`，收起也**必须有宽限期**（`CLOSE_DELAY_MS`）——从行挪到浮窗要跨过一道缝，那一两帧鼠标既不在行上也不在浮窗上，立刻收会让浮窗永远够不着。
  - **收起要分清是谁在滚**：页面滚动会让 fixed 的浮窗和目标行脱节，得收；但**浮窗自己内部的滚动不算**，一滚就收等于那个滚动条形同虚设。捕获阶段的 `scroll` 监听里用 `hoverTip.box.contains(e.target)` 区分。Esc 与右键仍然立刻收（右键菜单也是 fixed，会叠在一起）。
  - **定位必须夹进视口**：`place()` 横向左对齐目标行、右边溢出往左收；纵向优先放下方，放不下翻上方，**两边都放不下时选空间大的一侧并压行内 `max-height`**——只翻转不压高度的话，一份长细纲在矮窗口里会有一截永远够不到。量高度前要先清掉上一次的 `maxHeight`，否则会一直沿用之前那个更矮的值；内容后到达（`applySummary`）把浮窗撑高后要重新走一次定位。
- **三只浮窗，各有取舍**（`view/project/` 下的 `summaryTip` / `detailTip` / `errorTip`）：定位（`view/tip.ts` 的 `placeTip`）与事件委托是同一套（挂 `body`、`position: fixed`、委托在 `#projectBody` 上），区别只在**要不要让鼠标进去**。`detailTip` 只复读一行被截断的副标题，`pointer-events: none` 收起不留宽限；`summaryTip` 与 `errorTip` 的内容是多行、要能滚动与选中复制，所以必须留宽限期。`errorTip` 还有一点不同：**数据不必向后端单取**——失败记录随 `ProjectTree.failures` 一起推来了（一条几十字，且只有出错的目标才有），直接读 `treeState.lastTree` 即可。
- **失败标记是「解析失败只有日志、用户看不见」的界面出口**（`view/project/rows.ts` 的 `failureMark`）：出错的行在文件名之前插一个感叹号，红色 = 整体失败、目标一字未改，黄色 = 部分完成、下次会重来；同一目标混着两种时**按最严重的算**。感叹号还带原生 `title` 兜底（浮窗要等 300ms）。旧后端推来的树没有 `failures` 字段，`lastTree?.failures?.[relPath]` 的可选链是有意的，别把它简化掉。
- **一套菜单引擎、两个入口**（`view/menu.ts`）：`buildMenuElement(items, className)` 由 `{ label, run, danger, disabled }`（`{ sep: true }` 是分隔线）建出菜单 DOM。气泡右上角的 ⋯ 用 `.msg-menu` 绝对定位贴在 `.msg-head` 里；右键用 `.ctx-menu` 挂到 `body` 上 `position: fixed` 跟着光标走（工程页有内部滚动，挂在容器里会被裁掉），贴边时翻转。同时只有一个菜单，点别处 / Esc / 滚动都收起。
- **创作页只推荐一个动作，其余走 `/`**（`view/pipeline.ts` + `view/commands.ts`）：主按钮来自后端状态机算出的 `next`，**点了就跑**，输入框可留空——「写第 N 章细纲」本来就不需要作者再说什么。**发送时用 `next.target` 与 `next.range`，不用会话当下的 target**：全书层的下一步常常落在另一份产物上（会话停在大纲，下一步是给第 1 章拆细纲），从前只覆盖 stage 与 capability，按钮上写着一件事、落盘时写到了另一处。其余命令收在 `/` 面板里——**只有会写文件的**（生成，细纲层多一条 `/落定细纲`；目标是一条设定时生成叫 `/展开这条设定`，`/展开` 就挑得中，`commandsFor` 收 `store.session.target` 分得出来；每一层末尾都有一条 `/落定设定`，它带着自己的 `stage` 与 `target`（设定目录），挑中后 chip 记着它们、发送时用它们而不是会话那一层，回到哪由后端管）；讨论不是命令，打字就是。挑中变成输入框里的一枚待执行 chip，用完即清。命令表来自 core 的 `commandsFor`（零 import 的纯函数，前端直接打包），**前端不自己维护一份**——否则界面上会出现后端不认的命令，点了什么都不发生。
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
- **工作区卡是一只悬停浮窗**（`view/workbench.ts`）：流水线条上留一个一行高的入口（`#workbench`，只写「当前产物 · 正文」这样的层名 `WorkbenchView.layer`——章名已在面包屑上，完整标题 `title` 在浮窗头上；也不挂 ▤，那是标题栏「显示 / 隐藏编辑器」的图标），悬停浮出这一层的产物，**点一下钉住**（照着细纲写正文时鼠标要回输入框），Esc / 再点一次 / 点别处收起。从前它是消息流顶部一张 `position: sticky` 的卡片——滚不出视野，代价是永远占着消息流最上面那一块，而且**既关不掉也藏不起来**（只能折叠成一条标题栏，那条标题栏还在），侧边栏只有三百来像素宽，一份细纲能吃掉半屏对话。改成浮窗之后 `renderSession` 不必再把卡片节点放回 `#messages` 了。
  - **写前提醒**（完善设定三期）：`WorkbenchView.notice`（正文目标上「本章要用的 天机阁 还只有一句话」）在浮窗里是淡色的 `.wbt-notice`、入口上是淡色的 `◌`（`.wbt-entry-mark.is-notice`），与上游变过的 `⟳`（`warning`）分开——只是提个醒、零调用、不拦；两样都有时入口仍是 ⟳。
  - **类名用 `wbt-` 而不是 `wb-`**：`wb-` 是**独立版工作台外壳**的命名空间（`css/standalone/workbench.css` 的 `.wb-title` 是那条 38px 高的标题栏、`.wb-side` 是侧栏）。改造前这张卡的标题也叫 `.wb-title`，于是在独立版里被标题栏那条规则套上了 38px 高度与标题栏底色。
  - **不监听 scroll**，这是它与另外三只浮窗唯一的不同：那三只的目标是工程页里会滚动的行，页面一滚就得收；这个入口长在不滚的流水线条上（`.pipeline` 是 `flex: 0 0 auto`），消息流滚动时它一动不动。照抄那条会让「滚上去看前一轮对话，同时对着这一段的细纲」变得不可能——而那正是钉住要解决的情形。
- **四只浮窗共用一份定位**（`view/tip.ts` 的 `placeTip`）：挂 `body`、`position: fixed`、横向左对齐目标（右溢出往左收）、纵向优先下方（放不下翻上方、两边都不够就压 `max-height`）。从前这套几何在 `summaryTip` / `detailTip` / `errorTip` 里各抄了一遍。`minHeight: 0` 关掉压高度那一步，只有 `detailTip` 用它——那只浮窗只有一行、`pointer-events: none`、滚不动，压出来的 `max-height` 等于把字截掉。
- **右键菜单靠 WeakMap 登记**：构建某一行时用 `onContextMenu(row, () => items)` 把「这行右键给什么」记在元素上（那一刻上下文最全，不用右键时反查最近那棵树；行被重渲染丢弃后自动回收）。全局 `contextmenu` 监听从 `e.target` 向上找第一个登记过的祖先，找不到就用兜底的「刷新」。**刷新复用已有的 `projectAction: 'refresh'`**——后端那个分支只是 `pushState()`，会按当前页签推数据，天然适用于所有页面，无需新增协议。
- **右键一律接管**：全局监听里无条件 `preventDefault()`，输入框 / 文本域 / 内置编辑器里也一样，所以**原生的复制/粘贴/剪切菜单不会出现**。这是有意的取舍（菜单风格统一），代价是这几处的编辑项要自己实现（编辑器正文区与文件页已经做了，见 `editor/clipboard.ts` 与 `explorer/rows.ts`；输入框里目前只有「刷新」）。插件形态另需 [../src/shells/vscode/webviewHtml.ts](../src/shells/vscode/webviewHtml.ts) 的 `<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>`：VS Code 给 webview 右键菜单加的复制/粘贴项由宿主渲染，JS 的 `preventDefault` 压不住，不加会同时冒出两层菜单。**监听挂在 `window` 的捕获阶段**，并额外接管副键的 `auxclick`：冒泡阶段的监听会被中途任何一处 `stopPropagation()` 挡掉，而触控板双指点击在部分浏览器/驱动上只发 `auxclick`、不发 `contextmenu`——两种漏法的现象都是「弹出原生右键菜单」。同一次点击的尾巴（落点没动、300ms 内）只挡不弹，免得一下点击弹两遍。`pointerdown` / `mousedown` 的默认行为**不碰**：按规范取消它们拦不住 `contextmenu`，却会把 `mousedown` 一起吃掉，于是文本域里右键不再挪光标，菜单里的「粘贴」会贴到上一次光标的位置去。触摸长按的原生 callout 走的不是 `contextmenu`，在 CSS 里用 `-webkit-touch-callout: none` 关（`css/view/base.css`）。
- **DOM 结构只有一份**：工程页页签条等结构在 [../src/shells/shared/panes.ts](../src/shells/shared/panes.ts)，两个壳都从那里取，**加按钮只改那一处**。（从前两个壳各存一份，这条规矩是「要同时改两处」；现在前提没了。）两处例外：一是工作台外壳与编辑器容器只在独立版的 `page.ts` 里——那是布局，本该按宿主分叉；二是草稿那块编辑区的 DOM 由 `editor/paneElements.ts` 的 `createPaneElements()` 克隆主区结构现造，`page.ts` 里只有容器 `#wbEditors` 与分隔条 `#wbDraftResizer`。编辑区里由脚本现造的几样（章节条 `chapterBar.ts`、查找替换条 `find.ts`、高亮镜像层 `highlight.ts`、状态栏上「自动保存」那一枚 `saving.ts`、标签条里的 `.ed-tabs-list` 与「▾」`.ed-tabs-more`（`tabStrip.ts`，模板里只有空的 `.ed-tabs`）、工具栏面包屑的各段（`breadcrumb.ts`，填进 `.ed-path`））**两边模板里都没有**，各自只有一个生成函数，两块编辑区共用；编辑器的页内对话框（`dialog.ts`）挂在 `body` 上、现造现拆。
- **宿主差异用能力探测，不判断环境**：只有 VS Code 有原生设置界面，所以「在 VS Code 设置中打开」这颗按钮**在独立版的页面里根本不存在**（`settingsPane({ nativeSettings })`），前端用 `maybeById` 取不到就跳过。别改回「渲染出来再 hidden 掉」或「看 state 里的某个环境位」——那条路走过，界面文案会跟着腐烂（见 [../src/shells/README.md](../src/shells/README.md)）。
- **CSP**：webview 的 CSP 只允许本地资源与 nonce 脚本，不引任何 CDN / 外部脚本。独立版同样不引外部资源。
- **两形态隔离**：`standalone.css` 与 `editor.js` / `explorer.js` **只**由独立版加载，插件的 `webviewHtml.ts` 里没有它们，也没有 `#wbEditor` / `#filesBody` 容器。给独立版加样式请只改 `src/css/standalone/`（必要时用 `.workbench` 前缀覆盖 view 的规则），不要为独立版去动 `src/css/view/`。
- **能力探测而非环境判断**：`view/store.ts` 里用 `document.getElementById('wbEditor')` 判断有没有内置编辑器，据此决定「打开文件」发 `openEditor` 还是 `openFile`；`editor/index.ts` 与 `explorer/index.ts` 各自开头探测自己那块容器（`#wbEditor` / `#filesBody`），不在就直接 return（连 `acquireVsCodeApi()` 都不调——webview 里那个函数只允许调一次）。插件里没有这些容器，行为不变。
- **跨文件只经三样东西**（全在 `src/globals.ts`）：`window.__nfToast`（view 出，editor / explorer 用）、`window.__nfContextMenu` / `window.__nfShowMenu`（view 出的右键菜单登记函数，与「在某处弹一个菜单」——编辑器标签条的「▾」用，同一个菜单引擎、同时只有一个）、几个自定义事件——`nf-editor-active`（editor → explorer，高亮当前文件）、`nf-files-moved`（explorer → editor，改名后搬标签）、`nf-reveal-in-files`（editor → explorer + view：面包屑目录段、标签右键「在文件页中定位」；资源管理器展开到它、标出那一行 `.fx-revealed`，view 切到「文件」页），以及标题栏与编辑器之间的 `nf-editor-query` / `nf-editor-command`（保存、撤销那一组，外加「文件 → 自动保存」：`query` 里的 `autoSave`、`command` 的 `toggleAutoSave`）与 `nf-paragraph-query` / `nf-paragraph-command`（「编辑」菜单段落那一组）、`nf-versions-query` / `nf-versions-command`（「文件 → 历史版本…」）、`nf-quickopen-query` / `nf-quickopen-command`（「文件 → 转到…」）、`nf-bookfind-query` / `nf-bookfind-command`（「编辑 → 全书查找替换…」）、`nf-view-query` / `nf-view-command`（「视图」菜单；`query` 里的 `look` / `focus` 两个字段归外观与专注那两组）、`nf-stats-query` / `nf-stats-command`（「视图 → 统计」）、`nf-check-query` / `nf-check-command`（「视图 → 体检」）、`nf-names-query` / `nf-names-command`（「视图 → 补全」）、`nf-shortcuts-query` / `nf-shortcuts-command`（「帮助 → 快捷键一览」），以及对话页「加入选区」问内置编辑器选区的 `nf-selection-query`（独立版宿主取不到网页里的选区，前端问到了就随 `addSelection.selection` 带上去；没选中、在 Markdown 预览里、或者是插件形态没人回答时不带，交给宿主——插件读 VS Code 选区，独立版弹粘贴框）。**`editor/shortcuts.ts` 不是第四样**：它是一张纯数据表（零 DOM、零模块状态），view.js 打包一份只为在菜单上写键，两个产物之间不经它传任何东西。别让 explorer 直接读 editor 的 `panes`——那会把编辑器的内部状态变成两个文件之间的契约，而资源管理器在插件形态里根本不存在。右键菜单尤其**不能各起一套**：全局 `contextmenu` 监听在 view 里，另起一个会两层菜单一起弹。
- **不拼 HTML 字符串渲染用户内容**：一律 `createElement` + `textContent`（`src/dom.ts` 的 `el()` 就是干这个的），正文里写 `<script>` 也只是普通文字。
- **一排控件共用一套尺寸，主按钮靠颜色跳出来**（`css/view/buttons.css` 的 `--nf-ctl-height` / `--nf-ctl-padding-x` / `--nf-ctl-radius`）：`.primary` / `.secondary` / `.danger` / `.chip-btn` / `.composer-tool` 与 composer、日志页工具栏里的下拉框、数字框同高。从前主次按钮是 `5px 12px` + 13px 字号，在一排 0.8em 的小控件中间粗一号——「写第 N 章」「保存」「发送」于是成了三块各占一角的色斑。要改高度只动那三个变量。
  - **尺寸挂在变体类上，不挂在裸 `button` 上**：页面上大半的 `button` 不是「一排控件里的一颗」——菜单项、页签、标签页的关闭叉、chip 上的 ×、命令面板的每一项、流水线条上的那几层，各有各的高度。`min-height` 写在裸 `button` 上会把它们全拽到 24px（`min-height` 压得过它们自己的 `height`，而它们都没声明 min-height 来挡）。裸 `button` 只留字体、光标、圆角这类人人都要的。
  - **`forms.css` 的 `width: 100%` 要在工具栏里收回来**：那条规则是给设置页那种「一列一个字段」定的；工具栏一行摆好几颗控件，不写 `width: auto` 的话下拉框会独占一整行，把后面的按钮挤到第二行（日志页曾是这样）。
- **预览与等宽字体是两件事**：章节可以是 `.txt` / 无扩展名，那时没有 Markdown 可预览（隐藏「预览」按钮），但它仍是正文，该用正文字体；只有 `.json` / `.yml` 这类结构化文件才加 `.mono`。
- **两处 `countWords` 口径不同，别合并**：`editor/words.ts` 的与 core 一致（中文按字、英文按词），状态栏上的字数要与工程页上后端算的对得上（写法是一趟循环、不造中间数组，结果与 core 的正则写法逐字对拍，见 `tests/unit/editor/writingStats.test.js`）；`view/format.ts` 的统计模型回复长度（去空白后的字符数），是另一件事。

## 内置编辑器的行为约束

对应「不静默覆盖」这条产品承诺（见 [../AGENTS.md](../AGENTS.md)）：

- 保存带**内容 hash 乐观锁**。磁盘上的 hash 与编辑器基线不一致（作者在别处改过、或插件写入过）时保存被拒，前端弹冲突条，由用户在「对比合并…」「用磁盘版本覆盖编辑器」和「用编辑器内容强制保存」之间选。
- 只有用户明确点了「强制保存」（页内对话框里再确认一次），才会发不带 `baseHash` 的 `saveFile`。
- **「对比合并…」不写盘**（`editor/conflictMerge.ts` + `replace.ts`）：发 `mergeWithDisk`（带编辑器里的这一份与 requestId），后端读磁盘上此刻的那一份开合并视图（左磁盘、右编辑器），采纳后回 `editorReplace` 带 `base`。前端**先 `Pane.rebase`**（乐观锁基线换成磁盘那份、收起冲突条）**再 `applyEdit`** 换内容——顺序反过来的话，换内容那一刻的脏标记是对着旧基线算的。结果是一步撤销、仍是未保存，作者照常 `Ctrl+S`，不必强制保存。`rebase` 与冲突条上「用磁盘版本覆盖」同一套收尾：`diskSeen` 里见过的磁盘新版作废（`knownDiskHash` 回到新基线，之后磁盘再变——哪怕变回撞冲突时见过的那一份——核对时照样报）、`file.gone` 清掉、自动保存的闸放开（`saving.unblockAutoSave`：基线换了本来也会让闸失效，但磁盘那份正好变回撞冲突时的基线时 hash 一样，闸会一直关着），之后照常停笔就存。磁盘上已经没有这一份（`gone`）时冲突条也亮着，那时没有磁盘版本可合并，按钮藏起来（与「用磁盘版本覆盖」同一个判法）。放弃 / 关掉合并视图后端什么都不回，什么都不变。按钮由模块在每块编辑区第一次重画时插进冲突条（说明文字之后），`page.ts` / `createPaneElements` 里没有它；冲突条的显隐与说明文字仍归 `pane.ts`。
- **`editorReplace` 只认本页发的 requestId**（`replace.ts` 的 `newRequestId` / `claimRequest`）：回复是广播，同一个工程开着两个窗口时，另一个窗口里那份不该被换掉。
- **历史版本面板只换编辑区，从不写盘**（`editor/versions.ts`；快照由网关存，见 `src/core/workspace/README.md`）：工具栏「历史」（每块编辑区一颗，第一次重画时插到「保存」前面）与「文件 → 历史版本…」打开 `.ed-stage` 里右侧的抽屉 `.ed-versions`，开着时 `.ed-stage` 加 `ed-stage-versions` 让出那一截宽度（正文区同时看得见，高亮镜像层按 textarea 的实际宽度排，跟得上）。抽屉跟着这块编辑区的当前文件走：换了文件重发 `listVersions`，保存回执到了（`hash` 变了）也重拉（自动保存几秒一次，一秒最多拉一次，只发最后那次）；标签全关了就收起。选中一版先 `readVersion` 要全文给预览，「恢复这一版」拿那份全文直接 `applyEdit`（一步撤销，成为未保存，基线不变），「对比…」发 `compareVersion`、收 `editorReplace`（不带 `base`）。**放回之前磁盘上那一份先强制存一版**：恢复前前端发一条不说话的 `saveVersion { quiet: true }`（消息按顺序到，排在之后任何一次 `saveFile` 前面），对比与冲突合并由后端在回 `editorReplace` 之前自己存——放回的内容一存盘就盖掉它，而节流按「改动小」可能不存。开着自动保存时放回的内容照常停笔 2 秒就存（与打字一样，不另设闸），面板上多说一句。能不能用看 `unavailableReason`：没开文件、没给 `kind`（没打开工程）、`ViewState.initialized === false`（还不是小说工程）、`kind === 'other'` 时按钮与菜单项置灰、提示里写原因——与 `isProse` 同一条原则，**前端不拿路径猜**，后端也会再判一次（`versions.unavailable`）。
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
  - **排得一模一样**靠两样：一是**排版参数是一组 CSS 变量**（`css/standalone/look.css`：`--nf-ed-font-family` / `--nf-ed-font-size` / `--nf-ed-line-height` / `--nf-ed-measure` 由 `look.ts` 按偏好写在 `<html>` 上，`--nf-ed-pad-x` / `--nf-ed-pad-y` / `--nf-ed-pad-bottom` / `--nf-ed-gutter` 是 CSS 自己的），`.ed-area` 与 `.ed-mirror-content`（还有 `.ed-preview`）**写在同一条规则里读它们**——要改正文的字号、字体、行距、内边距，改变量或那一条规则，**不许**给 textarea 或镜像层单写一份、也不许在 JS 里往元素上写 `style.fontSize`；二是每次渲染时仍从 textarea 的**计算样式**抄（字体、字号、行高、字距、内边距、`white-space` / 断行规则、`tab-size`……，`.mono` 文件换了字体也跟得上），宽度取 textarea 的内容区（扣掉竖滚动条，用 `getBoundingClientRect` 的小数宽度），滚动用 `transform` 跟着平移。外观一变（`look.ts`）各块镜像层当场重抄一遍（`relayoutMirror`：字号变了而 textarea 尺寸没变时 `ResizeObserver` 不会叫）。CSS 里**不许**给 `<mark>` 加内边距、边框、字重——任何一样都会让两层排得不一样。
  - **版心居中按容器宽算**：`.ed-stage` 是 `container-type: inline-size`，左右内边距是 `max(--nf-ed-pad-x, (100cqi - --nf-ed-measure - --nf-ed-gutter) / 2)`。用 `cqi` 而不是百分比：textarea 与镜像层落在同一个容器里，算出来一样；百分比按包含块算，镜像层的包含块比 textarea 窄一条滚动条，两边会差半条。整段包在 `@supports (width: 1cqi)` 里，不认容器单位的旧浏览器照旧铺满（不至于把内边距算成 0）。
  - **接口按命名图层**：`setHighlights(pane, layer, ranges)` / `clearHighlights(pane, layer)`，`ranges` 是 `{ start, end, cls }`（`area.value` 的下标，`cls` 是那一段 `<mark>` 的 class，颜色写在 `highlight.css`）；几层叠在同一段字上时那一段带上几层的 class。查找用 `find` 这一层，段落聚焦用 `focus` 这一层（`<mark>` 不画底色、用实色画字，见下面「外观与专注」），写作体检用 `check` 这一层（只画下划线，敏感词另加淡底色，见下面「写作体检」），名词高亮用 `names` 这一层（角色 / 设定淡底色、未建条目虚下划线，见下面「名词高亮」）；再要新的就另起图层名，**别另起一层镜像**（各抄一遍排版，对不齐的地方会翻倍）。三层叠在同一段字上时各管一样：`find` 管底色、`focus` 管字色、`check` 管下划线（`check.css` 的选择器套 `:where()` 降一级，敏感词的淡底色永远盖不过查找的底色）。
  - **什么时候重画**：`setHighlights` / `clearHighlights` 当场画；换了文件所有图层清空（范围是给上一个文件算的）；内容变了各层先按这一处改动平移（压在改动上的丢掉）、下一帧重画——调用方自己下一帧重算再 `setHighlights` 的话那一帧只画一次；切预览当场藏；尺寸变了只重摆位置（`ResizeObserver`，没有就不管）。超过 `HIGHLIGHT_LIMIT`（30 万字符）不画，要不要告诉人由调用方定（`tooLargeToHighlight`，查找条会说一句）。
  - **按行分块，只换变了的那几块**：镜像里一行（按 `\n` 切，行尾的 `\n` 留在这一行里）一个 `<div>`，每块记着「这一行的字 + 落在这一行的那几段」（跨行的高亮切成几截）；重画时与上一次逐块比，头尾对得上的块原样留着，只换中间那一截——打一个字只重建、重排一行。从前整份 `replaceChildren`，三万字的章节、几百上千处标记时每敲一下要 20~30ms，分块之后不到 2ms（headless Chromium 实测，与整份一个 div 的排法逐个标记比过位置，差 0px）。排版不变的理由：`pre-wrap` 里块尾那个 `\n` 不多出一行（与 textarea 一样），空行是只有一个 `\n` 的块，以 `\n` 结尾时末尾空行单独一块放零宽空格；`text-indent` 只留给第一块（`highlight.css`）。抄样式、摆位置也只在值变了时才写（写同样的值可能让浏览器把这一层标脏、整份重排）。
  - **鼠标底下是哪一段**：`rangeAtPoint(pane, layer, x, y)`。镜像 `pointer-events: none`，鼠标事件全在 textarea 上，而浏览器按坐标取字（`caretPositionFromPoint`）在 textarea 上靠不住（Chromium 时有时无，WebKit 没有），所以反过来量镜像：按纵向二分找到那一块，再在块里量那几个 `<mark>`（`getClientRects`，折行的每一截都量）。只认画着的图层；名词浮窗用它。
  - **顺带的精确定位**：`scrollToOffset(pane, offset, { onlyIfHidden })` 在一份看不见的镜像（`.ed-mirror-probe`）里排出这个字之前的文字与它所在那一行、把这个字包进标记量 `offsetTop`，把它滚到视口偏上三分之一。审稿引文定位（`Pane.reveal`）与查找跳转（`onlyIfHidden`：已经看得见就不滚）都用它；打字机滚动用同一个量法（`measureOffset`）把光标那一行滚到中间，名词补全的候选框也用它（多量一个 `left`）贴着光标摆。从前按字符位置占全文的比例估，段落长短不一时能差出好几屏。量不了（太大、textarea 藏着）时退回按比例估。
- **查找替换条**（`editor/find.ts`，纯函数在零 DOM 的 `editor/findCore.ts`）：每块编辑区一条，只作用于这一块的当前文件。
  - **结构约定**：DOM 只由 `find.ts` 的 `buildFindDom()` 生成，两块编辑区都在第一次用到时现造、插在 `.ed-stage` 前面；`page.ts` 与 `createPaneElements()` 里都没有它（`tests/dom/standalone/find.test.js` 守着：渲染出来的页面模板里不许出现 `ed-find`）。从前查找条两边各写一份、靠人对齐，加了替换行与两颗开关之后再抄两份只会越抄越歪。节点没有 id（两块各一条），按 class 取：第一行 `.ed-find-toggle` / `.ed-find-input` / `.ed-find-case` / `.ed-find-regex` / `.ed-find-count` / `.ed-find-prev` / `.ed-find-next` / `.ed-find-close`，第二行 `.ed-replace-row` 里的 `.ed-replace-input` / `.ed-replace-one` / `.ed-replace-all`，底下一行提示 `.ed-find-note`。
  - **改写只走 `applyEdit`**：替换一处一步撤销；全部替换由 `findCore.replaceAllIn` 算出「第一处到最后一处那一段」的新文字，一次 `applyEdit`、只记一步。
  - **匹配口径只有一份**：`findCore` 里找匹配、展开 `$1`、全部替换那一半原样转自 core 的 `model/textFind.ts`（零 import，经 `protocol.ts` 打包）——后端的全书查找替换在磁盘上找的用的是同一份，同一个查找串、同两颗开关在一份文件里与在全书里找到的是同一批（`tests/unit/editor/findCore.test.js` 钉着两边是同一个函数）。
  - **借给全书查找定位**：`revealFindMatch(pane, query, opts, offset)`——这一块的查找条换成那边的查找串与两颗开关，选中离 `offset` 最近的那一处（与查找框里打字之后选中一处同一个 `select`）、焦点进编辑区。
  - **不夺焦点**：打字时从光标往后找、选中匹配，但焦点留在查找框（人还在打字）；textarea 没焦点时原生选区看不见，当前那一处靠高亮层的另一种颜色（`ed-hl-find-current`）标出来。`Esc` 关掉时焦点才回编辑区。
  - **快捷键**由 `installFind()` 挂在 document 上：`Ctrl+F` / `Ctrl+H` / `F3` 给焦点所在的那一块（焦点在页面上、按钮上时给当前那一块；**带 Shift 的不接**——`Ctrl+Shift+F` / `Ctrl+Shift+H` 是全书查找替换）；焦点在编辑区之外的输入框 / 文本框（对话输入框之类）时**不拦**，留给浏览器；那一块没开文件也不拦。编辑区里的 `Esc` 收起查找条。标题栏「编辑 → 查找 / 替换」经 `nf-editor-command`（`find` / `replace`）。
- **对「用户刚输入了什么」做反应，只认 `onEditorChange` 里带 `change` 的那一下，不认 keydown**（`editor/pairs.ts`）：中文标点几乎都是输入法打出来的，keydown 里看不到那个字，有的输入法还走一遍组字、`compositionend` 才上屏。`typing` 与 `composition` 两种来源都带 `change`（被替换掉的选区也在 `change.removed` 里），成对符号就靠它包选区、补右半边；补的那一下 `join: true`，与那次输入算一步撤销。在监听里调 `applyEdit` 会再发一条 `edit`，自己记一个标志跳过它。
- **按键归谁按功能分模块挂 `addKeyHandler`**（键本身一律先登记在 `shortcuts.ts`，见下面「快捷键」）：回车 / Shift+Enter 在 `enter.ts`，`Alt+↑↓`、`Shift+Alt+↑↓`、`Ctrl/Cmd+Shift+K`、`Ctrl/Cmd+Enter` 在 `lines.ts`；彼此不重叠，挂的顺序无所谓。没得可做（到顶、全是空行）也返回 true 接下这一下——这几个组合键浏览器的缺省动作在编辑区里没有用。**例外是名词补全**（`names.ts`）：`Alt+/` 归它，候选框开着时 `↑↓` / `Enter` / `Tab` / `Esc` 也先归它（边打边弹时回车不接，放给 `enter.ts`），所以 `installNames` 在 `installParagraphTools` 之前装。
- **分段格式是工程的设置，前端只读**（`editor/paragraphState.ts`）：从 `init` / `state`（`ViewState.paragraphStyle`，哪个页签都推）与 `project`（工程树，只在「工程」页签开着时推）里取，缺省 `blank`。切换是标题栏「编辑 → 段落格式」发 `setParagraphStyle`，后端只改 `config.md` frontmatter 的这一个键再 `pushState`，新值随下一条 `state` 回来——前端不先改本地的值。回车插什么、一键排版排成什么样都打包 core 的 `model/paragraphFormat.ts`，与后端同一份。
- **编辑器偏好按浏览器记**：localStorage `novelforge.editor.prefs`（不按工程分键，那是作者的手感，不是这本书的设置），一个对象：成对符号自动补全（缺省开）、自动保存（缺省关，只认明明白白的 `true`）、单击打开为临时标签（缺省开，只认明明白白的 `false`），外加外观四项（`fontFamily` / `fontSize` / `lineHeight` / `measure`）、专注三项（`focusMode` / `typewriter` / `paragraphFocus`，只认明明白白的 `true`；全屏不记），以及码字统计的 `stats` 子对象（`{ goal, session, today }`）、写作体检的 `check` 子对象（`{ highlight, status }`，两个都缺省开、只认明明白白的 `false`）、名词补全的边打边弹（`nameAutoPopup`，只认明明白白的 `true`，关掉就删掉这一项）、名词高亮（`nameHighlight`，缺省开、只认明明白白的 `false`，打开就删掉这一项）。前三项归 `paragraphState.ts`，其余各归各的模块（`look.ts` / `focus.ts` / `stats.ts` / `check.ts` / `names.ts` / `nameMarks.ts`）。**往这个键里写的模块一律读出整份、合上自己那几项再整份写回**（`paragraphState` 的 `storedPrefs` / `setStoredPrefs`；localStorage 读得到时每次都以它为准，读不了、写不进时以内存里那一份为准），谁也不冲掉谁；读回来的坏值各自逐项回落缺省（外观与专注在 `lookCore.ts`，越界的夹进上下限；写坏了不是 JSON 的整份当没记过）。写不进去时只在内存里生效。主题不在这里：照旧是 `novelforge.theme`。
- **只对正文出现的工具栏按钮由功能模块自己插**（「排版」，`editor/layout.ts`）：在每块编辑区第一次 `render` 时插到「预览」后面、之后跟着当前文件显隐，`page.ts` 与 `createPaneElements` 里没有它——两块编辑区走同一条路，`pane.ts` 不必知道它。
- **快捷键先登记、再处理**（`editor/shortcuts.ts`，见下面「快捷键」）：新增或改一个快捷键，先在那张表里写上键、做什么、分组、生效范围；菜单上的 `kbd`、快捷键一览、按钮提示里写的键都从表取，不写字面量。处理按键的地方照旧各管各的，`tests/dom/standalone/shortcuts.test.js` 两头守着表与处理对得齐。
- **预览按标签记，切换只走 `Pane.setPreviewing`**（见下面「Markdown 预览」）：`activate` 只切标签、不再顺手切回编辑——要「先切回编辑」的模块调 `setPreviewing(false)`。

## 快捷键（`editor/shortcuts.ts`）

快捷键的唯一一张表：每一条写着键（`Mod+Shift+F` 这样，`Mod` 是 Windows / Linux 的 Ctrl、Mac 的 ⌘）、做什么、分组、生效范围、补充说明（浏览器拦不住的写在这里）、菜单上哪一项写着它（`menu`）。纯数据加几个纯函数、零 DOM、没有模块状态（`tests/unit/editor/shortcuts.test.js` 钉着：不撞键、每条写全、按平台写、按法怎么认、筛选）。

- **生效范围四档**：`global` 哪里都行（焦点在对话输入框里也认：保存、转到、全书查找、专注、快捷键一览……）；`workbench` 编辑区里或页面上——焦点在对话输入框这类别的输入框里时不拦，留给浏览器（查找、F3、上一章 / 下一章、预览；该给哪一块用 `api.ts` 的 `paneForShortcut`）；`editor` 光标在正文里（`addKeyHandler`，组字中途收不到）；`context` 某个面板开着时或某个页面上（必须写 `where`：查找框里的回车、补全框里的方向键、文件页树上的 Ctrl+C……）。前三档会同时收到同一下按键，三档之间一种按法只许归一条；`context` 在同一个 `where` 里不许重。
- **新增快捷键**：先在表里加一条（菜单上也写着它就填 `menu`），再去处理按键的模块里认它——能用 `matchesShortcut(e, id)` 就用它：它不许多按修饰键（`Ctrl+Shift+S` 不是 `Ctrl+S`，`Ctrl+Alt+S` 也不是——AltGr 在一些键盘上就是 Ctrl+Alt），表与处理才对得齐。挑键之前先看表里有没有撞的、浏览器拦不拦得住：Chrome 的 `Ctrl+W` / `Ctrl+N` / `Ctrl+T` / `Ctrl+Tab` / `Ctrl+PageUp` / `Ctrl+PageDown` 页面拦不住，不拿来做新的快捷键（已有的 `Ctrl+W` 关标签、`Ctrl+N` 新建文件照旧处理——桌面版拦得到——表里写明了，⚑）。
- **写出来的键都从表取**：菜单（`view/menubar.ts` 与「视图」各组的 `kbd`）、快捷键一览、按钮与提示里的键（保存、预览、查找条的「展开替换」、上一章 / 下一章、外观面板的 −+、「转到…」底下那一行）用 `shortcutLabel(id)`：Windows / Linux 写 `Ctrl+Shift+F`，Mac 写 `⇧⌘F`（`isMacPlatform` 看 `navigator`）。view.js 打包这张表只为写键（上面「跨文件只经三样东西」那条说的）。
- **两头守着**（`tests/dom/standalone/shortcuts.test.js`）：表里每一条照它的生效范围摆好场面（正文里 / 页面上 / 对话输入框里 / `where` 说的那个面板）按一下，得被接走（`defaultPrevented`），浏览器自己的那几样（`native`：剪切、复制、粘贴、全选）反过来不许被接走——`where` 是新的、测试里没有摆场面的办法，就算没测到；反过来在正文里、页面上、对话输入框里把几百种按法（字母、数字、标点、F1–F12、方向键这些 × 修饰键组合）挨个按一遍，被接走的每一下都得是那一档认的某一条。菜单上写着键的每一项都得在表里（`menu`），字也一样。README「内置编辑器 → 快捷键一览」那张表由 `tests/unit/editor/shortcutsReadme.test.js` 逐格对着这张表核。

## 快捷键一览（Ctrl+/）

`editor/shortcutsPanel.ts` 是面板，标题栏「帮助」里那一项在 `view/shortcutsMenu.ts`，样式在 `css/standalone/keys.css`。

- **只在独立版**：它在 editor.js 里，探测不到 `#wbEditor` 就整个不装；插件形态没有内置编辑器、也没有标题栏。
- **写法照 `dialog.ts`**：DOM 现造现拆、页面模板里没有它，外观是 `modal.css` 那一套。它是模态的（外面那一层是 `.modal-overlay`，`Ctrl+P` 之类开着时不开），但不是一问一答：不算 `isDialogOpen()`（不拦自动保存），开着时别的快捷键照常；别的 `.modal-overlay`（服务商弹窗、表单、页内对话框）开着时它不开。
- **键 `Ctrl+/`**（⚑；Google 文档也是这个键）：document 的冒泡阶段，哪里都认（对话输入框里也开），组字中途不算。开着时面板在捕获阶段接走 `Esc` 与 `Ctrl+/`、关掉、焦点还回打开之前的地方；点外面那一层（`mousedown` 落在遮罩本身）、× 也关；`Tab` 不出面板（`focusin` 拉回筛选框）。
- **内容**：按分组（`SHORTCUT_GROUPS` 的顺序）列出整张表，一行三格：键（几种按法各一个 `<kbd>`）、做什么（补充说明在下面一行小字）、在哪儿管用。筛选框按说明、在哪儿、补充说明、分组与两种平台的按键写法筛（`filterShortcuts`，空白隔开的几段都得有），组字中途不筛。

## Markdown 预览

`editor/pane.ts` 的 `setPreviewing`；切块与换算是零 DOM 的 `editor/previewCore.ts`（`tests/unit/editor/previewCore.test.js`），量位置在 `editor/previewSync.ts`，渲染在 `editor/preview.ts`。

- **按标签记**（方案 D3）：预览还是编辑记在每份文件的 `OpenFile.markdownPreview` 上，`Pane.isPreviewing()` 说的是当前这一份。`setPreviewing(on)` 是唯一的切换入口：工具栏「预览 / 编辑」、`Ctrl+Shift+V`、要「先切回编辑」的模块（查找条、体检面板、`replace.ts` 放回内容、全书查找点一处、点引文 `reveal`）。**`activate` 只切标签、不改预览**——从前它顺手切回编辑，好几处模块靠这一下退出预览，现在都改调 `setPreviewing(false)`，新写的模块也照这样。切走时预览滚到哪记在 `previewScrollTop`，切回来放回去；从另一块搬过来（`CarriedDraft.markdownPreview`）、改名搬家、刷新恢复（快照里的 `markdownPreview`，⚑ 只记在前端、不随打开请求发出去）都照旧。只对 `.md` / `.markdown` 有意义（`canPreview`）。
- **滚动对应**：`renderPreview` 按 `previewBlocks` 切块，每一块（frontmatter、标题、段落、代码块、分隔线、引用、每一个列表项——不挂在 `<ul>` / `<ol>` 上，各块互不重叠）记 `data-line` / `data-line-end`（源文件第几行到第几行，从 0 数，`\r\n` 先归一，与 textarea 的行一致）。编辑 → 预览：`areaTopLine` 二分找编辑区视口顶上那一行，借高亮镜像层的 `measureOffset` 量行顶（只量 log₂(行数) 次，**不另起测量 DOM**），位置带小数——中文一段就是一行、能折成好几屏，滚到一段中间预览里也在那一段中间；`scrollPreviewToLine` 在对应那一块里按比例摆（两块之间的空行在上一块的底与下一块的顶之间摆）。预览 → 编辑反过来（`previewTopLine` → `areaScrollForLine`）。切回编辑时光标不在视口里就挪到视口顶上那一行的行首（⚑），在的话不动；先落光标、再滚，免得落选区时浏览器把视口拽回光标。量不了（30 万字以上、没有排版）按滚过的比例估。
- **重画不弹回顶上**：`showPreview` 重画之前记下预览的 `scrollTop`、画完放回——保存回执、磁盘上的新版进来都会重画预览。
- **键 `Ctrl+Shift+V`**（⚑，与 VS Code「打开预览」同一个键）：`index.ts` 的全局 keydown，`paneForShortcut` 认是哪一块（焦点在对话输入框里不拦）；那一份不是 Markdown 时也不拦，浏览器照常「粘贴为纯文本」。预览是 `tabIndex = -1`：切过去焦点进它（方向键与翻页键滚的是它，再按一下也认得出是这一块），`:focus` 不画框。

## 码字统计

`editor/stats.ts` 装配，口径在零 DOM 的 `editor/writingStats.ts`（`tests/unit/editor/writingStats.test.js` 钉着），「今日码字」的存法在 `editor/statsDaily.ts`，面板在 `editor/statsPanel.ts`，「视图 → 统计」在 `view/statsMenu.ts`。`pane.ts` 只在 `updateStatus` 里调一句 `renderWordStatus`，别的都是模块自己挂的（`onEditorChange`、章节索引、`storage` 事件）。

- **状态栏字数那一格**（每块编辑区一格，`#edStatusWords` 与草稿区那一格；class、子节点、点击都由 `stats.ts` 第一次画时挂上，`page.ts` / `createPaneElements` 里仍是一个空 `<span>`）：「全文 N 字」；有选区「选中 N 字 / 全文 M 字」；当前标签是某一章的**正文**（`chapterAt` 认出是 `chapter` 那一面）且章节索引里这一章有 `targetWords` 时换成「3,120 / 4,000 字，还差 880」（超了「超出 120」，正好「正好写够」）＋一条细进度条，到八成（第 21 条「写够了」的线）加 `enough` 换色。目标只认章节索引的 `targetWords`：后端 `views/pipeline.ts` 的 `plot?.targetWords ?? config.wordsPerChapter`，与写正文时判写够没有（`controller/chat.ts` 的 `targetWordsOf`、`generation/generate.ts`）同一个式子。细纲、草稿、角色卡，没写目标、索引里还没有这一章，都不显示目标。「· 本次 +356 字」「· 今日 1,820 字」两项按偏好显示（缺省关）。字符数在 `title` 里。按下鼠标 `preventDefault`（不夺编辑区焦点），点击 / 回车 / 空格开面板。
- **字数与后端同一个数法**：章节（`kind === 'chapter'` 且是 `.md` / `.markdown`）不算开头那行 `# 标题`（`headingWords`，与 core `stripH1` 同一条正则、单测对拍）——后端数章节字数是 `countWords(stripH1(body))`，状态栏、章节条、工程页三处说的才是同一个数。
- **码字口径**（「本次」「今日」同一套）：作者亲手打进去的净字数。算 `typing`、带 `change` 的 `composition`（输入法上屏那一下）与 `completion`（名词补全里挑了一个名字补上的那几个字，⚑ 与输入法挑候选词同理——`Pane.applyEdit` 带 `opts.source: 'completion'`），删掉的倒扣；**不算** `input`（粘贴、剪切、拖放）与一切 `program`（回车与 Tab 补的空白、成对符号的半边、段落快捷键、一键排版、半角转全角、替换 / 全部替换、对比合并、历史版本恢复、还原、用磁盘版本覆盖、磁盘同步、右键粘贴），组字中途也不算。**撤销 / 重做跟着那一步走**（⚑）：`EditHistory.topId` 给每一步一个编号，`StepLedger` 记每一步计入过几个字，撤销那一步就减回去、重做再加上；撤销粘贴、排版不动码字数。重新开始计时换一批新账本，之前打的字撤销了也不倒扣这一次。一处改动算几个字用 `wordDelta`：中文逐字，英文两头扩到词边界再比，等于前后各数一遍全文再相减，但只看改动那一段。
- **时长**：`typing` / `composition`（组字中途也算）是心跳；两下之间不超过 2 分钟（⚑ `IDLE_MS`）那段记进去，更长的整段不算；记在后一下落笔的文件上，各文件加起来就是总时长。速度 = 净字数 ÷ 时长，写够 1 分钟（`MIN_SPEED_MS`）且净字数为正才报。
- **本次**：从加载页面起，「重新开始计时」（面板里与「视图」里）、换工程（`nf-workspace-reset`）重来；按文件分别记（`nf-files-moved` 时明细跟着改名）。只在内存里，刷新从 0 起。
- **今日**：localStorage `novelforge.editor.stats.daily@<工程>`（`projectStorageKey`；网址上没有 `?project=` 时只在内存里），`{ v: 1, days: { 'YYYY-MM-DD': { words, ms } } }`，按落笔那一刻的本地日期记、留 30 天，坏值当没有（`parseDaily`）。**不进工程目录、不进 SQLite**：工程里放的是作品（第 17 条：内容的唯一真相是 Markdown），码字习惯是这个浏览器上这个人的，丢了无所谓。**多窗口**：每个窗口只往「待写」里记自己的增量，至多 2 秒（以及 `pagehide` / 藏起来 / 换工程时）现读、相加、写回，绝不写自己的总数；别的窗口写了，这边收 `storage` 事件丢掉缓存重画。显示的是「上次读到的 + 自己还没写进去的」。读写抛过就只在内存里算，面板上照实说。
- **大章节不卡**：`countWords` 一趟循环；每份文件缓存「数过的是哪一份文字」，带 `change` 的改动核对缓存正是改动之前那一份就只数改动那一段（`wordDelta`）；撤销 / 重做、组字中途这类没有 `change` 的，两万字以内当场重数、更长的至多 300ms 重数一次（其间显示上一次的数）；选中字数只数选中的那段并按（文字、起止）记住；本次 / 今日只看改动那一段。`pane.ts` 的 `updateStatus` 在 `edit` 事件之前调到——那一刻缓存还没跟上，长文字先显示旧数，紧跟着的 `edit` 监听补上再重画。
- **面板**（`statsPanel.ts`）：挂在 `body` 上 `position: fixed`、贴着那一格往上弹，不是遮罩；点外面（捕获阶段 `mousedown`）、`Esc`、再点那一格收起；同一时刻一个；开着时打字、章节索引更新、别的窗口记了今日码字都重画。用户内容一律 `textContent`。

## 写作体检

`editor/check.ts` 装配，口径在零 DOM 的 `editor/checkCore.ts`（`tests/unit/editor/checkCore.test.js` 钉着），面板在 `editor/checkPanel.ts`，「视图 → 体检」在 `view/checkMenu.ts`，样式在 `css/standalone/check.css`。**不调模型**（第 4 条），只是按词表在正文里找字；不替作者改字（替换是作者点的那一下，走 `applyEdit`）。`pane.ts`、`page.ts`、`createPaneElements` 一行都没改：那一格、图层、钩子都是模块自己挂的。

- **只看正文**：`isProse`（后端给的 `kind`，前端不拿路径猜）。细纲、角色卡、敏感词表本身（`kind: 'sensitive'`）、没给 `kind` 的都不查，那一格藏起来。
- **词从哪来、口径在哪**：禁用词与敏感词表由后端算好推来（`checkTerms` 消息，`core/protocol/check.ts`；`controller/check.ts` 每次 `pushState` 现算、内容变了才推、只给有 `openInEditor` 的宿主推）。禁用词**与生成链同一个函数、同一份输入**：后端 `views/checkTerms.ts` 的 `readBannedTerms`，`generation/generate.ts` 的 `planWriting` 也调它。找位置的函数在 core 的 `model/manuscriptCheck.ts`（`locateTerms` / `latinAcronymRanges`，零 import，前端经 `protocol.ts` 打包；生成链的 `countBanned` / `countSimiles` / `latinAcronyms` 都建在它们上面），比喻词表与上限（`SIMILE_WORDS` / `SIMILE_LIMIT`）也是那一份。
- **四类**：敏感词（`foldCase`：英文不分大小写、全角当半角）、禁用词（区分大小写，与 `countBanned` 一样）、比喻词（全章超过上限才算、才画，算超出的那几个）、英文缩写。同一段字可以同时落在几类里，各算各的；同一个词每一处都算。状态栏「体检 N」的 N 是四类加起来（⚑ 比喻词按超出的个数算），没有问题写「体检 ✓」（⚑）。
- **`check` 图层**：`<mark class="ed-hl ed-hl-chk-<类>">`。只用 `text-decoration`（不占排版；颜色明写，镜像里的字是透明的）：敏感词实线 + 淡底色、禁用词红波浪、比喻词黄波浪、缩写蓝点线，颜色是 `check.css` 里三套主题各一份的 `--nf-chk-*`。`dom/standalone/check.test.js` 钉着：这几条规则不许出现内边距、外边距、边框、字重、字色，选择器必须是 `:where(.ed-mirror) mark.ed-hl-chk-*`。
- **什么时候重查**（「几万字的章节每敲一下也不卡」，这一套在 `editor/liveLayer.ts`，名词高亮共用）：每份文件缓存「查过的是哪一份文字、哪一版词表」。两万字以内改了字在**微任务**里重查（`highlight.ts` 的同步订阅先平移各层，之后才落新的一份，两次绘制之间只画一次）；更长的至多 300ms 一次（尾随，`LIVE_RECHECK_MS`），其间已经画着的由 `highlight.ts` 跟着改动平移。模块自己记着「镜像层上此刻画着的那几段」（照 `highlight.ts` 同一条平移规则，`checkCore.shiftRanges`），重查结果一模一样就不再 `setHighlights`。撤销 / 重做、组字中途、上屏这些改动对不上「上一份文字」的，按前后文字差（`diffChange`）挪过去并标脏、微任务里重画一次。**组字中途不重查**（`compositionstart` / `compositionend` 挂在 textarea 上；pane 自己的 `compositionend` 先跑、上屏那一下的 `edit` 先发）：拼音字母不当英文敏感词、计数不跟着拼音跳，上屏之后再查。
- **状态栏那一格**（`.ed-check`，插在 `.ed-status` 的 `.spacer` 前面、紧跟字数那一格，两块编辑区各一格、第一次 `render` 时现造）：样子、`aria-expanded`、按下鼠标不夺焦点、回车 / 空格打开都照码字统计那一格；专注模式里状态栏淡掉时照样点得开（`focus.css` 认 `aria-expanded`）。
- **面板**（`checkPanel.ts`）：开合照码字统计面板——挂 `body`、`position: fixed`、贴着那一格往上弹、点外面（捕获阶段 `mousedown`）/ `Esc`（捕获阶段吞掉，专注模式不跟着退）/ 再点一下收起，同一时刻一个；面板上的按钮按下鼠标不夺焦点。按类列词与次数，点一个词：先 `freshEntry`（节流中就当场重查，位置是此刻的），预览里先切回编辑，选中下一处（选区正好是第 k 处就去 k+1，到底绕回，`nextOccurrence`），焦点进 textarea（`preventScroll`）、`scrollToOffset(…, { onlyIfHidden })`，那一行写「k/N」。有替换词的敏感词多「替换本处」（选区正好是某一处才换，换完选中下一处；不是就这一下只选中——与查找替换的「替换」同一个规矩）与「全部替换」（`checkCore.replaceAllEdit` 算第一处到最后一处那一段，一次 `applyEdit`、一步撤销——与查找替换的全部替换同一条路，位置用体检找出来的那几处，高亮在哪就换哪）。用户内容一律 `textContent`。
- **「编辑敏感词表…」**（面板底下、「视图 → 体检」里）：发 `editSensitiveWords`，后端没有就经网关新建模板（`mode: 'create'`）再 `openInEditor`；保存走编辑器那条路（乐观锁、存历史版本）。没打开工程（`body.no-workspace`）时菜单项置灰、面板里点了只说一句。
- 换工程（`nf-workspace-reset`）：词表作废、面板收起，等新工程的 `checkTerms`。

## 两块编辑区

- `createPane(id, refs, post)`（`editor/pane.ts`）是工厂，两块编辑区是它的两个实例，各自持有 `files` / `conflicts` / `activePath`（预览还是编辑按文件记在 `OpenFile.markdownPreview` 上，见下面「Markdown 预览」）。主区绑页面上固定 id 的节点，第二块（`pane: 'draft'`）在首次收到 `editorOpen{pane:'draft'}` 时惰性创建——它放草稿，也放点开一章时并排打开的那份细纲（W6）。
- **章节工作台（W6）**：工程页点章节行名发 `openChapter`，后端按宿主能力开——正文进主区，细纲经 `openBeside` 进第二块（VS Code 壳落在 `ViewColumn.Beside`，前端什么都不用做）。主区顶上的**章节条**（`editor/chapterBar.ts`）在任一块正开着某一章的正文或细纲时出现：这一章在哪一步、写了多少，「写这一章 / 接着写 / 重写 / 审稿 / 定稿」按状态亮灭（提示里写调用次数），另一份没开着时给「并排看细纲 / 正文」。按钮发 `chapterAction`，后端当成对这一章按下主按钮（审稿是正文层的 `review`，只出报告）。数据取**章节索引**（`chapterIndex` 消息，`editor/chapterIndex.ts`）与 `nf-editor-active`。从前只取工程树，而工程树只在「工程」页签开着时才推——作者待在对话页时条上的字数、状态是旧的，从没打开过工程页时干脆没有数据。章节索引哪个页签都推（随 `init` 一次，之后 `pushState` 里与 `ViewState` 同一趟流水线索引算出、内容变了才推）。条在主区里，当前文件却可能在右侧：条上的 `pointerdown` / `focusin` 不往上冒，免得主区把「当前这一块」抢过去、条一重画点击就落空。
- **上一章 / 下一章**（`editor/chapterNav.ts`，章节条两头的按钮与 Alt+PageUp / Alt+PageDown ⚑）：顺序按章节索引（章号，第 8 条）；正文跟正文、细纲跟细纲；没改过就在原位置换掉（`openEditor` 带 `replace`，收到时 `pane.ts` 的 `slotFor` 再看一眼那一份还是不是没改过），改过就另开；相邻那一章已经开着就直接切过去；另一块开着配对文件时同样换成相邻那一章的配对文件，**那一份的 `editorOpen` 不认下「当前这一块」**（`takeQuietOpen`：两份请求在后端是并发处理的，回来的先后不定）；相邻那一章没有这一面时 toast 照实说，不发请求。
- **点引文定位（五期 W10）**：后端推 `editorReveal { path, quote }`（紧跟在那一份的 `editorOpen` 之后），拥有那份文件的那一块 `Pane.reveal` 选中那一句，用高亮镜像层量出它的位置、滚到视口偏上三分之一（`highlight.ts` 的 `scrollToOffset`）。定位用 core 的 `locateQuote`（`model/review.ts`，与后端校验引文同一个归一化：去空白与标点），按编辑区里**当下**的文字找——有没保存的修改时照样认得出。
- **一个路径同一时刻只属于一块**。`editorSaved` / `editorConflict` / `editorError` / `editorDiskChanged` / `editorDiskGone` 都只带 `path`，靠这条不变量才认得出该送给谁（`paneOwning`）。因此收到 `editorOpen` 时会先让另一块 `closeSilently` 掉同路径，未保存内容与撤销历史一并搬过来（`CarriedDraft`；历史只在接上之后的内容与搬走时一字不差才接，改名搬家 `nf-files-moved` 同理）——不是关闭，是搬家。破坏这条会导致从错的那块保存时用错 `baseHash`，触发假冲突。标签右键「移到另一侧」走同一套（`Pane.moveOut` 交出去、`upsertFile(view, carried)` 接上），只是**不经后端**：交出来的 `view` 就是搬走时的基线，`carried.local` 让接手的那一块连冲突条、见过的磁盘新版、「磁盘上没了」与光标一起接上（经后端重读来的那一份可能已经不是它们说的那一份，所以 `editorOpen` 那条路不接这几样）。

**标签**（`pane.ts` 的 `renderTabs` / `upsertFile`，`tabLabels.ts` / `tabStrip.ts` / `tabMenu.ts`）：

- **称呼由后端算**（`EditorFileView.label`：类型短标记、去掉扩展名的名字、面包屑，`src/core/views/editorLabel.ts`），与 `kind`、`draftPath` 同一条原则；固定文件的中文称呼（情节大纲、文风指南、叙事线、全书摘要）与「转到…」的索引共用 `FIXED_DOC_LABEL` 一张表。面包屑的章节那一段优先取章节索引里的标题（`breadcrumb.ts`）：`editorLabel` 不读盘、只看得到文件名，而有正文的章改了标题文件名不动（第 7 条），那时章节条、「转到…」说的都是新标题；标签上仍写文件名；**同名区分在前端**——开着哪几份只有前端知道。两块编辑区放在一起比，所以一块的标签开了 / 关了要让另一块重画标签（`store.refreshOtherTabs`）。没给 `label` 时标签写文件名、工具栏写原始路径。
- **临时标签**（`OpenFile.preview`）：打开请求带 `preview`（工程页 / 文件页单击；第二下点击 `e.detail >= 2` 不带——第一下打开后那一行可能已经重画，不指望 `dblclick` 落在同一个元素上），后端原样带回 `editorOpen`（`EditorOpenIntent`）。**发送方总是带，开关在编辑器这边判**（`previewTabsEnabled`），view / explorer 不必读编辑器的偏好。不变量：**每块最多一个**（新来的临时标签占旧的那个的位置，`slotFor`）；**有未保存修改的永远不是临时的**（`afterContentChange` 里一变脏就转正）——所以换掉它从来不会丢字。转正的路：变脏、`save()`、双击标签、右键「固定」、被不带 `preview` 的打开请求打开一次（落盘后自动打开、点引文、双击那一行）、关掉开关；单击打开一份已经固定的不把它降回临时。从另一块经 `editorOpen` 搬来的保持原样，「移到另一侧」搬来的转正。刷新恢复记着（快照里的 `preview`，只放在 `pendingDrafts` 上，不随打开请求发出去）⚑。
- **最近关闭**按块记（`store.ts` 的 `noteClosed`），只记 `Pane.discard`（作者亲手关的）；搬家、换掉临时标签、原位换掉都不算。又开着了就从里面拿掉。
- **标签条**：整排换掉 DOM 之前留住 `scrollLeft`、换完放回再把当前那个滚进视野（`offsetLeft` 相对 `.ed-tabs-list`，它是 `position: relative`）；滚轮的竖向分量当横向滚。「▾」弹的是 view 的菜单（`showMenuAt`），点击要 `stopPropagation`，否则冒到 document 就把刚弹的菜单收了；菜单开着时再点「▾」反过来放它冒上去收起。
- **一块区只有一个 textarea**，所有标签共用，显示的是当前文件（`Pane.area`）。切标签时整份换 `value`，所以光标位置、滚动位置、撤销历史都记在 `OpenFile` 上，而不是指望 textarea 自己记得。别的模块要拿「当前那块区 + 当前文件 + 它的 textarea」，用 `api.ts` 的 `activeEditor()` / `editorOf(pane)`。
- `activePane` 靠两块根元素上的 `focusin` / `pointerdown` 跟踪，`Ctrl+S` / `Ctrl+W` 作用于它，`beforeunload` 则扫两块。标题栏的撤销 / 重做也作用于它（焦点在哪块区，它就是哪块）。
- 「草稿」按钮的可见性由后端给的 `file.draftPath` 决定，前端不自己判断什么算章节。点它发 `openDraft{path}`，**传的是章节路径**，草稿路径由后端推导并按需创建。
- localStorage 的 `novelforge.editor.v1` 从 `{ open, active }` 升为 `{ v: 2, panes: { main, draft }, activePane }`；`restore()` 兼容旧形状（认得 `saved.open` 就当主区），老用户的标签页不会在升级后消失。
- `activePane` 每次易主都要跟一句 `announceActive()`（`activate` / `upsertFile` / 两块之间的 `focusin`·`pointerdown` 切换、`dropFile` 关掉当前标签），资源管理器的高亮才不会停在上一个文件上。`upsertFile` 末尾那句读的是 `activePane`，所以 `editorOpen` 分支必须**先**认下目标块再 `upsertFile`。

## 外观与专注

标题栏「视图」菜单的第二、三组（`view/lookMenu.ts`，接在 `viewMenu.ts` 的 `GROUPS` 里；顺序是标签 → 外观 → 专注 → 统计 → 体检 → 补全）。状态经 `nf-view-query` 的 `look` / `focus` 两个字段问编辑器（`editor/look.ts` / `editor/focus.ts` 各填各的，没人回答就是 `undefined`、整组置灰），开关经 `nf-view-command` 交过去。

- **外观**（`look.ts`，取值与校验在 `lookCore.ts`）：字体（宋体 / 黑体 / 楷体 / 仿宋 / 跟随系统，只列字体族名、不打包字体文件）、字号（12–32px，缺省 15）、行距（1.3–3 倍，步长 0.05，缺省 1.95）、版心宽度（一行最多 20–80 字，`0` 是铺满、缺省）。生效方式只有一种：写 `<html>` 上那组 CSS 变量（见上面「高亮镜像层」那条）；预览也读同一组。
  - **字号快捷键只在焦点在编辑区里时拦**：`Ctrl+=` / `Ctrl++` 放大、`Ctrl+-` 缩小、`Ctrl+0` 还原挂在 `addKeyHandler` 上——只有正文的 textarea 收得到，组字中途的不收。焦点在对话输入框、页面上时一律放行，浏览器照常缩放整页。菜单里那三项不看焦点。
  - **外观面板**（`lookPanel.ts`，「视图 → 外观设置…」）：写法与样式照 `dialog.ts`（DOM 现造现拆、`.modal` / `.modal-head` / `.modal-body` / `.modal-foot`、焦点进出、`Esc` 关），但**不是模态的**：外面那一层是透明、不拦点击的 `.ed-look-overlay`，**不是** `.modal-overlay`（别的模块拿「有没有 `.modal-overlay` 开着」判断有弹窗，`Ctrl+P` 会因此不开），也不算 `isDialogOpen()`（不拦自动保存）。改了当场生效；「恢复默认」从偏好里删掉排版那四项（以后缺省改了也跟着走），主题不动（⚑）。段间距不单列（⚑）：textarea 画不出段与段之间的额外间距，空行分段时段间距就是那一行空行（跟着行距变）。
  - **护眼主题**（`shell.ts`）：与深 / 浅同一个机制——`<html data-theme="sepia">`，`theme.css` 里一套与浅色同样全的变量（米黄底、深棕字），记在 `novelforge.theme`。管整个界面，不只编辑区（⚑）。标题栏按钮按深 → 浅 → 护眼轮着换，按钮上画的是下一套。
- **专注模式**（`focus.ts`，F8 ⚑，`Esc` 或再按一次退出）：`<body>` 挂 `nf-focus`，当前那一块编辑区挂 `ed-focused`（只专注 `activePane`，另一块藏起来；每次 `render` 重新认一次，从别处打开了另一块里的文件就跟过去），`css/standalone/focus.css` 藏起活动栏、侧栏、标题栏里菜单以外的杂项、标签条、工具栏、章节条，状态栏淡成一行（只是 `opacity`，字数那一格照样点得开码字统计面板——面板挂在 `body` 上、不跟着淡；鼠标移上去、焦点进来、面板开着时恢复清楚）。**冲突条、查找条、历史版本抽屉照常**。`Esc` 只在没人接走时退出：查找条先收（它 `preventDefault`）、「转到…」先关、页内对话框、外观面板、码字统计面板与快捷键一览在捕获阶段吞掉 `Esc`、标题栏菜单与右键菜单开着时只收菜单（捕获阶段先记一笔「按下时有菜单开着」——它们在冒泡阶段收自己，又不 `preventDefault`）。所以 `installFocus()` 要在 `installFind()` 之后装。
- **全屏**（`focus.ts`）：Fullscreen API，**能力探测**（`document.fullscreenEnabled` 且有 `requestFullscreen`），不支持时菜单项置灰、提示说不支持；全屏的是整个页面，不记进偏好。F11 是浏览器的，不抢。桌面壳：Linux（WebKitGTK）上元素全屏会把窗口真正全屏；Windows（WebView2）上只把页面撑满 webview、窗口不变——要真全屏得在 Rust 那边接 `ContainsFullScreenElementChanged` 调 `set_fullscreen`（页面拿不到 Tauri 的 IPC，前端做不了），见 [../src/shells/desktop/README.md](../src/shells/desktop/README.md)。
- **打字机滚动**（`typewriter.ts`）：`edit`（带 `change` 的；组字中途不带，不认）与方向键 / 翻页 / Home / End 之后下一帧，用 `measureOffset` 量光标那一行、按 `focusCore.typewriterScrollTop` 滚到视口中间。只在焦点在这块 textarea 里时滚（磁盘新版就地换进来时不替人滚）；不听 `scroll` 与鼠标点击——滚轮翻看前文时不拉回，下一次打字才回来。开着时 `<body>` 挂 `nf-typewriter`，`--nf-ed-pad-bottom` 垫半屏，最后一行也滚得到中间。
- **段落聚焦**（`paragraphFocus.ts`，只对正文 `isProse`）：⚑ textarea 的字整体调淡（`.ed-para-dim`：前景色 × 30% 的**半透明**色，`caret-color` 不变），高亮镜像层的 `focus` 图层把当前那一段包进 `<mark class="ed-hl-focus">`、用**实色**画字——镜像层在下，半透明的淡字叠在同一个字形的实色字上看起来就是实色。光标、选区、输入法全是 textarea 自己的。代价：当前段画了两遍（笔画边缘略重），镜像层与 textarea 万一差半个像素当前段会有重影；超过 `HIGHLIGHT_LIMIT` 不画也**不调淡**。没取「textarea 全透明、镜像层画全部文字」：那样光标画在看不见的字上、组字时的拼音也是透明的。当前段由 `focusCore.paragraphRangeAt` 按 `paragraphStyle` 认（空行分段：空行隔开的一块；段首缩进：有缩进的那一行另起、没缩进紧跟着的是续行；两者都要：两样都算；标题行与场景分隔行自成一段）。改了字之后**在微任务里**重算——`highlight.ts` 的订阅先把各层平移、压在改动上的丢掉，之后才落新的一段，浏览器两次绘制之间只画一次；光标挪了（`keyup` / `mouseup` / `select` / `selectionchange`）段落变了才重画。

## 全书查找替换（Ctrl+Shift+F）

`editor/bookFind.ts` 是面板（画、按键、停顿再搜、点一处、预览与勾选、两段式、汇总），`editor/bookFindCore.ts` 是它的纯函数
（`tests/unit/editor/bookFindCore.test.js`），标题栏那一项在 `view/bookFindMenu.ts`，样式在 `css/standalone/bookfind.css`。
后端：查找在 `core/views/bookFind.ts`、替换在 `core/features/bookReplace.ts`、一份文件的口径在 `core/model/bookFind.ts`、
消息在 `core/protocol/bookFind.ts`（`bookFind` / `cancelBookFind` / `bookReplace` → `bookFindResult` / `bookReplaceDone`）。

- **只在独立版**：在 editor.js 里，探测不到 `#wbEditor` 就整个不装（插件形态 `Ctrl+Shift+F` 原样放行）。`Ctrl+Shift+F` 开面板、焦点进
  查找框，`Ctrl+Shift+H` 焦点进替换框（查找框空着时仍进查找框）；挂在 document 上，焦点在对话输入框里也开（这个键在那里没有别的用处）；
  组字中途、页内对话框与 `.modal-overlay` 开着时不开；没开工程（`body.no-workspace`）说一句、不开。查找条（`find.ts`）不接带 Shift 的那两下；
  名词补全的 `Alt+/` 带 Alt、这两下带 Ctrl+Shift，互不相干，补全只认编辑区的 textarea（`addKeyHandler` / `onEditorChange`），面板里的输入框不弹。
- **放在哪（⚑）**：**压在侧栏上**，与 VS Code 的「搜索」视图一样——面板现造、挂进 `#wbSide`，侧栏挂 `bf-open`、`css/standalone/bookfind.css`
  把那几页 `.pane` 藏起来（页头任务条照常），编辑区一点都不挡：点一处，右边跳过去，左边的结果还在。不是遮罩、不进 `.modal-overlay`。
  点活动栏任一页签（document 上的 `click`，认 `.tabbar .tab`）、×、面板里任何一处的 `Esc` 收起（不删 DOM，结果、勾选、展开状态都留着）；
  `Esc` 关掉时焦点还回打开之前的地方。换工程（`nf-workspace-reset`）清空。页面模板里没有它（`bookFind.test.js` 守着）。专注模式藏起侧栏，
  但开着的面板照常露出来（`body.nf-focus .wb-side.bf-open`，与查找条、历史版本抽屉同一个说法）；面板里的 `Esc` 不往上冒，先收面板、不退出专注。
- **停顿再搜**：查找框的 `input`（组字中途不算，`compositionend` 再算）停顿 `BOOK_FIND_DEBOUNCE_MS`（300ms）才发 `bookFind`；开关、范围一换、
  查找框里按 `Enter` 当场发。新的一次发出去之前先 `cancelBookFind` 上一次并作废它的 requestId（`replace.ts` 的 `newRequestId` / `claimRequest`，
  回复是广播），「停止」同理。叫停**按请求认**：后端几个窗口共用一个 controller，不能「新的一次顶掉同一个 controller 上的上一次」。
- **结果**：按范围分组（`groupByScope`，组标题「正文 · 2 个文件 3 处」）、一份文件一块（`.bf-file[data-path]`：三角、称呼——后端按编辑器标签
  的短标记 + 面包屑最后一段给的——、处数，没列全写「列了 / 一共」），每一处一行（`.bf-hit`：行号、同一行前后一截、命中的字 `<mark>`）。
  点文件那一行收起 / 展开。到了上限、没搜的文件、正则写错照实说（`resultNotes` / `resultStatus`）。用户内容一律 `textContent`。
- **用的是磁盘上的内容（⚑）**：编辑器里开着、有未保存修改的文件（`store.allOpenFiles()` 里 `draft !== text` 的）在结果上标「未保存」（列的是磁盘
  上那一份）；预览里那一份的勾选框勾不了，替换时照样带上、列进 `dirty`，后端跳过并在汇总里说。打字、保存之后停一下重画这些标记（`onEditorChange` /
  `editorSaved`）。
- **点一处**：那份文件开着就 `activate` 过去（在预览里就 `setPreviewing(false)` 切回编辑），没开着就发 `openEditor { path, pane: 'main' }`（**不带 `preview`**，开成正常标签），等它的
  `editorOpen`（3 秒之内）再定位——所以 `installBookFind` **要在 `index.ts` 自己的 `onMessage` 之后装**。定位按后端给的「行 + 列」认回编辑区里的下标
  （`offsetAt`：磁盘上的 `\r\n` 进了 textarea 是 `\n`，按下标会差），再交给查找条（`revealFindMatch`）选中离它最近的那一处；一处都没有（有没保存的
  修改）就说一句。窄屏先 `revealEditor`。
- **预览与替换**：「预览替换」把 `bookFind` 带上 `replacement` 再发一次；回来的每一处画成 `<del>` 旧字 + `<ins>` 新字，每一处、每份文件都有勾选框
  （文件那一格三态，`fileCheck`）。勾掉的按 `hitKey`（路径 + 位置）记，预览重推时还认得出（`pruneExcluded` 拿掉没了的）。改了勾选只就地改勾选框与数，
  不整个重画（滚动位置不动）。「替换所选」**两段式**（⚑，与表单的 `confirm` 同一个做法）：第一下只把字换成「再点一下：替换 N 个文件 M 处」，4 秒
  没点第二下、或改了勾选与输入框就退回；预览之后又改了输入框，新的预览回来之前不能点（`sameQuery`）。第二下发 `bookReplace`（`buildReplaceRequest`：
  勾着的那几处、每份预览时的 hash、`dirty`）。回 `bookReplaceDone`：汇总（`summaryLines`）画在结果上面；换过了就回到只查找、自动再搜一次（列出来的是
  还剩下的）；什么都没做（上一次还没换完）预览留着。
- **已打开的标签**这里什么都不做：后端替换完 `pushState`，`state` 一到 `diskSync.ts` 照常核对——没改过的就地换成新内容（一步撤销），改过的挂冲突条。

## 「转到…」（Ctrl+P）

`editor/quickOpen.ts` 是面板（画、按键、打开、焦点、最近打开的），`editor/quickOpenCore.ts` 是匹配与排序（纯函数、零 DOM，`tests/unit/editor/quickOpenCore.test.js` 钉口径），标题栏那一项在 `view/quickOpenMenu.ts`。

- **只在独立版**：它在 editor.js 里，`editor/index.ts` 探测不到 `#wbEditor` 就整个不装（能力探测），插件形态 Ctrl+P 原样交给 VS Code。
- **数据按需要**：打开时发 `requestQuickOpen { requestId }`，后端回 `quickOpenIndex`（`core/views/quickOpen.ts`：章节、角色卡、设定、架构几件与大纲 / 文风 / 叙事线 / 全书摘要、草稿；读了哪些盘写在那个文件头上），认 requestId（回复是广播）。不进 `ProjectTree` / `ViewState`——那两份每次文件变动都全量重推。面板开着时工程变了不刷新；上一份索引留着，再打开先拿它画、新的到了换掉（输入没变时停在原来那一条上）。换工程（`nf-workspace-reset`）作废。
- **键盘照 `/` 命令面板的教训**：过滤串从输入框的值算，重算挂在 `input` 上（组字中途的 `input` 不算，`compositionend` 再算），不在 keydown 里攒字；输入框只接管 ↑↓ / Enter / Ctrl+Enter / Esc / Tab，组字中途一个都不拦。全局的 Ctrl+P 挂在 document 的冒泡阶段：焦点在编辑区之外的输入框里（对话输入框）**照样开**——与查找（`find.ts`）不同，这个键在那些地方没有别的用处；组字中不响应；页内对话框（它在捕获阶段吞掉 Ctrl 组合键）、`.modal-overlay` 开着时不开；没开工程（`body.no-workspace`）时不开、说一句，「打印」照样拦下。
- **不是遮罩**：挂在 `body` 上、`position: fixed` 顶部居中（`css/standalone/quickopen.css`），点外面（document 捕获阶段的 `mousedown`）关、不还焦点；Esc 关、焦点还回打开之前的地方。行上 `mousedown` 先 `preventDefault`，点一行焦点不离开输入框。
- **打开什么**：章节发 `openChapter`（与工程页点章节行同一条：正文进主区、有细纲并排；没有正文给细纲路径），Ctrl+Enter / Ctrl+点击发 `openEditor { pane: 'draft' }` 开正文（没有正文开细纲）；其余发 `openEditor { pane: 'main' | 'draft' }`。**不带临时标签那类标记**（`preview`）——从这里打开是作者明确要去的地方，开成正常标签；按编辑器「被不带 `preview` 的打开请求打开一次就转正」那一条，要去的那一份正好是临时标签时它就此转正，别的临时标签不被换掉。后端的 `openChapter` 在一条消息里先开正文再开细纲，两份 `editorOpen` 按顺序到；就算先后反了（独立版对每条 WebSocket 消息并发处理），哪一份到了都把焦点放回拥有 `focusAfter.path` 的那一块，结果一样（`tests/dom/standalone/quickOpen.test.js` 两种顺序都钉着）。打开之后等那份文件的 `editorOpen`（3 秒之内）把焦点放进拥有它的那一块；章节并排的细纲随后才到（`index.ts` 那时把 `activePane` 认成第二块），到了也把焦点与 `activePane` 拉回正文那一块。所以 `installQuickOpen` **要在 `index.ts` 自己的 `onMessage` 之后装**：编辑区先收下文件，它才找得到拥有者。
- **最近打开的**：编辑器每激活一份文件（`nf-editor-active`，不论从哪打开）记一笔，localStorage `novelforge.quickopen.recent` 按工程分键（`projectStorageKey`），最多 20 条；写不进去就算了。空输入时按路径认回条目（同一章的正文与细纲算一条，删了的、不在索引里的跳过），最多 8 条，后面接前 10 章。

## 名词补全（Alt+/ 与边打边弹）

`editor/names.ts` 是装配（按键、候选框、插入、名词表的收发、「视图 → 补全」的编辑器一半），`editor/namesCore.ts` 是口径（取查询词、匹配排序、边打边弹的判定、替换范围，纯函数、零 DOM，`tests/unit/editor/namesCore.test.js` 钉着），菜单那一半在 `view/namesMenu.ts`。**不调模型**（第 4 条）。

- **名词表按需要**：第一次要用时发 `requestNameIndex { requestId, have? }`，后端回 `nameIndex { requestId, sig, index? }`（`core/views/nameIndex.ts`：角色卡的名字与别名、设定条目的标题 / 关键词 / 分类、设定名录里出现过还没建条目的名字，各带一句话；读盘代价写在那个文件头上），认 requestId。收到 `state` / `init`（磁盘上变过）记一笔「可能过期」，下一次要用时带着手上那份的 `sig` 再问，没变后端只回指纹；问的工夫里照样拿手上那份筛，手上还没有时按键那一下等表到了再弹（3 秒之内）。边打边弹时至多 3 秒问一次。不进 `ProjectTree` / `ViewState`。换工程作废。
- **快捷键 `Alt+/`**（⚑，Mac 上是 Option+/，按 `e.code === 'Slash'` 认，拦下打出 `÷` 的缺省动作）：挂在 `addKeyHandler` 上，只有正文区收得到、组字中途收不到。`Ctrl+Space` 在 Windows / Linux 上常被系统拿去切输入法，不用；浏览器与编辑器都没占 `Alt+/`。也可以点「视图 → 名词补全」（焦点不在编辑区时先放回去）。
- **查询词**：光标前 1~4 个字里（碰到空白、标点就停），能匹配上某个名字或别名开头的最长那段；匹配不上就是空查询、列全部。之后接着打字按「起点到光标」那一段重筛（`queryBetween`），碰到空白标点、光标退到起点前面、一条都对不上就收起。
- **排序**：查询词开头之前 2 万字里最近出现过的在前（越近越前）→ 只在光标后面 5 千字里出现过的 → 没出现过的；同一档里角色 → 设定 → 未建条目、正名先于别名、短的先于长的。一个名词只列一行；别名命中写「别名 → 正名」，插入的是那个别名（⚑）。拼音首字母不认：`/` 命令面板的拼音键是每条命令手写的，没有现成的汉字转拼音表（⚑）。
- **边打边弹**（「视图 → 边打边弹名词补全」，缺省关，`nameAutoPopup`）：只认带 `change` 的 `typing` / `composition`（上屏那一下）、刚插入了字、光标就在插进来的字后面、没有选区；查询词至少 2 个字（⚑）、不是哪个叫法的全称（打完整了不弹）、剩下那截不在光标后面（`autoPopQuery`）。框里只列还没打完的。**不抢回车**：回车照常换段（框收起，按键放给 `enter.ts`），`Tab` 接受（⚑），`↑↓` 在框里选；接着打字按同一个判定重看，不再成立就收起。
- **输入法**：组字中途的键根本到不了 `addKeyHandler`；自动弹只认上屏那一下；框开着时一开始组字就先藏起来（document 捕获阶段的 `compositionstart`，比编辑区自己的监听先跑），上屏之后按新的文字重筛，取消组字（编辑区不发 `edit`）也在下一拍重看一眼。
- **插入**：`insertionFor` 算出换掉哪一段（查询词，连同选区），经 `Pane.applyEdit(…, { source: 'completion' })`，一步撤销，光标落在名字后面；自己那一下的 `edit` 不当成作者在打字。
- **只对作者会写到名字的文件**：后端给的 `kind`（`completionApplies`：`chapter` / `draft` / `plot` / `character` / `lore` / `outline` / `threads`），前端不拿路径猜；小说配置、前提、世界观后端都给 `setting`、分不出哪份是配置，一律不补（⚑）；敏感词表（`sensitive`）、文风、全书摘要这些也不补——是白名单，以后新加的种类缺省不补。按键时说一句、不发请求。
- **候选框**：挂在 `body` 上 `position: fixed`（`css/standalone/names.css`），现造现拆。位置借高亮镜像层的 `measureOffset` 量查询词开头那个字（**不另起测量 DOM**），放在那一行下面、放不下翻到上面、两边都不够压 `max-height`、横向夹进视口；量不了（30 万字以上、textarea 藏着）就摆在编辑区左上角附近。框里按下鼠标 `preventDefault`（不夺编辑区焦点），点一行接受。**收起**：document 捕获阶段 `mousedown` 在框外、编辑区换了文件或切了预览、滚轮、别处滚动、窗口改大小、编辑区失焦、撤销 / 重做、改动落在查询词前面；编辑区自己滚（打字机滚动、打到底自动滚）时在微任务里重摆，光标那一行滚出视口才收。用户内容一律 `textContent`。
- **Esc**：收起并 `stopPropagation`——查找条的 Esc 监听不看 `defaultPrevented`，不拦的话一下 Esc 会把查找条也收了；专注模式同理。

## 名词高亮与悬停浮窗

`editor/nameMarks.ts` 装配（`names` 图层、浮窗、Ctrl+点击、「视图 → 名词高亮」的编辑器一半），认哪几段是名字在 `editor/namesCore.ts` 的 `nameRanges`（`tests/unit/editor/namesCore.test.js`），样式在 `css/standalone/names.css` 后半，`tests/dom/standalone/nameMarks.test.js` 钉整条链路。**不调模型**（第 4 条）。

- **名词表与补全同一份**：`names.ts` 管收发（`currentNameCatalog` / `refreshNameIndex` / `onNameCatalog`）。打开一份归这一层管的文件（与补全同一份白名单 `completionApplies`）就要表；收到 `state`（磁盘上变过）且正对着这样的文件就再问一次，没变的话后端只回指纹；表换了整层重画。开关关着时不要表。
- **认名字**（`nameRanges`）：正名与别名一趟扫完（`locateTerms`，折大小写）；长的优先、不重叠；一个字的叫法不认（⚑，满屏）；英文叫法要整词；**卡或条目自己那一份里不标它自己**（⚑，按 `path` 认）；两条叫法撞了归表里排前面的（角色 → 设定 → 未建条目）。每份文件按「哪一份文字、哪一张表」缓存。
- **`names` 图层**：`<mark class="ed-hl ed-hl-name-<来源>">`，角色 / 设定各一种淡底色，未建条目虚下划线（作者定的）。什么时候重算、打字 / 输入法 / 撤销时怎么跟上与体检同一套（`liveLayer.ts`）。选择器与 `check` 图层一样重（`:where(.ed-mirror) mark.…`），`names.css` 在 `standalone.css` 里排在 `check.css` 前面：撞在同一段字上时体检的下划线与敏感词淡底色盖过名字的；查找的底色更重，盖过两者。
- **悬停浮窗**：`mousemove` 记下位置，下一帧用 `rangeAtPoint` 量是不是名字、按那一段的字认回表里那一条（`nameItemOf`）；换了一个名字重新计时，停够 `HOVER_DELAY_MS`（400ms）再认一次、还是它才弹。框挂 `body`、`position: fixed`、`pointer-events: none`（不挡鼠标），贴着鼠标往下摆、靠近底边翻上去。写正名、类型（角色 / 分类 / 「分类 · 未建条目」）、别名命中时「这里写的是……」、一句话（没有就说没有）、底下一行 Ctrl+点击能打开什么。移开、移出编辑区、打字（光按修饰键不算）、滚动、滚轮、组字、失焦、换文件、编辑区重画就收起；按着鼠标拖选区时不弹；关着名词高亮时不弹（浮窗靠画着的那一层认名字）。
- **Ctrl+点击**（Mac 上 ⌘+点击，`isMacPlatform`：Mac 的 Ctrl+点击是右键）：`mousedown` 时量是不是名字，是就 `preventDefault`（不挪光标）、发 `openEditor { path, pane: 这一块 }`（正常标签，与「转到…」一样）；未建条目没有文件，`toast` 说一句。按住修饰键指着能打开的名字时 textarea 加 `nm-link`（手形），`keydown` / `keyup` 修饰键时跟着重量。快捷键表只收键盘（`shortcuts.test.js` 逐条去按），Ctrl+点击写在浮窗、菜单说明与 README 里。

## 资源管理器（「文件」页）

- **与「工程」页是两件事**：工程页是按语义整理过的视图（章节一条列表，带流水线状态与定稿状态；角色带别名），只看得见几个可管理区里的文件；这一页是磁盘上真实的目录结构，一个都不藏。`.novelforge/` 里的会话、`project.json`，以及老工程留下、工程页不再认的 `plots/`，只有这里进得去——这就是它存在的理由，别为了「干净」把点开头的目录过滤掉（`fileTree.ts` 的 `HIDDEN_DIR_NAMES` 只挡 `node_modules` 与 `.git`）。
- **懒加载，按目录**：展开哪个目录才列哪个。每次展开/折叠都把**当前展开着的全部目录**发给后端（`listDir{dirs}`），不是增量——折叠因此不必再发一条撤销消息，后端也据此记住该关注哪些目录，工程有变动时原样重推。
- **先 `requestDirs()` 再 `render()`**：请求那一步会把还没数据的目录记进 `pending`，顺序反了刚展开的那一层会显示「（未载入）」而不是「载入中…」。
- **能不能编辑由后端算**（`FsEntry.editable`，与 `fileEditing.ts` 同一份规则）。前端不复刻扩展名白名单，也就不会去撞一个必然失败的 `openEditor`——不可编辑的文件点击直接走 `openExternal`。
- **树是扁平渲染的**，与工程页同一套取舍：层级靠 `paddingLeft` 缩进表达，折叠只是重画一遍。展开集合存 localStorage 的 `novelforge.files.open`。
- **截断要说出来**：目录条目超过上限时后端给 `truncated`（真实总数），树尾多一行「另有 N 项未列出」。

## 测试

- [`../tests/dom/`](../tests/dom/) 用 jsdom 跑**构建产物**（`dist/media/*.js`，不是源码），从两个 html 模板里抠 body 保证结构与真实渲染一致，按页面与组件分文件（`view/` 下是对话页、创作页、工程页、表单、报告卡、合并视图、空状态、日志页、设置页、悬停浮窗……，`standalone/` 下是两块编辑区、撤销与 Tab 缩进、查找替换与高亮镜像层、回车、成对符号、段落快捷键、一键排版与「编辑」菜单段落那一组、磁盘同步、关标签的对话框、保存状态与自动保存、冲突时的对比合并、历史版本面板与「文件 → 历史版本…」、「转到…」面板与「文件 → 转到…」、章节条、标签称呼与面包屑、临时标签与「视图」菜单、外观（字号快捷键、外观面板、排版变量、护眼主题）与专注（专注模式、全屏、打字机滚动、段落聚焦）、标签右键、上一章 / 下一章、码字统计与「视图 → 统计」、写作体检与「视图 → 体检」、名词补全与「视图 → 补全」、全书查找替换与「编辑 → 全书查找替换…」、快捷键表（菜单上的键、表与处理两头核对）与快捷键一览、Markdown 预览（按标签记、切换时滚动对应）、资源管理器、欢迎页），清单见 [tests/README.md](../tests/README.md)。改了 `media/src/**` 先 `npm run media` 再跑它，否则测的是上一次的产物（`npm run test:dom` / `npm test` 会自动先构建）。
- [`../scripts/verify-css.js`](../scripts/verify-css.js) 比对两份 CSS 是否等价：规则集合一条不多一条不少，且「同选择器 + 同属性」的相对顺序没被改变。拆分或重排样式片段后可以拿它对着旧产物验一遍。

## 新增产物

加一个新的 `.js` / `.css` 产物：先写源码入口，再改三处配置（AGENTS.md 与 `standalone/README.md` 说的「三处」就是下面的 2–4 步）：

1. `media/src/<名字>/index.ts`（或 `src/css/<名字>.css`）放源码；
2. [`../scripts/build-media.js`](../scripts/build-media.js) 的 `JS_ENTRIES` / `CSS_ENTRIES` 加一条；
3. [`../scripts/embed-media.js`](../scripts/embed-media.js) 的 `built` 数组加一条——漏了这步，`bun build --compile` 出的单文件会 404；
4. 页面里引用：独立版 `standalone/page.ts`，需要时插件 `vscode/webviewHtml.ts`。

**在已有产物内部拆模块不用改任何配置**，直接 import 即可——这正是这次改造要换来的东西。
