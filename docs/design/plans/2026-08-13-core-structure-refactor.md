# 核心层结构整理 Implementation Plan



**Goal:** 把已经长出「一个文件一件事」边界的核心模块拆开，去掉跨 feature 复制的解析/I/O 小工具，并按职责收纳 `src/core/` 根目录；行为与对外 import 路径（壳、前端协议）保持兼容或一次性改干净。

**Architecture:** 先抽共享纯函数（零行为变化），再按域拆大文件（controller / layers / protocol / characterCard），最后才做目录搬家。永远不要同时存在 `foo.ts` 与 `foo/` 目录。壳继续从 `core/controller`、`core/protocol` 进口——这两处改成目录后靠 `index.ts` 顶住原路径。

**Tech Stack:** TypeScript（`src/core/`，零 vscode 依赖）+ `node:test` + `npm run typecheck`。不新增依赖。

## Global Constraints

- 行为不变：解析降级、不静默覆盖、不静默截断、hash 口径（含 `\r\n` 归一）、章节不认扩展名，一条都不能改。
- `src/core/` 零 `vscode` import（`tests/contract/corePurity.test.js`）。
- 壳与壳之间不许互相 import；壳不写业务逻辑。
- 改了 `src/core/**` 必须跑 `npm test`；改了任何 TS 必须过 `npm run typecheck`。
- 每个 Task 结束立刻 commit；前缀 `refactor` / `chore` / `docs`；中文正文可以。
- 不要同时留下 `controller.ts` 和 `controller/`（`layers.ts` / `protocol.ts` 同理）。
- `project.ts` 在 Task 2–3 抽走自由函数后，**暂时保留 re-export**，等调用方改完再在同一 Task 末尾删掉 re-export（测试改为从新模块 load）。
- 提示词正文逐字搬迁，一个标点都不能改（角色卡篇幅上限是产品承诺）。

---

## 文件结构（目标态）

```
src/core/
├── controller/          # 原 controller.ts
│   ├── index.ts         # ChatController + ViewHost + dispatch
│   ├── serialize.ts
│   ├── chat.ts
│   ├── session.ts
│   ├── project.ts
│   ├── files.ts
│   └── settings.ts
├── protocol/            # 原 protocol.ts
│   ├── index.ts         # 对外唯一入口（壳 / media 仍 from 'core/protocol'）
│   ├── in.ts
│   ├── out.ts
│   └── views.ts
├── context/layers/      # 原 context/layers.ts
│   ├── index.ts         # LAYERS 注册表 + 再导出
│   ├── focus.ts
│   ├── assembly.ts      # Assembly / LayerFn / admit 实现所在处：仍由 builder 构造，这里只放类型
│   ├── render.ts
│   ├── dialog.ts        # system / ask / attachments / history
│   ├── artifacts.ts     # outlineDoc / planSelf / planPrev / sceneSelf / sceneSiblings
│   └── background.ts    # style / globalSummary / characters / lore / prevTail / chapterFull / chapterSummary / revision
├── files/               # 原根上的文件操作
│   ├── fileOps.ts
│   ├── projectFiles.ts
│   ├── fileEditing.ts
│   ├── fileTree.ts
│   └── attachments.ts
├── views/               # 读聚合（不写盘）
│   ├── projectView.ts
│   ├── pipeline.ts
│   ├── workbench.ts
│   └── cast.ts
├── runtime/             # 日志 / 库 / 进度 / 并发
│   ├── logger.ts
│   ├── db.ts
│   ├── errorLog.ts
│   ├── progress.ts
│   └── concurrency.ts
├── model/
│   ├── fs.ts            # 新增：hash / exists / readText / …
│   ├── castParse.ts     # 新增：renderCastEntry / parseCastEntry / castFromText
│   ├── naming.ts        # 从 core 根搬来
│   └── identity.ts      # 从 core 根搬来
└── features/
    ├── parse.ts         # 新增：stripCodeFence / extractJson* / unique*
    ├── characterCard.ts
    ├── characterCardParse.ts
    ├── characterCardPrompt.ts
    ├── summarizePrompt.ts
    ├── lorePrompt.ts
    ├── charactersPrompt.ts
    └── stylePrompt.ts
```

不动：`host.ts`、`config.ts`、`stores.ts`、`actions.ts`、`choices.ts`、`watchPolicy.ts`、`features/creation.ts` 的编排、三个壳的目录布局、`media/src/` 的模块切分。

---

## 提交节奏（12 个 commit）

