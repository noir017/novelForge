/**
 * 层级目录与类文件操作的离线验证：在临时工程上跑递归扫描、树折叠与
 * 新建/重命名/移动/删除。
 *
 * 用法：node scripts/smoke-fileops.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-fileops-'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * 把几个模块打进**同一个** bundle 再取出来。
 *
 * 分开 bundle 会让每份产物各带一份 host.ts 的模块级状态，
 * initHost 只作用于其中一份，其余的仍然「宿主尚未初始化」。
 */
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
  projectView: './src/core/projectView.ts',
  fileOps: './src/core/fileOps.ts',
  characters: './src/core/features/characters.ts',
  actions: './src/core/actions.ts',
});

// core 的交互全走 Host。这里给一个可编程的假宿主：
// 每次 input/confirm/pick 从队列里取下一个答案，没排队就当用户取消。
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

/** 排下一轮交互的回答，并清空 toast 记录。 */
function expect(...values) {
  answers.length = 0;
  toasts.length = 0;
  answers.push(...values);
}

/** 最近一次操作是否报了错。 */
function erred() {
  return toasts.some((t) => t.startsWith('error:'));
}

const projectMod = bundle.project;
const projectViewMod = bundle.projectView;
const fileOpsMod = bundle.fileOps;
const charactersMod = bundle.characters;
const actionsMod = bundle.actions;

const rel = (...p) => path.join(WORK, ...p);
const write = (relPath, text) => {
  fs.mkdirSync(path.dirname(rel(relPath)), { recursive: true });
  fs.writeFileSync(rel(relPath), text, 'utf8');
};

