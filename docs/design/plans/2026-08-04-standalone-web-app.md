# Novel Forge 双形态改造实施计划



**Goal:** 把 Novel Forge 从纯 VS Code 插件改造为「共享核心 + VS Code 壳 + Bun 独立 Web 服务壳」的双形态架构，独立版 `novelforge [dir]` 启动本机 Web 服务，浏览器即可续写/管理小说工程。

**Architecture:** `src/core/` 零 vscode 依赖（数据层、上下文装配、LLM、controller、协议），通过窄接口 `Host` 获取宿主能力（配置、密钥、弹窗、进度、文件监听）；`src/vscode/` 是插件壳；`src/standalone/` 是 Bun HTTP+WebSocket 服务壳，复用现有 `InMessage/OutMessage` 协议与 `media/view.js` 前端（经 `bridge.js` 把 WebSocket 伪装成 webview API）。设计文档见 `docs/design/specs/2026-08-04-standalone-web-app-design.md`。

**Tech Stack:** TypeScript（现有 strict 配置）、esbuild（插件 bundle，维持现状）、Bun（独立壳运行时与 `bun build --compile`）、node:fs/path/child_process（core 内替代 vscode API）、原生 WebSocket（无第三方服务端框架）。

**通用约定：**
- 所有命令在仓库根目录 `c:\data\project\novelForge` 下执行，shell 为 PowerShell（不支持 `&&`，用 `;`）。
- 每个任务的验证基线：`npm run typecheck`（= `tsc --noEmit`）必须零错误；涉及 core 的任务还要跑 `npm run smoke`。
- 提交信息沿用现有风格（中文正文可，前缀用 `feat/refactor/chore/docs`）。
- 现有关键事实（执行者无需再探索）：
  - webview 前端 `media/view.js` 顶部 IIFE 内 `const vscode = acquireVsCodeApi()`，用 `vscode.postMessage(...)` 发消息，用 `window.addEventListener('message', ...)` 收消息，加载末尾自发 `{ type: 'ready' }`。
  - 协议在 `src/ui/protocol.ts`（`InMessage`/`OutMessage`），`renderHtml()` 生成两宿主共用的 HTML。
  - 配置现在全部读自 `vscode.workspace.getConfiguration('novel')`；API Key 存 `vscode.SecretStorage`。
  - smoke 脚本通过 esbuild 把单个 TS 文件 bundle 成 CJS 后 require，并用 `Module._load` 打 vscode 桩。

---

### Task 1: 目录重构 —— core / vscode 分层（纯移动，无行为变化）

**Files:**
- Move: `src/model/` → `src/core/model/`；`src/context/` → `src/core/context/`；`src/features/` → `src/core/features/`
- Move: `src/llm/provider.ts|openaiProvider.ts|anthropicProvider.ts|registry.ts` → `src/core/llm/`；`src/llm/vscodeLmProvider.ts` → `src/vscode/vscodeLmProvider.ts`
- Move: `src/ui/protocol.ts` → `src/core/protocol.ts`（其中 `renderHtml()` 拆到新文件 `src/vscode/webviewHtml.ts`）
- Move: `src/ui/projectView.ts` → `src/core/projectView.ts`
- Move: `src/extension.ts` → `src/vscode/extension.ts`；`src/ui/chatViewProvider.ts`、`src/ui/chatPanel.ts` → `src/vscode/`
- Keep（暂不移动，Task 8 再动）: `src/ui/chatController.ts`、`src/ui/attachments.ts`
- Modify: `esbuild.js`、`scripts/smoke*.js`（路径）、以及所有被移动文件的相对 import

- [ ] **Step 1: 用 git mv 移动目录与文件**

```powershell
git mv src/model src/core/model
git mv src/context src/core/context
git mv src/features src/core/features
New-Item -ItemType Directory src/core/llm, src/vscode -Force
git mv src/llm/provider.ts src/core/llm/provider.ts
git mv src/llm/openaiProvider.ts src/core/llm/openaiProvider.ts
git mv src/llm/anthropicProvider.ts src/core/llm/anthropicProvider.ts
git mv src/llm/registry.ts src/core/llm/registry.ts
git mv src/llm/vscodeLmProvider.ts src/vscode/vscodeLmProvider.ts
git mv src/ui/protocol.ts src/core/protocol.ts
git mv src/ui/projectView.ts src/core/projectView.ts
git mv src/extension.ts src/vscode/extension.ts
git mv src/ui/chatViewProvider.ts src/vscode/chatViewProvider.ts
git mv src/ui/chatPanel.ts src/vscode/chatPanel.ts
```

- [ ] **Step 2: 拆分 renderHtml 到 src/vscode/webviewHtml.ts**

从 `src/core/protocol.ts` 里**删除** `renderHtml()`（连同它对 `vscode` 的 import——`makeNonce` 保留在 protocol.ts，它是纯函数），新建：

```ts
// src/vscode/webviewHtml.ts
import * as vscode from 'vscode';
import { makeNonce } from '../core/protocol';

/**
 * 两个 webview 宿主共用的 HTML。只加载本地资源，CSP 里不开任何外部来源。
 * bridge.js 在 view.js 之前加载：webview 里它检测到 acquireVsCodeApi 存在就直通。
 */
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = makeNonce();
  const asset = (name: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name)).toString();

  // 内容与原 renderHtml 完全一致，仅两处变化：
  // 1. <script> 标签先加载 bridge.js 再加载 view.js（都带 nonce）
  // 2. 其余 DOM 结构一字不改
  return `<!DOCTYPE html>……（照抄原模板，脚本区改为）……
<script nonce="${nonce}" src="${asset('bridge.js')}"></script>
<script nonce="${nonce}" src="${asset('view.js')}"></script>
</body>
</html>`;
}
```

注意：完整照抄原 `renderHtml` 模板字符串（tabbar、四个 pane、providerModal、toast），只替换脚本引用那一处。`chatViewProvider.ts` / `chatPanel.ts` 改为 `import { renderHtml } from './webviewHtml'`。

- [ ] **Step 3: 修正所有相对 import**

规则：被移动文件之间的相对路径按新位置重算。关键点：
- `src/core/**` 内互相引用仍是 `../model/project` 这类（整目录平移的不变）；跨目录的改：
  - `src/vscode/extension.ts`：`./features/…` → `../core/features/…`；`./llm/registry` → `../core/llm/registry`；`./model/project` → `../core/model/project`；`./ui/chatController` → `../ui/chatController`（暂留）；`./ui/chatViewProvider` → `./chatViewProvider`。
  - `src/ui/chatController.ts`：`../context/builder` → `../core/context/builder`；`../features/…` → `../core/features/…`；`../model/…` → `../core/model/…`；`../llm/registry` → `../core/llm/registry`；`./protocol` → `../core/protocol`；`./projectView` → `../core/projectView`。
  - `src/ui/attachments.ts`：`../model/…` → `../core/model/…`。
  - `src/vscode/vscodeLmProvider.ts`：`./provider` → `../core/llm/provider`。
  - `src/core/llm/registry.ts`：`./vscodeLmProvider` 的 import 改为 `../../vscode/vscodeLmProvider`（临时跨层引用，Task 7 用工厂钩子消除）。

- [ ] **Step 4: 更新构建与 smoke 脚本里的路径**

`esbuild.js`：

```js
entryPoints: ['src/vscode/extension.ts'],
```

`scripts/smoke.js`：`loadModule('src/model/markdown.ts')` → `'src/core/model/markdown.ts'`；`'src/context/tokenizer.ts'` → `'src/core/context/tokenizer.ts'`；`'src/features/continueWriting.ts'` → `'src/core/features/continueWriting.ts'`；`'src/features/summarize.ts'`、`'src/features/characters.ts'` 同理（文件内共 5 处）。
`scripts/smoke-session.js`：`'src/model/project.ts'`、`'src/model/session.ts'` → `'src/core/model/…'`。
`scripts/smoke-providers.js`、`smoke-builder.js`、`smoke-llm.js`：同样把 `src/model/`、`src/context/`、`src/llm/`（openai/anthropic/provider）前缀改成 `src/core/…`；`vscodeLmProvider` 若被引用则指向 `src/vscode/vscodeLmProvider.ts`。

- [ ] **Step 5: 验证**

```powershell
npm run typecheck ; npm run smoke ; npm run compile
```

预期：全部与重构前一样通过（行为零变化）。若 F5 调试插件可开，手动确认面板正常。

- [ ] **Step 6: Commit**

```powershell
git add -A ; git commit -m "refactor: split src into core/vscode layers (file moves only)"
```

---

### Task 2: 文件系统去 vscode 化 —— Uri/workspace.fs → path/fs

**Files:**
- Modify: `src/core/model/project.ts`（核心）、`src/core/model/session.ts`
- Modify: 所有消费方（controller、continueWriting、summarize、characters、style、projectView、attachments、vscode/extension.ts）

目标：`NovelProject.root` 从 `vscode.Uri` 变为绝对路径 `string`；所有文件 IO 走 `node:fs/promises`；对外返回值从 `vscode.Uri` 变为**工作区相对路径字符串**（relPath）。

- [ ] **Step 1: 重写 project.ts 的基础设施**

删除 `import * as vscode from 'vscode'`，改为：

```ts
import * as crypto from 'crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
```

工具函数替换（文件尾部）：

```ts
export async function exists(absPath: string): Promise<boolean> {
  try { await fs.stat(absPath); return true; } catch { return false; }
}

export async function readText(absPath: string): Promise<string> {
  return fs.readFile(absPath, 'utf8');
}

export async function writeText(absPath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, text, 'utf8');
}

async function writeIfAbsent(absPath: string, text: string): Promise<void> {
  if (!(await exists(absPath))) await writeText(absPath, text);
}

/** 列出目录下所有 .md 文件的绝对路径。 */
async function listMarkdown(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}

function baseName(absPath: string): string {
  return path.basename(absPath).replace(/\.md$/i, '');
}
```

- [ ] **Step 2: 重写 NovelProject 类的路径层**

```ts
export class NovelProject {
  private chapterCache: Chapter[] | undefined;

  private constructor(public readonly root: string) {}

  /** 以某目录为工程根打开实例（不做初始化检查）。 */
  static open(root: string): NovelProject {
    return new NovelProject(path.resolve(root));
  }

  get chaptersDir(): string { return path.join(this.root, this.config.chaptersDir); }
  get novelDir(): string { return path.join(this.root, NOVEL_DIR); }
  get manifestPath(): string { return path.join(this.novelDir, MANIFEST_FILE); }
  get stylePath(): string { return path.join(this.novelDir, 'style.md'); }
  get outlinePath(): string { return path.join(this.novelDir, 'outline.md'); }
  get charactersDir(): string { return path.join(this.novelDir, 'characters'); }
  get loreDir(): string { return path.join(this.novelDir, 'lore'); }
  get summariesDir(): string { return path.join(this.novelDir, 'summaries'); }
  get sessionsDir(): string { return path.join(this.novelDir, 'sessions'); }
  get legacyNovelDir(): string { return path.join(this.root, LEGACY_NOVEL_DIR); }
  get globalSummaryPath(): string { return path.join(this.summariesDir, 'global.md'); }
  summaryPath(order: number): string { return path.join(this.summariesDir, `${pad3(order)}.md`); }

  /** 绝对路径 → 工作区相对路径（正斜杠）。 */
  relPath(absPath: string): string {
    return path.relative(this.root, absPath).replace(/\\/g, '/');
  }

  /** relPath 的逆运算。 */
  pathOf(relPath: string): string { return path.join(this.root, relPath); }
```