| # | 前缀 | 主题 |
|---|---|---|
| 1 | `refactor` | 抽出 `features/parse.ts` |
| 2 | `refactor` | 抽出 `model/fs.ts` |
| 3 | `refactor` | 抽出 `model/castParse.ts` |
| 4 | `refactor` | 拆 `characterCard` 的解析与提示词 |
| 5 | `refactor` | 其余 feature 提示词挪到旁路文件 |
| 6 | `refactor` | `controller.ts` → `controller/` |
| 7 | `refactor` | `context/layers.ts` → `context/layers/` |
| 8 | `refactor` | `protocol.ts` → `protocol/`（barrel 保路径） |
| 9 | `refactor` | `naming.ts` / `identity.ts` 迁入 `model/` |
| 10 | `refactor` | 文件操作迁入 `core/files/` |
| 11 | `refactor` | 读聚合迁入 `core/views/` |
| 12 | `refactor` | 运行时迁入 `core/runtime/` |

每个 Task 的 README / AGENTS.md 路径更新跟在**该 Task 自己的 commit** 里，不要攒到最后。

---

### Task 1: 抽出模型输出解析小工具

**Files:**
- Create: `src/core/features/parse.ts`
- Create: `tests/unit/features/parse.test.js`
- Modify: `src/core/features/summarize.ts`（删除 `extractJsonObject` / `stripCodeFence` 实现，改为从 `./parse` import；`toSectionText` 留在 summarize）
- Modify: `src/core/features/artifact.ts`（`extractJsonObject` / `stripCodeFence` 改从 `./parse`）
- Modify: `src/core/features/characters.ts`（删 `extractJsonArray` / `unique` / `toStringArray`；`stripCodeFence` 改从 `./parse`）
- Modify: `src/core/features/characterCard.ts`（`stripCodeFence` 改从 `./parse`；`unique` / `unique2` / `toStringArray` 改用 parse；解析 JSON 对象改用 `extractJsonObject`）
- Modify: `src/core/features/lore.ts`（删 `extractJson` / `unique` / `uniqueNumbers` / `stringArray`；`stripCodeFence` 改从 `./parse`）
- Modify: `src/core/features/style.ts`（`stripCodeFence` 改从 `./parse`）
- Modify: `src/core/features/README.md`（文件表加 `parse.ts`）

**Interfaces:**
- Produces:

```ts
export function stripCodeFence(text: string): string;
export function extractJsonObject(text: string): string | undefined;
export function extractJsonArray(text: string): string | undefined;
export function extractJson(text: string): string | undefined;
export function unique(values: string[]): string[];
export function uniqueNumbers(values: number[]): number[];
export function stringArray(value: unknown): string[];
```

- `extractJsonObject`：第一个 `{` 到最后一个 `}`（摘要正文里会有 `}`，取 lastIndexOf）。
- `extractJsonArray`：第一个 `[` 到最后一个 `]`。
- `extractJson`：`[` / `{` 里更靠前的那个，配对用对应的 `]` / `}` 的 lastIndexOf。
- `unique`：trim + 去空 + Set。
- `uniqueNumbers`：Set + 升序。
- `stringArray`：数组则滤 string；字符串则按 `[,，、\n]` 切（lore 口径，覆盖 characters 的 `[,，、]`）。

- [ ] **Step 1: 写失败测试** `tests/unit/features/parse.test.js`

```js
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

describe('features/parse', () => {
  let p;
  before(() => { p = loadModule('src/core/features/parse.ts'); });

  test('stripCodeFence 剥掉 json fence', () => {
    assert.equal(p.stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
  });
  test('stripCodeFence 无 fence 原样 trim', () => {
    assert.equal(p.stripCodeFence('  hello  '), 'hello');
  });
  test('extractJsonObject 取最外层对象', () => {
    assert.equal(p.extractJsonObject('好的：{"梗概":"x}y"} 以上'), '{"梗概":"x}y"}');
  });
  test('extractJsonArray 取最外层数组', () => {
    assert.equal(p.extractJsonArray('x [1,2] y'), '[1,2]');
  });
  test('extractJson 对象与数组取更靠前的', () => {
    assert.equal(p.extractJson('{"a":1}'), '{"a":1}');
    assert.equal(p.extractJson('[1]{"a":1}'), '[1]');
  });
  test('unique / uniqueNumbers', () => {
    assert.deepEqual(p.unique(['a', '', 'a', ' b ']), ['a', 'b']);
    assert.deepEqual(p.uniqueNumbers([3, 1, 3, 2]), [1, 2, 3]);
  });
  test('stringArray 认数组与顿号串', () => {
    assert.deepEqual(p.stringArray(['a', 1, 'b']), ['a', 'b']);
    assert.deepEqual(p.stringArray('林昭、沈氏'), ['林昭', '沈氏']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```
