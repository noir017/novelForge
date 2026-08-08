# 右键功能完善实施计划



**Goal:** 给独立版补齐三组右键/键盘能力：编辑器标签页与正文区菜单、文件页剪切/复制/粘贴/重命名（含 Ctrl+X/C/V）、工程页批量更新/重建全部角色卡。

**Architecture:** 新增 core 模块 `projectFiles.ts` 承担工程根范围的类文件操作（与三区锁定的 `fileOps.ts` 并列）；`characterCard.ts` 抽出可复用的单卡执行体并新增批量编排；前端三个 media 脚本复用 view.js 的全局右键菜单引擎（`__nfContextMenu`），编辑器标签搬家走 `nf-files-moved` 自定义事件。

**Tech Stack:** TypeScript（core，零 vscode 依赖）+ 原生 JS（media/）+ esbuild 打包的离线冒烟测试（scripts/）+ jsdom（smoke-view.js）。

**Spec:** `docs/design/specs/2026-08-08-context-menu-enhancements-design.md`

**通用约定（每个任务都适用）：**
- shell 为 PowerShell，`&&` 用 `;` 代替；所有命令在仓库根目录执行。
- 改了 TS 必须过 `npm run typecheck`；改了 `src/core/**` 必须跑 `npm run smoke`。
- commit 前缀 `feat/refactor/chore/docs`，中文正文可以。
- 本计划的「测试」即各 `scripts/smoke-*.js` 断言；没有测试框架，TDD 流程 = 先写断言 → 跑、确认失败 → 实现 → 跑、确认通过 → commit。

---

## 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/core/protocol.ts` | 改 | FileAction 加 `paste`/`renameAny`，CharacterAction 加两个批量动作，新 OutMessage `filesOpDone` |
| `src/core/fileOps.ts` | 改 | 导出 `validateName`/`carryDraft`，重命名拆出「根范围放宽」变体，新增 `isProtectedPath` |
| `src/core/projectFiles.ts` | 新建 | 工程根范围的 rename/move/copy，逐项结果 |
| `scripts/smoke-projectFiles.js` | 新建 | 上述操作的离线验证 |
| `src/core/features/characterCard.ts` | 改 | 抽出单卡执行体，新增批量计划与编排 |
| `scripts/smoke-characterCard.js` | 修改 | 批量计划与批量流程断言 |
| `src/core/controller.ts` | 改 | paste/renameAny/updateAllCards/rebuildAllCards 接线，派发 `filesOpDone` |
| `media/view.js` | 改 | 「角色」分组右键增加两个批量项 |
| `media/explorer.js` | 改 | 剪贴板、四个菜单项、Ctrl+X/C/V、与编辑器联动 |
| `media/editor.js` | 改 | 标签菜单、正文区菜单、标签搬家 |
| `media/standalone.css` | 改 | 剪切标记与行焦点样式 |
| `scripts/smoke-view.js` | 改 | 以上三处的前端断言 |
| `AGENTS.md` | 改 | 约束 #7 修订、模块地图 |
| `package.json` | 改 | smoke 链加 smoke-projectFiles.js |

---

### Task 1: 协议扩展（protocol.ts）

**Files:**
- Modify: `src/core/protocol.ts`

- [ ] **Step 1: 扩展消息类型**

在 `src/core/protocol.ts` 中做四处修改：

1. `fileAction` 入消息（约第 100 行）改为：

```ts
  /**
   * 类文件操作。工程页用 `relPath` 单数（rename/move/delete，锁在三个区内）；
   * 文件页用 `renameAny`（根范围重命名）与 `paste`（`relPaths` 源列表 +
   * `op` 区分移动/复制 + `targetDir` 落点）。
   */
  | {
      type: 'fileAction';
      action: FileAction;
      relPath?: string;
      relPaths?: string[];
      op?: 'cut' | 'copy';
      targetDir?: string;
    }
```

2. `FileAction`（约第 156 行）改为：

```ts
/**
 * 类文件操作。作用对象由 `relPath` / `relPaths` 给出，可以是文件也可以是目录。
 * `move` 另需 `targetDir`（工作区相对路径，空串表示所属区的根目录）。
 *
 * - `rename` / `move` / `delete`：工程页用，锁在章节/角色/设定三个区内（fileOps.ts）。
 * - `renameAny` / `paste`：文件页用，范围放宽到整个工程根（projectFiles.ts）。
 */
export type FileAction = 'rename' | 'renameAny' | 'move' | 'delete' | 'paste';
```

3. `CharacterAction`（约第 150 行）追加两个批量动作并补注释：

```ts
/**
 * 角色相关的动作。与 `projectAction` 分开是因为它们的作用对象是**角色**，
 * 而不是一个文件或一个章节。
 *
 * - `updateCard` / `rebuildCard`：更新已有角色卡。前者增量、后者全量，`relPath` 指向那张卡。
 * - `createCard`：给摘要里出现但还没建卡的人物建卡。`name` 是摘要里的名字。
 * - `updateAllCards` / `rebuildAllCards`：批量更新全部角色卡（增量 / 全量），
 *   不需要 name/relPath。
 */
export type CharacterAction =
  | 'updateCard'
  | 'rebuildCard'
  | 'createCard'
  | 'updateAllCards'
  | 'rebuildAllCards';
```

4. `OutMessage` 追加（放在 `dirListings` 之后），并在文件内定义结果形状：

```ts
  /**
   * 文件页类文件操作（renameAny / paste）的逐项结果。
   * 前端据此 remap 开着的编辑器标签，失败项各自提示原因。
   */
  | { type: 'filesOpDone'; op: 'rename' | 'move' | 'copy'; results: FileOpResult[] }
```