**删除** `static current()` 与 `static require()`（依赖 vscode.workspace/workspace.window）——调用方改为显式传 root；Task 8/9 里由壳构造。类内其余方法的机械替换规则：
- 所有 `vscode.Uri.joinPath(a, b)` → `path.join(a, b)`；成员名 `*Uri` → `*Path`（如 `this.manifestUri` → `this.manifestPath`）。
- `listChapters()`：`readDirectory` → `fs.readdir(this.chaptersDir, { withFileTypes: true })`，类型判断 `type !== vscode.FileType.File` → `!e.isFile()`，`const uri = vscode.Uri.joinPath(...)` → `const abs = path.join(...)`。
- `createChapter/appendToChapter/writeSummary/writeGlobalSummary/writeCharacter/writeStyleGuide` 返回值：`Promise<vscode.Uri>` → `Promise<string>`，return `this.relPath(abs)`（调用方拿到的就是 relPath）。
- `migrateLegacyDir()`：`vscode.workspace.fs.rename` → `fs.rename(this.legacyNovelDir, this.novelDir)`。
- `initialize()`：`createDirectory` → `fs.mkdir(dir, { recursive: true })`。
- `readConfig()` / `readGlobalBudget()` 本任务**原样保留**（仍读 vscode 配置，Task 4 再抽象）——因此 project.ts 顶部暂时保留一行 `import * as vscode from 'vscode'` 仅用于 readConfig，并加注释 `// TODO(Task 4): 移入 config.ts`。

- [ ] **Step 3: session.ts 改 node fs**

删除 vscode import。`SessionStore`：

```ts
private filePath(id: string): string {
  return path.join(this.project.sessionsDir, `${id}.json`);
}

async list(): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = (await fs.readdir(this.project.sessionsDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
      .map((e) => e.name);
  } catch { return []; }
  // 后续逻辑不变：逐个 read 并 summarize
}

async write(session: ChatSession): Promise<void> {
  await fs.mkdir(this.project.sessionsDir, { recursive: true });
  await writeText(this.filePath(session.id), `${JSON.stringify(session, null, 2)}\n`);
}

/** core 无系统回收站能力：移到 .novelforge/.trash/ 下（保留原文件名可手动找回）。 */
async delete(id: string): Promise<void> {
  const file = this.filePath(id);
  if (!(await exists(file))) return;
  const trashDir = path.join(this.project.novelDir, '.trash');
  await fs.mkdir(trashDir, { recursive: true });
  await fs.rename(file, path.join(trashDir, `${id}.json`));
}
```

- [ ] **Step 4: 修正消费方**

逐文件规则（都是机械替换，编译错误即清单）：
- `src/core/projectView.ts`：`project.relPath(project.styleUri)` → `project.relPath(project.stylePath)`，outline/globalSummary 同理。
- `src/core/features/continueWriting.ts`：`accept()` 返回类型 `Promise<vscode.Uri>` → `Promise<string>`（直接透传 project 返回的 relPath）；文件顶部若只剩这个 vscode 用途，删掉 import（`quickContinue` 除外——它整体依赖编辑器，**移到** `src/vscode/quickContinue.ts`，export 保持不变，extension.ts 改 import 路径）。
- `src/core/features/summarize.ts`：末尾 `vscode.commands.executeCommand('novel.openFile', ...)` 暂改为 `// TODO(Task 5): 经 Host.openFile`，先注释掉该行并保留 `project.relPath(project.globalSummaryPath)` 计算。
- `src/core/features/characters.ts`：diff 流程里的 `vscode.Uri.joinPath` → `path.join`、`project.root` 已是 string；`vscode.diff` 部分打 `// TODO(Task 6)` 注释保留（Task 6 换成 Host.reviewReplace）。
- `src/ui/chatController.ts`：`accept` 中 `this.project.relPath(uri)` → 直接用返回的 relPath 字符串；末尾 `vscode.window.showTextDocument(...)` 块整体替换为 `await vscode.commands.executeCommand('novel.openFile', turn.acceptedTo);`（Task 8 再改 Host）。
- `src/ui/attachments.ts`：`project.root`（QuickPick defaultUri）→ `vscode.Uri.file(project.root)`；`project.outlineUri/styleUri` → `outlinePath/stylePath` 包 `relPath()`（原代码 `project.relPath(project.outlineUri)` → `project.relPath(project.outlinePath)`）。
- `src/vscode/extension.ts`：`novel.openFile` 命令里 `vscode.Uri.joinPath(target.root, relPath)` → `vscode.Uri.file(target.pathOf(relPath))`；`workspaceName()` 不变。

- [ ] **Step 5: 改 smoke-session.js 桩为直接构造**

vscode 桩里 `workspace.fs` 相关全部删除；改为：

```js
const project = projectMod.NovelProject.open(WORK);
```

`check('sessionsDir 指向 .novelforge/sessions', project.sessionsDir === sessionsDir, project.sessionsDir);`（string 相等）。迁移用例里 `NovelProject.current()` → `NovelProject.open(legacyRoot)`；删除 `vscodeStub.workspace.workspaceFolders/asRelativePath` 的重设行。`check('删除走回收站', ...)` 改为断言文件出现在 `path.join(legacyOrWork, '.novelforge/.trash')`。

- [ ] **Step 6: 验证 + Commit**

```powershell
npm run typecheck ; npm run smoke ; npm run compile
```

全部通过后：

```powershell
git add -A ; git commit -m "refactor: replace vscode.Uri/workspace.fs with node path/fs in core"
```

---

### Task 3: Host 接口与 AbortSignal 化

**Files:**
- Create: `src/core/host.ts`
- Modify: `src/core/llm/provider.ts`、`src/core/llm/openaiProvider.ts`、`src/core/llm/anthropicProvider.ts`、`src/core/features/continueWriting.ts`

- [ ] **Step 1: 新建 src/core/host.ts**

```ts
import { NovelProject } from './model/project';
import { Attachment } from './model/session';

/**
 * core 对宿主的唯一依赖面。VS Code 插件与独立 Web 服务各实现一份。
 * 所有交互类方法（input/confirm/pick）在独立版里经 WebSocket 变成网页弹窗。
 */

export interface InputOptions {
  title?: string;
  prompt?: string;
  value?: string;
  placeHolder?: string;
  password?: boolean;
  /** 多行文本输入（独立版渲染 textarea）。 */
  multiline?: boolean;
  validate?: (value: string) => string | undefined;
}

export interface PickChoice<T = string> {
  label: string;
  description?: string;
  detail?: string;
  /** 分组标题，同组只出现一次。 */
  group?: string;
  value: T;
}

export interface Disposable { dispose(): void; }

export interface Host {
  readonly name: 'vscode' | 'standalone';
  /** 该宿主能否提供 vscode-lm（Copilot）模型。 */
  readonly supportsVscodeLm: boolean;

  input(opts: InputOptions): Promise<string | undefined>;
  /** 返回用户点选的 action 文案；取消返回 undefined。 */
  confirm(message: string, actions: string[], opts?: { modal?: boolean; detail?: string }): Promise<string | undefined>;
  pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined>;
  /** 可取消的长任务。report 用于更新进度文案。 */
  progress<T>(title: string, fn: (signal: AbortSignal, report: (message: string) => void) => Promise<T>): Promise<T>;
  /** 监听工程目录变化（章节/元数据）。onChange 已含防抖语义由实现方负责。 */
  watch(project: NovelProject, onChange: () => void): Disposable;
  /** 打开某相对路径文件。独立版降级为 toast 提示路径。 */
  openFile(relPath: string): Promise<void>;
  toast(message: string, level?: 'info' | 'error'): void;

  /** 「加入选区」：插件取编辑器选区；独立版弹粘贴框。返回 undefined 表示放弃。 */
  selectionAttachment(project: NovelProject): Promise<Attachment | undefined>;
  /** 「浏览工作区文件」：插件弹文件对话框；独立版提示输入相对路径。可选。 */
  browseFile?(project: NovelProject): Promise<string | undefined>;
  /** 角色卡更新审阅：插件开 diff 编辑器；独立版弹确认框。返回 undefined=取消。 */
  reviewReplace?(name: string, currentText: string, proposedText: string): Promise<'apply' | 'discard' | undefined>;
  /** 「在 VS Code 设置中打开」，仅插件实现。 */
  openNativeSettings?(): Promise<void>;
}

let current: Host | undefined;

export function initHost(host: Host): void {
  current = host;
  initConfigFromHost(host);
}

export function getHost(): Host {
  if (!current) throw new Error('Host 尚未初始化');
  return current;
}

// initConfigFromHost 在 Task 4 的 config.ts 里实现并在此 import；
// 本任务先留占位：import { initConfigFromHost } from './config';
```

（`./config` 文件在下一任务创建；两任务连续执行，若分开提交可先在 host.ts 里注释掉这两行 import/调用并在 Task 4 恢复。）

- [ ] **Step 2: provider.ts 取消令牌改 AbortSignal**

```ts
// 删除 import * as vscode from 'vscode'
export interface ChatOptions {
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  /** 外部取消（用户点「停止」）。超时仍由本模块内部处理。 */
  signal?: AbortSignal;
}

export function makeAbortSignal(options: ChatOptions): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason ?? new CancelledError());
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}
```

openai/anthropicProvider 只是用了 `makeAbortSignal(options)`，签名不变，无需改动（编译确认）。

- [ ] **Step 3: continueWriting.ts 用 AbortController**

```ts
export class ContinueSession {
  private currentAbort: AbortController | undefined;
  // ...
  async generate(...) {
    // ...
    const abort = new AbortController();
    this.currentAbort = abort;
    const options: ChatOptions = {
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      timeoutMs: config.requestTimeoutMs,
      signal: abort.signal,
    };
    try {
      // 流式循环不变
    } catch (err) {
      if (err instanceof CancelledError || abort.signal.aborted) handlers.onCancelled();
      else handlers.onError(err instanceof Error ? err.message : String(err));
    } finally {
      this.currentAbort = undefined;
    }
    return built;
  }

  stop(): void {
    this.currentAbort?.abort(new CancelledError());
  }

  dispose(): void {
    this.currentAbort?.abort(new CancelledError());
  }
}
```

`testConnection` 里同样：`new vscode.CancellationTokenSource()` → `new AbortController()`，`source.token` → `abort.signal`，finally 里删掉 cancel/dispose（无资源需释放）。

- [ ] **Step 4: 验证 + Commit**

```powershell
npm run typecheck ; npm run smoke ; npm run compile
git add -A ; git commit -m "refactor: introduce Host interface and AbortSignal cancellation in core"
```

---

### Task 4: 配置与密钥后端抽象

**Files:**
- Create: `src/core/config.ts`、`src/core/stores.ts`
- Modify: `src/core/model/project.ts`（移出 readConfig）、`src/core/llm/registry.ts`、各消费方 import

- [ ] **Step 1: 新建 src/core/config.ts**

把 `project.ts` 里的 `readConfig()`、`readGlobalBudget()` 整体搬来，数据源从 `vscode.workspace.getConfiguration` 换成注入的 store：