node --test "tests/unit/features/parse.test.js"
```

Expected: FAIL（模块不存在或导出缺失）

- [ ] **Step 3: 实现 `parse.ts`，调用方改为 import，删掉各文件里的副本**

`uniqueSlug` **先别动**（依赖 `exists`，Task 2 再收）。`toSectionText` 留在 `summarize.ts`（摘要小节专用）。`characterCard.ts` 的 `parseCardResponse` 里内联的 `{`…`}` 切片改成 `extractJsonObject`。

- [ ] **Step 4: 跑测试**

```
node --test "tests/unit/features/parse.test.js"
npm run typecheck
node --test "tests/unit/features/summarize.test.js" "tests/unit/features/characters.test.js"
```

Expected: PASS

- [ ] **Step 5: Commit**

```
git add src/core/features/parse.ts src/core/features/summarize.ts src/core/features/artifact.ts src/core/features/characters.ts src/core/features/characterCard.ts src/core/features/lore.ts src/core/features/style.ts src/core/features/README.md tests/unit/features/parse.test.js
git commit -m "$(cat <<'EOF'
refactor: 抽出模型输出解析小工具

stripCodeFence / 抠 JSON / unique 在摘要、角色、设定里各写一遍，artifact 还要绕道 import summarize。收到 features/parse.ts，行为口径与原来逐字节一致。
EOF
)"
```

---

### Task 2: 抽出 `model/fs.ts`

**Files:**
- Create: `src/core/model/fs.ts`
- Create: `tests/unit/model/fs.test.js`
- Modify: `src/core/model/project.ts`（删实现；本 Task 结束时**不再** re-export 这些名字）
- Modify: 所有从 `model/project` import `hash` / `exists` / `readText` / `writeText` / `countWords` / `sanitizeFileName` / `slugify` / `pad3` / `isIgnoredDir` 的生产代码，改为从 `./fs` 或 `../model/fs`
- Modify: `src/core/features/characters.ts`、`characterCard.ts`、`lore.ts`：本地 `uniqueSlug` / `uniqueLoreSlug` 改为 `uniqueSlug(dirAbs, base)`
- Modify: `src/core/model/README.md`（文件表加 `fs.ts`）
- Modify: 集成测试里 `bundle.project.hash(...)` 改为从 fs 模块取（`tests/integration/features/pipelineData.test.js`）

**Interfaces:**
- Produces:

```ts
export function hash(text: string): string;           // sha1，\r\n → \n，截 16 hex
export function countWords(text: string): number;     // 中文按字、英文按词
export function pad3(n: number): string;
export function sanitizeFileName(name: string): string;
export function slugify(name: string): string;
export async function exists(absPath: string): Promise<boolean>;
export async function readText(absPath: string): Promise<string>;
export async function writeText(absPath: string, text: string): Promise<void>;
export function isIgnoredDir(name: string): boolean;
export async function uniqueSlug(dirAbs: string, base: string): Promise<string>;
```

`uniqueSlug`：`base`、`base-2`、`base-3`… 直到 `${slug}.md` 不存在。`listFilesDeep` / `listMarkdownDeep` / `writeIfAbsent` / `baseName` **留在** `project.ts`（NovelProject 私有扫描）。

已知生产 import（全部改掉）：

| 文件 | 现从 project 取的工具 |
|---|---|
| `context/layers.ts` | `exists`, `readText` |
| `db.ts` | `exists` |
| `pipeline.ts` | `hash` |
| `fileEditing.ts` | `hash` |
| `projectFiles.ts` | `exists` |
| `fileOps.ts` | `exists`, `readText`, `sanitizeFileName`, `writeText` |
| `workbench.ts` | `hash` |
| `features/creation.ts` | `exists`, `hash`, `readText`, `sanitizeFileName`, `writeText` |
| `features/pipelineBatch.ts` | `hash`, `sanitizeFileName` |
| `features/characters.ts` | `exists`, `readText`, `slugify`, `writeText` |
| `features/characterCard.ts` | `exists`, `readText`, `slugify`, `writeText` |
| `features/lore.ts` | `exists` 等 |
| `features/characterMaintenance.ts` | `readText`, `writeText` |

`NovelProject` 本身继续从 `./fs` import 自己用。

- [ ] **Step 1: 写失败测试** `tests/unit/model/fs.test.js`

覆盖：`hash` 对 `\r\n` 与 `\n` 相同；`countWords` 中英混合；`sanitizeFileName` 剥非法字符；`slugify` 小写；`isIgnoredDir` 认 `.trash` 与 `node_modules`；`uniqueSlug` 用临时目录（`fs.mkdtemp`）验证撞名加 `-2`。

- [ ] **Step 2: 跑测试确认失败**

```
node --test "tests/unit/model/fs.test.js"
```

- [ ] **Step 3: 把 `project.ts` 里「工具函数」段（约 1001–1105 行）原样搬到 `fs.ts`，加上 `uniqueSlug`；更新全部生产 import；删三处 feature 里的 slug 副本**

实现必须从 `project.ts` **剪切**，不要重写 hash 算法。

- [ ] **Step 4: 跑测试**

```
npm run typecheck
node --test "tests/unit/model/fs.test.js" "tests/unit/model/project.test.js"
npm test
```

Expected: PASS。`project.test.js` 此刻仍只测 cast，不受影响。

- [ ] **Step 5: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 把磁盘小工具从 NovelProject 抽到 model/fs.ts

hash/exists/readText 被 fileEditing、db、fileOps 只为这几个函数去 import project.ts。uniqueSlug 在角色卡与设定里还复制了一份。收到 fs.ts 后调用方不再绕道数据层上帝类。
EOF
)"
```

