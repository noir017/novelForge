# 一期：workspace 读写网关 Implementation Plan

> **接手须知：** 这份计划面向新的 agent，假设你**没有读过**前面的对话。开工前必读：
> 1. 根目录 [AGENTS.md](../../../AGENTS.md) —— 23 条产品承诺。本期直接关系到第 **3、6、7、8、9、10、18** 条
> 2. 设计依据 [docs/design/specs/2026-08-15-agent-architecture-design.md](../specs/2026-08-15-agent-architecture-design.md) 的 **L1 一节**
> 3. [src/core/README.md](../../../src/core/README.md) 的「已知约定」全段
> 4. 前置：[零期](2026-08-15-agent-phase0-provider-events.md) 必须已经合入
>
> 每个 Task 按 `- [ ]` 逐步执行，做完立刻 commit。

**Goal:** 把散在六处的文件读写收敛成**唯一网关** `core/workspace/`，守卫在入口做一次，产物记账下沉到写入路径本身。这一期结束时，「给 agent 一个 `write`」不再是一件危险的事。

**Architecture:** 自底向上三步：先抽**纯函数**的路径种类表（零 I/O，可单测），再抽**统一守卫**（把六处各自的检查合并成一份），最后逐个把既有写盘路径改成经网关。**每一步都保证全量测试绿**——这一期一个新功能都没有，任何一条测试变红都意味着改错了。

**Tech Stack:** TypeScript（`src/core/workspace/`，零 vscode 依赖）+ `node:test` + `npm run typecheck`。不新增依赖。

## Global Constraints

- **行为不变**（唯一例外见下）。`npm test` 全绿是本期的验收标准。
- **唯一有意的行为变化**：`upstreamHash` / `beatsHash` 的记账从「只在采纳路径上做」下沉到「谁写都做」。这修掉一个既有缺陷——作者在内置编辑器里改一份细纲，指纹链现在会断（那一章从此不挂 ⟳）。要为它**补一条集成测试**。
- 守卫八条一条都不能少（见下面的守卫表）。**新代码不许绕过 `guard.ts` 直接 `fs.writeFile`。**
- `src/core/` 零 `vscode` import（`tests/contract/corePurity.test.js`）。
- 不要同时留下 `project.ts` 的旧写方法与 `workspace` 的新方法。每个 Task 搬完就删旧的。
- 每个 Task 结束立刻 commit；前缀 `refactor` / `test` / `docs`；中文正文。

---

## 目标态文件结构

```
src/core/workspace/
├── index.ts        Workspace 门面：list / read / write / edit / move / remove / search
├── kind.ts         ★ 路径 → 种类（纯函数，零 I/O，绝不抛）
├── guard.ts        ★ 统一入口守卫（八条）
├── search.ts       全文检索（朴素扫描，零模型调用）
├── handlers/
│   ├── index.ts    种类 → handler 注册表
│   ├── plot.ts     解析/渲染/记 upstreamHash/伴生搬迁
│   ├── scene.ts    解析/渲染/记 upstreamHash/改标题清旧文件名
│   ├── manuscript.ts 追加/记 beatsHash
│   ├── chapter.ts  草稿跟随/manifest 同步
│   ├── summary.ts  sourceHash
│   ├── doc.ts      outline / style / globalSummary / character / lore（纯文本 + frontmatter）
│   └── plain.ts    other / draft（纯文本，无记账）
└── README.md
```

搬空之后：

- `model/project.ts` 只剩**领域查询**（`listPlots` / `getPlot` / `nextPlotNo` / `listChapters` / `listScenes` / `readPlot` / `readScene` / `readManuscript` / `readSummary` / `syncManifest` / 路径推导 getter…）与 `initialize`。写方法（`writePlot` / `writeScene` / `deletePlot` / `appendToManuscript` / `splitManuscript` / `writeCharacter` / `writeLore` / `writeSummary` / `writeStyleGuide` / `writeGlobalSummary` / `createChapter` / `ensureDraft`）全部搬走。
- `files/fileOps.ts`、`files/projectFiles.ts`、`files/fileEditing.ts` 的**守卫部分**搬进 `guard.ts`，只留各自的交互流程（弹输入框、拼 toast 文案）。
- `features/creation.ts` 的 `acceptArtifact` 六条分支变成六次 `workspace.write(path, {artifact})`。

