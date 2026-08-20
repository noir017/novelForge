# 空窗口启动页与标题栏菜单 Implementation Plan

> **接手须知：** 这份计划面向新的 agent，假设你**没有读过**前面的对话。开工前必读：
> 1. 根目录 [AGENTS.md](../../../AGENTS.md)
> 2. 设计依据 [docs/design/specs/2026-08-20-empty-window-design.md](../specs/2026-08-20-empty-window-design.md)（已评审）
> 3. [src/shells/README.md](../../../src/shells/README.md) 壳契约（能力探测、不许按壳名分支）
> 4. [media/README.md](../../../media/README.md) 前端约定
>
> 每个 Task 按 `- [ ]` 逐步执行，做完立刻 commit。在 **git worktree** 里做，分支 `feat/empty-window`，不要在用户的 `main` 工作区改代码。

**Goal:** 独立版（含桌面）可以不带工程目录启动；空窗口是 VS Code 式 Get Started + File/Edit/Help 菜单栏；打开文件夹在同一进程热换工作区；协议预留 `mode: 'add'`。

**Architecture:** `ChatController` 仍一对一绑 `NovelProject`。独立版 `WorkspaceHub` 持有 0 或 1 份运行时。本机目录列举在壳层 `hostFs.ts`，不进 core。记忆在 `~/.novelforge/window.json`。前端菜单/欢迎页/选择器进现有 `view.js`，用节点探测跳过；不新增前端产物。

**Tech Stack:** 现有 TypeScript + `node:test` + Bun e2e + jsdom。不新增依赖。

**Spec:** `docs/design/specs/2026-08-20-empty-window-design.md`

## Global Constraints

- 插件壳行为不变。`corePurity` / `shellPurity` / sample-novel hash 保持绿。
- 不按 `host.name` 分支。不给 agent 开放 `listHostDir`。
- `listDir`（工程内）与 `listHostDir`（本机绝对路径）分开。
- 热换顺序：未保存 → 停生成 → `closeDatabase` → 停 watcher → 再 open。反了会在 Windows 上撞 EBUSY。
- 验证：改了 TS → `npm run typecheck`；改了 `src/core/**` → `npm test`；改了 `media/src/**` → `npm run test:dom`；改了独立版服务 → `npm run test:e2e`（需 Bun）。
- 本环境是 bash（WSL）。命令在仓库根执行。
- commit 前缀 `feat` / `refactor` / `test` / `docs` / `chore`，中文正文。

## 提交节奏

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `feat` | 协议：工作区生命周期与 `hostDir` |
| 2 | `feat` | CLI `root` 可空 + `window.json` |
| 3 | `feat` | `hostFs` 本机列目录 / 建文件夹 |
| 4 | `refactor` | 设置推送不依赖 `NovelProject` |
| 5 | `feat` | `FileHost.bind` + `WorkspaceHub` + `server` 热换 |
| 6 | `test` | 空窗口 e2e |
| 7 | `feat` | 标题栏菜单 + Get Started + `no-workspace` |
| 8 | `feat` | 目录选择器 UI 与菜单动作 |
| 9 | `feat` | 桌面闪屏只负责起服务 |
| 10 | `docs` | README / 壳 README / F5 |

---

### Task 1: 协议扩展

**Files:**
- Modify: `src/core/protocol/in.ts`
- Modify: `src/core/protocol/out.ts`
- Modify: `src/core/controller/index.ts`（`dispatch` 空分支）

- [ ] **Step 1: 写失败测试不是必须** —— 类型加完 `npm run typecheck` 会红，直到 `dispatch` 补上 case（若 tsconfig 对 switch 无 exhaustiveness 则不会红，仍然要补空分支，避免将来加 `assertNever` 时漏）。

- [ ] **Step 2: 在 `in.ts` 的 `InMessage` 联合上追加**（放在 `promptResult` 之前）：

```ts
  | { type: 'listHostDir'; path: string }
  | { type: 'createHostDir'; parent: string; name: string }
  | { type: 'openFolder'; path: string; mode?: 'replace' | 'add' }
  | { type: 'closeFolder'; id?: string }
  | { type: 'activateWorkspace'; id: string }
  | { type: 'openLogDir' }
```