```ts
/** 文件操作的单项结果。失败时保持原路径并给出原因（toast 也会同时报）。 */
export interface FileOpResult {
  from: string;
  /** 操作成功后的新路径；失败时没有。 */
  to?: string;
  ok: boolean;
  error?: string;
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: PASS（controller 还没引用新变体，新增类型不会破坏任何现有代码）

- [ ] **Step 3: Commit**

```powershell
git add src/core/protocol.ts
git commit -m "feat: 协议增加文件页粘贴/根范围重命名与批量角色卡动作"
```

---

### Task 2: fileOps.ts 导出与根范围重命名

**Files:**
- Modify: `src/core/fileOps.ts`

现有 `renameEntry` 锁在三个区内（`resolveTarget` 强制 section 归属）。文件页需要「工程根范围」的重命名：不限区，但保护固定目录。拆出一个带开关的内部实现，两个入口各自调用；区内的行为必须**一字不差**地保持（smoke-fileops.js 是守门员）。

- [ ] **Step 1: 导出两个内部函数**

projectFiles.ts 与测试都要用到它们：

```ts
// 原 `function validateName(...)` 改为：
export function validateName(value: string): string | undefined {
```

```ts
// 原 `async function carryDraft(...)` 改为：
export async function carryDraft(
```

- [ ] **Step 2: 新增 isProtectedPath**

放在 `normalizeRel` 之后：

```ts
/**
 * 工程的固定目录：改名/搬走会让工程结构散架（章节索引、草稿镜像、
 * 元数据与会话）。文件页的根范围操作对这些路径一律拒绝。
 */
export function isProtectedPath(project: NovelProject, relPath: string): boolean {
  const rel = normalizeRel(relPath);
  if (!rel) {
    return true;
  }
  const fixed = [
    project.relPath(project.chaptersDir),
    project.relPath(project.draftsDir),
    '.novelforge',
    '.novelforge/characters',
    '.novelforge/lore',
    '.novelforge/.trash',
  ];
  return fixed.includes(rel);
}
```

- [ ] **Step 3: 拆重命名实现**

把现有 `renameEntry` 的函数体整体挪进新的 `renameEntryImpl`，`renameEntry` 变薄壳，另加根范围入口。唯一的语义差别在解析目标这一步：

```ts
export async function renameEntry(project: NovelProject, relPath: string): Promise<string | undefined> {
  return renameEntryImpl(project, relPath, true);
}

/**
 * 工程根范围的重命名（文件页用）。不再要求路径在三个管理区内，
 * 但固定目录受 isProtectedPath 保护；章节的序号前缀/H1 同步与草稿跟随
 * 在路径确实位于章节区时照常生效。
 */
export async function renameEntryInRoot(project: NovelProject, relPath: string): Promise<string | undefined> {
  return renameEntryImpl(project, relPath, false);
}

async function renameEntryImpl(
  project: NovelProject,
  relPath: string,
  requireSection: boolean
): Promise<string | undefined> {
  const target = requireSection
    ? await resolveTarget(project, relPath)
    : await resolveTargetInRoot(project, relPath);
  if (!target) {
    return undefined;
  }
  // ……原函数体原样保留，仅把两处 `info.section` 改为 `target.info?.section`：
  //   if (!isDir && target.info?.section === 'chapters' && isMarkdownPath(rel)) { …H1 同步… }
  //   if (target.info?.section === 'chapters') { await carryDraft(…); await project.syncManifest(); }
}
```

- [ ] **Step 4: 新增 resolveTargetInRoot**

放在 `resolveTarget` 旁边，结构对齐：

```ts
/** 根范围解析：路径合法、不是固定目录、存在即可（不要求在三区内）。 */
async function resolveTargetInRoot(project: NovelProject, relPath: string): Promise<ResolvedTarget | undefined> {
  const rel = normalizeRel(relPath);
  if (!rel) {
    log.warn(`操作被拒：路径不合法`, `原始输入 ${JSON.stringify(relPath)}`);
    getHost().toast('路径不合法。', 'error');
    return undefined;
  }
  if (isProtectedPath(project, rel)) {
    log.warn(`操作被拒：${rel} 是工程的固定目录`);
    getHost().toast(`「${rel}」是工程的固定目录，不能改名或搬走。`, 'error');
    return undefined;
  }
  const abs = project.pathOf(rel);
  let isDir: boolean;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    log.warn(`操作被拒：找不到 ${rel}（可能刚被改名或删除）`);
    getHost().toast(`找不到：${rel}`, 'error');
    return undefined;
  }
  // 区外路径 info 为 undefined：下游用 `target.info?.section` 守卫。
  const info = sectionOf(project, rel);
  return { abs, rel, info: info as SectionInfo, isDir };
}
```

注意 `ResolvedTarget.info` 类型是 `SectionInfo`；区外时为 `undefined`，`as SectionInfo` 之后所有读取处都经 `?.` 守卫（第 3 步已列明两处）。

- [ ] **Step 5: 回归验证**

Run: `npm run typecheck; node scripts/smoke-fileops.js`
Expected: typecheck PASS；smoke-fileops 全部通过（区内行为零变化）。

- [ ] **Step 6: Commit**

```powershell
git add src/core/fileOps.ts
git commit -m "refactor: fileOps 拆出根范围重命名变体并导出共用守卫"
```

---

### Task 3: smoke-projectFiles.js（先写失败测试）

**Files:**
- Create: `scripts/smoke-projectFiles.js`
- Modify: `package.json`（smoke 链）

- [ ] **Step 1: 写测试脚本**

结构与 `smoke-fileops.js` 同款（loadBundle + 假宿主 + 临时工程），完整内容：

```js
/**
 * 工程根范围类文件操作（文件页）的离线验证：重命名/移动/复制、
 * 固定目录保护、同名拒绝、垃圾箱豁免、章节联动。
 *
 * 用法：node scripts/smoke-projectFiles.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-projfiles-'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function loadBundle(entries) {
  const source = Object.entries(entries)
    .map(([name, relPath]) => `export * as ${name} from '${relPath.replace(/\\/g, '/')}';`)
    .join('\n');
  const result = esbuild.buildSync({
    stdin: { contents: source, resolveDir: ROOT, sourcefile: 'bundle.ts', loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
  });
  const m = new Module('bundle.ts', null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, 'bundle.ts'));
  return m.exports;
}

const bundle = loadBundle({
  host: './src/core/host.ts',
  project: './src/core/model/project.ts',
  fileOps: './src/core/fileOps.ts',
  projectFiles: './src/core/projectFiles.ts',
});

const hostMod = bundle.host;
const answers = [];
const toasts = [];
const fakeHost = {
  name: 'standalone',
  supportsVscodeLm: false,
  config: { read: () => ({}), write: async () => {} },
  input: async () => answers.shift(),
  confirm: async () => answers.shift(),
  pick: async () => answers.shift(),
  progress: async (_t, fn) => fn(new AbortController().signal, () => {}),
  watch: () => ({ dispose: () => {} }),
  openFile: async () => {},
  toast: (m, level) => toasts.push(`${level ?? 'info'}: ${m}`),
  selectionAttachment: async () => undefined,
};
hostMod.initHost(fakeHost);

function expect(...values) {
  answers.length = 0;
  toasts.length = 0;
  answers.push(...values);
}
function erred() {
  return toasts.some((t) => t.startsWith('error:'));
}

const projectMod = bundle.project;
const pf = bundle.projectFiles;

const rel = (...p) => path.join(WORK, ...p);
const write = (relPath, text) => {
  fs.mkdirSync(path.dirname(rel(relPath)), { recursive: true });
  fs.writeFileSync(rel(relPath), text, 'utf8');
};
const read = (relPath) => fs.readFileSync(rel(relPath), 'utf8');

async function main() {
  const project = projectMod.NovelProject.open(WORK);
  await project.initialize({ title: '文件页测试', author: '测试' });
  fs.rmSync(rel('.novelforge/characters/example-protagonist.md'), { force: true });
  fs.rmSync(rel('.novelforge/lore/example-setting.md'), { force: true });
  write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
  write('.novelforge/characters/林昭.md', '---\nname: 林昭\n---\n\n# 林昭\n');
  write('notes/备忘.txt', '随便记的。\n');
  project.invalidate();

  console.log('\n== 根范围重命名 ==');
  {
    // 区外文件（notes/）也能改名——这是文件页与工程页的本质区别。
    expect('备忘改名');
    let r = await pf.renameAny(project, 'notes/备忘.txt');
    check('区外文件可重命名', r.ok && r.to === 'notes/备忘改名.txt', JSON.stringify(r));

    // 章节仍保留序号前缀与 H1 同步。
    expect('新的标题');
    r = await pf.renameAny(project, 'chapters/001-楔子.md');
    check('章节保留序号前缀', r.ok && r.to === 'chapters/001-新的标题.md', JSON.stringify(r));
    check('章节 H1 同步', read('chapters/001-新的标题.md').startsWith('# 新的标题'));

    // 固定目录一律拒绝。
    for (const p of ['chapters', '.novelforge', 'drafts', '.novelforge/characters', '.novelforge/.trash']) {
      expect('随便');
      r = await pf.renameAny(project, p);
      check(`固定目录不能改名：${p}`, r.ok === false && erred());
    }

    expect('外面');
    r = await pf.renameAny(project, '../外面');
    check('越界路径拒绝', r.ok === false && erred());

    expect('不存在');
    r = await pf.renameAny(project, 'notes/幽灵.txt');
    check('不存在的路径拒绝', r.ok === false);
  }

  console.log('\n== 移动（剪切+粘贴） ==');
  {
    fs.mkdirSync(rel('archive'), { recursive: true });

    // 区外自由移动。
    let results = await pf.moveInto(project, ['notes/备忘改名.txt'], 'archive');
    check('区外文件可移动', results[0].ok && results[0].to === 'archive/备忘改名.txt', JSON.stringify(results));
    check('原位置已空', !fs.existsSync(rel('notes/备忘改名.txt')));

    // 多项粘贴：一项撞名，其余照常。
    write('archive/撞名.txt', '先来的。\n');
    write('notes/甲.txt', '甲。\n');
    write('notes/撞名.txt', '后来的。\n');
    project.invalidate();
    results = await pf.moveInto(project, ['notes/甲.txt', 'notes/撞名.txt'], 'archive');
    const okOne = results.find((x) => x.from === 'notes/甲.txt');
    const badOne = results.find((x) => x.from === 'notes/撞名.txt');
    check('撞名项拒绝且原因明确', badOne && !badOne.ok && badOne.error.includes('同名'), JSON.stringify(badOne));
    check('其余项不受影响', okOne && okOne.ok && okOne.to === 'archive/甲.txt', JSON.stringify(okOne));
    check('撞名时两份都还在',
      read('archive/撞名.txt').includes('先来的') && read('notes/撞名.txt').includes('后来的'));

    // 章节移进 chapters 子目录：manifest 与草稿跟着走。
    fs.mkdirSync(rel('chapters/卷一'), { recursive: true });
    fs.mkdirSync(rel('drafts'), { recursive: true });
    write('drafts/001-新的标题.md', '# 草稿\n');
    project.invalidate();
    results = await pf.moveInto(project, ['chapters/001-新的标题.md'], 'chapters/卷一');
    check('章节可移入子目录',
      results[0].ok && results[0].to === 'chapters/卷一/001-新的标题.md', JSON.stringify(results));
    check('草稿跟着搬', fs.existsSync(rel('drafts/卷一/001-新的标题.md')));
    project.invalidate();
    const manifest = await project.readManifest();
    check('manifest 记新路径',
      manifest.chapters.find((c) => c.order === 1).file === 'chapters/卷一/001-新的标题.md');

    // 章节移出 chapters/：允许，但草稿留在原处（日志会 warn，这里只验磁盘状态）。
    results = await pf.moveInto(project, ['chapters/卷一/001-新的标题.md'], 'archive');
    check('章节可移出 chapters', results[0].ok && results[0].to === 'archive/001-新的标题.md', JSON.stringify(results));
    check('草稿留在原处', fs.existsSync(rel('drafts/卷一/001-新的标题.md')));

    // 固定目录不能搬。
    results = await pf.moveInto(project, ['chapters'], 'archive');
    check('固定目录不能移动', results[0].ok === false, JSON.stringify(results));

    // 文件夹不能进自己的子孙。
    results = await pf.moveInto(project, ['archive'], 'archive');
    check('文件夹不能粘贴进自己', results[0].ok === false, JSON.stringify(results));

    // 垃圾箱里的东西不搬。
    write('.novelforge/.trash/notes/旧物.txt', '删掉的。\n');
    results = await pf.moveInto(project, ['.novelforge/.trash/notes/旧物.txt'], 'notes');
    check('回收站内容不能移动', results[0].ok === false, JSON.stringify(results));

    // 越界落点。
    results = await pf.moveInto(project, ['notes/甲.txt'], '../../外面');
    check('落点越界拒绝', results[0].ok === false && erred(), JSON.stringify(results));

    // 已在目标目录里。
    results = await pf.moveInto(project, ['archive/甲.txt'], 'archive');
    check('已在该目录时拒绝', results[0].ok === false, JSON.stringify(results));
  }

  console.log('\n== 复制（复制+粘贴） ==');
  {
    let results = await pf.copyInto(project, ['archive/撞名.txt'], 'notes');
    check('复制后原文件还在', results[0].ok && fs.existsSync(rel('archive/撞名.txt')), JSON.stringify(results));
    check('复制出同名新文件', read('notes/撞名.txt').includes('先来的'));

    // 落点目录必须已存在——粘贴不会凭空建目录。
    results = await pf.copyInto(project, ['archive'], 'backup');
    check('落点目录不存在时拒绝', results[0].ok === false, JSON.stringify(results));
    fs.mkdirSync(rel('backup'), { recursive: true });
    results = await pf.copyInto(project, ['archive'], 'backup');
    check('目录递归复制', results[0].ok && fs.existsSync(rel('backup/archive/甲.txt')), JSON.stringify(results));

    // 复制撞名同样拒绝。
    results = await pf.copyInto(project, ['notes/撞名.txt'], 'archive');
    check('复制撞名拒绝', results[0].ok === false && fs.existsSync(rel('archive/撞名.txt')), JSON.stringify(results));
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: 挂进 smoke 链**

`package.json` 的 `smoke` 脚本里，在 `node scripts/smoke-fileops.js &&` 之后插入 `node scripts/smoke-projectFiles.js && `。

- [ ] **Step 3: 跑测试，确认失败**

Run: `node scripts/smoke-projectFiles.js`
Expected: FAIL（esbuild 解析不到 `./src/core/projectFiles.ts`，模块尚不存在）

- [ ] **Step 4: Commit**

```powershell
git add scripts/smoke-projectFiles.js package.json
git commit -m "chore: 增加工程根范围文件操作的冒烟测试（暂失败）"
```

---

### Task 4: projectFiles.ts 实现

**Files:**
- Create: `src/core/projectFiles.ts`

- [ ] **Step 1: 写实现**

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { carryDraft, isProtectedPath, normalizeRel, renameEntryInRoot, sectionOf } from './fileOps';
import { getHost } from './host';
import { describeError, scoped } from './logger';
import { NovelProject, exists } from './model/project';
import { FileOpResult } from './protocol';

const log = scoped('文件页');

/**
 * 文件页（资源管理器）的类文件操作：工程根范围的重命名、移动、复制。
 *
 * 与 fileOps.ts 的分工：那边锁在章节/角色/设定三个区里，是工程页的产品
 * 承诺；这边面向整个工程根（含 `.novelforge/`），是文件页的磁盘视角。
 * 相同的约束仍然在：
 *
 * 1. **不出工程根**：`..` 逃逸与绝对路径一律拒绝。
 * 2. **不静默覆盖**：目标同名逐项拒绝，其余项继续。
 * 3. **固定目录不动**：chapters/、drafts/、.novelforge 及其关键子目录受保护。
 * 4. **垃圾箱不搬**：`.novelforge/.trash/` 里的内容不是操作对象。
 *
 * 章节联动：源在 chapters/ 下的移动带草稿跟随与 manifest 同步；
 * 章节被移出 chapters/ 时草稿留在原镜像路径，只记日志提醒。
 */

/** 工程根范围的重命名。逐项结果的形状与 move/copy 对齐。 */
export async function renameAny(project: NovelProject, relPath: string): Promise<FileOpResult> {
  const from = normalizeRel(relPath) ?? relPath;
  const to = await renameEntryInRoot(project, relPath);
  return to ? { from, to, ok: true } : { from, ok: false };
}

/** 粘贴（剪切变体）：把若干文件/目录移动到目标目录。 */
export async function moveInto(
  project: NovelProject,
  sources: string[],
  targetDir: string
): Promise<FileOpResult[]> {
  return pasteAll(project, sources, targetDir, false);
}

/** 粘贴（复制变体）：把若干文件/目录递归复制到目标目录。 */
export async function copyInto(
  project: NovelProject,
  sources: string[],
  targetDir: string
): Promise<FileOpResult[]> {
  return pasteAll(project, sources, targetDir, true);
}

async function pasteAll(
  project: NovelProject,
  sources: string[],
  targetDir: string,
  copy: boolean
): Promise<FileOpResult[]> {
  // 空串落点 = 工程根目录；normalizeRel 不收空串，单独放行。
  const dest = targetDir.trim() === '' ? '' : normalizeRel(targetDir);
  if (dest === undefined) {
    log.warn(`粘贴被拒：目标目录不合法`, `原始输入 ${JSON.stringify(targetDir)}`);
    getHost().toast('目标目录不合法。', 'error');
    return sources.map((from) => ({ from, ok: false, error: '目标目录不合法' }));
  }
  const destAbs = dest === '' ? project.root : project.pathOf(dest);
  let destIsDir = false;
  try {
    destIsDir = (await fs.stat(destAbs)).isDirectory();
  } catch {
    destIsDir = false;
  }
  if (!destIsDir) {
    log.warn(`粘贴被拒：目标目录不存在 ${dest || '（工程根）'}`);
    getHost().toast(`目标目录不存在：${dest || '（工程根）'}`, 'error');
    return sources.map((from) => ({ from, ok: false, error: '目标目录不存在' }));
  }

  const results: FileOpResult[] = [];
  let chaptersTouched = false;
  for (const source of sources) {
    const r = await pasteOne(project, source, dest, copy);
    if (r.ok && sectionOf(project, r.from)?.section === 'chapters') {
      chaptersTouched = true;
    }
    results.push(r);
  }

  // 移动章节改了路径；复制进 chapters/ 的可能带来新章节。两种都重算 manifest。
  const chaptersRoot = project.relPath(project.chaptersDir);
  if (chaptersTouched || (copy && (dest === chaptersRoot || dest.startsWith(`${chaptersRoot}/`)))) {
    await project.syncManifest();
  }
  project.invalidate();

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    getHost().toast(`${failed.length} 项未${copy ? '复制' : '移动'}：${failed[0].error}`, 'error');
  } else {
    log.info(
      `${copy ? '已复制' : '已移动'} ${results.length} 项`,
      `落点 ${dest === '' ? '（工程根）' : dest}`
    );
    getHost().toast(`已${copy ? '复制' : '移动'} ${results.length} 项到 ${dest === '' ? '工程根目录' : dest}。`);
  }
  return results;
}

