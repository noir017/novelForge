/**
 * 章节文件规则与草稿的离线验证。
 *
 * 两件事：
 *   1. 「什么算章节」不再只认 `.md`——数字前缀 + 非二进制扩展名即可；
 *   2. 每章的草稿镜像在 `drafts/` 下，按需创建、绝不覆盖、不进上下文。
 *
 * 用法：node scripts/smoke-chapters.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-chapters-'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 与 smoke-fileops.js 同一套：几个模块打进同一个 bundle，共享 host 的模块级状态。 */
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
  chapterFile: './src/core/model/chapterFile.ts',
  markdown: './src/core/model/markdown.ts',
  project: './src/core/model/project.ts',
  projectView: './src/core/projectView.ts',
  fileOps: './src/core/fileOps.ts',
  fileEditing: './src/core/fileEditing.ts',
  attachments: './src/core/attachments.ts',
});

const answers = [];
const toasts = [];
bundle.host.initHost({
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
});

function expect(...values) {
  answers.length = 0;
  toasts.length = 0;
  answers.push(...values);
}

const { chapterFile, markdown, project: projectMod, projectView, fileOps, fileEditing, attachments } = bundle;

const rel = (...p) => path.join(WORK, ...p);
const write = (relPath, text) => {
  fs.mkdirSync(path.dirname(rel(relPath)), { recursive: true });
  fs.writeFileSync(rel(relPath), text, 'utf8');
};
const read = (relPath) => fs.readFileSync(rel(relPath), 'utf8');
const has = (relPath) => fs.existsSync(rel(relPath));

