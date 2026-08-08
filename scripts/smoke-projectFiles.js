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