async function pasteOne(
  project: NovelProject,
  relPath: string,
  dest: string,
  copy: boolean
): Promise<FileOpResult> {
  const rel = normalizeRel(relPath);
  if (!rel) {
    log.warn(`粘贴被拒：路径不合法`, `原始输入 ${JSON.stringify(relPath)}`);
    return { from: relPath, ok: false, error: '路径不合法' };
  }
  if (isProtectedPath(project, rel)) {
    log.warn(`粘贴被拒：${rel} 是工程的固定目录`);
    return { from: rel, ok: false, error: `「${rel}」是固定目录` };
  }
  if (rel === '.novelforge/.trash' || rel.startsWith('.novelforge/.trash/')) {
    log.warn(`粘贴被拒：${rel} 在回收站里`);
    return { from: rel, ok: false, error: '回收站里的内容不能操作' };
  }

  const abs = project.pathOf(rel);
  let isDir: boolean;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    log.warn(`粘贴被拒：找不到 ${rel}`);
    return { from: rel, ok: false, error: `找不到 ${rel}` };
  }

  const name = path.basename(rel);
  const nextRel = dest === '' ? name : `${dest}/${name}`;
  if (nextRel === rel) {
    return { from: rel, ok: false, error: '已经在这个目录里' };
  }
  // 目录不能搬进自己的子孙——那会把子树从文件系统上摘下来。
  if (isDir && (dest === rel || dest.startsWith(`${rel}/`))) {
    log.warn(`粘贴被拒：不能把文件夹放进自己里面`, `${rel} → ${dest}`);
    return { from: rel, ok: false, error: '不能放进它自己里面' };
  }
  const nextAbs = project.pathOf(nextRel);
  if (await exists(nextAbs)) {
    log.warn(`粘贴被拒：目标已有同名项 ${nextRel}`);
    return { from: rel, ok: false, error: `目标已有同名项 ${nextRel}` };
  }

  try {
    if (copy) {
      await fs.cp(abs, nextAbs, { recursive: true });
    } else {
      await fs.rename(abs, nextAbs);
    }
  } catch (err) {
    log.warn(`粘贴失败：${rel} → ${nextRel}`, describeError(err));
    return { from: rel, ok: false, error: describeError(err) };
  }

  if (!copy && sectionOf(project, rel)?.section === 'chapters') {
    // 章节移动：草稿跟随。移出 chapters/ 时新镜像路径推导不出，草稿留在原处。
    const toDraft = project.draftRelPathFor(nextRel);
    if (toDraft) {
      await carryDraft(project, rel, nextRel, isDir);
    } else {
      const fromDraft = project.draftRelPathFor(rel);
      if (fromDraft && (await exists(project.pathOf(fromDraft)))) {
        log.warn(`章节被移出 chapters/，草稿留在原处`, `草稿仍在 ${fromDraft}`);
      }
    }
  }

  log.info(`${copy ? '已复制' : '已移动'}${isDir ? '文件夹' : ''}`, `${rel} → ${nextRel}`);
  return { from: rel, to: nextRel, ok: true };
}
```

注意：`describeError` 从 `./logger` 导出（progress.ts 已在用）。实现前先确认该导出存在；若不存在改用 `(err as Error)?.message ?? String(err)`。

- [ ] **Step 2: 跑测试确认通过**

Run: `node scripts/smoke-projectFiles.js`
Expected: 全部通过

- [ ] **Step 3: 回归**

Run: `npm run typecheck; node scripts/smoke-fileops.js; node scripts/check-core-purity.js`
Expected: 全部 PASS（projectFiles.ts 无 vscode 依赖）

- [ ] **Step 4: Commit**

```powershell
git add src/core/projectFiles.ts
git commit -m "feat: 文件页的工程根范围重命名/移动/复制"
```

---

### Task 5: controller 接线（fileAction）

**Files:**
- Modify: `src/core/controller.ts`

- [ ] **Step 1: 补 import**

controller.ts 顶部已 import fileOps 的三个函数，追加 projectFiles：

```ts
import { copyInto, moveInto, renameAny } from './projectFiles';
```

并在 protocol 的 import 列表里加上 `FileOpResult` 类型。

- [ ] **Step 2: 改消息分发**

消息 switch 里（约第 294 行）：

```ts
      case 'fileAction':
        await this.fileAction(msg);
        return;