---

### Task 3: 抽出 `model/castParse.ts`

**Files:**
- Create: `src/core/model/castParse.ts`
- Modify: `src/core/model/project.ts`（`renderCastEntry` / `parseCastEntry` / `castFromText` / 内部 `parseCast` / `isPlausibleName` / `SENTENCE_MARKERS` 搬走；`readSummary` 等改为从 `./castParse` import）
- Modify: `src/core/features/summarize.ts`（改为从 `../model/castParse` import `castFromText` / `parseCastEntry` / `renderCastEntry`）
- Modify: `tests/unit/model/project.test.js` → 改名为或改为 load `src/core/model/castParse.ts`（describe 标题跟着改）
- Modify: `src/core/model/README.md`（文件表加 `castParse.ts`；「见 model/project.ts 的 castFromText」改指向新文件）
- Modify: `src/core/features/README.md`（摘要降级第 3 条里的路径）

**Interfaces:**
- Produces: `renderCastEntry` / `parseCastEntry` / `castFromText` 签名与现实现完全相同。
- `parseCast`（frontmatter 字段 → `SummaryCast[] | undefined`）若仅 `project.ts` 的 `readSummary` 使用，可留在 `castParse.ts` 并 export，供 `project.ts` 调用。

- [ ] **Step 1: 把现有 `tests/unit/model/project.test.js` 的 load 路径改成 `castParse.ts`，先跑一遍确认失败**

```
node --test "tests/unit/model/project.test.js"
```

Expected: FAIL（还没搬）

- [ ] **Step 2: 剪切实现到 `castParse.ts`，`project.ts` 从那里 import 私有 `parseCast`**

`castFromText` 仍依赖 `../naming` 的 `sanitizeAliases`。

- [ ] **Step 3: 跑测试**

```
npm run typecheck
node --test "tests/unit/model/project.test.js"
node --test --test-name-pattern="cast" "tests/integration/features/**/*.test.js"
```

- [ ] **Step 4: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 出场人物解析从 NovelProject 抽到 castParse.ts