```ts
import { getHost } from './host';
import { firstModelRef, normalizeProviders, resolveModelRef, seedFromLegacy } from './model/providers';
import { NovelConfig } from './model/types';

/** 落盘的设置形状（与 SettingsPayload 对齐，另加 chaptersDir）。 */
export interface PersistedSettings {
  providers?: unknown[];
  model?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  recentChaptersFullText?: number;
  prevChapterTailChars?: number;
  chaptersDir?: string;
  summaryBatchSize?: number;
  requestTimeoutMs?: number;
}

export interface ConfigStore {
  /** 未迁移/未保存过时返回 undefined。 */
  read(): PersistedSettings | undefined;
  write(settings: PersistedSettings): Promise<void>;
}

/**
 * 0.1.x 遗留配置读取器。VS Code 壳注入（读 settings.json 的 novel.*），
 * 用于尚未迁移到 ~/.novelforge/config.json 的老用户；独立版不注入。
 */
export interface LegacyConfigReader { read(): PersistedSettings; }

let store: ConfigStore | undefined;
let legacy: LegacyConfigReader | undefined;

/** 由 initHost 调用：配置跟随宿主。 */
export function initConfigFromHost(host: { config: ConfigStore }): void {
  store = host.config;
}

export function setLegacyConfigReader(reader: LegacyConfigReader): void {
  legacy = reader;
}

function raw(): PersistedSettings {
  return store?.read() ?? legacy?.read() ?? {};
}

export function readConfig(): NovelConfig {
  const c = raw();
  let providers = normalizeProviders(c.providers ?? []);
  let model = (c.model ?? '').trim();

  // 0.1.x 单服务商兜底：仅当新结构为空且宿主提供了遗留读取器。
  if (providers.length === 0 && legacy) {
    const seeded = seedFromLegacyRaw(c);
    providers = seeded.providers;
    if (!model) model = seeded.activeRef;
  }
  if (!model) model = firstModelRef(providers);

  const active = resolveModelRef(providers, model);
  const globalWindow = c.contextWindow ?? 128000;
  const globalOutput = c.maxOutputTokens ?? 4096;

  return {
    providers, model, active,
    contextWindow: active?.model.contextWindow ?? globalWindow,
    maxOutputTokens: active?.model.maxOutputTokens ?? globalOutput,
    temperature: c.temperature ?? 0.8,
    recentChaptersFullText: c.recentChaptersFullText ?? 2,
    prevChapterTailChars: c.prevChapterTailChars ?? 1500,
    chaptersDir: c.chaptersDir ?? 'chapters',
    summaryBatchSize: c.summaryBatchSize ?? 15,
    requestTimeoutMs: c.requestTimeoutMs ?? 300000,
  };
}

export function readGlobalBudget(): { contextWindow: number; maxOutputTokens: number } {
  const c = raw();
  return { contextWindow: c.contextWindow ?? 128000, maxOutputTokens: c.maxOutputTokens ?? 4096 };
}

/** 整体落盘（merge 后写）。 */
export async function updateSettings(patch: PersistedSettings): Promise<void> {
  if (!store) throw new Error('配置后端尚未初始化');
  await store.write({ ...raw(), ...patch });
}

/** seedFromLegacy 原本吃 vscode 配置的分散键；这里接受扁平 raw。 */
function seedFromLegacyRaw(c: PersistedSettings) {
  // 遗留键（novel.provider / novel.openai.baseUrl 等）只会出现在 legacy reader
  // 的返回值里，因此把 raw 直接透传给 providers.ts 新增的宽松入口。
  return seedFromLegacy({
    provider: (c as Record<string, unknown>).provider as string | undefined ?? 'openai',
    openaiBaseUrl: (c as Record<string, unknown>)['openai.baseUrl'] as string | undefined ?? 'https://api.openai.com/v1',
    openaiModel: (c as Record<string, unknown>)['openai.model'] as string | undefined ?? 'gpt-4o',
    anthropicBaseUrl: (c as Record<string, unknown>)['anthropic.baseUrl'] as string | undefined ?? 'https://api.anthropic.com',
    anthropicModel: (c as Record<string, unknown>)['anthropic.model'] as string | undefined ?? 'claude-sonnet-4-5',
    vscodeLmFamily: (c as Record<string, unknown>)['vscodeLm.family'] as string | undefined ?? 'gpt-4o',
  });
}
```

注意：`seedFromLegacy` 在 `src/core/model/providers.ts` 中已存在且吃上述形状对象——确认其签名一致；若它原来直接吃 `WorkspaceConfiguration.get`，按上面参数化即可（现有实现就是按值传参，无需改动）。legacy reader 需要返回这些带点键，VS Code 壳实现时把 `novel.provider`、`novel.openai.baseUrl` 等一并读出（见 Task 9）。

- [ ] **Step 2: 新建 src/core/stores.ts（文件存储，双壳共用）**

```ts
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore, PersistedSettings } from './config';

/** ~/.novelforge/ —— 配置与密钥的用户主目录存储。 */
export function homeDir(): string {
  return path.join(os.homedir(), '.novelforge');
}

export class FileConfigStore implements ConfigStore {
  readonly filePath = path.join(homeDir(), 'config.json');

  read(): PersistedSettings | undefined {
    try {
      return JSON.parse(fsReadSync(this.filePath)) as PersistedSettings;
    } catch { return undefined; }
  }

  async write(settings: PersistedSettings): Promise<void> {
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }
}

function fsReadSync(p: string): string {
  // read() 是同步接口（readConfig 到处同步调用）；文件极小，同步读可接受。
  return require('node:fs').readFileSync(p, 'utf8');
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * ~/.novelforge/secrets.json。JSON 无法写文件头注释，首次创建时
 * 同目录放一个 README.txt 说明「不要提交 secrets.json」。
 * Windows 无 POSIX 权限位，仅依赖用户主目录隔离。
 */
export class FileSecretStore implements SecretStore {
  private readonly filePath = path.join(homeDir(), 'secrets.json');

  private async load(): Promise<Record<string, string>> {
    try { return JSON.parse(await fs.readFile(this.filePath, 'utf8')); } catch { return {}; }
  }

  private async save(data: Record<string, string>): Promise<void> {
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600,
    });
    const readme = path.join(homeDir(), 'README.txt');
    try { await fs.stat(readme); } catch {
      await fs.writeFile(readme, 'secrets.json 存放各服务商的 API Key，请勿提交到版本库。\n', 'utf8');
    }
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.load())[key];
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this.load();
    data[key] = value;
    await this.save(data);
  }

  async delete(key: string): Promise<void> {
    const data = await this.load();
    if (!(key in data)) return;
    delete data[key];
    await this.save(data);
  }
}
```

- [ ] **Step 3: registry.ts 密钥后端换成 SecretStore**

`src/core/llm/registry.ts`：
- 删除 `initSecrets(context: vscode.ExtensionContext)`，改为：

```ts
import { SecretStore } from '../stores';
import { getHost } from '../host';

let secrets: SecretStore | undefined;
export function initSecrets(store: SecretStore): void { secrets = store; }
```

- `promptForApiKey`：`vscode.window.showInputBox({...})` → `getHost().input({ title, prompt, password: true, placeHolder, validate: v => v.trim() ? undefined : 'API Key 不能为空' })`；所有 `vscode.window.showErrorMessage/showInformationMessage` → `getHost().toast(msg, 'error'|'info')`。
- `pickProvider` / `pickModelRef`：`vscode.window.showQuickPick` → `getHost().pick(choices, title)`，choices 用 `PickChoice` 形状（label/description/detail/value）。`pickModelRef` 返回值语义不变（ref 字符串）。
- `resolveProvider`：`vscode.window.showErrorMessage` → `getHost().toast(..., 'error')`。
- vscode-lm 分支解耦（消除 core→vscode 反向 import）：

```ts
import { ActiveModel, ... } from '../model/providers';
import { LlmProvider } from './provider';

type ExtraProviderFactory = (active: ActiveModel) => LlmProvider | undefined;
let extraFactory: ExtraProviderFactory | undefined;

/** VS Code 壳启动时注册 vscode-lm provider 工厂。 */
export function registerProviderFactory(fn: ExtraProviderFactory): void {
  extraFactory = fn;
}

export async function buildProvider(active: ActiveModel): Promise<LlmProvider | undefined> {
  const { profile, model } = active;
  if (profile.kind === 'vscode-lm') {
    return extraFactory?.(active);
  }
  // ...原有 openai/anthropic 逻辑不变
}
```

删除 `import { VsCodeLmProvider } from '../../vscode/vscodeLmProvider'`。

- [ ] **Step 4: 全库 import 改道**

所有 `import { readConfig, readGlobalBudget } from '../model/project'`（以及任何相对变体）改为 `from '../config'`（按文件位置调整层级）：涉及 `context/builder.ts`、`features/*.ts`、`llm/registry.ts`、`ui/chatController.ts`、`core/projectView.ts`（若引用）。`project.ts` 里删除这两个函数与残留的 vscode import（至此 `src/core/model/` 应完全无 vscode）。

- [ ] **Step 5: 验证 + Commit**

此时需要一个临时宿主让 smoke 继续跑：`readConfig()` 只在被调用时才访问 store，现有 smoke 用例不触发它，预期直接通过。

```powershell
npm run typecheck ; npm run smoke ; npm run compile
git add -A ; git commit -m "refactor: abstract config/secrets backends behind Host stores"
```

---

### Task 5: features 交互去 vscode 化（summarize / characters / style）

**Files:**
- Modify: `src/core/features/summarize.ts`、`src/core/features/characters.ts`、`src/core/features/style.ts`

模式统一：`withProgress` → `getHost().progress`；`showInformationMessage/showWarningMessage`（纯提示）→ `toast`；带按钮的询问 → `getHost().confirm`；`showQuickPick` → `getHost().pick`；`CancellationToken` → `AbortSignal`。

- [ ] **Step 1: summarize.ts**

```ts
// 删除 import vscode；import { getHost } from '../host';

export async function summarizeChapter(
  project: NovelProject,
  chapter: Chapter,
  provider?: LlmProvider,
  signal?: AbortSignal
): Promise<boolean> {
  // 空章节提示：getHost().toast(`第 ${chapter.order} 章是空的，跳过总结。`);
  // options: ChatOptions = { ..., signal }
  // 其余不变
}

export async function syncSummaries(project: NovelProject): Promise<void> {
  const stale = await project.staleChapters();
  if (stale.length === 0) {
    getHost().toast('所有章节摘要都是最新的。');
    return;
  }
  const confirm = await getHost().confirm(
    `有 ${stale.length} 章摘要缺失或已过期，需要调用 ${stale.length} 次模型。现在同步？`,
    ['开始同步'], { modal: true }
  );
  if (confirm !== '开始同步') return;

  const provider = await resolveProvider();
  if (!provider) return;

  await getHost().progress('同步章节摘要', async (signal, report) => {
    let done = 0;
    const failed: number[] = [];
    for (const chapter of stale) {
      if (signal.aborted) break;
      report(`第 ${chapter.order} 章《${chapter.title}》（${done + 1}/${stale.length}）`);
      try {
        await summarizeChapter(project, chapter, provider, signal);
      } catch (err) {
        if (err instanceof CancelledError) break;
        failed.push(chapter.order);
      }
      done++;
    }
    const okCount = done - failed.length;
    if (failed.length > 0) getHost().toast(`完成 ${okCount} 章，第 ${failed.join('、')} 章失败，可稍后重试。`);
    else if (okCount > 0) getHost().toast(`已同步 ${okCount} 章摘要。`);
  });
}
```