- [ ] **Step 3: 在 `out.ts` 的 `OutMessage` 联合上追加**：

```ts
  | {
      type: 'workspaces';
      currentId: string | null;
      items: { id: string; root: string; name: string }[];
    }
  | {
      type: 'hostDir';
      path: string;
      parent?: string;
      entries: { name: string; kind: 'dir' | 'file'; absPath: string }[];
      truncated: number;
      error?: string;
      roots?: boolean;
    }
```

可把 `WorkspaceItem` / `HostDirEntry` 抽成 exported interface，避免两处手写。

- [ ] **Step 4: `ChatController.dispatch` 给这六条上行各一个空 `return`**，注释写明：独立版由 Hub 拦下，插件不会发。不要 toast、不要当错误。

- [ ] **Step 5:** `npm run typecheck` 必须零错误。`npm test` 应仍全绿（插件路径不发这些消息）。

- [ ] **Step 6: commit**

```
feat: 协议增加工作区生命周期与本机目录列举
```

---

### Task 2: CLI `root` 可空 + `window.json`

**Files:**
- Modify: `src/shells/standalone/cli.ts`
- Create: `src/shells/standalone/windowState.ts`
- Create: `tests/unit/shells/cli.test.js`
- Create: `tests/unit/shells/windowState.test.js`
- Modify: `src/shells/standalone/main.ts`（只改类型：允许 `root` 为 undefined；恢复逻辑留到 Task 5 与 server 一起接，避免 main 在 Hub 之前自己绑工程）

**`CliOptions.root`:** 改为 `string | undefined`。位置参数仍 `path.resolve`。不带位置参数时 **不要** `path.resolve('.')`。`init` 子命令：没有位置参数时 `root` 仍默认 `path.resolve('.')`（与现在 `novelforge init` 一致）。

实现提示：先扫一遍 argv 得到 `init` 与 `rest`，再决定默认值：

```ts
if (rest.length > 0) root = path.resolve(rest[0]);
else if (init) root = path.resolve('.');
else root = undefined;
```

**`windowState.ts`:** 读写函数收可选 `baseDir`，生产不传则用 `homeDir()`（`src/core/stores.ts`）。测试传入 `os.tmpdir()` 下的临时目录，**禁止写真实 `~/.novelforge`**。

```ts
export interface WindowState {
  lastOpen: string | null;
  recents: { root: string; name: string; openedAt: number }[];
}

export function readWindowState(baseDir?: string): WindowState;
export function writeWindowState(state: WindowState, baseDir?: string): void;
/** 成功打开工程：lastOpen = root，recents upsert，上限 20，openedAt 新的在前。 */
export function rememberOpen(root: string, baseDir?: string): WindowState;
/** 关闭文件夹：lastOpen = null，recents 不动。 */
export function rememberClosed(baseDir?: string): WindowState;
```

缺文件 / JSON 坏掉：返回 `{ lastOpen: null, recents: [] }`，不抛。`lastOpen` 指向的目录不存在时，`readWindowState` **不要**在读时修改文件；由 Hub 启动时清（Task 5）。

- [ ] **Step 1: 先写 `tests/unit/shells/cli.test.js`**，用 `loadModule('src/shells/standalone/cli.ts')`。断言：
  - `[]` → `root === undefined`
  - `['sample-novel']` → `root` 是 resolve 后的绝对路径
  - `['init']` → `init: true` 且 `root` 是 `path.resolve('.')`
  - `['init', '/tmp/book']` → 该绝对路径
  - `--port` / `--no-open` / `--verbose` 与无 root 组合仍对

跑：`node --test "tests/unit/shells/cli.test.js"` —— 应失败。

- [ ] **Step 2: 改 `cli.ts`，再跑同一条，应通过。**

- [ ] **Step 3: 写 `windowState.test.js`**（临时目录）：缺省状态、rememberOpen upsert 与上限 20、rememberClosed 清 lastOpen 留 recents、坏 JSON 降级。先失败再实现。

