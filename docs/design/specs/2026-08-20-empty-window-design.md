# 空窗口启动页与标题栏菜单设计

日期：2026-08-20
状态：待评审

## 背景与目标

独立版（含桌面壳）现在必须在启动命令里拿到工程目录：CLI 不带参数时把当前目录当成工程，桌面壳在闪屏里先选目录再起 sidecar。没有「未打开文件夹」的状态，标题栏也只是 logo + 工程名 + 主题按钮。

目标：

1. **可以不带工作区启动**，编辑器区给出类似 VS Code 空窗口的 Get Started。
2. **顶部 `.wb-title` 改成 VS Code 风格菜单栏**（File / Edit / Help）。
3. **打开文件夹在同一进程里热换工作区**，不重启服务。
4. **协议上预留多开工作区**，这一版窗口里仍然只有 0 或 1 个工程。

本设计修订 [2026-08-04 独立 Web 程序设计](2026-08-04-standalone-web-app-design.md) 里「单工程目录启动」那条：独立版进程仍只服务本机一个作者，但工程目录改为可空、可在运行时替换。插件壳不动（VS Code 自己的空窗口与打开文件夹继续当工作区来源）。

## 已确认的关键决策

| 决策点 | 结论 |
| --- | --- |
| 范围 | 独立 Web + 桌面。插件壳不改 |
| 空窗口外观 | VS Code 空窗口：菜单栏 + 活动栏仍在，编辑器区 Get Started；侧栏对话/工程/文件/历史为空态；设置仍可用 |
| 上次工程 | 像 VS Code：上次关窗口时工程还开着就恢复；`关闭文件夹` 后再退出则进空窗口 |
| 选目录 | 后端 `listHostDir` 列本机目录，前端做远程开发那种路径框 + 列表，不弹系统对话框、不让用户手打整段路径当唯一入口 |
| 打开工程 | 同一进程热换 `ChatController`，不重启 sidecar |
| 多开 | Hub 按 id 挂多份运行时；这一版只实现 `replace`，`mode: 'add'` 回明确错误 |
| 菜单深度 | VS Code 常用子集（见第 2 节表），不是 Selection / View / Go / Run / Terminal |
| 无工程文件 | 不支持未命名文件。新建文件 / 打开文件在无工程时置灰；有工程时打开文件锁在工程根内 |
| 桌面菜单 | 去掉 Tauri 原生 File/Help，只留 HTML 菜单 + 系统窗口按钮 |
| 目录列举 | `listDir`（工程内）与 `listHostDir`（本机绝对路径）分开，不合成一个 |

## 非目标

- 多窗口、`mode: 'add'` 的真正实现、无工程未命名文件
- 自定义窗口最小化/最大化/关闭按钮
- 工作区全文搜索、查找替换
- 改插件空窗口或给 agent 开放 `listHostDir`
- 改 `getHost()` 全局单例、给每条现有 `InMessage` 加 `workspaceId`

---

## 1. 工作区生命周期与预留的多开面

### 1.1 分层

`ChatController` 仍然一对一绑一份 `NovelProject`。多开不进 core。

独立版服务里新增 **`WorkspaceHub`**（`src/shells/standalone/workspaceHub.ts`）：

```
id → BoundRuntime { controller, watchDisposable }
```

`id` 是 `fs.realpath` 之后的绝对路径，同一目录只存在一份。再打开已打开的路径 = `activate`，不重建 controller。

现有创作 / 工程 / 文件消息打到**当前激活**的那一份。没有激活项时 Hub 拦截并 toast「请先打开文件夹」，不造假工程、不写临时目录。

### 1.2 这一版的行为

Hub 里最多一份。`打开文件夹` 若已有工程：先处理未保存 → 停生成 → `closeDatabase` → 停 watcher → 再绑定新路径（替换，等同 VS Code 同窗口 Open Folder）。`关闭文件夹` 卸掉当前项，回到空窗口。

启动时：

- CLI 带了目录 → 立刻绑定该目录（覆盖记忆）。
- 未带目录且 `window.json` 的 `lastOpen` 存在、目录仍在 → 启动时绑定，不闪欢迎页。
- `lastOpen` 路径已不在 → 清掉该字段，进空窗口，不崩。
- 上次是关掉文件夹后退出（`lastOpen` 为 `null`）→ 空窗口。