frontmatter 括号形式与小节文本反解是纯函数，不该跟章节扫描焊在一个类里。摘要读写仍走 NovelProject，解析口径只有这一份。
EOF
)"
```

---

### Task 4: 拆 characterCard 的解析与提示词

**Files:**
- Create: `src/core/features/characterCardParse.ts`（`parseCardResponse` + `ParsedCard` 类型）
- Create: `src/core/features/characterCardPrompt.ts`（`UPDATE_SYSTEM` 逐字搬迁）
- Modify: `src/core/features/characterCard.ts`（import 上述两处；文件应降到约 900 行以内的编排）
- Modify: `src/core/features/README.md`
- Test: 现有 `tests/unit/features/characters.test.js` 与 `tests/integration/features/characterCard.test.js`；若 unit 测的是 `parseCardResponse`，改为从 `characterCard.ts` 再导出或直接 load parse 模块（**保持 `characterCard.ts` re-export `parseCardResponse`**，避免集成测试入口变了）

**Interfaces:**
- Produces: `export function parseCardResponse(raw: string): ParsedCard | undefined`
- Produces: `export const UPDATE_SYSTEM: string`（全文与现文件 1112–1145 行逐字相同）
- `characterCard.ts` 继续 `export { parseCardResponse } from './characterCardParse'`

- [ ] **Step 1: 先加一条 unit 测试 load `characterCardParse.ts`**，用现有角色卡 JSON 夹具（可从 `tests/integration/features/characterCard.test.js` 抄一条最小 JSON），断言性格节有内容、泛称 alias 被滤掉。跑、确认失败。

- [ ] **Step 2: 剪切 `parseCardResponse` 与 `UPDATE_SYSTEM`，编排文件改为 import**

- [ ] **Step 3:**

```
npm run typecheck
node --test "tests/unit/features/characters.test.js"
node --test "tests/integration/features/characterCard.test.js"
```

- [ ] **Step 4: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 角色卡更新的解析与提示词从编排里拆出

characterCard.ts 同时堆着单卡/批量/切批/审阅/JSON 解析/系统提示。解析与控篇幅提示词是另一条变更轴，拆到旁路文件后编排只负责调用模型与写盘。
EOF
)"
```

---

### Task 5: 其余 feature 提示词旁路

**Files:**
- Create: `src/core/features/summarizePrompt.ts`（`SUMMARY_SYSTEM` / `STAGE_SYSTEM` / `GLOBAL_SYSTEM`）
- Create: `src/core/features/lorePrompt.ts`（`LORE_EXTRACT_SYSTEM` / `LORE_SYNTHESIS_SYSTEM`）
- Create: `src/core/features/charactersPrompt.ts`（`CHARACTER_SYSTEM`）
- Create: `src/core/features/stylePrompt.ts`（`STYLE_SYSTEM`）
- Modify: 对应四个编排文件改为 import
- Modify: `src/core/features/README.md` 文件表

提示词字符串**逐字剪切**，不要重新排版。

- [ ] **Step 1: 剪切四个文件的 `*_SYSTEM` 常量到旁路模块并改 import**（无新行为，现有 unit/integration 即回归网）

- [ ] **Step 2:**

```
npm run typecheck
node --test "tests/unit/features/summarize.test.js" "tests/unit/features/characters.test.js"
node --test "tests/integration/features/lore.test.js" "tests/integration/features/characterCard.test.js"
```

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 把摘要/设定/提取/文风的系统提示词挪到旁路文件

编排文件里大段模板字符串让调用模型的控制流读不下去。提示词与流水线分开改，避免改一句「80 字以内」时还要在 800 行里找常量。
EOF
)"
```

---

### Task 6: `controller.ts` → `controller/`

**Files:**
- Delete: `src/core/controller.ts`（与目录不能并存）
- Create: `src/core/controller/index.ts`（`ChatController`、`ViewHost`、`describeProvider`、`dispatch` 的 switch、生命周期）
- Create: `src/core/controller/serialize.ts`（`serializeSession` / `serializeTurn` / `serializeAttachment` / `serializeDigest` / `serializeItem` / `factsOf` / `targetOf` / `describeProvider`）
- Create: `src/core/controller/session.ts`（`persist` / `newSession` / `openSession` / `deleteSession` / `renameSession`）
- Create: `src/core/controller/chat.ts`（`send` / `retry` / `runTurn` / `accept` / `acceptArtifact` / `setTarget` / `selectChapter` / `applyAction` / `describeArtifactOf` / `targetHasContent` / `restoreTarget` / `focusWithTarget` / `pushPipeline` / `outlineNextStep` / `describeCurrentTarget`）
- Create: `src/core/controller/project.ts`（`projectAction` / `characterAction` / `pickSection`）
- Create: `src/core/controller/files.ts`（`fileAction` / `openDraft` / `pushDirListings`）
- Create: `src/core/controller/settings.ts`（`saveSettings` / `selectModel` / `testConnection` / `pushSettings`）
- Modify: `src/core/README.md`、`src/README.md`、`AGENTS.md`、`src/core/features/README.md` 里写 `controller.ts` 的路径改为 `controller/`
- 壳 import **不用改**：`from '../../core/controller'` 解析到 `controller/index.ts`

**Interfaces:**
- 对外仍是：

```ts
export interface ViewHost {
  post(message: OutMessage): void;
  reveal(): void;
}
export class ChatController {
  constructor(project: NovelProject);
  attach(host: ViewHost): void;
  detach(host: ViewHost): void;
  dispose(): void;
  handle(msg: InMessage): Promise<void>;
  resendFullState(): Promise<void>;
  pushState(): Promise<void>;
  addSelectionFromCommand(): Promise<boolean>;
  focusWithTarget(order: number): Promise<void>;
  showTab(tab: Tab): Promise<void>;
  newSessionFromCommand(): Promise<void>;
}
export function describeProvider(config?: NovelConfig): string;
```

- 同目录模块通过把原 `private` 字段改成**不写 private**（或 `readonly` 公开给同包）共享状态。文件头注释写清：「这些字段只给 `controller/` 下的模块用，壳不要读。」不要新造第二个 controller 类。
- `dispatch` 的 switch **留在 index.ts**，case 里调拆出去的函数，例如 `await send(this, msg.payload)`。
- 拆出的函数签名形态：`export async function send(c: ChatController, payload: SendPayload): Promise<void>`

- [ ] **Step 1: 先把 `serialize.ts` 和 `describeProvider` 搬出去**，`controller.ts` 改为 import。typecheck。这一步若更稳，可以先在仍叫 `controller.ts` 的文件里 import 旁路模块——但最终 commit 必须是目录形态，所以本 Task 一次做到 `controller/index.ts`。

- [ ] **Step 2: 建 `controller/`，按上表剪切方法，删除根上的 `controller.ts`**

注意 `describeProvider` 被壳或测试引用的话从 `controller/index.ts` re-export。

- [ ] **Step 3:**

```
npm run typecheck
npm test
```

Expected: PASS。契约测试扫的是 `src/core/**/*.ts`，新目录自动覆盖。

- [ ] **Step 4: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 按消息域拆 ChatController

一个 class 同时处理会话、采纳、工程页、文件页和设置，dispatch 还能读，方法区已经读不动。拆成 controller/ 下按域分的模块，对外仍是同一个 ChatController，双开同步的那份状态不拆开。
EOF
)"
```