- [ ] **Step 4:** `npm run typecheck`。`main.ts` 里 `opts.root` 可能 undefined：`init` 分支仍要求 root（init 时永远有）；非 init 分支暂时把 `startServer({ root: opts.root ?? placeholder })` **不要**用 placeholder。Task 5 才会让 `startServer` 接受可选 root。本 Task 若 `main.ts` 因此编不过，给 `startServer` 的 `root` 先改成 `root?: string` 但行为仍是「undefined 就先不 `NovelProject.open`」——若这会把 Task 5 的一半提前，则本 Task **只改 cli + windowState + 测试**，`main.ts` 用 `opts.root!` 或 `opts.root ?? process.cwd()` 先不动，在 Task 5 再改。选后者：本 Task 不改 `server.ts`/`main.ts` 行为。

- [ ] **Step 5: commit**

```
feat: CLI 允许无工程目录启动，并记下 window.json
```

（CLI 解析已可空；真正无 root 起服务在 Task 5。）

---

### Task 3: `hostFs` 本机列目录

**Files:**
- Create: `src/shells/standalone/hostFs.ts`
- Create: `tests/unit/shells/hostFs.test.js`

隐藏名 **import** `HIDDEN_DIR_NAMES` 与 `MAX_DIR_ENTRIES`（`src/core/files/fileTree.ts`），不要复制一份。失败不抛，带 `error`。不返回文件内容（entries 只有 `name` / `kind` / `absPath`）。

```ts
export interface HostDirListing {
  path: string;
  parent?: string;
  entries: { name: string; kind: 'dir' | 'file'; absPath: string }[];
  truncated: number;
  error?: string;
  roots?: boolean;
}

export async function listHostDir(absPath: string): Promise<HostDirListing>;
export async function createHostDir(parent: string, name: string): Promise<HostDirListing>;
```

规则（与 spec 一致）：

- Unix：`''` 或 `'/'` → 列举 `/`，无 `parent`。其它路径 `parent` 为 `path.dirname`，根的 dirname 仍是 `/` 时不要设 parent（或与 path 相同则视为无 parent）。打开选择器的「默认落点」是前端的事，本函数只认传入路径。
- Windows：`''` → 盘符列表，`roots: true`，无 parent。盘符路径（`C:\`）的 parent 不设（前端据此回到盘符层，再发 `path: ''`）。
- `createHostDir`：`name` 含 `/` `\` `..` 或为空 → 返回带 error 的 listing，不 mkdir。已存在 → error，不覆盖。成功则 `mkdir` 后 `listHostDir(parent)`。
- symlink：`stat` 后按目录/文件列入。
- 排序：目录在前、文件在后，名称 `localeCompare(..., 'zh-Hans-CN', { numeric: true })`（与 `fileTree` 一致）。

- [ ] **Step 1: 测试用临时目录树**（含子目录、文件、`.git`、`node_modules`、点开头目录）。断言：隐藏两个名字、点开头可见、截断字段、不存在目录有 error、`createHostDir` 拒绝 `..` 与同名、成功后能列到新目录。Unix 上 `listHostDir('/')` 无 parent。

- [ ] **Step 2: 实现到测试绿。** `npm run typecheck`。

- [ ] **Step 3: commit**

```
feat: 独立版本机目录列举与新建文件夹
```

---

### Task 4: 设置推送不依赖 `NovelProject`

**Files:**
- Modify: `src/core/controller/settings.ts`
- Modify: `src/core/controller/index.ts`（若只转调则可能不用改）

把 `pushSettings` / `saveSettings` 里拼 payload、写盘的部分抽成：

```ts
export async function pushSettingsTo(
  post: (msg: OutMessage) => void,
  ack?: 'saved' | 'rejected'
): Promise<void>;