async function main() {
  console.log('\n== 章节文件名规则 ==');
  {
    const yes = ['001-楔子.md', '001-楔子.txt', '001-楔子', '004.json', '001-手记.rtf', '12_初入江湖.md', '003.md'];
    for (const name of yes) {
      check(`「${name}」算章节`, chapterFile.isChapterFileName(name));
    }
    const no = ['001-封面.png', '002-稿.docx', '003.zip', '004.mp3', '005.pdf', '006.exe', '笔记.txt', 'README.md'];
    for (const name of no) {
      check(`「${name}」不算章节`, !chapterFile.isChapterFileName(name));
    }

    const parsed = chapterFile.parseChapterFileName('001-楔子.txt');
    check('解析出序号/词干/扩展名',
      parsed.order === 1 && parsed.stem === '楔子' && parsed.ext === '.txt', JSON.stringify(parsed));
    const bare = chapterFile.parseChapterFileName('003.md');
    check('`003.md` 的词干为空（点没被当成分隔符吃掉扩展名）',
      bare.order === 3 && bare.stem === '' && bare.ext === '.md', JSON.stringify(bare));
    const noExt = chapterFile.parseChapterFileName('005-无扩展名');
    check('无扩展名解析正确',
      noExt.order === 5 && noExt.stem === '无扩展名' && noExt.ext === '', JSON.stringify(noExt));
  }

  console.log('\n== extractH1 只看首行 ==');
  {
    check('首行是标题时取到', markdown.extractH1('# 楔子\n\n正文') === '楔子');
    check('标题在中段时不取', markdown.extractH1('第一行\n\n# 后面的') === undefined,
      String(markdown.extractH1('第一行\n\n# 后面的')));
    check('与 stripH1 互逆', markdown.stripH1('第一行\n\n# 后面的') === '第一行\n\n# 后面的');
  }

  const project = projectMod.NovelProject.open(WORK);
  await project.initialize({ title: '章节格式测试', author: '测试' });
  fs.rmSync(rel('.novelforge/characters/example-protagonist.md'), { force: true });
  fs.rmSync(rel('.novelforge/lore/example-setting.md'), { force: true });

  console.log('\n== 扫描：任意后缀 ==');
  {
    write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
    // 正文中段有一行像标题的字：不该被当成章节标题，也不该从正文里消失。
    write('chapters/002-手记.txt', '他翻开笔记。\n\n# 这是纸上写的字\n\n然后合上了。\n');
    write('chapters/卷一/003-夜访.md', '# 夜访\n\n三更时分。\n');
    write('chapters/004-无扩展名', '没有扩展名的一章。\n');
    write('chapters/005-封面.png', 'PNG 假装');
    write('chapters/笔记.txt', '没有数字前缀，不是章节');
    write('.novelforge/characters/林昭.md', '---\nname: 林昭\n---\n\n# 林昭\n');
    write('.novelforge/characters/说明.txt', '角色区不放宽扩展名');
    project.invalidate();

    const chapters = await project.listChapters();
    check('扫到四章（.md / .txt / 无扩展名，跨子目录）', chapters.length === 4, `got ${chapters.length}`);
    check('png 不算章节', !chapters.some((c) => c.relPath.endsWith('.png')));
    check('无数字前缀的 txt 不算章节', !chapters.some((c) => c.relPath.endsWith('笔记.txt')));

    const txt = chapters.find((c) => c.order === 2);
    check('.txt 章节标题取自文件名，不吃正文里的 #', txt.title === '手记', txt.title);
    const body = await project.readChapterText(txt);
    check('.txt 章节正文原样保留那行 #', body.includes('# 这是纸上写的字'), body);

    const md = chapters.find((c) => c.order === 1);
    check('.md 章节仍取 H1', md.title === '楔子', md.title);
    check('.md 章节 readChapterText 仍剥掉 H1',
      (await project.readChapterText(md)) === '雨下了三天。', await project.readChapterText(md));

    const bare = chapters.find((c) => c.order === 4);
    check('无扩展名章节标题取自文件名', bare.title === '无扩展名', bare.title);

    const cards = await project.listCharacters();
    check('角色区仍然只认 .md', cards.length === 1 && cards[0].name === '林昭', `got ${cards.length}`);
  }

  console.log('\n== 可编辑判定 ==');
  {
    check('无扩展名章节可编辑', fileEditing.isEditablePath('chapters/004-无扩展名'));
    check('.rtf 章节可编辑', fileEditing.isEditablePath('chapters/006-手记.rtf'));
    check('.png 不可编辑', !fileEditing.isEditablePath('chapters/005-封面.png'));
    check('白名单里的 json 仍可编辑', fileEditing.isEditablePath('.novelforge/project.json'));
    check('非章节的 png 不可编辑', !fileEditing.isEditablePath('media/icon.png'));
  }

  console.log('\n== createChapter 默认仍出 .md ==');
  {
    const created = await project.createChapter(9, '新章', '', undefined);
    check('文件名带 .md', created === 'chapters/009-新章.md', created);
    check('markdown 家族写标题行', read(created).startsWith('# 新章'), read(created).slice(0, 20));
    const txt = await project.createChapter(10, '纯文本章', '正文', undefined, '.txt');
    check('指定 .txt 时不写标题行', read(txt) === '正文\n', JSON.stringify(read(txt)));
    fs.rmSync(rel(created), { force: true });
    fs.rmSync(rel(txt), { force: true });
    project.invalidate();
  }

  console.log('\n== 草稿路径推导 ==');
  {
    check('根目录 .md 章节', project.draftRelPathFor('chapters/001-楔子.md') === 'drafts/001-楔子.md',
      project.draftRelPathFor('chapters/001-楔子.md'));
    check('子目录镜像层级', project.draftRelPathFor('chapters/卷一/003-夜访.md') === 'drafts/卷一/003-夜访.md',
      project.draftRelPathFor('chapters/卷一/003-夜访.md'));
    check('.txt 章节草稿也是 .txt', project.draftRelPathFor('chapters/002-手记.txt') === 'drafts/002-手记.txt',
      project.draftRelPathFor('chapters/002-手记.txt'));
    check('无扩展名章节草稿也无扩展名',
      project.draftRelPathFor('chapters/004-无扩展名') === 'drafts/004-无扩展名',
      project.draftRelPathFor('chapters/004-无扩展名'));
    check('章节根之外的路径没有草稿',
      project.draftRelPathFor('.novelforge/characters/林昭.md') === undefined,
      project.draftRelPathFor('.novelforge/characters/林昭.md'));
  }

  console.log('\n== 草稿按需创建，绝不覆盖 ==');
  {
    const md = await project.getChapter(1);
    const first = await project.ensureDraft(md);
    check('返回草稿相对路径', first === 'drafts/001-楔子.md', first);
    check('草稿已落盘', has(first));
    check('markdown 草稿带模板头', read(first).startsWith('# 楔子 · 草稿'), read(first).slice(0, 20));

    // 作者往草稿里写了东西，再点一次「打开草稿」不能被抹掉。
    write(first, '# 楔子 · 草稿\n\n这段是我自己写的，不能丢。\n');
    const second = await project.ensureDraft(md);
    check('第二次调用不覆盖已有草稿',
      read(second).includes('这段是我自己写的'), read(second));

    const txt = await project.getChapter(2);
    const txtDraft = await project.ensureDraft(txt);
    check('.txt 章节的草稿是空文件（不塞 markdown）', read(txtDraft) === '', JSON.stringify(read(txtDraft)));

    const paths = await project.listDraftPaths();
    check('listDraftPaths 收到两份', paths.size === 2, `got ${paths.size}`);
    check('集合里是工作区相对路径', paths.has('drafts/001-楔子.md') && paths.has('drafts/002-手记.txt'),
      [...paths].join(','));
  }

  console.log('\n== 草稿不混进章节与工程树 ==');
  {
    project.invalidate();
    const chapters = await project.listChapters();
    check('drafts/ 里的文件不算章节', !chapters.some((c) => c.relPath.startsWith('drafts/')),
      chapters.map((c) => c.relPath).join(','));
    check('章节数没变', chapters.length === 4, `got ${chapters.length}`);

    const tree = await projectView.buildProjectTree(project);
    const flat = [];
    const walk = (nodes) => nodes.forEach((n) => (n.kind === 'dir' ? walk(n.children) : flat.push(n)));
    walk(tree.chapters);
    check('树上没有 drafts 节点', !flat.some((n) => n.relPath.startsWith('drafts/')),
      flat.map((n) => n.relPath).join(','));

    const withDraft = flat.find((n) => n.order === 1);
    check('已建草稿的章节 hasDraft 为真', withDraft.hasDraft === true);
    check('带上 draftPath', withDraft.draftPath === 'drafts/001-楔子.md', withDraft.draftPath);
    const noDraft = flat.find((n) => n.order === 3);
    check('未建草稿的章节 hasDraft 为假', noDraft.hasDraft === false);
    check('未建也给出 draftPath（路径是推导出来的）',
      noDraft.draftPath === 'drafts/卷一/003-夜访.md', noDraft.draftPath);

    check('草稿不是可管理区', fileOps.sectionOf(project, 'drafts/001-楔子.md') === undefined);
  }

  console.log('\n== @ 引用里的草稿组 ==');
  {
    const choices = await attachments.listAttachmentChoices(project);
    const drafts = choices.filter((c) => c.group === '草稿');
    check('只列已存在的草稿', drafts.length === 2, `got ${drafts.length}`);
    check('标签带「· 草稿」', drafts.every((d) => d.label.includes('· 草稿')),
      drafts.map((d) => d.label).join(' | '));
    check('detail 指向 drafts/', drafts.every((d) => d.detail.startsWith('drafts/')),
      drafts.map((d) => d.detail).join(' | '));
    check('章节组不受影响', choices.filter((c) => c.group === '章节').length === 4);
  }

  console.log('\n== 草稿跟随章节改名 / 移动 ==');
  {
    expect('楔子改名');
    const renamed = await fileOps.renameEntry(project, 'chapters/001-楔子.md');
    check('章节已改名', renamed === 'chapters/001-楔子改名.md', renamed);
    check('旧草稿已不在', !has('drafts/001-楔子.md'));
    check('草稿跟着改名', has('drafts/001-楔子改名.md'));
    check('草稿内容原样带过去',
      read('drafts/001-楔子改名.md').includes('这段是我自己写的'), read('drafts/001-楔子改名.md'));

    fs.mkdirSync(rel('chapters/归档'), { recursive: true });
    expect();
    const moved = await fileOps.moveEntry(project, 'chapters/001-楔子改名.md', 'chapters/归档');
    check('章节已移动', moved === 'chapters/归档/001-楔子改名.md', moved);
    check('草稿跟着移动', has('drafts/归档/001-楔子改名.md'));
    check('旧位置草稿已清掉', !has('drafts/001-楔子改名.md'));

    // .txt 章节改名：不该往正文里塞 H1。
    const before = read('chapters/002-手记.txt');
    expect('手记改名');
    const txtRenamed = await fileOps.renameEntry(project, 'chapters/002-手记.txt');
    check('.txt 章节改名保留序号前缀', txtRenamed === 'chapters/002-手记改名.txt', txtRenamed);
    check('.txt 章节正文一个字节没动', read(txtRenamed) === before);
    check('.txt 草稿也跟着改名', has('drafts/002-手记改名.txt'));
  }

  console.log('\n== 目标已有草稿时不覆盖 ==');
  {
    write('chapters/007-甲.md', '# 甲\n\n正文\n');
    project.invalidate();
    const seven = await project.getChapter(7);
    await project.ensureDraft(seven);
    write('drafts/007-甲.md', '旧草稿');
    // 提前占位：改名后的目标草稿已经存在。
    write('drafts/007-乙.md', '占位的新草稿');

    expect('乙');
    await fileOps.renameEntry(project, 'chapters/007-甲.md');
    check('目标草稿未被覆盖', read('drafts/007-乙.md') === '占位的新草稿', read('drafts/007-乙.md'));
    check('旧草稿留在原处', has('drafts/007-甲.md') && read('drafts/007-甲.md') === '旧草稿');
    check('给出了提示', toasts.some((t) => t.startsWith('error:') && t.includes('drafts/007-乙.md')),
      toasts.join(' | '));
  }

  console.log('\n== 删章节不删草稿 ==');
  {
    expect('删除');
    await fileOps.deleteEntry(project, 'chapters/归档/001-楔子改名.md');
    check('章节已进回收站', has('.novelforge/.trash/chapters/归档/001-楔子改名.md'));
    check('草稿没被一起删', has('drafts/归档/001-楔子改名.md'));
  }

  console.log('\n== manifest 认得非 .md 章节 ==');
  {
    project.invalidate();
    const manifest = await project.syncManifest();
    const txt = manifest.chapters.find((c) => c.file.endsWith('.txt'));
    check('.txt 章节进了 manifest', !!txt, manifest.chapters.map((c) => c.file).join(','));
    check('记录了 order 与 hash', txt && txt.order === 2 && typeof txt.contentHash === 'string');
    check('manifest 里没有草稿', !manifest.chapters.some((c) => c.file.startsWith('drafts/')));
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