### 1.3 预留的多开协议（这一版就落地形状）

上行：

| 消息 | 字段 | 这一版 |
| --- | --- | --- |
| `openFolder` | `path: string; mode?: 'replace' \| 'add'` | 缺省与 `'replace'` 实现；`'add'` toast「本版本只支持一个工作区」，磁盘不变 |
| `closeFolder` | `id?: string` | 省略则关当前 |
| `activateWorkspace` | `id: string` | 只有 0/1 项，调用等于确认当前项 |

下行（bind / unbind / 刷新 / `ready` 都推）：

```ts
{ type: 'workspaces'; currentId: string | null; items: { id: string; root: string; name: string }[] }
```

空窗口是 `{ currentId: null, items: [] }`。前端只凭 `currentId` 切欢迎页/工作台，不猜。

这些消息由 Hub 在进入 `ChatController` 之前处理。插件不会发。core 的 `dispatch` 给它们空分支，避免 `InMessage` 联合类型漏网。

### 1.4 刻意不预留

- 不改 `getHost()`。`FileHost.root` 随 bind/unbind 更换。真要 N 个同时开着时，再做成每份运行时一个 Host。
- 不做多根工作区（一个窗口里几个根目录）。
- 不给每条 `send` / `saveFile` 加 `workspaceId`。多开后的路由是 `activate` 之后打到当前项，或下一期再加 Host-per-runtime。

### 1.5 记忆：`~/.novelforge/window.json`

```ts
{
  lastOpen: string | null; // 关掉文件夹后为 null；恢复启动只看这个
  recents: { root: string; name: string; openedAt: number }[];
}
```

- 配置与密钥仍在 `config.json` / `secrets.json`，本文件只记窗口状态。
- `recents` 在成功 `openFolder` 时 upsert，关掉文件夹不删。上限 20 条，按 `openedAt` 新的在前。
- 桌面壳现有 `<app_config_dir>/shell.json` 的 `last_project`：若 `window.json` 还没有 `lastOpen`，启动时迁过去一次，然后不再当真相。独立版与桌面共用 `window.json`。

设置不依赖工程，空窗口也能打开设置页。日志库跟工程走：没打开文件夹时日志页只有本进程内存记录，`requestLogHistory` 回空列表且 `exhausted: true`。

---

## 2. 标题栏菜单与空窗口欢迎页

只改独立版 `page.ts` 的 `.wb-title` 与独立版 CSS。插件没有这条栏。前端用节点是否存在做能力探测，不写壳名字分支。不新增前端产物（菜单栏 / 欢迎页 / 选择器都进现有 `view.js`，探测不到节点就 return）。

### 2.1 标题栏布局

从左到右，高度保持 38px，观感贴 VS Code 自定义标题栏：

1. 应用图标
2. **File / Edit / Help** 文字菜单（不是大按钮）
3. 窗口标题：空窗口 `Novel Forge`；有工程 `工程名 - Novel Forge`；有当前文件再在前面加文件名
4. 右侧仍是「显示/隐藏编辑器」和主题

窗口最小化/最大化/关闭继续用系统原生，不做假窗口按钮。页面标题和 `#wbProject` 只跟 `workspaces` 快照（外加当前编辑器文件名）走，不把工程名写死在首屏 HTML 里。

菜单交互按 VS Code：点开一个，鼠标移到隔壁就切过去；点外面或 Esc 收起；加速键写在项右侧；不可用项留着但置灰。`打开最近打开的` 是子菜单。不做 Alt 快捷字母。不复用右键菜单引擎（缺悬停切菜单和子菜单），单独一个菜单栏模块。

### 2.2 菜单项与启用