export async function saveSettingsFrom(
  s: SettingsPayload,
  post: (msg: OutMessage) => void,
  afterSave?: () => Promise<void>  // 有工程时 controller 传 () => c.pushState()
): Promise<void>;
```

`pushSettings(c)` 变成 `pushSettingsTo(c.post.bind(c), ack)`。`saveSettings(c, s)` 在成功后仍 `c.pushState()` + toast。行为与现在逐字节一致。

空窗口的 Hub（Task 5）调 `pushSettingsTo(broadcast)`，`afterSave` 不传。

- [ ] **Step 1: 抽出函数，旧包装保留。`npm test` 全绿（设置相关集成测不能红）。**

- [ ] **Step 2: commit**

```
refactor: 设置读写改为可在无工程时调用
```

---

### Task 5: FileHost.bind + WorkspaceHub + server 热换

**Files:**
- Modify: `src/shells/standalone/fileHost.ts`
- Create: `src/shells/standalone/workspaceHub.ts`
- Modify: `src/shells/standalone/server.ts`
- Modify: `src/shells/standalone/main.ts`
- Create: `tests/unit/shells/workspaceHub.test.js`（能单测的部分：id 用 realpath、add 拒绝、同路径激活；需要临时目录 + 假 broadcast）

**FileHost：** `root` 改为可变。`bind(root: string)` 打开 `NovelProject`、记下 root。`unbind()` 清空 root/project。`watch` 仍返回 Disposable，由 Hub 保存。`openInEditor` 在 root 为空时发 `editorError`（或 no-op toast），不要 `resolve('.', rel)`。

**WorkspaceHub** 构造吃 `{ broadcast, host: FileHost }`。

```ts
open(absPath: string, mode?: 'replace' | 'add'): Promise<void>
close(id?: string): Promise<void>
activate(id: string): void
snapshot(): { currentId: string | null; items: { id: string; root: string; name: string }[] }
handle(msg: InMessage): Promise<boolean>  // true = 已处理，server 不要再交给 controller
```

`open`：

1. `realpath` + `stat` 必须是目录，否则 toast，Hub 不变。
2. `mode === 'add'` 且已有当前项 → toast「本版本只支持一个工作区」，return。
3. 已有相同 id → activate，推 `workspaces`，return。
4. 已有不同项（replace）：`current.abort` 停生成 → `controller.dispose()`（内部 `closeDatabase`）→ `watchDisposable.dispose()` → 再绑新的。
5. `NovelProject.open` → `host.bind` → `new ChatController(project)` → `attach` 现有 ViewHost → `host.watch` → `rememberOpen` → 推 `workspaces` → `resendFullState`。
6. 中途失败：能回旧工程则回；旧的已 dispose 则 `unbind` + 空 `workspaces` + toast。

`close`：dispose 当前 → `host.unbind` → `rememberClosed` → 推空 `workspaces`。没有当前项则 no-op。

`handle` 吃掉：`listHostDir` / `createHostDir` / `openFolder` / `closeFolder` / `activateWorkspace` / `openLogDir` / `saveSettings` / `setApiKey` / `clearApiKey` / `testConnection` / `ready`（先推 `workspaces`；有激活项再 `controller.resendFullState()`，没有则 `pushSettingsTo` + 内存 logs + 空 tasks，**不发假 init**）。

`openLogDir`：`openWithSystem(homeDir())`。

`ready` 无工程：不要 `init` / `project` / `session`。

**server.ts：**

- `ServeOptions.root?: string`
- 不再在模块顶层 `NovelProject.open`。建 `FileHost`（root 可先空）、`initHost`、`WorkspaceHub`。
- 若 `opts.root` 有值 → `hub.open(opts.root)`。若无 → 读 `readWindowState()`，`lastOpen` 存在且 `fs.existsSync` 是目录则 `hub.open(lastOpen)`，否则清掉坏 `lastOpen`（`writeWindowState`）并保持空。
- WS `message`：`promptResult` → PromptHub；`hub.handle(msg)` 若 true 结束；否则 `hub.activeController()?.handle(msg)`，没有则 toast「请先打开文件夹」。
- WS `open`：与 `ready` 相同的补推（有工程 `workspaces`+`resendFullState`，无则空 `workspaces`+settings）。
- 页面 `standalonePage()` **不要**再把工程名写死；改为无参或只传产品名。标题由前端跟 `workspaces` 更新（Task 7）。本 Task 可以暂时仍 `standalonePage(hub.snapshot().items[0]?.root)`，Task 7 再改页面。优先本 Task 就改成不写死，避免热换后首屏 HTML 过期。
- 启动日志：无工程时打「未打开工程」而不是一个假路径。

**main.ts：** 非 init：`startServer({ root: opts.root, ... })`。无 root 时不要 `existsSync(project.json)` 那两行提示（没有目录可查）。有 root 时保留「还不是小说工程」提示。

- [ ] **Step 1: Hub 单测**（临时目录当工程：至少建一个空目录即可 `NovelProject.open`）。打开、再 open 同一 realpath 不创建第二份、replace 会 dispose、add 不改变当前 id、close 后 snapshot 为空。

- [ ] **Step 2: 接线 server/main。`npm run typecheck`。现有 `npm run test:e2e` 必须仍绿**（它们传 `root`）。

- [ ] **Step 3: commit**

```
feat: 独立版用 WorkspaceHub 热换工程目录
```

---

### Task 6: 空窗口 e2e

**Files:**
- Modify: `tests/e2e/standalone/server.test.js`（**同一文件末尾**加一节，不要新文件，避免 bun test 并行把 `initHost` 单例打串）

新端口例如 `EMPTY_PORT = 3997`。`before` 里 `startServer({ port: EMPTY_PORT })` **不传 root**（或 `root: undefined`）。这一节必须放在 3999/3998 的 `after` 都跑完之后——现有结构是两个 describe 顺序执行，把空窗口做成**第三个** `describe('空窗口', ...)`。

断言：

1. `ready` 后收到 `workspaces` 且 `currentId === null`，且在绑定前**没有** `type === 'init'`（或 init 的 `state.initialized` 不得冒充某个工程——正确是根本没有 init）。
2. `listHostDir { path: os.homedir() }` 回 `hostDir`，`entries` 是数组，条目没有正文。
3. `openFolder { path: sample-novel 绝对路径 }` 后出现 `workspaces.currentId` 非空，且随后有 `init` 或 `state`。
4. `closeFolder` 后 `currentId === null`。
5. `openFolder { mode: 'add' }` 在已打开时不把 currentId 换成第二份（仍是那一个或 toast；以 snapshot 只有 1 项为准）。

- [ ] **Step 1: 写断言，跑 `npm run test:e2e`。** Task 5 已实现则应绿；若 ready 仍误发 init，修 server。

- [ ] **Step 2: commit**

```
test: 独立版空窗口打开与关闭工程的 e2e
```

---

### Task 7: 标题栏、Get Started、`no-workspace`

**Files:**
- Modify: `src/shells/standalone/page.ts`（`.wb-title` 结构；`data-version`）
- Modify: `media/src/css/standalone/workbench.css`
- Create: `media/src/css/standalone/menubar.css`、`welcome.css`（或合并进 workbench.css，避免碎片也行）
- Modify: `media/src/css/standalone.css` 若有新 @import
- Create: `media/src/view/menubar.ts`
- Create: `media/src/view/welcome.ts`（或 `workspaceUi.ts` 同时管 body class 与欢迎页）
- Modify: `media/src/view/index.ts`（收到 `workspaces` 时更新）
- Modify: `media/src/view/state.ts` / composer：无工程禁用输入
- Modify: `tests/helpers/dom.js`：`standaloneBodyHtml()` 现传 `standalonePage('/tmp/示例工程')`，改为 `standalonePage()` 仍能抽 body；菜单节点必须在
- Create: `tests/dom/standalone/menubar.test.js`、`welcome.test.js`

**标题栏 DOM（VS Code 自定义标题栏）：**

```html
<header class="wb-title" id="wbTitle" data-version="0.1.0">
  <span class="wb-logo">…</span>
  <nav class="wb-menubar" id="wbMenubar">
    <button class="wb-menu-btn" data-menu="file">File</button>
    …
  </nav>
  <span class="wb-title-text" id="wbTitleText">Novel Forge</span>
  <span class="spacer"></span>
  <button class="icon-btn" id="wbEditorToggle" …>
  <button class="icon-btn" id="wbThemeBtn" …>