```

- [ ] **Step 3: 重写 fileAction 方法**

整个替换现有 `private async fileAction(...)`（约第 919-933 行）：

```ts
  /**
   * 类文件操作。工程页的 rename/move/delete 走 core/fileOps（三区锁定），
   * 文件页的 renameAny/paste 走 core/projectFiles（根范围）。
   * 有逐项结果的动作额外推 filesOpDone，前端据此 remap 编辑器标签。
   */
  private async fileAction(msg: Extract<InMessage, { type: 'fileAction' }>): Promise<void> {
    const { action, relPath, relPaths, op, targetDir } = msg;
    log.info(
      `文件动作：${action}`,
      [relPath ?? '', relPaths ? relPaths.join('、') : '', targetDir !== undefined ? `目标目录 ${targetDir || '（根）'}` : '']
        .filter(Boolean)
        .join('｜') || undefined
    );
    let results: FileOpResult[] | undefined;
    switch (action) {
      case 'rename':
        if (relPath) {
          await renameEntry(this.project, relPath);
        }
        break;
      case 'renameAny':
        if (relPath) {
          results = [await renameAny(this.project, relPath)];
        }
        break;
      case 'move':
        if (relPath) {
          await moveEntry(this.project, relPath, targetDir);
        }
        break;
      case 'delete':
        if (relPath) {
          await deleteEntry(this.project, relPath);
        }
        break;
      case 'paste':
        results =
          op === 'copy'
            ? await copyInto(this.project, relPaths ?? [], targetDir ?? '')
            : await moveInto(this.project, relPaths ?? [], targetDir ?? '');
        break;
    }
    if (results && results.length > 0) {
      this.post({
        type: 'filesOpDone',
        op: action === 'renameAny' ? 'rename' : op === 'copy' ? 'copy' : 'move',
        results,
      });
    }
    await this.pushState();
  }
```

- [ ] **Step 4: 验证**

Run: `npm run typecheck; node scripts/smoke-fileops.js; node scripts/smoke-projectFiles.js`
Expected: PASS（smoke 不经过 controller，这里主要保编译与既有行为）

- [ ] **Step 5: Commit**

```powershell
git add src/core/controller.ts
git commit -m "feat: controller 接线文件页粘贴与根范围重命名"
```

---

### Task 6: characterCard.ts 抽出单卡执行体（等价重构）

**Files:**
- Modify: `src/core/features/characterCard.ts`

批量编排要逐卡复用「分批分析 → 写回」的执行体，但不能嵌套两层 runTask（进度条会叠）。把现 `runUpdate` 里 runTask 内部的循环体抽成 `runCardUpdate`，单卡流程行为**一字不差**（smoke-characterCard.js 是守门员）。

- [ ] **Step 1: 导出批类型、抽执行体**

1. `interface Batch` 改为 `export interface Batch`（批量计划要引用）。

2. 新增结果类型与执行体。把原 `runUpdate` 中 `await runTask(...)` 回调里从 `const startedAt` 到结尾的全部逻辑搬进 `runCardUpdate`，并做三处参数化：

```ts
/** 单卡执行的结果。batch 编排据此统计。 */
export interface CardUpdateOutcome {
  status: 'updated' | 'discarded' | 'failed' | 'cancelled';
  /** status 为 updated 时给出推进后的水位线。 */
  updatedThrough?: number;
}

/**
 * 单张卡的执行体：分批分析 → 合并 → 审阅/写回。
 * 不自己开 runTask，进度经 ctx.report 交给外层（单卡与批量共用一条进度条）。
 * `batches` 由外层算好传入——批量场景在总确认前已算过一次，不必重读章节。
 */
async function runCardUpdate(
  project: NovelProject,
  card: CharacterCard,
  chapters: Chapter[],
  opts: {
    scope: UpdateScope;
    allAppearances: number[];
    batches: Batch[];
    skipReview?: boolean;
  },
  ctx: {
    signal: AbortSignal;
    report: (message: string, current?: number, total?: number) => void;
  }
): Promise<CardUpdateOutcome> {
  const startedAt = Date.now();
  const steps = opts.batches.length + 1;
  let sections: CharacterSections = { ...card.sections };
  let aliases = [...card.aliases];
  let tags = [...card.tags];
  const analyzed: number[] = [];
  const failed: number[] = [];

  for (let i = 0; i < opts.batches.length; i++) {
    if (ctx.signal.aborted) {
      log.warn(`更新被取消，已完成 ${i}/${opts.batches.length} 批`);
      return { status: 'cancelled' };
    }
    // 原 for 循环体从这里起逐行搬入，只改两处：
    //   report({ message, current: i, total: steps })  →  ctx.report(`分析 ${range}`, i, steps)
    //   其余（analyzeBatch、失败降级、analyzed/failed 记录、逐批日志）原样。
  }

  if (ctx.signal.aborted) {
    log.warn('更新被取消（写入前）');
    return { status: 'cancelled' };
  }

  if (analyzed.length === 0) {
    // 原「全部失败」分支逐行搬入（log.error + toast 文案不变），末尾改为：
    return { status: 'failed' };
  }

  ctx.report('写入角色卡', opts.batches.length, steps);
  // 原 appearances / firstFailure / updatedThrough / merged 计算逐行搬入，不改。

  const abs = project.pathOf(card.relPath);
  const proposedText = renderCharacterCard(merged);
  if (opts.skipReview) {
    await writeText(abs, proposedText);
    log.info(`已写入角色卡「${card.name}」`, `${card.relPath}｜总耗时 ${elapsed(startedAt)}`);
  } else {
    const applied = await review(project, card, proposedText);
    if (!applied) {
      ctx.report('已放弃', steps, steps);
      return { status: 'discarded' };
    }
    log.info(
      `已更新角色卡「${card.name}」`,
      `${card.relPath}｜覆盖至第 ${merged.updatedThrough} 章｜总耗时 ${elapsed(startedAt)}`
    );
  }
  ctx.report('完成', steps, steps);
  return { status: 'updated', updatedThrough: merged.updatedThrough };
}
```

搬迁要点（原逻辑逐条保留）：
- 水位线只推进到第一个失败章节之前（原注释保留）；
- 单批解析失败不放弃整次更新（原注释保留）；
- `report({ message, current, total })` 全部改写为 `ctx.report(message, current, total)`。

3. `runUpdate` 改为薄编排：

```ts
async function runUpdate(
  project: NovelProject,
  card: CharacterCard,
  chapters: Chapter[],
  opts: { scope: UpdateScope; allAppearances: number[]; skipReview?: boolean }
): Promise<void> {
  const provider = await resolveProvider();
  if (!provider) {
    log.error('没有可用的模型，更新中止');
    return;
  }
  const config = readConfig();
  const batches = await planBatches(project, chapters, config);
  if (batches.length === 0) {
    log.warn(`「${card.name}」的出场章节都是空的`);
    getHost().toast('这些章节都是空的，没有可分析的内容。', 'error');
    return;
  }

  // ……原 willRead/skipped 统计与「预计调用模型 N 次」的 confirm 原样保留……

  log.info(
    `开始${scopeLabel}「${card.name}」`,
    `${willRead} 章分 ${batches.length} 批｜章节 ${describeChapters(
      batches.flatMap((b) => b.chapters.map((c) => c.order))
    )}｜模型 ${provider.label}`
  );

  await runTask(
    `更新角色卡「${card.name}」`,
    async ({ signal, report }) => {
      const outcome = await runCardUpdate(
        project,
        card,
        chapters,
        { scope: opts.scope, allAppearances: opts.allAppearances, batches, skipReview: opts.skipReview },
        {
          signal,
          report: (message, current, total) => report({ message, current, total }),
        }
      );
      if (outcome.status === 'updated') {
        getHost().toast(`「${card.name}」已更新，覆盖至第 ${outcome.updatedThrough} 章。`);
        await getHost().openFile(card.relPath);
      }
    },
    { scope: '角色卡' }
  );
}
```

- [ ] **Step 2: 回归**

Run: `npm run typecheck; node scripts/smoke-characterCard.js`
Expected: 全部通过（行为等价）。

- [ ] **Step 3: Commit**

```powershell
git add src/core/features/characterCard.ts
git commit -m "refactor: 角色卡更新抽出单卡执行体供批量复用"
```

---

### Task 7: smoke-characterCard.js 批量断言（先写失败测试）

**Files:**
- Modify: `scripts/smoke-characterCard.js`

- [ ] **Step 1: 假宿主记录 openFile**

在 fakeHost 定义之前加 `const opened = [];`，把 `openFile: async () => {},` 改为：

```js
  openFile: async (p) => opened.push(p),
```

`expect(...)` 里追加 `opened.length = 0;`。并在「分批与『预计调用次数』」小节末尾追加一条现有行为断言：

```js
    check('单卡更新后自动打开该卡', opened.includes('.novelforge/characters/林昭.md'), JSON.stringify(opened));