| 菜单 | 项 | 无工程 | 有工程 |
| --- | --- | --- | --- |
| File | 新建文件 | 置灰 | 可用：问工程内相对路径，经 `workspace` 网关写空文件；已存在则拒绝，不限章节/角色/设定三个区 |
| File | 新建工程 | 可用 | 可用 |
| File | 打开文件 | 置灰 | 可用：选择器根锁在当前工程，数据走现有 `listDir` |
| File | 打开文件夹 | 可用 | 可用，`mode: 'replace'` |
| File | 最近打开 ▶ | 可用（无记录时子菜单写「没有最近打开的工程」） | 同左 |
| File | 保存 / 另存为 / 全部保存 | 置灰 | 有打开且（保存/全部保存）有脏标签才启用；另存为问工程内新路径，不覆盖已有 |
| File | 关闭编辑器 | 置灰 | 有当前标签才启用 |
| File | 关闭文件夹 | 置灰 | 可用 |
| File | 退出 | 可用 | 一律 `window.close()`，**不**向服务发 quit（以免杀掉还开着网页的 `novelforge`）。普通浏览器标签通常关不掉，用户关标签即可；Tauri WebView 里会关窗口。不按壳名字决定渲染 |
| Edit | 撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选 | 焦点在 input/textarea 才启用 | 同左；走现有 `execCommand`，保住 textarea 撤销栈 |
| Edit | 查找 | 置灰 | 当前编辑器一条窄查找条（下一个/上一个），不做工作区搜索、不做替换 |
| Help | 欢迎页面 | 可用（已在欢迎页则无操作） | 在编辑器区打开 Get Started，不关已打开的文件标签；切回文件标签即离开 |
| Help | 使用说明 | 见 2.2.1 | 同左 |
| Help | 打开日志目录 | 可用：发 `openLogDir`。Hub 用 `openWithSystem` 打开 `~/.novelforge/`（`window.json` / 配置所在目录）。桌面失败闪屏仍走 Tauri `open_logs`（sidecar.log 目录），那是服务还没起来时的入口 | 同左 |
| Help | 关于 | 前端弹层：产品名、版本（`standalonePage` 写入 `data-version`，来自 `package.json`）、当前工程路径（没有则省略） | 同左 |

**使用说明（2.2.1）。** 有打开的工程且工程根下有 `README.md`（或 `README.markdown`）→ 内置编辑器打开。否则，若进程能解析到源码仓库根的 `README.md`（从仓库跑 `npm run standalone` 时可以）→ `openWithSystem` 打开该绝对路径，不经工程网关。单文件可执行旁边没有这份文件 → toast「找不到使用说明」。不 404，不编一套新文档页。

桌面壳去掉 `build_menu` 注册的原生 File/Help，避免叠两层。关窗口用系统标题按钮。失败闪屏上的「查看日志」仍走 Tauri `open_logs`（那时还没导航到 sidecar 页面）。

### 2.3 两种空态，不合并

`body` 用能力类（如 `no-workspace`），不判断壳名。

**无工程（`currentId === null`）—— Get Started**

- 编辑器区：左列 Start（新建工程、打开文件夹）+ Recent（名字 + 路径，点一项即 `openFolder replace`）；右列一句产品说明和常用快捷键。没有克隆 Git / 远程连接。
- 对话 / 工程 / 文件 / 历史：短空态「打开文件夹后即可使用」；对话输入禁用。
- 设置可用。日志页仅内存日志。

**有工程、没打开文件**——继续用现有 `ed-welcome`（「还没有打开文件」）。Help → 欢迎页面可以在有工程时盖住编辑区显示 Get Started，但不关标签。

### 2.4 新建工程

先打开第 3 节的目录选择器（选目录）。若该目录已是小说工程（存在 `.novelforge/project.json`）：toast 并 `openFolder replace`，不跑初始化。否则先绑定该目录，再走现有 `initProjectFlow`（作品名 / 作者）。用户取消初始化：目录保持打开，工程页仍可点「初始化工程」。

---

## 3. 目录选择器与本机列举

### 3.1 两种列举

| API | 路径 | 用途 |
| --- | --- | --- |
| 现有 `listDir` | 工程内相对路径 | 侧栏文件页；有工程时的「打开文件」 |
| 新 `listHostDir` | 本机绝对路径 | 「打开文件夹」「新建工程」 |

`listHostDir` 只列一层、**不返回文件内容**。写盘仍只在打开工程之后走 `workspace/` 网关（`createHostDir` 除外，见下）。实现放在独立版壳（`src/shells/standalone/hostFs.ts`），不进 core，避免 agent 或插件误用。

隐藏名与资源管理器同一份：`node_modules`、`.git`。点开头的目录显示。条目上限与截断口径与 `listDir` 相同（`MAX_DIR_ENTRIES`，把真实总数放进 `truncated`）。失败不抛，结果带 `error`。symlink 按 `stat` 后的目录/文件列出来；workspace `id` 用 `realpath`，避免同一目录两条。