## 提交节奏（8 个 commit）

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `refactor` | 抽出 `workspace/kind.ts`（纯函数种类表） |
| 2 | `refactor` | 抽出 `workspace/guard.ts`（统一守卫） |
| 3 | `refactor` | `Workspace` 门面 + `plain` / `doc` handler |
| 4 | `refactor` | plot / scene handler，记账下沉 |
| 5 | `refactor` | manuscript / chapter / summary handler |
| 6 | `refactor` | `acceptArtifact` 六条分支改走网关 |
| 7 | `refactor` | 文件页 / 内置编辑器 / fileOps 改走网关 |
| 8 | `feat` | `workspace/search.ts` |

---

### Task 1: 抽出 `workspace/kind.ts`

**Files:**
- Create: `src/core/workspace/kind.ts`
- Create: `tests/unit/workspace/kind.test.js`

这是整期的地基：**纯函数、零 I/O、绝不抛**。判定逻辑现在散在四处，本 Task 把它们合成一处并**逐字保留口径**：

| 现有判定 | 位置 | 搬进 `kind.ts` 后 |
|---|---|---|
| 章节文件名规则（数字前缀 + 扩展名不在黑名单） | `model/chapterFile.ts` 的 `isChapterFileName` | **继续 import 它**，不复制 |
| 细纲文件名 | `model/plotFile.ts` 的 `parsePlotFileName` | 继续 import |
| 场景文件名 | `model/sceneFile.ts` 的 `parseSceneFileName` | 继续 import |
| 区归属 | `files/fileOps.ts` 的 `sectionOf` | `kindOfPath` 内部用同一套前缀比较 |
| `plots/` 路径判定 | `files/fileOps.ts` 的 `isPlotPath` | 合进来，原处改为转发 |

**Interfaces:**

```ts
export type ArtifactKind =
  | 'outline' | 'style' | 'globalSummary'
  | 'plot' | 'scene' | 'manuscript'
  | 'chapter' | 'summary' | 'draft'
  | 'character' | 'lore'
  | 'other';

export interface PathKind {
  kind: ArtifactKind;
  /** 规范化后的相对路径（正斜杠）。越界时是 undefined，此时 kind 恒为 'other'。 */
  rel?: string;
  /** 该路径对应的创作层。非创作产物为 undefined。 */
  stage?: CreationStage;
  /** 该路径对应的创作目标，供 generate 直接用。 */
  target?: CreationTarget;
  no?: number;
  sceneNo?: number;
  /** scene / manuscript / summary 这类镜像产物所属的细纲路径。 */
  plotRelPath?: string;
}

export function kindOfPath(project: NovelProject, relPath: string): PathKind;

/** 反过来：这个创作目标该落在哪个路径。`acceptArtifact` 用它。 */
export function pathOfTarget(project: NovelProject, target: CreationTarget): string;
```

**三条必须写进注释的取舍：**

1. **`scene` 的 `plotRelPath` 要从镜像目录名反推**。`scenes/012-入宗/02-翻越侧峰.md` → 细纲是 `plots/012-入宗.md`。反推靠 `project.plotStem` 的逆运算；找不到对应细纲文件时**仍然返回 `kind: 'scene'`**（文件确实在那儿），只是 `plotRelPath` 指向那个应该存在的位置。
2. **`chapter` 与 `other` 的边界**：章节根之下、数字前缀、扩展名不在二进制黑名单 → `chapter`；否则 `other`。**不看是不是 `.md`**（第 9 条：章节不认扩展名）。
3. **越界一律 `other` 且 `rel: undefined`**，不抛。这个函数会被前端传上来的路径调用。

- [ ] **Step 1: 写失败测试** `tests/unit/workspace/kind.test.js`

用例矩阵（至少这些）：