```

- [ ] **Step 2: 新增批量小节**

在 `main()` 的最后一个小节之后、统计输出之前插入。此时夹具状态：林昭（updatedThrough 6，第 7、8 章是新出场）、幽灵（摘要里没出现）、客栈掌柜（updatedThrough 3，无新章）：

```js
  console.log('\n== 批量更新所有角色卡 ==');
  {
    // ---- 增量：只挑有新出场的卡，动手前报总调用次数。
    project.invalidate();
    expect('逐张确认后开始');
    replies = [cardJson({ 当前状态: '批量测试中' })];
    await cardMod.updateAllCharacterCards(project, 'incremental');

    const ask = confirms.find((c) => c.message.includes('预计调用模型'));
    check('批量动手前问过用户', !!ask, JSON.stringify(confirms.map((c) => c.message)));
    check('确认框给出两种采纳方式',
      ask && ask.actions.includes('逐张确认后开始') && ask.actions.includes('全部直接采纳并开始'),
      ask && JSON.stringify(ask.actions));
    check('预计调用次数与实际一致',
      ask && ask.message.includes(`预计调用模型 ${calls.length} 次`), ask && ask.message);
    check('跳过情况写进明细',
      ask && ask.detail.includes('幽灵') && ask.detail.includes('客栈掌柜'), ask && ask.detail);

    const corpus = calls.map((m) => m[1].content).join('\n');
    check('增量批量只读新出场的章节', corpus.includes('第七') && !corpus.includes('楔子'), corpus.slice(0, 120));
    check('逐张确认模式走了 diff 审阅', reviewed.length === 1, String(reviewed.length));
    check('批量不自动打开卡', opened.length === 0, JSON.stringify(opened));
    check('林昭的卡已更新', read('.novelforge/characters/林昭.md').includes('批量测试中'));

    // ---- 从头重建：全部有出场的卡全量重读，可整体直接采纳。
    expect('全部直接采纳并开始');
    replies = [cardJson({ 身份: '重建的身份' })];
    await cardMod.updateAllCharacterCards(project, 'full');

    const fullCorpus = calls.map((m) => m[1].content).join('\n');
    check('重建读全部出场章节', fullCorpus.includes('楔子') && fullCorpus.includes('夜谈'));
    check('直接采纳模式不走审阅', reviewed.length === 0, String(reviewed.length));
    check('两张卡都已重写',
      read('.novelforge/characters/林昭.md').includes('重建的身份') &&
      read('.novelforge/characters/客栈掌柜.md').includes('重建的身份'));
    check('完成提示报数', toasts.some((t) => t.includes('已更新 2 张')), toasts.join(' | '));

    // ---- 取消：一次模型都不调。
    expect(undefined);
    replies = [cardJson()];
    await cardMod.updateAllCharacterCards(project, 'full');
    check('用户取消则不调模型', calls.length === 0, String(calls.length));

    // ---- 无可更新：不弹确认框，直接说明。
    expect();
    await cardMod.updateAllCharacterCards(project, 'incremental');
    check('没有新章节时不弹确认框', confirms.length === 0, JSON.stringify(confirms.map((c) => c.message)));
    check('没有新章节时明说', toasts.some((t) => t.includes('没有需要更新的角色卡')), toasts.join(' | '));
  }
```

注意最后一条「无可更新」依赖前两步已把所有卡的 updatedThrough 推到最新；若执行顺序调整需同步调整该依赖。

- [ ] **Step 3: 跑测试，确认失败**

Run: `node scripts/smoke-characterCard.js`
Expected: FAIL（`updateAllCharacterCards` 尚不存在）

- [ ] **Step 4: Commit**

```powershell
git add scripts/smoke-characterCard.js
git commit -m "chore: 批量角色卡更新的冒烟断言（暂失败）"
```

---

### Task 8: characterCard.ts 批量计划与编排

**Files:**
- Modify: `src/core/features/characterCard.ts`

- [ ] **Step 1: 批量计划（纯函数化，可测）**

放在 `updateCharacterCard` 之后：

```ts
/** 批量计划里的一张卡。 */
export interface CardUpdatePlan {
  card: CharacterCard;
  /** 本次要读的出场章节序号。 */
  orders: number[];
  /** 预先算好的分批（总确认报调用次数用，执行时不重算）。 */
  batches: Batch[];
  /** 真正参与分析的章节数（空章节已剔除）。 */
  chapters: number;
}

export interface BatchUpdatePlan {
  plans: CardUpdatePlan[];
  skipped: { card: CharacterCard; reason: string }[];
}

/**
 * 批量计划：列出全部角色卡，逐卡算出要读哪些章、分几批。
 * 增量模式只取 updatedThrough 之后的新出场；无新出场/未在摘要出现/
 * 出场章节已不在磁盘/正文全空的卡计入 skipped。导出供总确认与冒烟测试。
 */
export async function planAllUpdates(project: NovelProject, scope: UpdateScope): Promise<BatchUpdatePlan> {
  const cards = await project.listCharacters();
  const index = await buildCastIndex(project);
  const config = readConfig();
  const allChapters = await project.listChapters();
  const result: BatchUpdatePlan = { plans: [], skipped: [] };

  for (const card of cards) {
    const all = appearancesOf(index, card);
    if (all.length === 0) {
      result.skipped.push({ card, reason: '未在摘要中出现' });
      continue;
    }
    const orders = scope === 'incremental' ? all.filter((o) => o > (card.updatedThrough ?? 0)) : all;
    if (orders.length === 0) {
      result.skipped.push({ card, reason: '没有新的出场章节' });
      continue;
    }
    const chapters = allChapters.filter((c) => orders.includes(c.order));
    if (chapters.length === 0) {
      result.skipped.push({ card, reason: '出场章节已不在磁盘上' });
      continue;
    }
    const batches = await planBatches(project, chapters, config);
    if (batches.length === 0) {
      result.skipped.push({ card, reason: '章节正文都为空' });
      continue;
    }
    result.plans.push({
      card,
      orders,
      batches,
      chapters: batches.reduce((sum, b) => sum + b.chapters.length, 0),
    });
  }
  return result;
}
```

- [ ] **Step 2: 批量编排**

紧接其后：

```ts
/**
 * 批量更新全部角色卡——工程页「角色」分组的右键动作。
 * incremental：每卡只读上次更新后的新出场章节；full：每卡全量重读。
 *
 * 「不偷偷烧 token」：总确认框先报清卡数、章数、批数（= 预计调用次数），
 * 并让用户选采纳方式（逐张 diff 确认 / 全部直接采纳）。
 */
export async function updateAllCharacterCards(project: NovelProject, scope: UpdateScope): Promise<void> {
  const provider = await resolveProvider();
  if (!provider) {
    log.error('没有可用的模型，批量更新中止');
    return;
  }
  const { plans, skipped } = await planAllUpdates(project, scope);
  if (plans.length === 0) {
    log.info('没有需要更新的角色卡', skipped.length > 0 ? `跳过 ${skipped.length} 张` : undefined);
    getHost().toast(
      `没有需要更新的角色卡${skipped.length > 0 ? `（${skipped.length} 张被跳过）` : ''}。`
    );
    return;
  }

  const totalBatches = plans.reduce((sum, p) => sum + p.batches.length, 0);
  const totalChapters = plans.reduce((sum, p) => sum + p.chapters, 0);
  const label = scope === 'incremental' ? '更新' : '从头重建';
  const pick = await getHost().confirm(
    `${label} ${plans.length} 张角色卡：共需通读 ${totalChapters} 章，` +
      `分 ${totalBatches} 批，预计调用模型 ${totalBatches} 次。现在开始？`,
    ['逐张确认后开始', '全部直接采纳并开始'],
    {
      modal: true,
      detail:
        skipped.length > 0
          ? `跳过 ${skipped.length} 张：${skipped.map((s) => `「${s.card.name}」（${s.reason}）`).join('、')}`
          : undefined,
    }
  );
  if (!pick) {
    log.info('用户取消了批量更新');
    return;
  }
  const autoApply = pick === '全部直接采纳并开始';

  log.info(
    `开始批量${label}角色卡`,
    `${plans.length} 张｜${totalChapters} 章分 ${totalBatches} 批｜模型 ${provider.label}｜` +
      (autoApply ? '全部直接采纳' : '逐张确认')
  );

  await runTask(
    `批量${label}角色卡`,
    async ({ signal, report }) => {
      // 每张卡的步数（批数 + 写入那一步），累加成总进度条的分母。
      const totalSteps = plans.reduce((sum, p) => sum + p.batches.length + 1, 0);
      let done = 0;
      let updated = 0;
      let failed = 0;
      let discarded = 0;

      for (let i = 0; i < plans.length; i++) {
        if (signal.aborted) {
          break;
        }
        const plan = plans[i];
        // 计划是确认前算的，章节可能刚被改名/删除——以当前磁盘为准再过滤一次。
        const chapters = (await project.listChapters()).filter((c) => plan.orders.includes(c.order));
        const outcome = await runCardUpdate(
          project,
          plan.card,
          chapters,
          { scope, allAppearances: plan.orders, batches: plan.batches, skipReview: autoApply },
          {
            signal,
            report: (message, current) =>
              report({
                message: `第 ${i + 1}/${plans.length} 张「${plan.card.name}」· ${message}`,
                current: done + (current ?? 0),
                total: totalSteps,
              }),
          }
        );
        done += plan.batches.length + 1;
        if (outcome.status === 'updated') updated++;
        else if (outcome.status === 'failed') failed++;
        else if (outcome.status === 'discarded') discarded++;
        else if (outcome.status === 'cancelled') break;
      }

      report({ message: '完成', current: totalSteps, total: totalSteps });
      const summary =
        `已更新 ${updated} 张` +
        (discarded > 0 ? `，放弃 ${discarded} 张` : '') +
        (failed > 0 ? `，失败 ${failed} 张` : '') +
        (skipped.length > 0 ? `，跳过 ${skipped.length} 张` : '');
      log.info(`批量${label}角色卡结束`, summary);
      getHost().toast(`角色卡${label}完成：${summary}。`);
    },
    { scope: '角色卡' }
  );
}
```

注意：批量结束**不**调用 `openFile`（区别于单卡流程，避免连开几十个标签），路径已进日志。

- [ ] **Step 3: 跑测试确认通过**

Run: `node scripts/smoke-characterCard.js`
Expected: 全部通过（含新小节与既有小节）。

- [ ] **Step 4: Commit**

```powershell
git add src/core/features/characterCard.ts
git commit -m "feat: 批量更新/从头重建所有角色卡"
```

---

### Task 9: controller 接线 + 工程页「角色」分组菜单

**Files:**
- Modify: `src/core/controller.ts`
- Modify: `media/view.js`
- Modify: `scripts/smoke-view.js`

- [ ] **Step 1: controller 补两个 case**

`characterAction` 方法的 switch 里（约第 941 行），import 先补 `updateAllCharacterCards`（来自 `./features/characterCard`），再加：

```ts
      case 'updateAllCards':
        await updateAllCharacterCards(this.project, 'incremental');
        break;
      case 'rebuildAllCards':
        await updateAllCharacterCards(this.project, 'full');
        break;