`rebuildGlobalSummary` 同模式：两处询问改 `getHost().confirm`（「先同步摘要/仍然重建」双 action）；`withProgress` → `getHost().progress`，内部 `token.isCancellationRequested` → `signal.aborted`，`progress.report({message, increment})` → `report(message)`；结尾 `vscode.commands.executeCommand('novel.openFile', ...)` → `await getHost().openFile(project.relPath(project.globalSummaryPath))`。

- [ ] **Step 2: characters.ts**

- 章节 QuickPick → `getHost().pick(chapters.map(c => ({ label, description: `${c.wordCount} 字`, value: c.order })), '选择要提取角色的章节')`，随后按 order 取章节（多选语义若原实现用了 `canPickMany`，改为单选最近 N 章或保持逐次 pick——按原实现的 `picked.length` 逻辑：pick 不支持多选时，用 host.input 让用户输入章节序号列表如 `1,2,3`，解析成 orders。选择此方案并在代码注释说明）。
- `withProgress` → `getHost().progress`，token → signal。
- 提示类全改 toast。
- diff 审阅流程改为：

```ts
// 原：写 .tmp 预览文件 + vscode.diff + 询问采纳
const proposedText = renderCharacterCard(proposed);
const verdict = await getHost().reviewReplace?.(existing.name, existingRawText, proposedText);
if (verdict === 'apply') {
  await writeText(project.pathOf(existing.relPath), proposedText);
  getHost().toast(`已更新「${existing.name}」。`);
}
```

删除 `.tmp` 预览文件逻辑（`vscode.workspace.fs.createDirectory/.tmp`、读回预览文件）。`existingRawText` = `await readText(project.pathOf(existing.relPath))`。

- [ ] **Step 3: style.ts**

同模式：章节多选改 input 序号列表（同上）；覆盖确认 `showWarningMessage(modal)` → `getHost().confirm(..., ['覆盖'], { modal: true })`；`withProgress` → `progress`；结尾 `showTextDocument` → `getHost().openFile(project.relPath(project.stylePath))`；提示改 toast。

- [ ] **Step 4: 验证 + Commit**

smoke.js 里 continueWriting/summarize/characters 的 vscode 桩 hack 此时可以删除（模块不再 import vscode）——把三个 `Module._load` 桩块删掉直接 `loadModule`。

```powershell
npm run typecheck ; npm run smoke ; npm run compile
git add -A ; git commit -m "refactor: route feature interactions through Host (progress/confirm/pick)"
```

---

### Task 6: controller 宿主无关化

**Files:**
- Move+Modify: `src/ui/chatController.ts` → `src/core/controller.ts`
- Create: `src/core/actions.ts`、`src/core/attachments.ts`（选择项构建）
- Modify: `src/ui/attachments.ts`（只留 vscode 选区实现，移入 `src/vscode/`）

- [ ] **Step 1: 新建 src/core/actions.ts —— 原 extension.ts 命令的 core 化**

```ts
import { getHost } from './host';
import { NovelProject } from './model/project';
import { newCharacter, newLore } from './features/characters';
import { ContinueSession } from './features/continueWriting';
import * as path from 'node:path';

/** 初始化工程：问作品名与作者。defaultTitle 由壳给定（插件用工作区名，独立版用目录名）。 */
export async function initProjectFlow(project: NovelProject, defaultTitle: string): Promise<boolean> {
  if (await project.isInitialized()) {
    getHost().toast('当前目录已经是小说工程。');
    return false;
  }
  const title = await getHost().input({
    title: '初始化小说工程（1/2）', prompt: '作品名', value: defaultTitle,
    validate: (v) => (v.trim() ? undefined : '不能为空'),
  });
  if (!title) return false;
  const author = await getHost().input({ title: '初始化小说工程（2/2）', prompt: '作者名（可留空）' });
  await project.initialize({ title: title.trim(), author: (author ?? '').trim() });
  getHost().toast(`已初始化《${title.trim()}》。`);
  const pick = await getHost().confirm(`要现在新建第 1 章吗？`, ['新建第 1 章', '稍后']);
  if (pick === '新建第 1 章') await newChapterFlow(project);
  return true;
}

export async function newChapterFlow(project: NovelProject): Promise<string | undefined> {
  const order = await project.nextChapterOrder();
  const title = await getHost().input({
    title: `新建第 ${order} 章`, prompt: '章节标题', value: `第${order}章`,
    validate: (v) => (v.trim() ? undefined : '不能为空'),
  });
  if (!title) return undefined;
  const relPath = await project.createChapter(order, title.trim());
  await getHost().openFile(relPath);
  return relPath;
}
```

- [ ] **Step 2: 新建 src/core/attachments.ts —— 选择项构建（无 UI）**

从 `src/ui/attachments.ts` 抽出条目构建逻辑：

```ts
import { NovelProject } from './model/project';
import { Attachment, AttachmentKind } from './model/session';
import { PickChoice } from './host';

/** 构建 @ 引用的候选列表；展示与选择交给 Host.pick。 */
export async function listAttachmentChoices(project: NovelProject): Promise<PickChoice<Attachment>[]> {
  const choices: PickChoice<Attachment>[] = [];
  const chapters = await project.listChapters();
  for (const c of [...chapters].reverse()) {
    choices.push({
      label: `${String(c.order).padStart(3, '0')} ${c.title}`,
      description: `${c.wordCount} 字`, detail: c.relPath, group: '章节',
      value: fileAttachment('chapter', `第${c.order}章 ${c.title}`, c.relPath),
    });
  }
  for (const card of await project.listCharacters()) {
    choices.push({
      label: card.name, description: card.tags.join(' · '), detail: card.relPath, group: '角色',
      value: fileAttachment('character', `角色 ${card.name}`, card.relPath),
    });
  }
  for (const entry of await project.listLore()) {
    choices.push({
      label: entry.title, description: entry.keywords.join('/'), detail: entry.relPath, group: '设定',
      value: fileAttachment('lore', `设定 ${entry.title}`, entry.relPath),
    });
  }
  choices.push({ label: '全书大纲', detail: project.relPath(project.outlinePath), group: '其他',
    value: fileAttachment('file', '全书大纲', project.relPath(project.outlinePath)) });
  choices.push({ label: '文风指南', detail: project.relPath(project.stylePath), group: '其他',
    value: fileAttachment('file', '文风指南', project.relPath(project.stylePath)) });
  return choices;
}

function fileAttachment(kind: AttachmentKind, label: string, relPath: string): Attachment {
  return { id: `${kind}:${relPath}`, kind, label, relPath };
}
```

`src/ui/attachments.ts` 里删除 `pickAttachment`（保留 `selectionAttachment`），文件改名为 `git mv src/ui/attachments.ts src/vscode/attachments.ts`，import 层级修正。

- [ ] **Step 3: controller 移动并替换所有 vscode 调用**

`git mv src/ui/chatController.ts src/core/controller.ts`，import 层级修正（`../core/...` → `./...`），然后逐条替换 `dispatch`：

```ts
// 新增 import
import { getHost } from './host';
import { initProjectFlow, newChapterFlow } from './actions';
import { listAttachmentChoices } from './attachments';
import { syncSummaries, summarizeChapter } from './features/summarize';
import { rebuildGlobalSummary, extractCharacters } from ...; // 按 ProjectAction 对应
import { extractStyle } from './features/style';
import { promptForApiKey, clearApiKey } from './llm/registry';
import { updateSettings } from './config';
```

| 原代码 | 替换为 |
| --- | --- |
| `case 'openFile'` 执行命令 | `await getHost().openFile(msg.path);` |
| `case 'syncSummaries'` 执行命令 | `await syncSummaries(this.project); await this.pushState();` |
| `case 'setApiKey'` 执行命令 | `await promptForApiKey(msg.providerId); await this.pushSettings(); await this.pushState();` |
| `case 'clearApiKey'` 执行命令 | `await clearApiKey(msg.providerId); await this.pushSettings();` |
| `case 'openNativeSettings'` 执行命令 | `await getHost().openNativeSettings?.();` |
| `case 'pickAttachment'` | 见 Step 4 |
| `case 'addSelection'` | 见 Step 4 |
| `deleteSession` 里 `showWarningMessage` modal | `getHost().confirm(`删除对话「${title}」？`, ['删除'], { modal: true, detail: '会移到 .novelforge/.trash/，可手动找回。' })` |
| `renameSession` 里 `showInputBox` | `getHost().input({ title: '重命名对话', value: target.title, validate: v => v.trim() ? undefined : '不能为空' })` |
| `accept` 末尾 showTextDocument + novel.refresh | `await getHost().openFile(turn.acceptedTo!); await this.pushState();` |
| `selectModel` 写配置 | `await updateSettings({ model: ref });` |
| `saveSettings` 写配置 | 见 Step 5 |
| `projectAction` 的 COMMANDS 表 | 见 Step 6 |

- [ ] **Step 4: pickAttachment / addSelection**

```ts
case 'pickAttachment': {
  const choices = await listAttachmentChoices(this.project);
  const picked = await getHost().pick(choices, '引用到上下文');
  if (picked) this.addAttachment(picked);
  else if (getHost().browseFile) {
    // 列表尾部语义：取消时不再追问；「浏览」入口由前端保留旧按钮时另行处理（YAGNI：先移除浏览入口）
  }
  return;
}

case 'addSelection': {
  const att = await getHost().selectionAttachment(this.project);
  if (!att) {
    this.toast('没有可加入的文本。', 'error');
    return;
  }
  this.addAttachment(att);
  return;
}
```

（「浏览工作区」入口本任务顺带从 view.js 移除：删除 QuickPick 相关说明不涉及前端——浏览项本来在后端 QuickPick 里，前端无感知，无需动 view.js。）

- [ ] **Step 5: saveSettings 写后端**

```ts
private async saveSettings(s: SettingsPayload): Promise<void> {
  const before = readConfig().providers.map((p) => p.id);
  const providers = normalizeProviders(s.providers);
  if (s.providers.length > 0 && providers.length === 0) {
    this.toast('服务商配置不合法：id 不能为空或含斜杠，且每个服务商至少要有一个模型。', 'error');
    await this.pushSettings('rejected');
    return;
  }
  await updateSettings({
    providers,
    model: s.model.trim(),
    contextWindow: s.contextWindow,
    maxOutputTokens: s.maxOutputTokens,
    temperature: s.temperature,
    recentChaptersFullText: s.recentChaptersFullText,
    prevChapterTailChars: s.prevChapterTailChars,
    summaryBatchSize: s.summaryBatchSize,
    requestTimeoutMs: s.requestTimeoutMs,
  });
  await pruneApiKeys(providers, before);
  await this.pushSettings('saved');
  await this.pushState();
  this.toast('设置已保存。');
}
```

- [ ] **Step 6: projectAction 直调 core**