---

### Task 7: `context/layers.ts` → `context/layers/`

**Files:**
- Delete: `src/core/context/layers.ts`
- Create: `src/core/context/layers/index.ts`（`export const LAYERS: Record<LayerId, LayerFn>` 组装；再导出 `resolveFocus` / `Focus` / `Assembly` / `LayerFn` / `tailByChars` / `isPlaceholder`）
- Create: `src/core/context/layers/focus.ts`（`Focus`、`resolveFocus`）
- Create: `src/core/context/layers/assembly.ts`（`Assembly`、`LayerFn` 类型；admit/accept/reject 的实现**仍在 builder.ts**——这里只放类型。若 admit 实现目前写在 layers.ts 里作为闭包，保持「由 builder 注入」的现状，不要把预算算法搬进层文件。）
- Create: `src/core/context/layers/render.ts`（`renderPlan` / `renderScene` / `renderSceneBrief` / `renderCharacter` / `resolveAttachment` / `chapterLabel` / `focusText` / `selectCharacters` / `matchesKeywords` / `tailByChars` / `isPlaceholder` / `ATTACHMENT_NOTE`）
- Create: `src/core/context/layers/dialog.ts`（`system` `ask` `attachments` `history`）
- Create: `src/core/context/layers/artifacts.ts`（产物五层）
- Create: `src/core/context/layers/background.ts`（背景与正文层）
- Modify: `src/core/context/builder.ts` 的 import 仍是 `from './layers'`（目录 index）
- Modify: `src/core/context/README.md`

**Interfaces:**
- `builder.ts` 继续：`import { LAYERS, resolveFocus, type Assembly } from './layers'`
- 每层文件 export 具名 `LayerFn`，例如 `export const system: LayerFn = async (a, spec) => { ... }`
- `index.ts`：

```ts
export const LAYERS: Record<LayerId, LayerFn> = {
  system, ask, attachments, history,
  outlineDoc, planSelf, planPrev, sceneSelf, sceneSiblings,
  style, globalSummary, characters, lore, prevTail, chapterFull, chapterSummary, revision,
};
```

层函数内部逻辑剪切，不要改 `admit` / `reject` 的 note 文案（测试会盯明细）。

- [ ] **Step 1: 建目录、剪切、删 `layers.ts`**

- [ ] **Step 2:**

```
npm run typecheck
node --test "tests/integration/context/builder.test.js" "tests/unit/context/**/*.test.js"
```

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 按层把装配实现拆进 context/layers/