</header>
```

`data-version` 从 `package.json` 读（page.ts 用 `createRequire` 或写死再在构建里替换——最简单：`import pkg from '../../../package.json' assert` 可能碍 tsconfig，改为在 `page.ts` 顶部 `const VERSION = '0.1.0'` 并从 package.json 复制会漂。用 `readFileSync` 读仓库/cwd 的 package.json，失败则 `'0.0.0'`。）

菜单栏交互：点击打开下拉；已打开时 hover 隔壁切换；Esc / 点外面关闭。项可 `disabled`。子菜单「最近打开」。**本 Task 菜单项可以先只有结构 + 打开/关闭文件夹占位 `data-action`，真正发消息在 Task 8 接满。** 但 File 打开文件夹 / 关闭文件夹 / 最近打开 与 Help 欢迎 / 关于 可以先接到 `welcome.ts` 已有的函数上，避免空按钮。

Get Started：放在 `#wbEditor .ed-stage` 里新节点 `#nfWelcome`（与 `#edWelcome` 并列）。无工程显示 `#nfWelcome`，隐藏 `#edWelcome` 与 textarea。有工程无文件：现有 `#edWelcome`。Help→欢迎：有工程时显示 `#nfWelcome` 但不关标签。

`body.no-workspace`：对话/工程/文件/历史短空态。composer 的 textarea `disabled`。设置页仍可点。