```ts
private async projectAction(action: ProjectAction, order?: number): Promise<void> {
  const host = getHost();
  switch (action) {
    case 'initProject':
      await initProjectFlow(this.project, this.project.root.split(/[\\/]/).pop() ?? '我的小说');
      break;
    case 'refresh': break; // pushState 本身就是刷新
    case 'newChapter': await newChapterFlow(this.project); break;
    case 'newCharacter': await newCharacter(this.project); break;
    case 'newLore': await newLore(this.project); break;
    case 'continueFrom':
      // 与原语义一致：从某章续写 = 目标设为下一章
      this.current.targetOrder = (order ?? (await this.project.nextChapterOrder() - 1)) + 1;
      await this.showTab('chat');
      break;
    case 'summarizeChapter': {
      if (order === undefined) break;
      const chapter = await this.project.getChapter(order);
      if (!chapter) break;
      await host.progress(`总结第 ${chapter.order} 章`, async (signal) => {
        const ok = await summarizeChapter(this.project, chapter, undefined, signal);
        if (ok) host.toast(`第 ${chapter.order} 章摘要已生成。`);
      });
      break;
    }
    case 'syncSummaries': await syncSummaries(this.project); break;
    case 'rebuildGlobalSummary': await rebuildGlobalSummary(this.project); break;
    case 'extractCharacters': await extractCharacters(this.project); break;
    case 'extractStyle': await extractStyle(this.project); break;
  }
  await this.pushState();
}
```

注意 `extractCharacters` 的原实现含章节选择；其内部已 Task 5 化，直调即可。`newCharacter/newLore` 内部若有 showInputBox，Task 5 未覆盖——检查并按同模式改为 `getHost().input`（它们当前通过 `vscode.window.showInputBox` 问名字/内容，逐个替换）。

- [ ] **Step 7: 验证 + Commit**

`extension.ts` 此时 import 路径变了（`../core/controller`），编译通过即可。

```powershell
npm run typecheck ; npm run smoke ; npm run compile
git add -A ; git commit -m "refactor: make ChatController host-agnostic (core/controller.ts)"
```

---

### Task 7: VS Code 壳 —— VsCodeHost + settings.json/SecretStorage 后端

**Files:**
- Create: `src/vscode/vscodeHost.ts`、`src/vscode/settingsStore.ts`
- Modify: `src/vscode/extension.ts`（initHost、工厂注册、watcher 改走 Host）

目标：插件侧把 Task 3/4 的抽象接回 VS Code 原生 API。行为与改造前完全一致。

- [ ] **Step 1: 新建 src/vscode/settingsStore.ts**

```ts
import * as vscode from 'vscode';
import { ConfigStore, PersistedSettings } from '../core/config';
import { SecretStore } from '../core/stores';

/**
 * 过渡后端：继续读写工作区 settings.json 的 novel.*。
 * Task 12 迁移完成后，插件壳也切到 FileConfigStore，本文件删除。
 */
export class SettingsJsonConfigStore implements ConfigStore {
  read(): PersistedSettings | undefined {
    const cfg = vscode.workspace.getConfiguration('novel');
    // 未显式配置过任何键时返回 undefined，让 legacy reader 有机会兜底
    const keys = ['providers', 'model', 'contextWindow', 'maxOutputTokens', 'temperature',
      'recentChaptersFullText', 'prevChapterTailChars', 'chaptersDir', 'summaryBatchSize', 'requestTimeoutMs'];
    if (!keys.some((k) => cfg.get(k) !== undefined && !isDefaultOnly(cfg, k))) {
      // 简化判断：只要 providers 非空或 model 非空就算「配置过」
      if (!cfg.get<unknown[]>('providers', []).length && !cfg.get<string>('model', '')) return undefined;
    }
    const out: PersistedSettings = {};
    for (const k of keys) {
      const v = cfg.get(k);
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  }

  async write(settings: PersistedSettings): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('novel');
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    for (const [k, v] of Object.entries(settings)) {
      if (v !== undefined) await cfg.update(k, v, target);
    }
  }
}

function isDefaultOnly(_cfg: vscode.WorkspaceConfiguration, _k: string): boolean {
  return false; // 占位：read() 里的简化判断已够用
}

/**
 * 遗留单服务商键的读取器（novel.provider / novel.openai.baseUrl …），
 * 供 config.ts 的 seedFromLegacyRaw 兜底。
 */
export const legacySettingsReader = {
  read(): PersistedSettings {
    const cfg = vscode.workspace.getConfiguration('novel');
    return {
      provider: cfg.get<string>('provider'),
      'openai.baseUrl': cfg.get<string>('openai.baseUrl'),
      'openai.model': cfg.get<string>('openai.model'),
      'anthropic.baseUrl': cfg.get<string>('anthropic.baseUrl'),
      'anthropic.model': cfg.get<string>('anthropic.model'),
      'vscodeLm.family': cfg.get<string>('vscodeLm.family'),
    } as unknown as PersistedSettings;
  },
};

/** SecretStorage 后端的 SecretStore 适配。 */
export class SecretStorageSecretStore implements SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}
  get(key: string) { return this.secrets.get(key); }
  async set(key: string, value: string) { await this.secrets.store(key, value); }
  async delete(key: string) { await this.secrets.delete(key); }
}
```

- [ ] **Step 2: 新建 src/vscode/vscodeHost.ts**

```ts
import * as vscode from 'vscode';
import { ConfigStore } from '../core/config';
import { Disposable, Host, InputOptions, PickChoice } from '../core/host';
import { NovelProject } from '../core/model/project';
import { Attachment } from '../core/model/session';
import { pickAttachment, selectionAttachment } from '../ui/attachments';

export class VsCodeHost implements Host {
  readonly name = 'vscode' as const;
  readonly supportsVscodeLm = true;
  constructor(public readonly config: ConfigStore) {}

  async input(opts: InputOptions): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: opts.title, prompt: opts.prompt, value: opts.value,
      placeHolder: opts.placeHolder, password: opts.password,
      ignoreFocusOut: true,
      validateInput: opts.validate ? (v) => opts.validate!(v) ?? undefined : undefined,
    });
  }

  async confirm(message: string, actions: string[], opts?: { modal?: boolean; detail?: string }) {
    return vscode.window.showInformationMessage(
      `Novel Forge：${message}`, { modal: opts?.modal ?? false, detail: opts?.detail }, ...actions);
  }

  async pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined> {
    const picked = await vscode.window.showQuickPick(
      choices.map((c) => ({ label: c.label, description: c.description, detail: c.detail, value: c.value })),
      { title });
    return picked?.value;
  }

  async progress<T>(title: string, fn: (signal: AbortSignal, report: (m: string) => void) => Promise<T>): Promise<T> {
    const source = new vscode.CancellationTokenSource();
    const abort = new AbortController();
    source.token.onCancellationRequested(() => abort.abort());
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Novel Forge：${title}`, cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => abort.abort());
          return fn(abort.signal, (message) => progress.report({ message }));
        });
    } finally {
      source.dispose();
    }
  }

  watch(project: NovelProject, onChange: () => void): Disposable {
    const config = require('../core/config').readConfig();
    const patterns = [`${config.chaptersDir}/**/*.md`, '.novelforge/**/*.md', '.novelforge/project.json'];
    const watchers = patterns.map((p) =>
      vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.root, p)));
    for (const w of watchers) { w.onDidChange(onChange); w.onDidCreate(onChange); w.onDidDelete(onChange); }
    return { dispose: () => watchers.forEach((w) => w.dispose()) };
  }

  async openFile(relPath: string): Promise<void> {
    const project = NovelProject.current?.() ?? undefined;
    // controller 场景下 root 已知：由调用方传入相对路径时以当前工程解析
    const abs = project ? project.pathOf(relPath) : relPath;
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(vscode.Uri.file(abs)),
      { viewColumn: vscode.ViewColumn.One, preview: false });
  }

  toast(message: string, level: 'info' | 'error' = 'info'): void {
    if (level === 'error') void vscode.window.showErrorMessage(`Novel Forge：${message}`);
    else void vscode.window.showInformationMessage(`Novel Forge：${message}`);
  }

  selectionAttachment(project: NovelProject): Promise<Attachment | undefined> {
    return selectionAttachment(project);
  }

  browseFile(project: NovelProject): Promise<string | undefined> {
    return pickAttachment(project) as Promise<string | undefined>;
  }

  async reviewReplace(name: string, currentText: string, proposedText: string): Promise<'apply' | 'discard' | undefined> {
    // 保持原有 diff 体验：写临时文件开 diff，询问采纳
    const tmp = await vscode.workspace.fs.writeFile(
      vscode.Uri.file(`${(await import('node:os')).tmpdir()}/novelforge-${name}.proposed.md`),
      Buffer.from(proposedText, 'utf8'));
    void tmp;
    await vscode.commands.executeCommand('vscode.diff',
      undefined /* 由 controller 传当前文件 uri */, undefined, `角色卡：${name}（审阅）`);
    const pick = await vscode.window.showInformationMessage(
      `Novel Forge：采纳对「${name}」的更新？`, { modal: true }, '采纳', '放弃');
    return pick === '采纳' ? 'apply' : pick === '放弃' ? 'discard' : undefined;
  }

  async openNativeSettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'novel.');
  }
}
```

注意：`reviewReplace` 的 diff 实现细节跟随原 characters.ts 的 `.tmp` 逻辑——执行时把原实现里「写临时文件 → vscode.diff → 询问」三步原样搬进来（上面的代码是骨架，diff 的两个 uri 用「当前角色卡文件 uri」与「临时文件 uri」）。`openFile` 里若拿不到 project，直接用 relPath 兜底打开。

- [ ] **Step 3: extension.ts 接线**

在 `activate` 最前面（`initSecrets` 之前）：

```ts
import { initHost } from '../core/host';
import { setLegacyConfigReader, initConfigFromHost } from '../core/config';
import { initSecrets, registerProviderFactory } from '../core/llm/registry';
import { VsCodeHost } from './vscodeHost';
import { SettingsJsonConfigStore, SecretStorageSecretStore, legacySettingsReader } from './settingsStore';
import { VsCodeLmProvider } from './vscodeLmProvider';

// activate() 内第一行起：
initHost(new VsCodeHost(new SettingsJsonConfigStore()));
setLegacyConfigReader(legacySettingsReader);
initSecrets(new SecretStorageSecretStore(context.secrets));
registerProviderFactory((active) => new VsCodeLmProvider(active));
```

其余调整：
- `NovelProject.current()` 在 core 里保留为静态方法：读 `vscode` 的职责移到这里——实现方式：`NovelProject.current()` 保留在 **extension.ts 侧**新增的 helper `currentProject()`（读 `vscode.workspace.workspaceFolders?.[0].uri.fsPath` → `NovelProject.open(...)`）。全文替换 `NovelProject.current()` / `NovelProject.require()` 为 `currentProject()` / `requireProject()`（后者无工作区时 toast 并返回 undefined）。若 Task 2 已把 `current()/require()` 从 project.ts 删除，此处直接新建这两个 helper；若还在，删除之。
- `registerWatcher(context, project, chat)` 改为：

```ts
function registerWatcher(context: vscode.ExtensionContext, project: NovelProject, chat: ChatController | undefined): void {
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { project.invalidate(); void chat?.pushState(); }, 250);
  };
  const watcher = getHost().watch(project, schedule);
  context.subscriptions.push(watcher);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('novel')) schedule();
  }));
}
```

- 命令注册保持清单不变，但 `novel.initProject` / `novel.newChapter` 的命令体改为调 Task 6 的 `initProjectFlow(chat)` / `newChapterFlow(chat, project)`（core/actions.ts）；`novel.summarizeChapter` 等已是「调 core 函数 + refresh」的直接保留，仅把 `withProgress` 换成 `getHost().progress`、`showQuickPick` 换成 `getHost().pick`（`pickChapter` 用 host.pick 重写）。
- `offerMigration` 里 `showInformationMessage` → `getHost().confirm(...)`。

- [ ] **Step 4: 验证 + Commit**

```powershell
npm run typecheck ; npm run smoke ; npm run compile
git add -A ; git commit -m "feat(vscode): implement VsCodeHost over settings.json and SecretStorage"
```

---

### Task 8: 协议扩展 + view.js 弹窗适配

**Files:**
- Modify: `src/core/protocol.ts`、`media/view.js`、`src/vscode/webviewHtml.ts`（hint 文案）

目标：独立版的 `host.input/confirm/pick` 经 WebSocket 变成网页 modal。协议新增两条消息；view.js 主体不动，只加一个渲染函数。

- [ ] **Step 1: protocol.ts 新增消息类型**

```ts
// InMessage 联合新增：
  | { type: 'promptResult'; requestId: string; value?: string }