layers.ts 是一份层名到取数函数的目录，八百行挤在一个 Record 里改某一层要先翻配方。拆开后配方表仍是唯一策略入口，builder 的 import 路径不变。
EOF
)"
```

---

### Task 8: `protocol.ts` → `protocol/`（barrel 保路径）

**Files:**
- Delete: `src/core/protocol.ts`
- Create: `src/core/protocol/in.ts`（`Tab`、`SendPayload`、`SerializedAttachment`、`EditorPane`、`InMessage`、`ProjectAction`、`CharacterAction`、`FileAction`、`SettingsPayload`）
- Create: `src/core/protocol/out.ts`（`OutMessage`、`SerializedProvider`、`SerializedModel`、`FileOpResult`、`EditorFileView`）
- Create: `src/core/protocol/views.ts`（`ViewState`、`ProjectTree` / `ProjectNode*`、`ChapterPipelineView`、`WorkbenchView`、`Cast*`、`FailureView`、`SerializedSession` / `SerializedTurn` / `SerializedArtifact` / `SerializedDigest`、`SessionListItem`、`NextStepView` 等界面快照）
- Create: `src/core/protocol/index.ts`（re-export 上述全部 + 现有的 `export type { LogEntry, LogLevel } from '../logger'` 等转出口 + `makeNonce`）
- `media/src/protocol.ts`、壳、`host.ts` 的 `from '.../core/protocol'` **不用改**
- Modify: `src/core/README.md`、`AGENTS.md` 提到 `protocol.ts` 的地方改为 `protocol/`（说明对外入口仍是 `core/protocol`）

**Interfaces:**
- `index.ts` 必须把现在 `protocol.ts` 导出的每一个类型/函数再导出。用 `export type { ... }` / `export { makeNonce }` 显式列出，不要 `export *` 漏掉 `makeNonce`。
- 改完立刻 `npm run typecheck`（含 `media/tsconfig.json`）——前端对不上会在这里红。

- [ ] **Step 1: 按消息方向切开，`index.ts` 显式 re-export，删除 `protocol.ts`**

- [ ] **Step 2:**

```
npm run typecheck
npm test
```

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 协议类型按方向拆进 protocol/，对外入口不变

八百行协议文件里 InMessage、OutMessage 和工程页快照缠在一起。拆开后 media 与壳仍从 core/protocol 进口，typecheck 继续当契约网。
EOF
)"
```

---

### Task 9: `naming.ts` / `identity.ts` 迁入 `model/`

**Files:**
- Move: `src/core/naming.ts` → `src/core/model/naming.ts`
- Move: `src/core/identity.ts` → `src/core/model/identity.ts`
- Modify: 所有 import（`cast.ts`、`castParse.ts`、`characterCard.ts`、`characterMaintenance.ts`、`project.ts` 若仍引用 naming、测试）
- Modify: `src/core/README.md`、`src/core/model/README.md`、`AGENTS.md`（第 14 条路径）

理由：二者与 `chapterFile.ts` 同类——纯函数、零 I/O、领域规则。现在却放在 core 根上。

- [ ] **Step 1: git mv + 改 import + 改文档**

- [ ] **Step 2:**

```
npm run typecheck
node --test "tests/integration/features/cast.test.js" "tests/unit/model/**/*.test.js"
```

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 称呼学与同一人聚类归入 model/

naming/identity 与 chapterFile 一样是纯领域规则，放在 core 根上跟日志、进度混在一起。搬进 model/ 后数据层的「谁是谁」规则就在一处。
EOF
)"
```

---

### Task 10: 文件操作迁入 `core/files/`

**Files:**
- Move: `fileOps.ts` / `projectFiles.ts` / `fileEditing.ts` / `fileTree.ts` / `attachments.ts` → `src/core/files/`
- Modify: 全部 import（controller、壳、protocol 若 type-reexport `DirListing` 从 fileTree、standalone fileHost 等）
- Modify: `src/core/README.md`、`AGENTS.md` 约束 7 的路径、`src/shells/README.md` 如有引用
- `protocol/index.ts` 里 `export type { DirListing, FsEntry } from '../fileTree'` 改为 `from '../files/fileTree'`

**不要**在旧路径留 stub re-export——一次改干净。

- [ ] **Step 1: git mv 五个文件，ripgrep `from '\\./fileOps'|from '\\./fileTree'|from '\\./fileEditing'|from '\\./projectFiles'|from '\\./attachments'` 以及 `core/fileOps` 等壳路径，全部更新**

- [ ] **Step 2:**

```
npm run typecheck
npm test
```

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 工程文件操作收到 core/files/

fileOps、projectFiles、fileEditing、fileTree、attachments 都是「路径守卫 + 读写」，却和日志、流水线快照平铺在 core 根上。收到 files/ 后三区锁定与根范围操作仍然分文件，只是终于能当一组找。
EOF
)"
```