| 输入 | 期望 kind | 期望其余字段 |
|---|---|---|
| `.novelforge/outline.md` | `outline` | `stage: 'outline'`, `target: {kind:'outline'}` |
| `.novelforge/plots/012-入宗.md` | `plot` | `no: 12`, `stage: 'plot'` |
| `.novelforge/plots/012.md`（无标题） | `plot` | `no: 12` |
| `.novelforge/scenes/012-入宗/02-翻越侧峰.md` | `scene` | `no: 12`, `sceneNo: 2`, `plotRelPath: '.novelforge/plots/012-入宗.md'` |
| `.novelforge/manuscripts/012-入宗.md` | `manuscript` | `no: 12` |
| `chapters/012-入宗.md` | `chapter` | `no: 12` |
| `chapters/012-楔子`（无扩展名） | `chapter` | `no: 12` |
| `chapters/第一卷/013-夜访.txt` | `chapter` | `no: 13`（层级只是收纳，第 8 条） |
| `chapters/cover.png` | `other` | — |
| `chapters/说明.md`（无数字前缀） | `other` | — |
| `.novelforge/summaries/012-入宗.md` | `summary` | `no: 12` |
| `.novelforge/characters/林昭.md` | `character` | — |
| `.novelforge/lore/青云宗.md` | `lore` | — |
| `drafts/012-入宗.md` | `draft` | — |
| `../etc/passwd` | `other` | `rel: undefined` |
| `/abs/path` | `other` | `rel: undefined` |
| `C:\Windows` | `other` | `rel: undefined` |
| `` （空串） | `other` | `rel: undefined` |

外加 `pathOfTarget` 的四支往返测试（`outline` / `plot` / `scene` / `manuscript`），断言 `kindOfPath(pathOfTarget(t)).target` 与 `t` 相等。

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test "tests/unit/workspace/kind.test.js"
```

- [ ] **Step 3: 实现 `kind.ts`**
- [ ] **Step 4: 把 `files/fileOps.ts` 的 `isPlotPath` 改成转发给 `kindOfPath`**（保留导出名，调用方不动）
- [ ] **Step 5: 跑测试**

```bash
node --test "tests/unit/workspace/kind.test.js"
npm run typecheck
npm test
```

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(workspace): 抽出路径种类表

细纲/场景/章节/摘要的路径判定散在四处，各自认一半。收成 kindOfPath 一张表，纯函数零 I/O 绝不抛——它会被前端传上来的路径调用。"
```

---

### Task 2: 抽出 `workspace/guard.ts`

**Files:**
- Create: `src/core/workspace/guard.ts`
- Create: `tests/unit/workspace/guard.test.js`

把六处各自的检查合并成一份。**八条守卫，一条都不能少**：

| # | 守卫 | 现在在哪 | 触发时怎么办 |
|---|---|---|---|
| 1 | 路径规范化（拒绝绝对路径、`..`、空串） | `fileOps.normalizeRel` | 抛 `WsError('越界')` |
| 2 | 工程根包含检查 | `fileEditing.resolveInRoot` | 抛 `WsError('越界')` |
| 3 | 固定目录保护（改名/删除） | `fileOps.isProtectedPath` | 抛 `WsError('受保护')` |
| 4 | `.trash/` 内容不可操作 | `projectFiles` | 抛 `WsError('回收站')` |
| 5 | 读取大小上限（2MB） | `fileEditing.MAX_EDITABLE_BYTES` | 抛 `WsError('过大')` |
| 6 | 同名不覆盖（`mode: 'create'`） | `fileOps` / `projectFiles` 各一份 | 抛 `WsError('已存在')` |
| 7 | 覆盖前审阅（`reviewReplace` 或确认框） | `creation.confirmOverwrite` | 用户拒绝 → 返回 `{skipped: true}` |
| 8 | 内容 hash 乐观锁 | `fileEditing.saveFromEditor` | 抛 `WsConflictError(diskText, diskHash)` |

**Interfaces:**

```ts
export class WsError extends Error {
  constructor(readonly code: WsErrorCode, message: string) { super(message); }
}
export type WsErrorCode =
  | 'outOfRoot' | 'protected' | 'inTrash' | 'tooLarge'
  | 'exists' | 'notFound' | 'notFile' | 'conflict';

export class WsConflictError extends WsError {
  constructor(readonly diskText: string, readonly diskHash: string) { … }
}

/** 读之前过一遍：返回绝对路径。 */
export async function guardRead(project: NovelProject, relPath: string): Promise<string>;

/** 写之前过一遍。返回绝对路径与「目标是否已存在」。 */
export async function guardWrite(
  project: NovelProject,
  relPath: string,
  opts: { mode: 'create' | 'overwrite' | 'append'; baseHash?: string }
): Promise<{ abs: string; existed: boolean; current?: string }>;

/** 改名/移动/删除之前过一遍（多两条：保护路径、回收站）。 */
export async function guardMutate(project: NovelProject, relPath: string): Promise<string>;

/**
 * 覆盖前审阅。有 reviewReplace 的宿主开 diff，没有的弹确认框。
 * 逐字搬自 features/creation.ts 的 confirmOverwrite——那段文案是产品承诺的一部分。
 */
export async function reviewOverwrite(
  what: string, relPath: string, current: string, next: string
): Promise<boolean>;
```