前端 `store` 记下 `currentId` 与 `recents`（recents 需要下行：`workspaces` 不含 recents）。**补一条 OutMessage 或把 recents 放进 `workspaces`。** Spec 的 `workspaces` 只有 items。Recent 列表来自 `window.json`，Hub 在每次 `workspaces` 推送时**额外**带 recents：

为免再改一轮协议，本 Task **把 recents 加进 `workspaces`**：

```ts
{ type: 'workspaces'; currentId; items; recents: { root: string; name: string }[] }
```

这是对 spec 的小修正（前端否则无法画 Recent）。Task 1 若已合入，在此 Task 补字段，e2e 断言放宽为「有 recents 数组」。**不要另造 `recents` 消息。**

- [ ] **Step 1: 改协议 `workspaces` 加 `recents`，Hub 推送时带上 `readWindowState().recents`。e2e 不因多字段红。**

- [ ] **Step 2: 改 page.ts + CSS。DOM 测试：standalone body 有 `#wbMenubar`、三个 `.wb-menu-btn`、`#nfWelcome`。**

- [ ] **Step 3: `menubar.ts` / `welcome.ts` 能力探测：没有 `#wbMenubar` 直接 return（插件）。`index.ts` 处理 `workspaces`：toggle `no-workspace`、更新标题、渲染 Recent。**

- [ ] **Step 4:** `npm run typecheck` && `npm run test:dom`。

- [ ] **Step 5: commit**

```
feat: 独立版标题栏菜单与空窗口欢迎页
```

---

### Task 8: 目录选择器与菜单动作

**Files:**
- Create: `media/src/view/folderPicker.ts`
- Create: `media/src/css/standalone/picker.css`（或并入 menubar.css）
- Modify: `media/src/view/menubar.ts`（填满 spec 第 2.2 节表）
- Modify: `media/src/editor/`：查找条（下一个/上一个，仅当前 textarea）
- Modify: `tests/dom/standalone/` 选择器与菜单启用

选择器：模态、路径框、列表、`..`、确定=当前路径（文件夹模式）、文件模式锁工程根并走 `listDir`（把 `dirListings` 转成选择器列表，absPath 用工程根拼接）。`listHostDir` / `hostDir` 驱动文件夹模式。新建文件夹发 `createHostDir`，用返回的 `hostDir` 刷新。

未保存确认：打开/关闭文件夹前，若 editor 有 dirty，复用现有关标签确认。

新建文件：`input` 相对路径 → 发一条需要后端写空文件的消息。**不要新协议也能做**：有工程时 `saveFile` 对不存在路径是否允许？`writeFileFromEditor` 走 workspace，通常要求文件存在。应加 `createFile { relPath }` 或 Hub 在有工程时 `workspace.write` 空内容。为避免含糊：**新增 `InMessage` `{ type: 'createFile'; relPath: string }`**，Hub 有激活工程才处理，经 `Workspace.write` 写空字符串，已存在 toast 拒绝。插件 dispatch 空分支。这是 spec「经 workspace 网关写空文件」的落点。

另存为：问新相对路径，读当前编辑器文本 `saveFile` 到新路径（若 saveFile 不能创建，则先 `createFile` 再 save）。以 `Workspace.write` 一次写满内容为准，可让 `createFile` 收可选 `text`。

查找：`#edFind` 窄条，Enter 下一个，Shift+Enter 上一个，高亮用 textarea 选区即可，不做工作区搜索。

菜单启用表按 spec。Edit 项：焦点在 input/textarea 时启用，走 `editor/clipboard.ts` 的 execCommand。