```

- [ ] **Step 2: view.js 的 buildGroup 支持附加菜单项**

`buildGroup` 里的菜单登记（约第 1387-1394 行）改为：

```js
    if (opts.section) {
      // 登记在整个分组上：标题栏、分组内的空白、空提示行都能右键新建。
      onContextMenu(box, () => [
        ...(opts.extraItems ? opts.extraItems() : []),
        ...newItemsIn(opts.section, opts.root),
        { sep: true },
        ...baseMenuItems(),
      ]);
    }
```

- [ ] **Step 3: 角色分组挂上两个批量项**

`renderProject` 里构建角色分组处（约第 1147 行）：

```js
    el.projectBody.appendChild(
      buildGroup('characters', '角色', countLabel(tree.characters, '人'), {
        section: SECTIONS.characters,
        root: tree.charactersRoot,
        extraItems: () => [
          { label: '更新所有角色卡', run: () => characterAction('updateAllCards') },
          { label: '从头重建所有角色卡', run: () => characterAction('rebuildAllCards') },
          { sep: true },
        ],
        build: () =>
          tree.characters.length === 0
            ? [emptyRow('还没有角色卡。可运行「提取/更新角色卡」从正文抽取。')]
            : renderNodes(tree.characters, 0, SECTIONS.characters, tree),
      })
    );
```

`characterAction` 帮助函数（约第 1098 行）把 name 兜底为空串，批量动作不必传名字：

```js
  function characterAction(action, name, relPath) {
    vscode.postMessage({ type: 'characterAction', action, name: name ?? '', relPath });
  }
```

- [ ] **Step 4: smoke-view.js 断言**

在「工程页的右键菜单」小节末尾（`closeAnyMenu(ui);` 之前）插入：

```js
  // ---- 角色分组：批量更新/重建。
  const charHead = [...ui.doc.querySelectorAll('#projectBody .group-head')]
    .find((n) => n.querySelector('.group-name').textContent === '角色');
  const charItems = itemsOf(rightClick(charHead));
  check('角色分组菜单含批量项',
    charItems.includes('更新所有角色卡') && charItems.includes('从头重建所有角色卡'),
    JSON.stringify(charItems));
  check('角色分组菜单仍含新建项', charItems.includes('在此新建角色卡'), JSON.stringify(charItems));
  pick(rightClick(charHead), '更新所有角色卡');
  const upAll = last('characterAction');
  check('「更新所有角色卡」发 updateAllCards',
    upAll && upAll.action === 'updateAllCards', JSON.stringify(upAll));
  pick(rightClick(charHead), '从头重建所有角色卡');
  const reAll = last('characterAction');
  check('「从头重建」发 rebuildAllCards',
    reAll && reAll.action === 'rebuildAllCards', JSON.stringify(reAll));
```

- [ ] **Step 5: 验证**

Run: `npm run typecheck; node scripts/smoke-view.js`
Expected: 全部通过

- [ ] **Step 6: Commit**

```powershell
git add src/core/controller.ts media/view.js scripts/smoke-view.js
git commit -m "feat: 工程页角色分组增加批量更新/重建入口"
```

---

### Task 10: explorer.js 剪贴板、菜单、快捷键与联动

**Files:**
- Modify: `media/explorer.js`
- Modify: `media/standalone.css`
- Modify: `scripts/smoke-view.js`

- [ ] **Step 1: explorer.js 剪贴板状态与工具函数**

在 `let activeFile = null;` 之后插入：

```js
  /**
   * 文件剪贴板：剪切/复制只是登记，真正的磁盘动作只有「粘贴」一次。
   * 同时把相对路径以纯文本写进系统剪贴板（仅外送，不读回）——
   * 在别处粘贴得到的是路径字符串。
   */
  let clipboard = null; // { op: 'cut' | 'copy', paths: string[] }

  /** 当前选中行（点击或键盘焦点到达的行）。Ctrl+X/C/V 作用在它上面。 */
  let selectedEntry = null;

  function parentOf(relPath) {
    const i = relPath.lastIndexOf('/');
    return i === -1 ? '' : relPath.slice(0, i);
  }

  function setClipboard(op, paths) {
    clipboard = { op, paths };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(paths.join('\n')).catch(() => {});
    }
    toast(`${op === 'cut' ? '已剪切' : '已复制'} ${paths.length} 项`);
    render();
  }

  function pasteInto(destDir) {
    if (!clipboard) return;
    vscode.postMessage({
      type: 'fileAction',
      action: 'paste',
      op: clipboard.op,
      relPaths: clipboard.paths,
      targetDir: destDir,
    });
  }

  /** 剪切/复制/粘贴/重命名四项。文件与文件夹行共用。 */
  function clipboardItems(entry) {
    const dest = entry.kind === 'dir' ? entry.relPath : parentOf(entry.relPath);
    return [
      { label: '剪切', run: () => setClipboard('cut', [entry.relPath]) },
      { label: '复制', run: () => setClipboard('copy', [entry.relPath]) },
      { label: '粘贴', disabled: !clipboard, run: () => pasteInto(dest) },
      {
        label: '重命名',
        run: () => vscode.postMessage({ type: 'fileAction', action: 'renameAny', relPath: entry.relPath }),
      },
      { sep: true },
    ];
  }
```

- [ ] **Step 2: 行渲染挂钩**

`baseRow(depth)` 末尾（return 之前）加焦点支持：

```js
    row.tabIndex = 0;
    return row;
```

（原来的 `return row;` 保留在它后面。）

`dirRow` 与 `fileRow` 里各加两处：

```js
    // 剪切源压暗，与 VS Code 一致。
    if (clipboard && clipboard.op === 'cut' && clipboard.paths.includes(entry.relPath)) {
      row.classList.add('fx-cut');
    }
    row.addEventListener('focus', () => { selectedEntry = entry; });
```

并把两个函数里现有 `onContextMenu(row, () => [` 的菜单数组前面拼上 `...clipboardItems(entry),`——即文件行菜单变为：

```js
    onContextMenu(row, () => [
      ...clipboardItems(entry),
      {
        label: entry.editable ? '打开' : '打开（外部程序）',
        run: () => openEntry(entry),
      },
      { label: '在系统中打开', run: () => vscode.postMessage({ type: 'openExternal', path: entry.relPath }) },
      { sep: true },
      { label: '复制相对路径', run: () => copyPath(entry.relPath) },
    ]);
```

目录行同理（`clipboardItems(entry),` 之后接原有的 折叠/展开、在系统中打开、复制相对路径）。

两处 `row.addEventListener('click', ...)` 改为先记选中再执行原逻辑：

```js
    row.addEventListener('click', () => {
      selectedEntry = entry;
      toggleDir(entry.relPath); // 目录行；文件行是 openEntry(entry)
    });
```

- [ ] **Step 3: 空白处右键可粘贴到工程根**

在「工具栏」小节之前插入：

```js
  // 树里的空白处（没命中任何行）：给一条粘贴到工程根。
  onContextMenu(body, () => [
    { label: '粘贴到工程根目录', disabled: !clipboard, run: () => pasteInto('') },
    { sep: true },
    {
      label: '刷新',
      run: () => {
        for (const dir of openDirs) pending.add(dir);
        requestDirs();
      },
    },
  ]);
```

- [ ] **Step 4: Ctrl+X/C/V**

同处继续插入：

```js
  // 快捷键只认「文件」页激活且树里有选中行——编辑器里的文本
  // Ctrl+C/V 走不到这里（焦点不在树上），互不干扰。
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !selectedEntry) return;
    const pane = document.getElementById('pane-files');
    if (!pane || !pane.classList.contains('active')) return;
    const key = e.key.toLowerCase();
    if (key === 'c') {
      e.preventDefault();
      setClipboard('copy', [selectedEntry.relPath]);
    } else if (key === 'x') {
      e.preventDefault();
      setClipboard('cut', [selectedEntry.relPath]);
    } else if (key === 'v') {
      e.preventDefault();
      const dest = selectedEntry.kind === 'dir' ? selectedEntry.relPath : parentOf(selectedEntry.relPath);
      pasteInto(dest);
    }
  });