### 3.2 选择器 UI

模态框，不是 `prompt` 输入框。按 VS Code 远程 Open Folder：

- 标题随用途变
- 路径输入框：当前绝对路径，回车跳转；不合法则列表区显示原因，不关框
- 列表：目录在前、文件在后；单击目录进入；`..` 回到 `parent`（文件系统根没有 `..`）
- Windows：路径为空或从盘符再往上 → 列出盘符（`roots: true`）
- Unix：打开选择器时落在 `os.homedir()`；`..` 可上到 `/`。`path === ''` 与 `path === '/'` 都列举 `/` 的直接子项，此时没有 `..`
- 底部：新建文件夹、取消、确定
- 文件夹模式：确定 = 打开**当前路径**（不必再点进子目录）
- 文件模式：选中一个文件后确定才启用；根锁在当前工程，请求走 `listDir`

### 3.3 `createHostDir`

仅选择器「新建文件夹」：`{ parent: string; name: string }` → `mkdir`。同名已存在则报错不覆盖。`name` 含斜杠、反斜杠或 `..` 直接拒绝。不给 agent、不进工程文件操作。

### 3.4 协议补遗

上行另增：

```ts
{ type: 'listHostDir'; path: string }           // '' = 根层
{ type: 'createHostDir'; parent: string; name: string }
{ type: 'openLogDir' }
```

下行：

```ts
{
  type: 'hostDir';
  path: string;
  parent?: string;
  entries: { name: string; kind: 'dir' | 'file'; absPath: string }[];
  truncated: number;
  error?: string;
  roots?: boolean;
}
```

失败用已有 `toast`，不另造 `workspaceError`。`createHostDir` 成功后推一条该 `parent` 的 `hostDir`（列表刷新）。

### 3.5 打开 / 替换 / 关闭流程

1. 前端若有未保存编辑器，先问（与关标签同一套）；取消则不发消息。
2. `openFolder` + `replace`：校验路径是存在的目录 → dispose 旧运行时 → `NovelProject.open` → 新 controller、新 watcher、`FileHost.bind` → 写 `window.json` → 推 `workspaces` → `resendFullState`。
3. 已在 Hub 里的路径：只激活。
4. `closeFolder`：dispose → `lastOpen = null`（recents 保留）→ 推空 `workspaces`。前端清编辑器标签、回到 Get Started。
5. 无激活工作区时，创作/工程/文件类消息由 Hub 拦住。下列消息在空窗口仍可用：`ready`、选择器消息、工作区生命周期、`openLogDir`、`saveSettings` / `setApiKey` / `clearApiKey` / `testConnection` / `openNativeSettings`（独立版无操作）、`switchTab`、日志三条、`cancelTask`、`promptResult`。

设置读写抽成不依赖 `NovelProject` 的函数（配置本就在 `~/.novelforge`）。独立版无论有没有工程，设置类消息都走 Hub → 这些函数，避免空窗口去构造 controller。插件壳仍走现有 `ChatController` 分支（那边一定有工作区）。

### 3.6 空窗口的 `ready` / WS 重连

不发带假工程的 `init` / `project` / `session`。先发 `workspaces`（空）和 `settings`（读 `config.json`），可附带内存 `logs` 与空 `tasks`。

有工程时的 `ready` / WS `open`：先 `workspaces`，再现有 `resendFullState`。

---

## 4. CLI、桌面、热换落点

### 4.1 CLI

`parseArgs`：`root` 改为 `string | undefined`。不带位置参数时不再 `path.resolve('.')`。

| 命令 | 行为 |
| --- | --- |
| `novelforge` | 起服务、按第 1.2 节恢复或空窗口 |
| `novelforge [dir]` | 打开该目录 |
| `novelforge init [dir]` | 不变；`init` 仍要一个目录，缺省才是 `.` |
| `--port` / `--no-open` / `--verbose` | 不变 |

未初始化目录仍只打提示、不阻止启动（与现在一致）。F5 保留「示例小说工作区」，新增「空窗口」（不带目录）。README 去掉「默认当前目录」。

### 4.2 桌面