退出：`window.close()`。

使用说明：按 spec 2.2.1。需要 Hub 处理 `{ type: 'openReadme' }` 或前端自己 `openEditor('README.md')` 若工程里有。无工程发 `openReadme`，Hub 找仓库根 README（从 `import.meta.dir` 上溯找 `package.json`+`README.md`），有则 `openWithSystem`，没有 toast。**加 `openReadme` 空窗口消息**，与 `openLogDir` 同类。

关于：前端弹层读 `#wbTitle[data-version]` 与当前工程路径。

- [ ] **Step 1: 协议补 `createFile` / `openReadme`，controller 空分支，Hub 实现。**

- [ ] **Step 2: 选择器 DOM 测试：发 hostDir → 列出名字；点目录发出新的 listHostDir；确定发出 openFolder。**

- [ ] **Step 3: 菜单动作接到 post()。`npm run typecheck` && `npm run test:dom` && `npm run test:e2e`。**

- [ ] **Step 4: commit**

```
feat: 远程风目录选择器与 File/Edit/Help 动作
```

---

### Task 9: 桌面壳

**Files:**
- Modify: `src/shells/desktop/src/main.rs`
- Modify: `src/shells/desktop/src/sidecar.rs`（`start` 不再收 `root`，args 只有 `--no-open --port`）
- Modify: `src/shells/desktop/src/project.rs`（启动时把 `shell.json` 的 `last_project` 迁到 sidecar 会读的 `window.json` **做不到**：window.json 在用户 home 的 `.novelforge`，Rust 可以写 `dirs::home_dir()/.novelforge/window.json`。迁一次：若 window.json 无 lastOpen 且 shell.json 有 last_project 且目录存在，写入 lastOpen。）
- Modify: `src/shells/desktop/ui/splash.html`、`splash.js`：删除 picking 态与选目录按钮；failed 只留重试/查看日志
- 去掉 `build_menu` 的 File/Help，或 `menu(None)` / 空菜单，避免与 HTML 菜单重复。保留系统窗口按钮。

`launch` 不再 `choose_then_launch`。`setup` 直接 `sidecar::start(app)`。`select_project` 命令可删。失败 retry 只再起 sidecar，不传路径。

- [ ] **Step 1: 改 Rust 与 splash，保证能编**（本机有 Rust 则 `cargo check --manifest-path src/shells/desktop/Cargo.toml`）。没有工具链就只改源码，不假装编过。

- [ ] **Step 2: commit**

```
feat: 桌面壳无工程路径起 sidecar，闪屏不再选目录
```

---

### Task 10: 文档与 F5

**Files:**
- `README.md`：去掉「默认当前目录」；写明 `novelforge` 空窗口、`novelforge [dir]` 打开
- `src/shells/standalone/README.md`、`src/shells/desktop/README.md`：热换、闪屏只 starting/failed、不再传工程路径
- `.vscode/launch.json` + `.vscode/README.md`：新增「起独立 Web 版（空窗口）」
- `AGENTS.md` 模块地图如有新文件可补一行 workspaceHub/hostFs
- `src/shells/standalone/page.ts` 注释

- [ ] **Step 1: 改文档。**

- [ ] **Step 2: commit**

```
docs: 独立版可空窗口启动的使用说明
```

---

## 完成定义

- `novelforge` 不带目录能打开网页，见 Get Started，File 能打开文件夹。
- `novelforge sample-novel` 行为与现在一致（直接进工程）。
- 关闭文件夹回到欢迎页；再启动不自动打开。
- 打开文件夹不重启服务（桌面不 kill sidecar）。
- `mode: 'add'` toast 且仍只有一个工作区。
- 插件、`npm test`、sample-novel hash 绿。
- 桌面无原生 File/Help 重复菜单。

## 给接手 agent 的提示词

```
按 docs/design/plans/2026-08-20-empty-window.md 在 git worktree 里实施，分支 feat/empty-window。
先读 docs/design/specs/2026-08-20-empty-window-design.md 与 AGENTS.md。
从 Task 1 做到 Task 10，每个 Task 测过再 commit。不要在用户的 main 工作区改代码。
不要给 agent 开放 listHostDir，不要改插件空窗口，不要把 listDir 与 listHostDir 合成一个。
```