```

- [ ] **Step 5: 收 filesOpDone、广播搬家事件**

`window.addEventListener('message', ...)` 里 `dirListings` 分支之后加：

```js
    // 文件操作完成：剪切态清除（仅 move 成功时），改名/搬家的结果广播给
    // 编辑器 remap 标签。复制态保留——可以在别处再粘一次。
    if (msg.type === 'filesOpDone') {
      if (msg.op === 'move' && clipboard && clipboard.op === 'cut') clipboard = null;
      for (const r of msg.results) {
        if (r.ok && r.to && (msg.op === 'rename' || msg.op === 'move')) {
          window.dispatchEvent(new CustomEvent('nf-files-moved', { detail: { from: r.from, to: r.to } }));
        }
      }
      // 不清空 pending：已有结果的目录保持显示，只标记待刷新，避免闪「载入中」。
      for (const dir of openDirs) pending.add(dir);
      requestDirs();
      render();
      return;
    }
```

- [ ] **Step 6: standalone.css 样式**

文件末尾追加：

```css
/* 文件页：剪切源压暗；行可聚焦（Ctrl+X/C/V 的作用对象）。 */
.fx-row.fx-cut { opacity: 0.55; }
.fx-row:focus { outline: 1px solid rgba(128, 128, 128, 0.6); outline-offset: -1px; }
```

- [ ] **Step 7: smoke-view.js 断言**

文件末尾（最后一个 explorer 小节之后）新增小节。`mountExplorer()` 已同时装载 view.js + editor.js + explorer.js：

```js
console.log('\n== 文件页：剪贴板与右键菜单 ==');
{
  const ui = mountExplorer();
  const written = [];
  ui.window.navigator.clipboard = { writeText: (t) => { written.push(t); return Promise.resolve(); } };
  ui.doc.getElementById('pane-files').classList.add('active');
  const rightClick = (node) => {
    node.dispatchEvent(new ui.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
    return ui.doc.querySelector('.ctx-menu');
  };
  const itemsOf = (menu) => [...menu.querySelectorAll('button')].map((b) => b.textContent);
  const btn = (menu, label) => [...menu.querySelectorAll('button')].find((b) => b.textContent === label);
  const clickEl = (node) => node.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const last = (type) => [...ui.sent].reverse().find((m) => m.type === type);

  ui.post({ type: 'dirListings', listings: [ui.listing('', { '子目录': 'dir', 'a.md': 'file' })] });
  const fileRow = ui.rows().find((r) => r.textContent.includes('a.md'));
  const dirRow = ui.rows().find((r) => r.textContent.includes('子目录'));

  const fileItems = itemsOf(rightClick(fileRow));
  check('文件行菜单含剪切/复制/粘贴/重命名',
    ['剪切', '复制', '粘贴', '重命名'].every((l) => fileItems.includes(l)), JSON.stringify(fileItems));
  check('没有剪贴板时粘贴置灰', btn(rightClick(fileRow), '粘贴').disabled);
  closeAnyMenu(ui);

  // 复制：内部登记 + 路径外送系统剪贴板。
  clickEl(btn(rightClick(fileRow), '复制'));
  check('复制把路径写进系统剪贴板', written.includes('a.md'), JSON.stringify(written));
  check('粘贴变为可用', !btn(rightClick(fileRow), '粘贴').disabled);
  closeAnyMenu(ui);

  // 在文件夹行上粘贴：落点是该文件夹。
  clickEl(btn(rightClick(dirRow), '粘贴'));
  const pasteMsg = last('fileAction');
  check('粘贴发 fileAction',
    pasteMsg && pasteMsg.action === 'paste' && pasteMsg.op === 'copy' &&
    pasteMsg.relPaths.join(',') === 'a.md' && pasteMsg.targetDir === '子目录',
    JSON.stringify(pasteMsg));

  // 复制态在粘贴后保留（可再粘）；重命名走 renameAny。
  check('复制态粘贴后保留', !btn(rightClick(fileRow), '粘贴').disabled);
  clickEl(btn(rightClick(fileRow), '重命名'));
  const ren = last('fileAction');
  check('重命名发 renameAny', ren && ren.action === 'renameAny' && ren.relPath === 'a.md', JSON.stringify(ren));

  // 剪切 + move 完成后清除剪切态。
  clickEl(btn(rightClick(fileRow), '剪切'));
  check('剪切后行带 fx-cut 标记',
    ui.rows().some((r) => r.classList.contains('fx-cut')));
  ui.post({ type: 'filesOpDone', op: 'move', results: [{ from: 'a.md', to: '子目录/a.md', ok: true }] });
  check('move 完成后剪切态清除', btn(rightClick(dirRow), '粘贴').disabled);
  closeAnyMenu(ui);

  // 快捷键：焦点行上 Ctrl+C。
  ui.post({ type: 'dirListings', listings: [ui.listing('', { 'b.md': 'file' })] });
  const bRow = ui.rows().find((r) => r.textContent.includes('b.md'));
  bRow.dispatchEvent(new ui.window.FocusEvent('focus', { bubbles: true }));
  ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
  check('Ctrl+C 复制焦点行', written.includes('b.md'), JSON.stringify(written));
}
```

注意：`FocusEvent` 在 jsdom 中可用；explorer 的 focus 监听不带 preventDefault 需求。若 jsdom 版本对 `FocusEvent` 构造报错，退化为 `new ui.window.Event('focus', { bubbles: true })`。

- [ ] **Step 8: 验证**

Run: `node scripts/smoke-view.js`
Expected: 全部通过

- [ ] **Step 9: Commit**

```powershell
git add media/explorer.js media/standalone.css scripts/smoke-view.js
git commit -m "feat: 文件页剪切/复制/粘贴/重命名与 Ctrl+X/C/V"
```

---

### Task 11: editor.js 标签菜单、正文区菜单、标签搬家

**Files:**
- Modify: `media/editor.js`
- Modify: `scripts/smoke-view.js`

- [ ] **Step 1: 菜单引擎引用**

`const toast = ...` 之后插入：

```js
  // view.js 的右键菜单登记表。独立版里 view.js 先加载，必有；兜底成
  // 「不登记」只是让菜单缺席，不影响编辑主流程。
  const onCtx = window.__nfContextMenu || ((node) => node);
```

- [ ] **Step 2: 标签页右键菜单**

`createPane` 的 `renderTabs` 里，`tab.addEventListener('auxclick', ...)` 之后插入：

```js
        onCtx(tab, () => tabMenuItems(file.path));
```

`renderTabs` 函数之后新增：

```js
    /**
     * 标签右键菜单：关闭当前/左侧/右侧/其它。
     * 批量关闭**逐个确认**：每个脏标签各问一次，取消哪个跳过哪个、继续其余。
     */
    function tabMenuItems(anchor) {
      const order = [...files.keys()];
      const idx = order.indexOf(anchor);
      const left = order.slice(0, idx);
      const right = order.slice(idx + 1);
      const closeMany = (paths) => {
        for (const p of paths) closeFile(p);
      };
      const items = [{ label: '关闭', run: () => closeFile(anchor) }];
      if (left.length > 0) items.push({ label: `关闭左侧（${left.length}）`, run: () => closeMany(left) });
      if (right.length > 0) items.push({ label: `关闭右侧（${right.length}）`, run: () => closeMany(right) });
      if (left.length + right.length > 0) {
        items.push({ label: `关闭其它（${left.length + right.length}）`, run: () => closeMany([...left, ...right]) });
      }
      return items;
    }
```

标签条空白处（右键时以当前激活标签为准）——在 `createPane` 内、`renderTabs` 登记之外的任意位置（比如 `el.area` 监听器附近）加一次：

```js
    onCtx(el.tabs, () => (pane.activePath ? tabMenuItems(pane.activePath) : []));
```

- [ ] **Step 3: 正文区右键菜单**

`createPane` 内（与上一步相邻处）：

```js
    // 正文区菜单：预览模式没有可编辑内容，provider 返回空数组即不弹。
    onCtx(el.area, () => {
      if (pane.previewMode) return [];
      const hasSel = el.area.selectionStart !== el.area.selectionEnd;
      return [
        { label: '剪切', disabled: !hasSel, run: () => areaCut() },
        { label: '复制', disabled: !hasSel, run: () => areaCopy() },
        { label: '粘贴', run: () => areaPaste() },
        { sep: true },
        { label: '全选', run: () => { el.area.focus(); el.area.select(); } },
      ];
    });
```

编辑动作放在 createPane 工厂**外部**（与 countWords 等并列的模块级函数，textarea 由调用者传入）：

```js
  /**
   * 正文区的剪切/复制/粘贴。优先 execCommand——它保留 textarea 的
   * 原生撤销栈；Clipboard API 作为读剪贴板的正路（粘贴）与兜底（复制）。
   */
  function areaCopy(area) {
    area.focus();
    if (document.execCommand && document.execCommand('copy')) return;
    const text = area.value.slice(area.selectionStart, area.selectionEnd);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => toast('复制失败，请手动选中复制。', true));
    } else {
      toast('当前环境不支持剪贴板。', true);
    }
  }

  function areaCut(area) {
    area.focus();
    if (document.execCommand && document.execCommand('cut')) return;
    // 兜底：先复制再手动删选区。
    areaCopy(area);
    const s = area.selectionStart;
    const e = area.selectionEnd;
    area.value = area.value.slice(0, s) + area.value.slice(e);
    area.selectionStart = area.selectionEnd = s;
    area.dispatchEvent(new Event('input'));
  }

  async function areaPaste(area) {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      toast('当前环境不支持剪贴板读取。', true);
      return;
    }
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast('粘贴失败：浏览器未授权剪贴板读取。', true);
      return;
    }
    area.focus();
    // insertText 保留撤销栈；不支持时退回手动拼接（丢撤销，但能贴上）。
    if (document.execCommand && document.execCommand('insertText', false, text)) return;
    const s = area.selectionStart;
    const e = area.selectionEnd;
    area.value = area.value.slice(0, s) + text + area.value.slice(e);
    area.selectionStart = area.selectionEnd = s + text.length;
    area.dispatchEvent(new Event('input'));
  }