**注意**：`reviewOverwrite` 里的确认框文案（`「${what}」已经有内容了，用新版本覆盖？`、`现有 N 字，新版 M 字`）**逐字搬**，不要改措辞。

- [ ] **Step 1: 写失败测试** `tests/unit/workspace/guard.test.js`

八条守卫各至少一条用例。第 7、8 条需要假 Host（`tests/helpers/` 里已有类似的，照抄）。

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `guard.ts`**
- [ ] **Step 4: 跑测试 + `npm test`**
- [ ] **Step 5: Commit**

---

### Task 3: `Workspace` 门面 + `plain` / `doc` handler

**Files:**
- Create: `src/core/workspace/index.ts`
- Create: `src/core/workspace/handlers/index.ts`
- Create: `src/core/workspace/handlers/plain.ts`
- Create: `src/core/workspace/handlers/doc.ts`
- Create: `tests/integration/workspace/basic.test.js`

**Interfaces:**

```ts
export interface WsEntry {
  name: string;
  rel: string;
  type: 'file' | 'dir';
  kind: ArtifactKind;
  /** 文本文件给字数，其余给字节数。 */
  words?: number;
  bytes: number;
}

export interface WsFile {
  rel: string;
  text: string;
  hash: string;
  bytes: number;
  kind: ArtifactKind;
  /** 按 offset/limit 截过。**必须说出来**（第 2 条：不静默截断）。 */
  truncated?: { from: number; total: number };
}

export type WriteInput = { text: string } | { artifact: Artifact };

export interface WriteOptions {
  mode?: 'create' | 'overwrite' | 'append';
  /** 覆盖前是否审阅。缺省 true。**agent 路径不允许传 false。** */
  review?: boolean;
  baseHash?: string;
  /** 覆盖审阅框里显示的名字，如「第 12 章的细纲」。 */
  what?: string;
}

export interface WriteResult {
  rel: string;
  skipped?: boolean;
  message: string;
  /** 这次写入连带做了什么（记了哪个 hash、搬了哪个伴生目录）。进日志用。 */
  side?: string[];
}

export interface Handler {
  /** 把结构化产物渲染成该种类的文件内容。 */
  render?(ctx: HandlerCtx, artifact: Artifact): Promise<string>;
  /** 写入之后的记账与伴生动作。 */
  after?(ctx: HandlerCtx, result: WriteResult): Promise<void>;
  /** 改名/移动时要连带搬走什么。 */
  companions?(ctx: HandlerCtx, from: string, to: string): Promise<void>;
}

export class Workspace {
  constructor(private readonly project: NovelProject) {}
  list(relDir?: string): Promise<WsEntry[]>;
  read(rel: string, opts?: { offset?: number; limit?: number }): Promise<WsFile>;
  write(rel: string, input: WriteInput, opts?: WriteOptions): Promise<WriteResult>;
  edit(rel: string, edits: { old: string; new: string; all?: boolean }[]): Promise<WriteResult>;
  move(from: string, to: string): Promise<WriteResult>;
  remove(rel: string): Promise<WriteResult>;
}
```

本 Task 只接两个最简单的 handler：

- `plain`（`other` / `draft`）：纯文本进出，无记账。
- `doc`（`outline` / `style` / `globalSummary` / `character` / `lore`）：纯文本 + frontmatter，无上游指纹。

其余种类先落到 `plain`，Task 4/5 逐个接上。

**`remove` 必须搬进 `.trash/` 并保留原相对路径**（第 6 条），逐字复用 `project.trash` 的实现。

- [ ] **Step 1: 写失败测试** `tests/integration/workspace/basic.test.js`

用真临时工程（`tests/helpers/` 里有现成的 fixture 工具）。至少覆盖：