async function main() {
  const project = projectMod.NovelProject.open(WORK);
  await project.initialize({ title: '层级测试', author: '测试' });
  // initialize 会撒两个示例文件，删掉以免干扰计数。
  fs.rmSync(rel('.novelforge/characters/example-protagonist.md'), { force: true });
  fs.rmSync(rel('.novelforge/lore/example-setting.md'), { force: true });

  console.log('\n== 递归扫描 ==');
  {
    write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
    write('chapters/第一卷/002-入镇.md', '# 入镇\n\n他走进青崖镇。\n');
    write('chapters/第一卷/深处/003-夜访.md', '# 夜访\n\n三更时分。\n');
    write('chapters/第一卷/笔记.txt', '不是 markdown，应被忽略');
    write('.novelforge/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n');
    write('.novelforge/characters/配角/李叔.md', '---\nname: 李叔\n---\n\n# 李叔\n');
    write('.novelforge/lore/势力/玄门七宗.md', '---\ntitle: 玄门七宗\nkeywords: [玄门]\n---\n\n# 玄门七宗\n');
    project.invalidate();

    const chapters = await project.listChapters();
    check('扫到三层里的全部章节', chapters.length === 3, `got ${chapters.length}`);
    check('顺序由序号决定而非目录深度',
      chapters.map((c) => c.order).join(',') === '1,2,3', chapters.map((c) => c.order).join(','));
    check('子目录章节的 relPath 带目录',
      chapters[2].relPath === 'chapters/第一卷/深处/003-夜访.md', chapters[2].relPath);
    check('非 .md 文件被忽略', !chapters.some((c) => c.relPath.endsWith('.txt')));

    const cards = await project.listCharacters();
    check('角色卡递归扫描', cards.length === 2, `got ${cards.length}`);
    const li = cards.find((c) => c.name === '李叔');
    check('子目录角色的 slug 带路径前缀', li.slug === '配角/李叔', li.slug);
    check('根目录角色的 slug 与改造前一致',
      cards.find((c) => c.name === '林昭').slug === '林昭');

    const lore = await project.listLore();
    check('设定递归扫描', lore.length === 1 && lore[0].slug === '势力/玄门七宗', lore[0] && lore[0].slug);

    // .trash 里的东西不能被扫回来，否则「删除」等于没删。
    write('.novelforge/.trash/.novelforge/characters/已删.md', '---\nname: 已删\n---\n');
    check('回收站里的文件不参与扫描', (await project.listCharacters()).length === 2);
  }

  console.log('\n== 树的折叠 ==');
  {
    fs.mkdirSync(rel('chapters/第二卷'), { recursive: true });
    project.invalidate();
    const tree = await projectViewMod.buildProjectTree(project);

    check('章节区顶层：两个文件夹 + 一个文件', tree.chapters.length === 3, String(tree.chapters.length));
    check('目录排在文件前面', tree.chapters[0].kind === 'dir' && tree.chapters[2].kind === 'chapter',
      tree.chapters.map((n) => n.kind).join(','));

    const vol1 = tree.chapters.find((n) => n.kind === 'dir' && n.label === '第一卷');
    check('第一卷有子目录与章节', vol1.children.length === 2, String(vol1.children.length));
    check('fileCount 统计整棵子树', vol1.fileCount === 2, String(vol1.fileCount));
    const deep = vol1.children.find((n) => n.kind === 'dir');
    check('第三层节点在位', deep.label === '深处' && deep.children[0].order === 3);

    // 每层内章节倒序（最新的在上），与改造前的平铺列表一致。
    write('chapters/第一卷/004-后续.md', '# 后续\n\n再后来。\n');
    project.invalidate();
    const reordered = (await projectViewMod.buildProjectTree(project)).chapters
      .find((n) => n.kind === 'dir' && n.label === '第一卷')
      .children.filter((n) => n.kind === 'chapter')
      .map((n) => n.order);
    check('同层章节倒序排列', reordered.join(',') === '4,2', reordered.join(','));
    fs.rmSync(rel('chapters/第一卷/004-后续.md'));
    project.invalidate();

    const vol2 = tree.chapters.find((n) => n.kind === 'dir' && n.label === '第二卷');
    check('空文件夹也在树上', !!vol2 && vol2.children.length === 0 && vol2.fileCount === 0);

    check('chapterCount 仍是全书总章数', tree.chapterCount === 3, String(tree.chapterCount));
    check('totalWords 跨目录累加', tree.totalWords > 0);
    check('给出各区根目录', tree.chaptersRoot === 'chapters' &&
      tree.charactersRoot === '.novelforge/characters', tree.charactersRoot);
    check('角色区顶层：一个文件夹 + 一个文件',
      tree.characters.filter((n) => n.kind === 'dir').length === 1 &&
      tree.characters.filter((n) => n.kind === 'file').length === 1);
  }

  console.log('\n== 路径守卫 ==');
  {
    const norm = fileOpsMod.normalizeRel;
    check('拒绝 ..', norm('../外面') === undefined);
    check('拒绝夹在中间的 ..', norm('chapters/../../外面') === undefined);
    check('拒绝绝对路径', norm('/etc/passwd') === undefined && norm('C:/Windows') === undefined);
    check('拒绝空路径', norm('') === undefined && norm('   ') === undefined);
    check('反斜杠归一为正斜杠', norm('chapters\\第一卷') === 'chapters/第一卷');
    check('去掉结尾斜杠', norm('chapters/第一卷/') === 'chapters/第一卷');
    check('内部 . 被折叠', norm('chapters/./卷一') === 'chapters/卷一');

    check('识别章节区', fileOpsMod.sectionOf(project, 'chapters/001-楔子.md').section === 'chapters');
    check('识别角色区',
      fileOpsMod.sectionOf(project, '.novelforge/characters/林昭.md').section === 'characters');
    check('区外路径无归属', fileOpsMod.sectionOf(project, '.novelforge/style.md') === undefined);
    check('越界路径无归属', fileOpsMod.sectionOf(project, '../x') === undefined);
  }

  console.log('\n== 新建文件夹 ==');
  {
    expect('第三卷');
    const created = await fileOpsMod.newFolder(project, 'chapters');
    check('建在区根目录下', created === 'chapters/第三卷', created);
    check('目录真的建出来了', fs.existsSync(rel('chapters/第三卷')));

    expect('子卷');
    const nested = await fileOpsMod.newFolder(project, 'chapters', 'chapters/第三卷');
    check('可建在子目录下', nested === 'chapters/第三卷/子卷', nested);

    expect('第三卷');
    const dup = await fileOpsMod.newFolder(project, 'chapters');
    check('同名文件夹被拒绝', dup === undefined && erred());

    expect('越界');
    const escaped = await fileOpsMod.newFolder(project, 'chapters', '../../外面');
    check('落点越界时退回区根目录', escaped === 'chapters/越界', escaped);

    // 名字里的非法字符被清洗，而不是原样写进文件系统。
    expect('第四:卷?');
    const dirty = await fileOpsMod.newFolder(project, 'chapters');
    check('文件名非法字符被清洗', dirty === 'chapters/第四卷', dirty);
  }

  console.log('\n== 在文件夹里新建 ==');
  {
    expect('新的一章');
    const chapterPath = await actionsMod.newChapterFlow(project, 'chapters/第三卷');
    check('章节建到指定目录', chapterPath === 'chapters/第三卷/004-新的一章.md', chapterPath);
    project.invalidate();
    check('序号仍是全书唯一的下一个',
      (await project.listChapters()).find((c) => c.order === 4) !== undefined);

    expect('沈氏');
    await charactersMod.newCharacter(project, '.novelforge/characters/配角');
    check('角色卡建到指定目录', fs.existsSync(rel('.novelforge/characters/配角/沈氏.md')));

    expect('崖字令牌');
    await charactersMod.newLore(project, '.novelforge/lore/势力');
    check('设定建到指定目录', fs.existsSync(rel('.novelforge/lore/势力/崖字令牌.md')));

    expect('青崖镇');
    await charactersMod.newLore(project, '../../外面');
    check('落点越界的设定退回区根目录', fs.existsSync(rel('.novelforge/lore/青崖镇.md')));

    expect('越界的章');
    const escaped = await actionsMod.newChapterFlow(project, '../../../外面');
    check('落点越界的章节退回 chapters/', escaped === 'chapters/005-越界的章.md', escaped);

    expect('跨区的章');
    const crossed = await actionsMod.newChapterFlow(project, '.novelforge/characters');
    check('落点跨区的章节退回 chapters/', crossed === 'chapters/006-跨区的章.md', crossed);
  }

  console.log('\n== 重命名 ==');
  {
    expect('新的一章改名');
    const renamed = await fileOpsMod.renameEntry(project, 'chapters/第三卷/004-新的一章.md');
    check('保留序号前缀', renamed === 'chapters/第三卷/004-新的一章改名.md', renamed);
    check('正文 H1 同步更新',
      fs.readFileSync(rel(renamed), 'utf8').startsWith('# 新的一章改名'),
      fs.readFileSync(rel(renamed), 'utf8').slice(0, 20));

    // 作者手写过的 H1 不该被改名顺手改掉。
    write('chapters/008-占位.md', '# 作者自己写的标题\n\n正文。\n');
    project.invalidate();
    expect('改过的名');
    const kept = await fileOpsMod.renameEntry(project, 'chapters/008-占位.md');
    check('与文件名不一致的 H1 不动',
      fs.readFileSync(rel(kept), 'utf8').startsWith('# 作者自己写的标题'));

    expect('第三卷改名');
    const dir = await fileOpsMod.renameEntry(project, 'chapters/第三卷');
    check('文件夹可重命名', dir === 'chapters/第三卷改名' && fs.existsSync(rel(dir)), dir);
    project.invalidate();
    check('里面的章节跟着走',
      (await project.listChapters()).some((c) => c.relPath.startsWith('chapters/第三卷改名/')));

    // 名字被清洗后，H1 要与清洗结果一致而不是与用户原样输入一致——
    // 否则下次改名就认不出「这个 H1 是跟着文件名走的」，同步会断掉。
    write('chapters/007-原名.md', '# 原名\n\n正文。\n');
    project.invalidate();
    expect('带:非法?字符');
    const cleaned = await fileOpsMod.renameEntry(project, 'chapters/007-原名.md');
    check('非法字符被清洗进文件名', cleaned === 'chapters/007-带非法字符.md', cleaned);
    check('H1 与清洗后的文件名一致',
      fs.readFileSync(rel(cleaned), 'utf8').startsWith('# 带非法字符'),
      fs.readFileSync(rel(cleaned), 'utf8').slice(0, 20));
    expect('再改一次');
    const again = await fileOpsMod.renameEntry(project, cleaned);
    check('清洗后仍能继续同步 H1',
      fs.readFileSync(rel(again), 'utf8').startsWith('# 再改一次'),
      fs.readFileSync(rel(again), 'utf8').slice(0, 20));

    expect('第一卷');
    const clash = await fileOpsMod.renameEntry(project, 'chapters/第二卷');
    check('重名被拒绝且原目录还在',
      clash === undefined && erred() && fs.existsSync(rel('chapters/第二卷')));

    expect('随便什么');
    const root = await fileOpsMod.renameEntry(project, 'chapters');
    check('区根目录不能重命名', root === undefined && erred());

    expect('随便什么');
    const outside = await fileOpsMod.renameEntry(project, '.novelforge/style.md');
    check('区外文件不能操作', outside === undefined && erred());
  }

  console.log('\n== 移动 ==');
  {
    const before = await project.readManifest();
    const hashBefore = before.chapters.find((c) => c.order === 1)?.contentHash;

    const moved = await fileOpsMod.moveEntry(project, 'chapters/001-楔子.md', 'chapters/第二卷');
    check('文件移动到目标目录', moved === 'chapters/第二卷/001-楔子.md', moved);
    check('原位置已空', !fs.existsSync(rel('chapters/001-楔子.md')));

    project.invalidate();
    const after = await project.syncManifest();
    const entry = after.chapters.find((c) => c.order === 1);
    check('manifest 记下新路径', entry.file === 'chapters/第二卷/001-楔子.md', entry.file);
    check('正文没被改动', entry.contentHash === hashBefore);

    expect();
    const cross = await fileOpsMod.moveEntry(
      project, 'chapters/第二卷/001-楔子.md', '.novelforge/characters');
    check('不能跨区移动', cross === undefined && erred());

    expect();
    const intoSelf = await fileOpsMod.moveEntry(project, 'chapters/第一卷', 'chapters/第一卷/深处');
    check('文件夹不能移进自己里面', intoSelf === undefined && erred());

    expect();
    const escape = await fileOpsMod.moveEntry(project, 'chapters/第二卷/001-楔子.md', '../../外面');
    check('不能移出工程', escape === undefined && erred());

    // 目标目录已有同名文件时必须拒绝，不能覆盖。
    write('chapters/第一卷/001-楔子.md', '# 另一个楔子\n\n别的内容。\n');
    project.invalidate();
    expect();
    const collide = await fileOpsMod.moveEntry(
      project, 'chapters/第二卷/001-楔子.md', 'chapters/第一卷');
    check('同名不覆盖', collide === undefined && erred());
    check('两份文件都还在',
      fs.existsSync(rel('chapters/第二卷/001-楔子.md')) &&
      fs.readFileSync(rel('chapters/第一卷/001-楔子.md'), 'utf8').includes('另一个楔子'));
    fs.rmSync(rel('chapters/第一卷/001-楔子.md'));

    // 不带 targetDir 时走 Host.pick。
    project.invalidate();
    expect('chapters');
    const picked = await fileOpsMod.moveEntry(project, 'chapters/第二卷/001-楔子.md');
    check('可经选择框移回根目录', picked === 'chapters/001-楔子.md', picked);
  }

  console.log('\n== 删除 ==');
  {
    write('chapters/009-待删.md', '# 待删\n\n第一份内容。\n');
    project.invalidate();
    const countBefore = (await project.listChapters()).length;

    expect('删除');
    const ok = await fileOpsMod.deleteEntry(project, 'chapters/009-待删.md');
    check('确认后删除', ok === true);
    check('原位置已空', !fs.existsSync(rel('chapters/009-待删.md')));
    check('搬进回收站并保留原路径',
      fs.existsSync(rel('.novelforge/.trash/chapters/009-待删.md')));
    project.invalidate();
    check('列表里少了一章', (await project.listChapters()).length === countBefore - 1);

    // 同名再删一次不能把回收站里那份覆盖掉。
    write('chapters/009-待删.md', '# 待删\n\n第二份内容。\n');
    project.invalidate();
    expect('删除');
    await fileOpsMod.deleteEntry(project, 'chapters/009-待删.md');
    check('回收站里同名不覆盖',
      fs.existsSync(rel('.novelforge/.trash/chapters/009-待删-2.md')) &&
      fs.readFileSync(rel('.novelforge/.trash/chapters/009-待删.md'), 'utf8').includes('第一份内容'));

    expect(undefined);
    const cancelled = await fileOpsMod.deleteEntry(project, 'chapters/第一卷');
    check('取消则什么都不做', cancelled === false && fs.existsSync(rel('chapters/第一卷')));

    expect('删除');
    const dir = await fileOpsMod.deleteEntry(project, 'chapters/第一卷');
    check('文件夹整棵子树一起删', dir === true && !fs.existsSync(rel('chapters/第一卷')));
    check('子树内容在回收站里',
      fs.existsSync(rel('.novelforge/.trash/chapters/第一卷/深处/003-夜访.md')));
    project.invalidate();
    check('删掉的章节不再出现', !(await project.listChapters()).some((c) => c.order === 3));

    expect('删除');
    const root = await fileOpsMod.deleteEntry(project, 'chapters');
    check('区根目录不能删', root === false && erred() && fs.existsSync(rel('chapters')));

    expect('删除');
    const missing = await fileOpsMod.deleteEntry(project, 'chapters/不存在.md');
    check('不存在的路径报错而非抛异常', missing === false && erred());
  }

  console.log('\n== 摘要新鲜度跨目录 ==');
  {
    // 挪动章节不该让它的摘要变成「过期」——序号没变，就还是同一章。
    write('chapters/010-有摘要.md', '# 有摘要\n\n正文内容。\n');
    project.invalidate();
    const chapter = (await project.listChapters()).find((c) => c.order === 10);
    const sections = projectMod.emptySummarySections();
    sections.梗概 = '摘要正文。';
    await project.writeSummary(chapter, sections);
    project.invalidate();

    const treeBefore = await projectViewMod.buildProjectTree(project);
    const findTen = (nodes) => {
      for (const n of nodes) {
        if (n.kind === 'dir') {
          const hit = findTen(n.children);
          if (hit) return hit;
        } else if (n.order === 10) return n;
      }
      return undefined;
    };
    check('刚写完摘要不算过期', findTen(treeBefore.chapters).stale === false);

    fs.mkdirSync(rel('chapters/归档'), { recursive: true });
    await fileOpsMod.moveEntry(project, 'chapters/010-有摘要.md', 'chapters/归档');
    project.invalidate();
    const treeAfter = await projectViewMod.buildProjectTree(project);
    const moved = findTen(treeAfter.chapters);
    check('移动后仍在树上', moved && moved.relPath === 'chapters/归档/010-有摘要.md',
      moved && moved.relPath);
    check('移动后摘要仍算新鲜', moved.stale === false);
    check('摘要路径仍指得到', moved.summaryPath.endsWith('010.md'), moved.summaryPath);
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