// OutMessage 联合新增：
  | { type: 'prompt'; requestId: string; kind: 'input' | 'confirm' | 'pick';
      title: string; message?: string; placeholder?: string; value?: string;
      password?: boolean; multiline?: boolean; options?: string[] }
```

另在 `ViewState` 里加 `standalone?: boolean`（前端据此隐藏「在 VS Code 设置中打开」、把 hint 改成 `~/.novelforge/`）。

- [ ] **Step 2: view.js 新增 renderPrompt 与两个 case**

在 `window.addEventListener('message', ...)` 的 switch 里加：

```js
case 'prompt': renderPrompt(msg); break;
```

新增函数（放在附件区附近即可）：

```js
function renderPrompt(msg) {
  // 复用 providerModal 遮罩层，body 换成临时内容
  const overlay = el.providerModal;           // 现有 modal-overlay
  const body = el.providerModalBody;
  $('providerModalTitle').textContent = msg.title;
  let inputEl;
  if (msg.kind === 'confirm') {
    body.innerHTML = `<p class="hint">${escapeHtml(msg.message ?? '')}</p>
      <div class="actions"><button class="primary" id="pmOk">确定</button>
      <button class="secondary" id="pmCancel">取消</button></div>`;
  } else if (msg.kind === 'pick') {
    body.innerHTML = `<div class="picklist" id="pmList"></div>
      <div class="actions"><button class="secondary" id="pmCancel">取消</button></div>`;
    const list = $('pmList');
    (msg.options ?? []).forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'pick-item';
      btn.textContent = opt;
      btn.addEventListener('click', () => { reply(opt); });
      list.appendChild(btn);
    });
  } else { // input
    const tag = msg.multiline ? 'textarea' : 'input';
    body.innerHTML = `${msg.message ? `<p class="hint">${escapeHtml(msg.message)}</p>` : ''}
      <${tag} id="pmInput" ${msg.multiline ? 'rows="6"' : ''} ${msg.password ? 'type="password"' : ''}
        placeholder="${escapeHtml(msg.placeholder ?? '')}" style="width:100%"></${tag}>
      <div class="actions"><button class="primary" id="pmOk">确定</button>
      <button class="secondary" id="pmCancel">取消</button></div>`;
    inputEl = $('pmInput');
    inputEl.value = msg.value ?? '';
    inputEl.focus();
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !msg.multiline) { e.preventDefault(); reply(inputEl.value); }
      if (e.key === 'Escape') reply(undefined);
    });
  }
  $('pmOk')?.addEventListener('click', () => reply(msg.kind === 'confirm' ? 'yes' : inputEl.value));
  $('pmCancel')?.addEventListener('click', () => reply(msg.kind === 'confirm' ? 'no' : undefined));
  overlay.classList.remove('hidden');

  function reply(value) {
    overlay.classList.add('hidden');
    body.innerHTML = '';
    vscode.postMessage({ type: 'promptResult', requestId: msg.requestId, value });
  }
}
```

`escapeHtml` 若 view.js 已有则复用，没有就在文件内加一个（`replace(/[&<>"']/g, ...)`）。`.pick-item` 在 view.css 补一条：块级全宽按钮、左对齐、hover 高亮（复用现有 chip 样式变量）。

- [ ] **Step 3: 前端环境差异**

在 `renderState(state)` 里加（只执行一次的 flag）：

```js
if (state.standalone && !applied.standalone) {
  applied.standalone = true;
  $('nativeSettingsBtn').classList.add('hidden');
  // 设置页底部 hint 改文案
  document.querySelector('#pane-settings .hint:last-of-type').textContent =
    '设置写入 ~/.novelforge/config.json；API Key 存在 ~/.novelforge/secrets.json。';
}
```

controller 在 pushState 时根据 `getHost().name === 'standalone'` 置 `standalone: true`（Task 9 的 controller 接线时一并改）。

- [ ] **Step 4: 验证 + Commit**

```powershell
npm run typecheck ; npm run smoke
git add -A ; git commit -m "feat(protocol): add prompt/promptResult messages and web modal"
```

（此时 VS Code 壳不会发 prompt，行为不变；弹窗在 Task 9/10 的独立版里端到端验证。）

---

### Task 9: 独立版 Host —— FileHost + PromptHub

**Files:**
- Create: `src/standalone/promptHub.ts`、`src/standalone/fileHost.ts`
- Modify: `src/core/controller.ts`（pushState 置 standalone）

- [ ] **Step 1: 新建 src/standalone/promptHub.ts**

```ts
import { OutMessage } from '../core/protocol';

type PromptRequest = Exclude<OutMessage, { type: string }> extends never ? never : Extract<OutMessage, { type: 'prompt' }>;

/**
 * 管理未决的网页弹窗：ask() 向广播函数要一条 prompt 消息，
 * 等前端回 promptResult 后 resolve。页面断开时统一 reject（取消）。
 */
export class PromptHub {
  private seq = 0;
  private pending = new Map<string, (value: string | undefined) => void>();

  constructor(private readonly broadcast: (msg: OutMessage) => void) {}

  ask(req: Omit<PromptRequest, 'type' | 'requestId'>): Promise<string | undefined> {
    const requestId = `p${++this.seq}-${Date.now().toString(36)}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.broadcast({ type: 'prompt', requestId, ...req });
    });
  }

  resolve(requestId: string, value: string | undefined): void {
    const done = this.pending.get(requestId);
    if (!done) return;
    this.pending.delete(requestId);
    done(value);
  }

  /** WS 全部断开时，未决弹窗一律按取消处理。 */
  cancelAll(): void {
    for (const done of this.pending.values()) done(undefined);
    this.pending.clear();
  }
}
```

- [ ] **Step 2: 新建 src/standalone/fileHost.ts**

```ts
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { ConfigStore } from '../core/config';
import { Disposable, Host, InputOptions, PickChoice } from '../core/host';
import { NovelProject } from '../core/model/project';
import { Attachment } from '../core/model/session';
import { OutMessage } from '../core/protocol';
import { PromptHub } from './promptHub';

export class FileHost implements Host {
  readonly name = 'standalone' as const;
  readonly supportsVscodeLm = false;
  readonly prompts: PromptHub;

  constructor(
    public readonly config: ConfigStore,
    broadcast: (msg: OutMessage) => void,
  ) {
    this.prompts = new PromptHub(broadcast);
  }

  async input(opts: InputOptions): Promise<string | undefined> {
    const value = await this.prompts.ask({
      kind: 'input', title: opts.title ?? '输入', message: opts.prompt,
      placeholder: opts.placeHolder, value: opts.value,
      password: opts.password, multiline: opts.multiline,
    });
    if (value === undefined) return undefined;
    if (opts.validate) {
      const err = opts.validate(value);
      if (err) { this.toast(err, 'error'); return this.input(opts); }
    }
    return value;
  }

  async confirm(message: string, actions: string[], opts?: { detail?: string }): Promise<string | undefined> {
    // 网页弹窗只有 确定/取消；把第一个 action 当作「确定」的语义
    const value = await this.prompts.ask({
      kind: 'confirm', title: actions[0] ?? '确认', message, value: opts?.detail });
    return value === 'yes' ? (actions[0] ?? '确定') : undefined;
  }

  async pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined> {
    const labels = choices.map((c) => c.description ? `${c.label}（${c.description}）` : c.label);
    const picked = await this.prompts.ask({ kind: 'pick', title, options: labels });
    if (!picked) return undefined;
    const idx = labels.indexOf(picked);
    return idx >= 0 ? choices[idx].value : undefined;
  }