| 用例 | 断言 |
|---|---|
| `write` 新文件 | 落盘，`mode: 'create'` |
| `write` 同名 + `mode: 'create'` | 抛 `WsError('exists')` |
| `write` 同名 + `mode: 'overwrite'` + 假 Host 同意 | 覆盖 |
| `write` 同名 + `mode: 'overwrite'` + 假 Host 拒绝 | `{skipped: true}`，磁盘一字未改 |
| `write` + `baseHash` 对不上 | 抛 `WsConflictError` |
| `read` 超 offset/limit | `truncated` 字段说明截了多少 |
| `remove` | 文件进 `.trash/` 且保留原相对路径 |
| `remove` 受保护路径 | 抛 `WsError('protected')` |
| `edit` old 不唯一 + `all: false` | 抛，不改 |
| `list` 目录 | 条目带 `kind` |

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试 + `npm test`**
- [ ] **Step 5: 写 `src/core/workspace/README.md`**（八条守卫表 + 种类表 + 「新代码不许绕过 guard 直接 fs.writeFile」）
- [ ] **Step 6: Commit**

---

### Task 4: plot / scene handler，**记账下沉**

**Files:**
- Create: `src/core/workspace/handlers/plot.ts`
- Create: `src/core/workspace/handlers/scene.ts`
- Modify: `src/core/model/project.ts`（删 `writePlot` / `deletePlot` / `carryPlotCompanions` / `writeScene` / `deleteScene`）
- Modify: 所有调用上述方法的地方
- Create: `tests/integration/workspace/hashChain.test.js`

**这是本期唯一有意的行为变化。** 现在 `upstreamHash` 只在 `features/creation.ts` 的 `acceptPlot` / `acceptSceneList` / `acceptScene` 里记；下沉之后，**任何一次 `workspace.write` 到 plot/scene 路径都记**。

`plot` handler：

```ts
// render: Artifact{kind:'plot'} → renderPlotFile，四个小节换新，
//         标题/幕/目标字数/done 沿用磁盘那份（「重写剧情」不该抹掉作者起的标题）
// after:  upstreamHash = hash(await project.readOutline())
// companions: 改名时搬 scenes/<stem>/ 与 manuscripts/<stem>.md（原 carryPlotCompanions）
```

`scene` handler：

```ts
// render: Artifact{kind:'scene'} → renderSceneFile，
//         标题沿用磁盘那份（标题决定文件名，改写一张卡不该顺手改文件名）
//         status 由 isSceneReady(sections) 推，不靠调用方传
// after:  upstreamHash = plotContentHash(plot)
// companions: 改标题时清掉旧文件名（原 writeScene 的行为）
```

**四条不能碰的既有取舍**（逐条在代码注释里保留原文）：

1. `plotContentHash` 只哈希四个小节、不含 frontmatter（第 18b 条）
2. `beatsHashFor` 排除场景的 `status`（同上）
3. 手写的产物永不标脏——`upstreamHash` 为空就是「不是这条链生出来的」（第 18a 条）
4. 删细纲要连带搬走场景目录与中转站正文，**但不碰 `chapters/` 与摘要**

- [ ] **Step 1: 写失败测试** `tests/integration/workspace/hashChain.test.js`

| 用例 | 断言 |
|---|---|
| `write` 一份细纲 | frontmatter 里有 `upstreamHash = hash(outline)` |
| **改大纲后再 `write` 细纲** | `upstreamHash` 跟着更新（**这是修的那个缺陷**） |
| **不经采纳路径直接 `write` 细纲文本** | 一样记 `upstreamHash`（缺陷修复的核心断言） |
| `write` 场景 | `upstreamHash = plotContentHash(plot)` |
| 把细纲标 `done` | 场景**不**标脏（哈希不含 status） |
| 细纲改名 | 场景目录与中转站正文跟着搬 |
| 细纲改名到已存在的目标 | 不覆盖，伴生不动 |
| 删细纲 | 细纲/场景/中转站进 `.trash`，`chapters/` 与摘要不动 |

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现两个 handler，从 `project.ts` 搬走五个方法**
- [ ] **Step 4: 改所有调用点**

```bash
grep -rn "writePlot\|deletePlot\|writeScene\|deleteScene" src/ tests/
```

- [ ] **Step 5: 跑测试 + `npm test`**
- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(workspace): plot/scene handler，记账下沉