sidecar **不再接收工程路径**，参数只有 `--no-open --port`。恢复上次工程由 sidecar 读 `window.json`，与浏览器里跑 `novelforge` 同一条路。打开/关闭文件夹不 kill、不重启 sidecar。

闪屏只剩：

- `starting`：正在启动
- `failed`：起失败了（重试 / 查看日志）

删除 `picking` 态、选目录按钮、以及「打开其他工程就重启 sidecar」的菜单路径。`setup` 里直接 `launch`（无 root）。`shell.json` 只做一次迁到 `window.json` 的桥，迁完可不再写 `last_project`。

约定仍成立：退出必须 kill sidecar；不开 `dangerousRemoteDomainIpcAccess`。传给 sidecar 的工程路径这条约定改为「不再传工程路径」。

### 4.3 热换实现要点

- `startServer({ root?: string; port; verbose? })`：有 `root` 则立刻 `hub.open`（给 CLI 与现有 e2e）。
- `FileHost` 增加 `bind(root)` / `unbind()`：换工程与 watcher；`PromptHub` 和广播一直活着。`initHost` 仍只调一次。
- 替换顺序不可颠倒：未保存 → 停生成 → `closeDatabase` → 停 watcher → `open`。反了会在 Windows 上撞库文件 EBUSY。
- 打开失败：能回旧工程则回；旧的已经 dispose 完则落到空窗口并 toast 原因。列目录失败写在 `hostDir.error`，框不关。
- 日志仍 `redact`，`listHostDir` 只记路径与条目数，不记文件内容。

### 4.4 消息路由（独立版 `server.ts`）

```
promptResult                → PromptHub
listHostDir / createHostDir
openFolder / closeFolder
activateWorkspace
openLogDir                  → WorkspaceHub（始终）
saveSettings / setApiKey /
clearApiKey / testConnection
ready（先 workspaces）      → Hub；有激活项再转 controller.resendFullState
其余 InMessage              → hub.active()?.handle；没有则 toast
```

---

## 5. 测试

| 层 | 内容 |
| --- | --- |
| 单元 | `parseArgs` 无参数时 `root` 为 `undefined`，带 dir 仍 resolve；`hostFs`：缺目录、截断、拒绝 `..`、同名不覆盖、不返回内容；Hub：打开、替换会 dispose、`add` 报错、同路径只激活、`realpath` 去重、关闭后 `lastOpen` 为空 |
| e2e（Bun） | 无 `root` 起服务 → `ready` 得到空 `workspaces`、没有假 `init`；`listHostDir`；打开 `sample-novel` 后有 `init`/`project`；再 `closeFolder` 回到空。现有带 `root` 的用例继续传 `root` |
| DOM | 菜单栏结构与置灰；`no-workspace` 时 Get Started；选择器进入子目录 / `..` / 确定当前路径 |
| 契约 | `corePurity` / `shellPurity`、sample-novel hash、插件行为不改 |
| 桌面 | 无自动测。手测：无记忆进欢迎页；有记忆不闪欢迎页；失败态仍能看日志；HTML 菜单存在且无原生 File/Help 重复 |

`startServer` 的 `initHost` 仍是模块级单例，e2e 里无 root 的服务与带 root 的服务仍须按文件顺序跑完，不能并行起两份还指望 Host 不串。

---

## 6. 主要改动文件（供计划拆任务，不是实施步骤）

- 协议：`src/core/protocol/in.ts`、`out.ts`；`ChatController.dispatch` 空分支
- 独立版：`cli.ts`、`main.ts`、`server.ts`、`fileHost.ts`、`page.ts`、新 `workspaceHub.ts`、`hostFs.ts`、`windowState.ts`
- 前端：`media/src/view/` 下菜单栏 / 欢迎页 / 选择器；`media/src/css/standalone/`
- 桌面：`src/main.rs`、`sidecar.rs`、`project.rs`、`ui/splash.html`、`splash.js`
- 文档：`README.md`、`src/shells/standalone/README.md`、`src/shells/desktop/README.md`、`.vscode/README.md`、`launch.json`
- 测试：`tests/unit/`、`tests/e2e/standalone/`、`tests/dom/standalone/`

设置相关的纯函数从 `controller/settings.ts` 抽出时，插件路径保持行为逐字节不变（仍由 controller 调用同一份函数）。