---

### Task 11: 读聚合迁入 `core/views/`

**Files:**
- Move: `projectView.ts` / `pipeline.ts`（**I/O 那份**，不是 `model/pipeline.ts`） / `workbench.ts` / `cast.ts` → `src/core/views/`
- Modify: 全部 import（controller、features/characterCard 的 `buildCastIndex`、creation 的 `planContentHash` 若在 pipeline.ts）
- Modify: README / AGENTS.md。特别写清：`model/pipeline.ts` 仍是纯领域模型，**不要**搬进 views。

- [ ] **Step 1: git mv + 改 import。 ripgrep 时把 `core/model/pipeline` 与 `core/pipeline` 分开看，只动后者。**

- [ ] **Step 2:**

```
npm run typecheck
npm test
```

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 工程页/流水线/工作区/出场索引收到 core/views/

这四个模块都是「从磁盘聚合成界面快照」，一个字都不写盘。与 model/pipeline.ts 的纯函数状态机分开目录，避免再出现改徽章却翻到取数文件的情况。
EOF
)"
```

---

### Task 12: 运行时迁入 `core/runtime/`

**Files:**
- Move: `logger.ts` / `db.ts` / `errorLog.ts` / `progress.ts` / `concurrency.ts` → `src/core/runtime/`
- Modify: **几乎所有 core 文件**以及壳里 `scoped` / `runTask` 的 import
- Modify: `protocol/index.ts` 的 `export type { LogEntry, LogLevel } from '../logger'` → `from '../runtime/logger'`（TaskSnapshot 同理）
- Modify: `src/core/README.md`、`AGENTS.md` 约束 11/16/17 的路径
- 注意 `logger.ts` 与 `db.ts` 的反向 import 约定：`installLogPersistence` 仍只由 db 调 logger 的 sink，logger **继续零依赖 db**（搬目录不改这个方向）

- [ ] **Step 1: git mv + 全仓库改 import。优先用 ripgrep 列清单再改，漏一处 typecheck 会红。**

- [ ] **Step 2:**

```
npm run typecheck
npm test
```

Expected: 全绿。这是最后一次搬家，路径引用应全部落在目标态。

- [ ] **Step 3: Commit**

```
git commit -m "$(cat <<'EOF'
refactor: 日志/库/进度/并发收到 core/runtime/

这些模块是宿主无关的运行时设施，不是小说领域模型。从 core 根挪走之后根上只剩 host/config/actions 这类真正的入口胶水，失败记录与日志仍不进 Markdown。
EOF
)"
```

---

## 每个 Task 的验证口令

```
npm run typecheck
```

改了 `src/core/**` 再加：

```
npm test
```

单测加速（Task 1–5 够用）：

```
node --test --test-name-pattern="关键字" "tests/unit/**/*.test.js"
```

glob 必须带引号。

---

## 明确不做

- 不拆 `NovelProject` 类本身（路径推导 + 各区 read/write 仍是一个门面；只抽走了与实例无关的自由函数）。
- 不合并 `fileOps` 与 `projectFiles`（三区 vs 根范围是产品承诺）。
- 不合并两份 `pipeline`（纯函数 vs 读盘聚合）。
- 不改 `media/src/view/` 的模块切分。
- 不把 feature 提示词搬进 `context/prompts.ts`（那份是 Stage × Capability；后台任务提示词跟编排走）。
- 不在旧路径留永久 stub（除 Task 6–8 用 `index.ts` 顶住**本来就是目录入口**的 `core/controller` 与 `core/protocol`）。

---

## Spec coverage

| 上次审查项 | Task |
|---|---|
| ChatController 1605 行 | 6 |
| NovelProject 自由函数 / cast 解析 | 2, 3 |
| characterCard 提示词+解析 | 4 |
| 跨 feature 的 JSON/unique/slug | 1, 2 |
| layers.ts 847 行 | 7 |
| protocol.ts 832 行 | 8 |
| core 根目录过平 | 9–12 |
| naming/identity 与 chapterFile 分层不一致 | 9 |
| model/README 仍写依赖 vscode / `ui/` | 3 或 9 改 README 时删掉那句，改为「只依赖 Node API 与 core 内更底层模块」 |
| 其余 feature 大段提示词 | 5 |