upstreamHash 从前只在「采纳」路径上记，作者在内置编辑器里改一份细纲，指纹链就断了——那一章从此再也不挂 ⟳。下沉到写入路径本身，谁写都记。"
```

---

### Task 5: manuscript / chapter / summary handler

**Files:**
- Create: `src/core/workspace/handlers/manuscript.ts`
- Create: `src/core/workspace/handlers/chapter.ts`
- Create: `src/core/workspace/handlers/summary.ts`
- Modify: `src/core/model/project.ts`（删 `appendToManuscript` / `createChapter` / `writeSummary` / `markSummarized` / `ensureDraft` 的写入部分）
- Modify: `src/core/features/splitChapter.ts`（改走网关）
- Modify: 调用点

`manuscript` handler：

- `mode: 'append'` 是**默认**（正文是追加不是覆盖）
- 首次写入建 frontmatter + `# 第N章… · 正文` 标题行
- 两次追加之间插一行 `---`（默认拆分候选点，第 23 条）
- `after`：记 `beatsHash = await project.beatsHashFor(plotRelPath)`
- `contentHash` 只哈希正文本身，不含 frontmatter 与标题行

`chapter` handler：

- 改名/移动时草稿跟随（原 `fileOps.carryDraft`）
- 删章节**不删草稿**（第 10 条，确认框里说明）
- `after`：`syncManifest`

`summary` handler：`sourceHash` 记的是**成品**的 `contentHash`。

**`splitChapter.ts` 的顺序不能改**：先移号再落盘（第 23 条）。反过来的话，落盘后重编号失败会留下「章节已建但细纲还撞着号」的中间态。

- [ ] **Step 1: 写失败测试**（扩充 `hashChain.test.js`，加一个 `tests/integration/workspace/split.test.js`）
- [ ] **Step 2–5: 同上**

---

### Task 6: `acceptArtifact` 六条分支改走网关

**Files:**
- Modify: `src/core/features/creation.ts`（`acceptArtifact` 及其六个私有方法、`confirmOverwrite` 删掉）
- Modify: `tests/integration/features/*`（涉及采纳的）

六条分支各变成一次 `workspace.write`：

| 分支 | 改成 |
|---|---|
| `acceptOutline` | `ws.write(outlinePath, {artifact}, {mode:'overwrite', what:'全书大纲'})` |
| `acceptPlotList` | 循环 `ws.write(plotPathForNo(no), {artifact}, {mode:'create'})`，**已存在的跳过并在 message 里说出来** |
| `acceptPlot` | `ws.write(plot.relPath, {artifact}, {mode:'overwrite', what:'第 N 章的细纲'})` |
| `acceptSceneList` | 循环 `ws.write(scenePath, …, {mode:'create'})`，已存在的跳过 |
| `acceptScene` | `ws.write(scenePath, {artifact}, {mode:'overwrite', what:'第 N 章 · 场景 M'})` |
| `acceptManuscript` | `ws.write(manuscriptPath, {artifact}, {mode:'append'})` |

**「跳过已存在」的文案必须保留**（`，跳过已存在的第 3、5 章`）——默默少建三章，作者要到写到那里才发现。

`confirmOverwrite` 整个删掉，它的实现已经在 `guard.reviewOverwrite` 里。

- [ ] **Step 1–5: 同上**。这一步的验收是既有的采纳集成测试**一条都不改**还能全绿。

---

### Task 7: 文件页 / 内置编辑器 / fileOps 改走网关

**Files:**
- Modify: `src/core/files/fileEditing.ts`（`readFileForEditor` / `saveFromEditor` 改成 `ws.read` / `ws.write`，只留 `EditorFile` 的形状转换）
- Modify: `src/core/files/projectFiles.ts`（`renameAny` / `moveInto` / `copyInto` 改走 `ws.move`）
- Modify: `src/core/files/fileOps.ts`（`renameEntry` / `moveEntry` / `deleteEntry` 改走 `ws.move` / `ws.remove`，只留区界限判断与交互流程）

**注意区界限**：`fileOps` 的三区约束（章节挪不进角色目录）是**工程页的产品承诺**，比 `guard` 的工程根约束更严。这一层保留在 `fileOps` 里，先判区再调网关。

- [ ] **Step 1–5: 同上**。验收是 `tests/integration/files/*` 与 `tests/dom/standalone/*` 全绿。

---

### Task 8: `workspace/search.ts`

**Files:**
- Create: `src/core/workspace/search.ts`
- Create: `tests/integration/workspace/search.test.js`

本期唯一的新代码。**零模型调用的朴素全文扫描**，三期的 `search` 工具吃它。

