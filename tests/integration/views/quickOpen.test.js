/**
 * 「转到…」（Ctrl+P）的索引（`src/core/views/quickOpen.ts`），真临时工程。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 章节 | 一个章号一条：章号、标题（细纲优先，回落标题给空串）、卷目录、正文 / 细纲路径（没有就缺席）、字数；`.txt` 正文也是章；只有细纲的章；细纲按路径配对（改了名的正文不冒认旧细纲） |
 * | 角色 / 设定 | 名字与别名、设定标题、路径（子目录里的也在） |
 * | 文档 | 架构三件、大纲、文风、叙事线、全书摘要，**有文件的才列** |
 * | 草稿 | 路径、文件名、文件名里的章号 |
 * | 还不是小说工程 | `initialized: false`，列表全空 |
 * | 读盘 | 章节与细纲借缓存（热的时候一章都不读）；冷的时候每个文件至多读一次；草稿只列不读 |
 * | controller | `requestQuickOpen` 回 `quickOpenIndex`，带同一个 `requestId` |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;

const plot = (no, title) =>
  `---\nno: ${no}\ntitle: ${title}\n---\n\n# ${title}\n\n## 梗概\n梗概\n\n## 关键事件\n事件\n`;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    quickOpen: './src/core/views/quickOpen.ts',
    editorLabel: './src/core/views/editorLabel.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'quick-open', title: '青云剑录' });
  project = t.project;

  // 第 1 章：根下，有正文有细纲。
  t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。');
  t.write('.novelforge/summaries/001-楔子.md', plot(1, '楔子'));
  // 第 2 章：第一卷里，细纲的标题与正文的不一样——细纲优先。
  t.write('chapters/第一卷/002-入镇.md', '# 入镇\n\n他走进镇子。');
  t.write('.novelforge/summaries/第一卷/002-入镇.md', plot(2, '入镇（改）'));
  // 第 3 章：.txt 正文，没有细纲。
  t.write('chapters/第一卷/003-夜访.txt', '夜里有人敲门。');
  // 第 4 章：只有细纲，在第二卷。
  t.write('.novelforge/summaries/第二卷/004-北行.md', plot(4, '北行'));
  // 第 5 章：纯序号的正文，没有标题。
  t.write('chapters/第二卷/005.md', '正文');
  // 第 6 章：正文在外面改了名，旧细纲成了孤儿——不冒认。
  t.write('chapters/第二卷/006-新名.md', '# 新名\n\n正文');
  t.write('.novelforge/summaries/第二卷/006-旧名.md', plot(6, '旧名'));

  t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\naliases: [阿昭, 小林]\n---\n\n# 林昭\n');
  t.write('.novelforge/characters/配角/李叔.md', '# 李叔\n');
  t.write('.novelforge/lore/门派/青云宗.md', '---\ntitle: 青云宗\nkeywords: [门派]\n---\n\n# 青云宗\n');
  t.write('drafts/第一卷/002-入镇.md', '草稿');
  t.write('drafts/随手记.md', '随手记');
  t.write('.novelforge/threads.md', '# 叙事线\n');
  // 世界观删掉：没有文件的不列。
  fs.rmSync(t.rel('.novelforge/world.md'));
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle.db);
});

describe('views/quickOpen › 索引', () => {
  let index;
  before(async () => {
    index = await bundle.quickOpen.buildQuickOpenIndex(project);
  });

  test('是小说工程', () => {
    assert.equal(index.initialized, true);
  });

  test('一个章号一条，按章号升序', () => {
    assert.deepEqual(index.chapters.map((c) => c.no), [1, 2, 3, 4, 5, 6]);
  });

  test('根下的章：卷目录是空串，正文与细纲都在，字数是正文的', () => {
    assert.deepEqual(index.chapters[0], {
      no: 1,
      title: '楔子',
      volume: '',
      chapterPath: 'chapters/001-楔子.md',
      plotPath: '.novelforge/summaries/001-楔子.md',
      words: 5,
    });
  });

  test('卷里的章：卷目录、细纲镜像正文的路径、标题取细纲的', () => {
    const c = index.chapters[1];
    assert.equal(c.volume, '第一卷');
    assert.equal(c.title, '入镇（改）');
    assert.equal(c.chapterPath, 'chapters/第一卷/002-入镇.md');
    assert.equal(c.plotPath, '.novelforge/summaries/第一卷/002-入镇.md');
  });

  test('.txt 正文也是一章；没有细纲时 plotPath 缺席，标题取文件名', () => {
    const c = index.chapters[2];
    assert.equal(c.chapterPath, 'chapters/第一卷/003-夜访.txt');
    assert.equal('plotPath' in c, false);
    assert.equal(c.title, '夜访');
    assert.equal(c.words, 6);
  });

  test('只有细纲的章：chapterPath 缺席、字数 0、卷目录取细纲所在的', () => {
    const c = index.chapters[3];
    assert.equal('chapterPath' in c, false);
    assert.equal(c.plotPath, '.novelforge/summaries/第二卷/004-北行.md');
    assert.equal(c.volume, '第二卷');
    assert.equal(c.words, 0);
    assert.equal(c.title, '北行');
  });

  test('没有标题的章：标题是空串（不把「第 5 章」当标题）', () => {
    assert.equal(index.chapters[4].title, '');
  });

  test('正文改过名的章不冒认旧细纲（按路径配对）', () => {
    const c = index.chapters[5];
    assert.equal(c.chapterPath, 'chapters/第二卷/006-新名.md');
    assert.equal('plotPath' in c, false);
    assert.equal(c.title, '新名');
  });

  test('角色卡：名字、别名、路径（子目录里的也在）', () => {
    const byName = (name) => index.characters.find((c) => c.name === name);
    assert.equal(index.characters.length, 2);
    assert.deepEqual(byName('林昭'), { name: '林昭', aliases: ['阿昭', '小林'], path: '.novelforge/characters/林昭.md' });
    assert.deepEqual(byName('李叔'), { name: '李叔', aliases: [], path: '.novelforge/characters/配角/李叔.md' });
  });

  test('设定条目：标题与路径', () => {
    assert.deepEqual(index.lore, [{ title: '青云宗', path: '.novelforge/lore/门派/青云宗.md' }]);
  });

  test('文档：有文件的才列（世界观删了不在，叙事线有了就在），按架构 → 大纲 → 文风 → 叙事线 → 全书摘要', () => {
    assert.deepEqual(
      index.docs.map((d) => [d.key, d.label, d.path]),
      [
        ['config', '小说配置', '.novelforge/config.md'],
        ['premise', '故事前提', '.novelforge/premise.md'],
        ['outline', '情节大纲', '.novelforge/outline.md'],
        ['style', '文风指南', '.novelforge/style.md'],
        ['threads', '叙事线', '.novelforge/threads.md'],
        ['globalSummary', '全书摘要', '.novelforge/summaries/global.md'],
      ]
    );
  });

  test('每份文档的称呼与内置编辑器标签上的一字不差（views/editorLabel.ts 同一张表）', () => {
    for (const doc of index.docs) {
      assert.equal(bundle.editorLabel.describeEditorFile(project, doc.path).title, doc.label, doc.path);
    }
  });

  test('草稿：路径、文件名、文件名里的章号（认不出就缺席）', () => {
    assert.deepEqual(index.drafts, [
      { path: 'drafts/第一卷/002-入镇.md', name: '002-入镇.md', no: 2 },
      { path: 'drafts/随手记.md', name: '随手记.md' },
    ]);
  });

  test('全书摘要不当成一章（summaries/global.md 没有数字前缀）', () => {
    assert.ok(!index.chapters.some((c) => c.plotPath === '.novelforge/summaries/global.md'));
  });
});

describe('views/quickOpen › 还不是小说工程', () => {
  test('initialized: false，列表全空', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-quick-open-bare-'));
    try {
      fs.mkdirSync(path.join(dir, 'chapters'));
      fs.writeFileSync(path.join(dir, 'chapters', '001-楔子.md'), '正文');
      const bare = bundle.project.NovelProject.open(dir);
      assert.deepEqual(await bundle.quickOpen.buildQuickOpenIndex(bare), {
        initialized: false,
        chapters: [],
        characters: [],
        lore: [],
        docs: [],
        drafts: [],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('views/quickOpen › 读盘', () => {
  /** 量一次构建读了哪些文件（相对工程根）、各几次。 */
  async function measure() {
    const original = fsp.readFile;
    const reads = new Map();
    fsp.readFile = async (...args) => {
      const key = path.relative(t.dir, path.resolve(String(args[0]))).replace(/\\/g, '/');
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return original.apply(fsp, args);
    };
    try {
      await bundle.quickOpen.buildQuickOpenIndex(project);
    } finally {
      fsp.readFile = original;
    }
    return reads;
  }

  test('冷的时候：每个文件至多读一次', async () => {
    project.invalidate();
    const reads = await measure();
    const repeated = [...reads].filter(([, n]) => n > 1).map(([f]) => f);
    assert.deepEqual(repeated, []);
  });

  test('章节与细纲借工程上的缓存：热的时候一章正文、一份细纲都不读', async () => {
    project.invalidate();
    await Promise.all([project.listChapters(), project.listPlots()]);
    const reads = await measure();
    const touched = [...reads.keys()].filter((f) => f.startsWith('chapters/') || f.startsWith('.novelforge/summaries/'));
    assert.deepEqual(touched, []);
  });

  test('草稿只列不读；大纲、配置、manifest 的内容一律不读', async () => {
    const reads = await measure();
    const touched = [...reads.keys()].filter(
      (f) =>
        f.startsWith('drafts/') ||
        ['.novelforge/outline.md', '.novelforge/config.md', '.novelforge/project.json', '.novelforge/threads.md'].includes(f)
    );
    assert.deepEqual(touched, []);
  });
});

describe('controller › requestQuickOpen', () => {
  test('回 quickOpenIndex，带同一个 requestId', async () => {
    const posted = [];
    const controller = new bundle.controller.ChatController(project);
    controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
    try {
      await controller.handle({ type: 'requestQuickOpen', requestId: 'qo-1' });
      const reply = posted.find((m) => m.type === 'quickOpenIndex');
      assert.ok(reply, JSON.stringify(posted.map((m) => m.type)));
      assert.equal(reply.requestId, 'qo-1');
      assert.equal(reply.index.chapters.length, 6);
    } finally {
      controller.dispose();
    }
  });
});