```

菜单登记处的三个 run 相应改为 `() => areaCut(el.area)` / `() => areaCopy(el.area)` / `() => areaPaste(el.area)`。

- [ ] **Step 4: 标签搬家（改名/移动后不丢草稿）**

模块级（`window.addEventListener('message', ...)` 之前）：

```js
  /**
   * explorer.js 在 rename/move 成功后广播的搬家事件：把旧标签连同
   * 未保存草稿整体挪到新路径。
   *
   * 走 pendingDrafts 的 `moved` 标记绕开 hash 相等检查——改名后
   * 文件的 hash 基线必然变化，但草稿本身没有理由丢。
   */
  window.addEventListener('nf-files-moved', (event) => {
    const from = event.detail && event.detail.from;
    const to = event.detail && event.detail.to;
    if (!from || !to) return;
    const pane = paneOwning(from);
    if (!pane) return;
    const file = pane.files.get(from);
    const carry = file.draft !== file.text ? { hash: file.hash, draft: file.draft, moved: true } : undefined;
    pane.closeSilently(from);
    rekeyStorage(from, to);
    if (carry) pendingDrafts.set(to, carry);
    pendingActive.set(pane.id, to);
    vscode.postMessage({ type: 'openEditor', path: to, pane: pane.id });
  });

  /** 刷新恢复用的 localStorage 里，旧路径条目改写成新路径，草稿不丢。 */
  function rekeyStorage(from, to) {
    try {
      const data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!data || !data.panes) return;
      for (const paneData of Object.values(data.panes)) {
        if (!paneData || !Array.isArray(paneData.open)) continue;
        for (const item of paneData.open) {
          if (item && item.path === from) item.path = to;
        }
        if (paneData.active === from) paneData.active = to;
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch {
      /* 读不下/写不进都无所谓，最坏退化为丢一次刷新恢复 */
    }
  }
```

`upsertFile` 里的草稿恢复判断加 `moved` 豁免（约第 470 行）：

```js
        if (restore && restore.draft !== undefined) {
          // moved：文件刚改名/搬家，hash 基线必然变了，草稿照贴；
          // 其余情况（刷新恢复）仍要求磁盘没变过。
          if (restore.moved || restore.hash === incoming.hash) {
            file.draft = restore.draft;
          } else {
            toast(`「${file.name}」在离开期间被改过，已放弃未保存的草稿。`, true);
          }
        }
```

- [ ] **Step 5: smoke-view.js 断言**

用 `mountExplorer()`（三脚本齐备）。新增小节：

```js
console.log('\n== 内置编辑器：右键菜单与标签搬家 ==');
{
  const ui = mountExplorer();
  const rightClick = (node) => {
    node.dispatchEvent(new ui.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
    return ui.doc.querySelector('.ctx-menu');
  };
  const itemsOf = (menu) => [...menu.querySelectorAll('button')].map((b) => b.textContent);
  const btn = (menu, label) => [...menu.querySelectorAll('button')].find((b) => b.textContent === label);
  const clickEl = (node) => node.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
  const tabs = () => [...ui.doc.querySelectorAll('.ed-tab')];

  ui.post({ type: 'editorOpen', file: ui.file('a.md', '甲的内容') });
  ui.post({ type: 'editorOpen', file: ui.file('b.md', '乙的内容') });
  check('打开了两个标签', tabs().length === 2, String(tabs().length));

  // ---- 标签菜单
  const tabMenu = rightClick(tabs()[0]);
  check('标签菜单四项齐全',
    itemsOf(tabMenu).some((l) => l === '关闭') &&
    itemsOf(tabMenu).some((l) => l.startsWith('关闭右侧')) &&
    itemsOf(tabMenu).some((l) => l.startsWith('关闭其它')),
    JSON.stringify(itemsOf(tabMenu)));
  clickEl(btn(rightClick(tabs()[0]), itemsOf(rightClick(tabs()[0])).find((l) => l.startsWith('关闭其它'))));
  check('关闭其它后只剩一个标签', tabs().length === 1, String(tabs().length));
  closeAnyMenu(ui);

  // ---- 正文区菜单
  const area = ui.doc.getElementById('edArea');
  const areaMenu = rightClick(area);
  check('正文区菜单含剪切/复制/粘贴/全选',
    ['剪切', '复制', '粘贴', '全选'].every((l) => itemsOf(areaMenu).includes(l)),
    JSON.stringify(itemsOf(areaMenu)));
  check('无选中时剪切/复制置灰',
    btn(areaMenu, '剪切').disabled && btn(areaMenu, '复制').disabled);
  clickEl(btn(rightClick(area), '全选'));
  check('全选选中全文', area.selectionStart === 0 && area.selectionEnd === area.value.length,
    `${area.selectionStart}-${area.selectionEnd}/${area.value.length}`);
  closeAnyMenu(ui);

  // ---- 标签搬家：未保存草稿原样带走
  area.value = '甲的内容，改了一半';
  area.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  ui.window.dispatchEvent(new ui.window.CustomEvent('nf-files-moved', { detail: { from: 'a.md', to: 'sub/a.md' } }));
  const reopen = [...ui.sent].reverse().find((m) => m.type === 'openEditor' && m.path === 'sub/a.md');
  check('搬家后请求打开新路径', !!reopen && reopen.pane === 'main', JSON.stringify(reopen));
  // hash 变了也没关系：moved 标记豁免基线检查。
  ui.post({ type: 'editorOpen', file: Object.assign(ui.file('sub/a.md', '甲的内容'), { hash: 'h-other' }) });
  check('搬家后只剩一个标签且是新路径', tabs().length === 1 && tabs()[0].textContent.includes('a'),
    tabs().map((t) => t.textContent).join(','));
  check('未保存草稿跟着搬', ui.doc.getElementById('edArea').value === '甲的内容，改了一半',
    ui.doc.getElementById('edArea').value);
  check('草稿仍是脏标记', tabs()[0].classList.contains('dirty'));
}
```

- [ ] **Step 6: 验证**

Run: `node scripts/smoke-view.js`
Expected: 全部通过

- [ ] **Step 7: Commit**

```powershell
git add media/editor.js scripts/smoke-view.js
git commit -m "feat: 编辑器标签右键菜单、正文区剪切复制粘贴与标签搬家"
```

---

### Task 12: AGENTS.md 约束修订 + 全量验证

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: 修订行为约束 #7**

`AGENTS.md` 「必须遵守的行为约束」第 7 条改为：

```markdown
7. **文件访问不越界**：工程页的类文件操作锁在章节/角色/设定三个区内（`core/fileOps.ts` 的 `normalizeRel` / `sectionOf`）；独立版的读写另有一层——路径落在工程根内、大小上限、以及「纯文本扩展名白名单 ∪ 章节文件名规则」，全在 `fileEditing.ts` 里兜住。独立版「文件」页的写入口只经 `core/projectFiles.ts`（重命名/移动/复制锁在工程根内、`chapters/`、`drafts/`、`.novelforge` 等固定目录受保护、同名绝不覆盖、`.trash` 内容不可操作），目录列举（`core/fileTree.ts`）仍只读。服务无鉴权（只绑 127.0.0.1），别在别处绕过这几处直接读写。
```

- [ ] **Step 2: 模块地图补一行**

「模块地图」表里 `src/core/` 行的职责描述末尾追加「工程根范围文件操作 projectFiles.ts」，即：

```markdown
| `src/core/` | 核心逻辑层入口（含协议 protocol.ts、工程页快照 projectView.ts、出场人物索引 cast.ts、资源管理器目录列举 fileTree.ts、类文件操作 fileOps.ts、工程根范围文件操作 projectFiles.ts、日志 logger.ts、长任务 progress.ts） | [src/core/README.md](src/core/README.md) |
```

若 `src/core/README.md` 内有文件清单，同步把 projectFiles.ts 补进去（一行的事）。

- [ ] **Step 3: 全量验证**

Run: `npm test`
Expected: typecheck 零错误、check-core-purity 通过、全部十二个冒烟测试通过（含新增 smoke-projectFiles）。

- [ ] **Step 4: 手动验证清单**

起独立版：`npm run standalone`，浏览器打开后逐项过：

1. 编辑器：开两三个文件 → 标签右键四项齐全，关闭其它时脏标签逐个确认；正文区右键剪切/复制/粘贴/全选可用，Ctrl+Z 能撤销粘贴。
2. 文件页：文件/文件夹右键四项齐全；Ctrl+C 后行尾 toast；文件夹上粘贴落点正确；改名一个开着的文件，编辑器标签跟到新路径且未保存内容不丢。
3. 工程页：角色分组右键两个批量项；「更新所有」弹总确认（卡数/章数/次数/跳过明细），逐张确认与全部直接采纳各跑一遍。
4. 插件形态 F5：工程页角色分组菜单同样出现（view.js 双形态共享），点击走 VS Code 的弹窗。

- [ ] **Step 5: Commit**

```powershell
git add AGENTS.md src/core/README.md
git commit -m "docs: 修订约束 #7，文件页写入口收敛到 projectFiles"
```

---

## 收尾

全部任务完成后：

1. `npm test` 最后一次全绿确认。
2. `git log --oneline` 过一遍提交序列，确认每个 commit 独立可回滚。
3. 若手动验证发现问题，回到对应 Task 修复并重跑该任务的验证命令。