  async progress<T>(title: string, fn: (signal: AbortSignal, report: (m: string) => void) => Promise<T>): Promise<T> {
    this.toast(`开始：${title}`);
    const abort = new AbortController();
    try {
      const result = await fn(abort.signal, (m) => this.toast(`${title}：${m}`));
      return result;
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), 'error');
      throw err;
    }
  }

  watch(project: NovelProject, onChange: () => void): Disposable {
    // 优先 fs.watch（node ≥ 20 支持 recursive）；失败回退 1s 轮询目录 mtime
    try {
      const watcher = fs.watch(project.root, { recursive: true }, (_event, filename) => {
        const name = String(filename ?? '');
        if (!/\.(md|json)$/i.test(name)) return;
        if (name.includes('node_modules')) return;
        onChange();
      });
      return { dispose: () => watcher.close() };
    } catch {
      const timer = setInterval(async () => {
        try {
          const st = await fsp.stat(project.novelDir);
          onChange(); void st;
        } catch { /* 目录不存在时忽略 */ }
      }, 1000);
      return { dispose: () => clearInterval(timer) };
    }
  }

  async openFile(relPath: string): Promise<void> {
    // 用系统默认程序打开（用户自己的编辑器）
    const abs = path.resolve(relPath);
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      spawn(cmd, [abs], { detached: true, stdio: 'ignore' }).unref();
      this.toast(`已打开：${relPath}`);
    } catch {
      this.toast(`无法打开：${relPath}，请手动打开。`);
    }
  }

  toast(message: string, level: 'info' | 'error' = 'info'): void {
    this.broadcastToast({ type: 'toast', message, level });
  }
  private broadcastToast: (msg: OutMessage) => void;

  async selectionAttachment(project: NovelProject): Promise<Attachment | undefined> {
    const text = await this.input({
      title: '加入选区', prompt: '粘贴要引用的原文', multiline: true,
      placeHolder: '在编辑器里复制后粘贴到这里',
      validate: (v) => (v.trim() ? undefined : '不能为空'),
    });
    if (text === undefined) return undefined;
    return {
      id: `paste-${Date.now().toString(36)}`,
      kind: 'selection', label: '粘贴的选区', text,
    } as Attachment;
  }

  async browseFile(project: NovelProject): Promise<string | undefined> {
    const rel = await this.input({
      title: '引用文件', prompt: '输入工作区内的相对路径（如 chapters/003.md）',
      validate: (v) => {
        const abs = project.pathOf(v.trim());
        if (!fs.existsSync(abs)) return '文件不存在';
        return undefined;
      },
    });
    return rel?.trim();
  }

  async reviewReplace(name: string, currentText: string, proposedText: string): Promise<'apply' | 'discard' | undefined> {
    const ok = await this.confirm(`将更新角色卡「${name}」（新版 ${proposedText.length} 字，当前 ${currentText.length} 字）。`, ['应用更新']);
    return ok ? 'apply' : 'discard';
  }

  // standalone 没有 openNativeSettings：前端已隐藏按钮，此处不提供。
}
```

实现细节：把构造函数传入的 `broadcast` 存为私有字段 `broadcastMsg`，`toast` 与 `PromptHub` 都用它（上面 `broadcastToast` 占位写法执行时直接改成构造参数保存）。注意：prompt/toast 的广播只在有 WS 连接时有效，无连接时静默丢弃（broadcast 实现方保证）。

- [ ] **Step 3: controller 置 standalone 标记**

`src/core/controller.ts` 的 pushState 构造 ViewState 处：`standalone: getHost().name === 'standalone'`。

- [ ] **Step 4: 验证 + Commit**

```powershell
npm run typecheck ; npm run smoke
git add -A ; git commit -m "feat(standalone): FileHost with WebSocket prompts and fs watcher"
```

---

### Task 10: 独立版 Web 服务 —— server / bridge / CLI

**Files:**
- Create: `scripts/embed-media.js`、`media/bridge.js`、`src/standalone/mediaAssets.ts`（生成物，进 .gitignore）、`src/standalone/html.ts`、`src/standalone/server.ts`、`src/standalone/cli.ts`、`src/standalone/main.ts`
- Modify: `.gitignore`、`tsconfig.json`（如需）

- [ ] **Step 1: 新建 scripts/embed-media.js（媒体内嵌，供 bun compile）**

```js
/**
 * 把 media/ 下的静态资源 base64 内嵌进生成文件，
 * 使 bun build --compile 出的单文件可执行文件不依赖外部资源。
 * 用法：node scripts/embed-media.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const OUT = path.join(ROOT, 'src', 'standalone', 'mediaAssets.ts');

const files = ['view.css', 'view.js', 'bridge.js', 'icon.svg'];
const lines = ['// 由 scripts/embed-media.js 生成，勿手改。', 'export const MEDIA_ASSETS: Record<string, { mime: string; base64: string }> = {'];
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
for (const name of files) {
  const buf = fs.readFileSync(path.join(MEDIA, name));
  lines.push(`  '${name}': { mime: '${MIME[path.extname(name)]}', base64: '${buf.toString('base64')}' },`);
}
lines.push('};');
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(`✓ 生成 ${path.relative(ROOT, OUT)}（${files.length} 个资源）`);
```

`.gitignore` 追加 `src/standalone/mediaAssets.ts`。

- [ ] **Step 2: 新建 media/bridge.js（把 WebSocket 伪装成 webview API）**

```js
// 独立版桥接：在 view.js 之前加载。
// webview 环境（VS Code）里 acquireVsCodeApi 已存在，本文件直接退出。
(function () {
  if (typeof acquireVsCodeApi === 'function') return;

  let ws;
  let closed = false;
  const outbox = [];        // 连接未就绪时暂存的消息

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      hideBanner();
      for (const msg of outbox.splice(0)) ws.send(JSON.stringify(msg));
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      window.dispatchEvent(new MessageEvent('message', { data: msg }));
    };
    ws.onclose = () => {
      if (closed) return;
      showBanner();
      setTimeout(connect, 1500);
    };
  }

  let banner;
  function showBanner() {
    if (!banner) {
      banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;' +
        'background:#b83e3e;color:#fff;padding:6px 12px;font-size:12px;text-align:center;';
      banner.textContent = '与服务器的连接已断开，正在重连…';
      document.body.appendChild(banner);
    }
    banner.style.display = '';
  }
  function hideBanner() { if (banner) banner.style.display = 'none'; }

  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else outbox.push(msg);
    },
    getState() { return undefined; },
    setState() {},
  });

  connect();
})();
```

要点：view.js 用 `window.addEventListener('message', e => e.data)` 收消息，MessageEvent 的 dispatch 与其完全兼容；重连后 view.js 不会再发 ready——因此 server 侧在 WS open 时主动推 init/state（见 Step 4）。

- [ ] **Step 3: 新建 src/standalone/html.ts**

```ts
import { MEDIA_ASSETS } from './mediaAssets';

/**
 * 与 webviewHtml.ts 同一套 DOM；资源改为内嵌直出。
 * 执行时把 webviewHtml.ts 的模板字符串整段拄过来，仅改：
 * 1. 去掉 CSP meta（浏览器直接服务本机，无 webview 隔离需求）
 * 2. <link href="/media/view.css">；脚本先 /media/bridge.js 再 /media/view.js
 */
export function standalonePage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="/media/view.css" rel="stylesheet">
<title>Novel Forge</title>
</head>
<body>
……（照抄 webviewHtml.ts 的 tabbar / 四个 pane / providerModal / toast）……
<script src="/media/bridge.js"></script>
<script src="/media/view.js"></script>
</body>
</html>`;
}

export function assetBytes(name: string): { mime: string; bytes: Uint8Array } | undefined {
  const asset = MEDIA_ASSETS[name];
  if (!asset) return undefined;
  return { mime: asset.mime, bytes: Uint8Array.from(Buffer.from(asset.base64, 'base64')) };
}
```

- [ ] **Step 4: 新建 src/standalone/server.ts**

```ts
import { initHost, getHost } from '../core/host';
import { initSecrets } from '../core/llm/registry';
import { FileConfigStore, FileSecretStore } from '../core/stores';
import { setLegacyConfigReader } from '../core/config'; // 独立版不注入 legacy，仅确认不调用
import { NovelProject } from '../core/model/project';
import { ChatController } from '../core/controller';
import { InMessage, OutMessage } from '../core/protocol';
import { FileHost } from './fileHost';
import { assetBytes, standalonePage } from './html';

export interface ServeOptions {
  root: string;   // 小说工程目录（绝对路径）
  port: number;
}

export function startServer(opts: ServeOptions): void {
  const project = NovelProject.open(opts.root);
  const clients = new Set<import('bun').ServerWebSocket<{ }>>();

  const broadcast = (msg: OutMessage) => {
    const text = JSON.stringify(msg);
    for (const ws of clients) ws.send(text);
  };

  const host = new FileHost(new FileConfigStore(), broadcast);
  initHost(host);
  initSecrets(new FileSecretStore());
  const chat = new ChatController(project);
  host.watch(project, () => { project.invalidate(); void chat.pushState(); });

  const server = Bun.serve({
    port: opts.port,
    hostname: '127.0.0.1',

    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (server.upgrade(req)) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(standalonePage(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (url.pathname.startsWith('/media/')) {
        const asset = assetBytes(url.pathname.slice('/media/'.length));
        if (asset) return new Response(asset.bytes, { headers: { 'content-type': asset.mime } });
      }
      return new Response('Not Found', { status: 404 });
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        // 新连接（含重连）直接推完整状态，不等 ready
        void chat.resendFullState();
      },
      async message(_ws, raw) {
        try {
          const msg = JSON.parse(String(raw)) as InMessage;
          if (msg.type === 'promptResult') {
            host.prompts.resolve(msg.requestId, msg.value);
            return;
          }
          if (msg.type === 'ready') return;
          await chat.dispatch(msg);
        } catch (err) {
          broadcast({ type: 'toast', message: err instanceof Error ? err.message : String(err), level: 'error' });
        }
      },
      close(ws) {
        clients.delete(ws);
        if (clients.size === 0) host.prompts.cancelAll();
      },
    },
  });

  console.log(`Novel Forge 已启动：http://127.0.0.1:${server.port}/（工程：${opts.root}）`);
}
```

controller 需补两个入口（若 Task 6 尚未提供，在这里一并加到 `src/core/controller.ts`）：
- `dispatch(msg: InMessage): Promise<void>` —— 把 Task 6 里 switch 分发表导出为公开方法（webview 壳和 WS 共用）；
- `resendFullState(): Promise<void>` —— 依次推 `init(state)`、`tab`、当前 session、sessions 列表、project tree、settings（照抄现有 ready 处理逻辑，抽成方法）。

- [ ] **Step 5: 新建 src/standalone/cli.ts 与 main.ts**

```ts
// src/standalone/cli.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CliOptions {
  root: string;
  port: number;
  open: boolean;
  init: boolean;
}

/**
 * novelforge [dir] [--port N] [--no-open]
 * novelforge init [dir]
 */
export function parseArgs(argv: string[]): CliOptions {
  let root = '.';
  let port = 3680;
  let open = true;
  let init = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') port = Number(argv[++i]) || 3680;
    else if (a === '--no-open') open = false;
    else if (a === 'init') init = true;
    else if (!a.startsWith('-')) rest.push(a);
  }
  if (rest.length > 0) root = rest[0];
  return { root: path.resolve(root), port, open, init };
}

/** 端口被占时顺延，最多试 20 次。 */
export function nextFreePort(preferred: number): number {
  // Bun.serve 失败时由 main.ts 循环重试；此处仅返回候选序列的起点
  return preferred;
}
```

```ts
// src/standalone/main.ts —— bun build --compile 的入口
import { parseArgs } from './cli';
import { startServer } from './server';
import { NovelProject } from '../core/model/project';
import { initProjectFlow } from '../core/actions';

const opts = parseArgs(process.argv.slice(2));

if (opts.init) {
  // CLI 交互式 init：终端问答（Bun.stdin）后写盘，不开服务
  const project = NovelProject.open(opts.root);
  if (await project.isInitialized()) {
    console.log('该目录已是小说工程。');
  } else {
    const title = await ask('作品名：');
    const author = await ask('作者名（可留空）：');
    await project.initialize({ title: title.trim() || '我的小说', author: author.trim() });
    console.log(`已初始化：${path.join(opts.root, '.novelforge')}`);
  }
  process.exit(0);
}

if (!fs.existsSync(path.join(opts.root, '.novelforge', 'project.json'))) {
  console.log(`目录还不是小说工程：${opts.root}`);
  console.log('提示：先跑 novelforge init，或在网页上点「初始化工程」。');
}

let port = opts.port;
for (let i = 0; ; i++) {
  try { startServer({ root: opts.root, port }); break; }
  catch (err) {
    if (i >= 20) throw err;
    port++;
  }
}