```ts
export interface SearchOptions {
  /** 限定目录，缺省全工程。 */
  path?: string;
  /** 限定种类，如 ['chapter','summary']。 */
  kinds?: ArtifactKind[];
  /** 正则还是字面量。缺省字面量（作者搜的是人名地名，不是正则）。 */
  regex?: boolean;
  /** 每个文件最多返回几条命中。缺省 5。 */
  perFile?: number;
  /** 总共最多返回几条。缺省 50。 */
  limit?: number;
  /** 命中行前后各带几行。缺省 1。 */
  context?: number;
}

export interface SearchHit {
  rel: string;
  kind: ArtifactKind;
  no?: number;
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  /** 扫了几个文件。 */
  scanned: number;
  /** 因为超上限被丢掉了几条。**必须报出来**（第 2 条）。 */
  dropped: number;
}
```

**四条实现约束：**

1. **跳过 `.trash/` 与二进制**（走 `kindOfPath`，`other` 且扩展名在黑名单里的不读）。
2. **单文件读入有上限**（复用 `MAX_EDITABLE_BYTES`），超了跳过并计入 `dropped`。
3. **`dropped > 0` 时必须在返回值里说出来**，三期的工具会把它转述给模型。
4. **默认按章号排序**，不按文件系统顺序——作者问「他前面说过吗」，时间线顺序才有意义。

- [ ] **Step 1: 写失败测试**

| 用例 | 断言 |
|---|---|
| 搜一个只在第 9 章出现的词 | 命中一条，`no: 9` |
| 跨多章命中 | 按章号升序 |
| 超 `limit` | `dropped > 0` |
| `.trash/` 里的内容 | 不命中 |
| `kinds: ['summary']` | 只搜摘要 |
| 正则模式 | 生效 |
| 坏正则 | 不抛，降级成字面量并在结果里说明 |

- [ ] **Step 2–5: 同上**

---

## 本期不做

- **不接 agent**。这一期结束时 `workspace` 还没有任何 agent 调用方。
- **不改 `context/`**。装配器读文件走的是 `project.read*`（查询），不受影响。
- **不改协议与前端**。
- **不动 `pipelineBatch.ts` 的批量逻辑**（它的落盘会跟着 handler 走，但「只补不改」的策略不变）。

## 给接手 agent 的提示词

> 你在 novel-forge 仓库里执行「一期：workspace 读写网关」。前置是零期（事件流 provider），确认它已经合入。
>
> 先读 `AGENTS.md`（尤其第 3、6、7、8、9、10、18 条）、`src/core/README.md` 的「已知约定」全段、以及 `docs/design/specs/2026-08-15-agent-architecture-design.md` 的 L1 一节。然后读这六个文件，它们是你要收敛的对象：
> `src/core/model/project.ts`、`src/core/features/creation.ts`、`src/core/files/{fileOps,fileEditing,projectFiles}.ts`、`src/core/features/splitChapter.ts`。
>
> 这一期**只有一个有意的行为变化**：`upstreamHash` / `beatsHash` 的记账从「只在采纳路径上做」下沉到「谁写都做」——它修掉一个既有缺陷（作者在内置编辑器里改细纲，指纹链会断）。除此之外任何一条测试变红都意味着你改错了。
>
> 按 `docs/design/plans/2026-08-15-agent-phase1-workspace.md` 的 8 个 Task 逐个做，每个 Task 做完立刻 commit（前缀 `refactor(workspace)`，中文正文，**不要加 Co-Authored-By 或 Generated with 标记**）。
>
> 五件最容易做错的事：
> 1. **守卫八条一条都不能少**（Task 2 的表）。少一条就是给 agent 开了一个后门。
> 2. **`plotContentHash` 只哈希四个小节，`beatsHashFor` 排除 `status`**。把 frontmatter 或 status 算进去，会让「排一次剧情」立刻使全部场景过期。
> 3. **手写的产物永不标脏**：`upstreamHash` 为空 = 不是这条链生出来的，不要给它补一个。
> 4. **拆分是先移号再落盘**，顺序反了会留下中间态。
> 5. **删细纲连带搬场景与中转站，但不碰 `chapters/` 与摘要**。
>
> `project.ts` 有 1501 行，不要试图一次读完再动手——按 Task 顺序，每次只看你这一步要搬的那几个方法。