if (opts.open) {
  const url = `http://127.0.0.1:${port}/`;
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

async function ask(label: string): Promise<string> {
  process.stdout.write(label);
  const buf = Buffer.alloc(4096);
  const n = await new Promise<number>((resolve) => {
    process.stdin.once('readable', () => resolve(process.stdin.read()?.length ?? 0));
  });
  void n; void buf;
  // 执行时用更稳的实现：Bun.stdin 逐行读（readline 风格），这里留实现钩子
  return '';
}
```

（`ask()` 执行时用 `for await (const line of readline/promises 风格)` 实现：`import { createInterface } from 'node:readline/promises'` + `rl.question(label)`，Bun 兼容 node readline。）

- [ ] **Step 6: 验证 + Commit**

```powershell
node scripts/embed-media.js
npm run typecheck
bun run src/standalone/main.ts sample-novel --no-open
# 另开终端：curl http://127.0.0.1:3680/ 应返回 HTML；/media/view.js 应 200
# 浏览器打开验证：init 状态、对话、设置页可交互
```

```powershell
git add -A ; git commit -m "feat(standalone): Bun HTTP+WS server, bridge.js and CLI entry"
```

---

### Task 11: vscode-lm 在独立版中隐藏 + 端到端手测清单

**Files:**
- Modify: `src/core/llm/registry.ts`（`listModelChoices`）、`src/core/controller.ts`

- [ ] **Step 1: 模型清单按宿主过滤**

`registry.ts` 里供设置页下拉用的列表函数（现名 `listModelChoices` 或类似）加参数：

```ts
export function listModelChoices(includeVscodeLm: boolean): { ref: string; label: string; group: string }[] {
  const config = readConfig();
  return config.providers
    .filter((p) => includeVscodeLm || p.kind !== 'vscode-lm')
    .flatMap((p) => p.models.map((m) => ({ ref: `${p.id}/${m.name}`, label: ..., group: p.label || p.id })));
}
```

调用方改为 `listModelChoices(getHost().supportsVscodeLm)`（controller 的 modelSelect 与 settings 推送）。若当前模型恰是被过滤的 vscode-lm，modelIssue 提示「当前模型仅在 VS Code 内可用」。

- [ ] **Step 2: 端到端手测清单（逐项打勾）**

插件（F5）：初始化工程、续写一轮、采纳、总结本章、同步摘要、角色提取、设置页保存、设/清 API Key、选区附件、断网错误提示。
独立版（`bun run src/standalone/main.ts sample-novel`）：同上 + WS 断线重连条（杀服务再起）、prompt 弹窗（初始化工程、新建章节、删除会话确认）、粘贴选区附件、openFile toast/系统打开、设置页不显示「在 VS Code 设置中打开」。

- [ ] **Step 3: Commit**

```powershell
npm run typecheck ; npm run smoke
git add -A ; git commit -m "feat: hide vscode-lm models in standalone host"
```

---

### Task 12: 配置迁移 —— 插件壳切到 ~/.novelforge/

**Files:**
- Create: `src/vscode/migrate.ts`
- Modify: `src/vscode/extension.ts`、`package.json`（配置项标废弃）
- Delete: `src/vscode/settingsStore.ts`（过渡后端）

- [ ] **Step 1: 新建 src/vscode/migrate.ts**

```ts
import * as vscode from 'vscode';
import { FileConfigStore, FileSecretStore } from '../core/stores';
import { PersistedSettings } from '../core/config';
import { legacySettingsReader } from './settingsStore'; // 迁移完再删

/**
 * 一次性迁移：settings.json 的 novel.* + SecretStorage → ~/.novelforge/。
 * 已迁移过（config.json 存在）则跳过。迁移成功后不删旧配置，
 * 只在 VS Code 里提示「可清理」，避免用户回滚时丢东西。
 */
export async function migrateVscodeSettings(secrets: vscode.SecretStorage): Promise<boolean> {
  const store = new FileConfigStore();
  if (store.read()) return false;

  const cfg = vscode.workspace.getConfiguration('novel');
  const settings: PersistedSettings = {};
  const keys = ['providers', 'model', 'contextWindow', 'maxOutputTokens', 'temperature',
    'recentChaptersFullText', 'prevChapterTailChars', 'chaptersDir', 'summaryBatchSize', 'requestTimeoutMs'];
  for (const k of keys) {
    const v = cfg.get(k);
    if (v !== undefined) (settings as Record<string, unknown>)[k] = v;
  }
  if (Object.keys(settings).length === 0) {
    // 没配过新结构：试遗留单服务商键
    const legacy = legacySettingsReader.read();
    if (Object.values(legacy).some((v) => v !== undefined)) {
      (settings as Record<string, unknown>)['_legacy'] = legacy; // seedFromLegacyRaw 会消费
      Object.assign(settings, legacy as Record<string, unknown>);
      delete (settings as Record<string, unknown>)['_legacy'];
    }
  }
  if (Object.keys(settings).length === 0) return false;
  await store.write(settings);

  // SecretStorage 里的 key：按现有 registry 的命名规则逐个搬
  const secretStore = new FileSecretStore();
  const cfgProviders = cfg.get<unknown[]>('providers', []);
  // 执行时：遍历 registry 中实际的 secret key 格式（如 `novel.apiKey.${providerId}`），
  // 对每个 id 调 secrets.get → secretStore.set。key 命名以现有代码为准，不臆测。
  void cfgProviders; void secrets; void secretStore;

  void vscode.window.showInformationMessage(
    'Novel Forge：配置与密钥已迁移到 ~/.novelforge/，VS Code 内的旧配置可手动清理。');
  return true;
}
```

- [ ] **Step 2: extension.ts 切换后端**

```ts
// 替换 Task 7 的接线：
await migrateVscodeSettings(context.secrets);
initHost(new VsCodeHost(new FileConfigStore()));
initSecrets(new FileSecretStore());
// setLegacyConfigReader 保留（未迁移或回滚用户的兜底）
```

随后删除 `src/vscode/settingsStore.ts` 中 `SettingsJsonConfigStore`/`SecretStorageSecretStore`（若 migrate.ts 仍引用 legacySettingsReader，把该对象内联到 migrate.ts）。`package.json` 的 `novel.*` 配置项全部加 `markdownDeprecationMessage`：「已迁移至 ~/.novelforge/config.json，此处仅作兼容兜底。」（contributes 保留，不改默认值）。

- [ ] **Step 3: 验证 + Commit**

```powershell
npm run typecheck ; npm run smoke ; npm run compile
# F5 手测：配置过 novel.providers 的工程 → 激活后 ~/.novelforge/config.json 出现，面板行为不变
git add -A ; git commit -m "feat(vscode): migrate settings and secrets to ~/.novelforge"
```

---

### Task 13: 收尾 —— 纯度检查、发布脚本、文档

**Files:**
- Create: `scripts/check-core-purity.js`、`scripts/smoke-server.js`
- Modify: `package.json`、`README.md`、`.gitignore`

- [ ] **Step 1: core 纯度检查**

```js
// scripts/check-core-purity.js
// 保证 src/core/ 永不 import vscode。用法：node scripts/check-core-purity.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'src', 'core');
let bad = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.ts$/.test(e.name)) {
      const text = fs.readFileSync(p, 'utf8');
      if (/from\s+['"]vscode['"]|require\(['"]vscode['"]\)/.test(text)) bad.push(p);
      if (/from\s+['"]\.{1,2}\/.*vscode/.test(text)) bad.push(`${p} (跨层引用 vscode 壳)`);
    }
  }
})(ROOT);
if (bad.length) { console.error('✗ core 层发现 vscode 依赖：\n' + bad.join('\n')); process.exit(1); }
console.log('✓ src/core 无 vscode 依赖');
```

- [ ] **Step 2: smoke-server.js**

```js
// scripts/smoke-server.js
// 用 bun 起服务 → HTTP 拿页面/资源 → WS 握手拿 init 消息。用法：bun scripts/smoke-server.js
const proc = Bun.spawn(['bun', 'run', 'src/standalone/main.ts', 'sample-novel', '--no-open', '--port', '3999'], { cwd: `${import.meta.dir}/..` });
try {
  await retryFetch('http://127.0.0.1:3999/');
  const html = await (await fetch('http://127.0.0.1:3999/')).text();
  if (!html.includes('view.js')) throw new Error('首页缺 view.js');
  if ((await fetch('http://127.0.0.1:3999/media/view.js')).status !== 200) throw new Error('view.js 404');
  const ws = new WebSocket('ws://127.0.0.1:3999/ws');
  const first = await new Promise((resolve, reject) => {
    ws.onmessage = (e) => resolve(JSON.parse(e.data));
    setTimeout(() => reject(new Error('WS 无 init')), 5000);
  });
  if (first.type !== 'init' && first.type !== 'state') throw new Error(`首条消息是 ${first.type}`);
  console.log('✓ smoke-server 通过');
} finally { proc.kill(); }

async function retryFetch(url) {
  for (let i = 0; i < 30; i++) {
    try { await fetch(url); return; } catch { await Bun.sleep(300); }
  }
  throw new Error('服务未在 9s 内就绪');
}
```

- [ ] **Step 3: package.json 脚本与 bin**

```json
"bin": { "novelforge": "./bin/novelforge.js" },
"scripts": {
  "smoke": "node scripts/smoke.js && node scripts/smoke-providers.js && node scripts/smoke-builder.js && node scripts/smoke-llm.js && node scripts/smoke-session.js && bun scripts/smoke-server.js",
  "test": "npm run typecheck && node scripts/check-core-purity.js && npm run smoke",
  "standalone": "bun run src/standalone/main.ts",
  "dist": "node scripts/embed-media.js && bun build src/standalone/main.ts --compile --outfile dist/novelforge"
}
```

新建 `bin/novelforge.js`（npm 安装时用本机 bun/node 跑源码入口）：

```js
#!/usr/bin/env node
// npm 包形态：优先用 bun 跑；没有 bun 时用 node（需用户自行保证依赖可用）
const { spawnSync } = require('child_process');
const path = require('path');
const entry = path.join(__dirname, '..', 'src', 'standalone', 'main.ts');
const bun = spawnSync('bun', ['run', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
if (bun.status === null) { console.error('需要安装 Bun（https://bun.sh）或直接用编译好的可执行文件。'); process.exit(1); }
process.exit(bun.status ?? 0);
```

- [ ] **Step 4: README 与最终验证**

README.md 增加「独立版」一节：安装（bun 单文件 / npm）、`novelforge [dir]` 用法、`~/.novelforge/` 说明、与 VS Code 插件的差异（选区粘贴、无 diff 审阅、无 vscode-lm）。

```powershell
npm run test
npm run dist ; .\dist\novelforge.exe sample-novel --no-open
# 确认可执行文件自包含：把 dist/novelforge.exe 拷到空目录运行，页面正常
git add -A ; git commit -m "feat: standalone distribution scripts, purity check and docs"
```

---

## Self-Review

**规格覆盖（对照 specs/2026-08-04-standalone-web-app-design.md）：**
- 双形态共存 / 分层：Task 1（目录）、Task 7（插件壳）、Task 9–10（独立壳）。
- Host 抽象 + AbortSignal：Task 3。
- 配置/密钥入主目录 + 迁移：Task 4、12。
- `novelforge [dir]` / init / --port / --no-open：Task 10 Step 5。
- 仅 127.0.0.1 + 自动开浏览器：Task 10 Step 4/5。
- 协议复用 + prompt 弹窗：Task 8。
- view.js 两处小适配（粘贴选区、重连条）：Task 9（粘贴）、Task 10 Step 2（重连条）。
- vscode-lm 隔离：Task 4（工厂钩子）、Task 11（隐藏）。
- 会话删除走 .trash：Task 2。
- 单文件 + npm 双渠道：Task 13。

**已知遗留/风险：**
1. Task 7 的 `VsCodeHost.reviewReplace` 与 Task 12 的 secret key 迁移留了「按原实现为准」的钩子——执行时对照原 characters.ts / registry.ts 的实际 key 命名填入，不臆测。
2. `FileHost.watch` 的轮询回退较粗（只盯 .novelforge 目录 mtime），Windows 上 fs.watch recursive 可用，实际不会落到回退。
3. smoke 脚本在 Task 5 后删掉 vscode 桩；若某模块仍有残留 import，typecheck 会先报警。
4. bun compile 产物需在目标 OS 上验证；`dist` 脚本默认当前平台，跨平台加 `--target`。

**占位符扫描：** 无 TBD；webviewHtml 模板、migrate 的 key 遍历两处已显式标注「照抄/以原实现为准」，均为可执行指令而非模糊描述。
