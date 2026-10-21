/**
 * 编辑器「名词补全」的名词表（`src/core/views/nameIndex.ts`），真临时工程。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 角色卡 | 名字、别名（名字里括号内外各一截也算；一个字的不要）、一句话取「身份」第一句（没写取标签）、路径 |
 * | 设定条目 | 标题、关键词当别名、分类就是目录（根下是空串）、一句话取 `brief`（没写取正文第一句） |
 * | 未建条目 | 名录里定稿过的「设定」一节出现过、没有条目的名字：建议分类、一句话取最近那一章的说明；人名、已有条目不算 |
 * | 顺序 | 角色卡 → 设定条目 → 未建条目 |
 * | 卡改了会更新 | 改别名、新建一条设定、删一张卡，表跟着变，指纹跟着变；没变时指纹不变 |
 * | 读盘 | 没变的时候一份卡、一条设定、一份细纲都不读；变了只重读卡与条目 |
 * | 还不是小说工程 | `initialized: false`，表是空的 |
 * | controller | `requestNameIndex` 回 `nameIndex`（同一个 `requestId` 与指纹）；带着对得上的 `have` 时不带表 |
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

/** 一份定稿过的细纲（有 `sourceHash`），「设定」一节照给。 */
const finalizedPlot = (no, title, lore) =>
  `---\nno: ${no}\ntitle: ${title}\nsourceHash: done${no}\n---\n\n# ${title}\n\n## 梗概\n梗概\n\n## 关键事件\n事件\n\n## 设定\n\n${lore}\n`;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    names: './src/core/views/nameIndex.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'name-index', title: '青云剑录' });
  project = t.project;

  t.write(
    '.novelforge/characters/林昭.md',
    '---\nname: 林昭\naliases: [阿昭, 小林]\n---\n\n# 林昭\n\n## 身份\n青云宗外门弟子，十七岁。父母早亡，由李叔带大。\n'
  );
  t.write('.novelforge/characters/配角/李叔.md', '---\ntags: [镇上铁匠, 长辈]\n---\n\n# 李叔\n');
  t.write('.novelforge/characters/沈怀山.md', '---\nname: 沈怀山（老沈）\naliases: [沈, 沈先生]\n---\n\n# 沈怀山\n');
  t.write(
    '.novelforge/lore/门派/青云宗.md',
    '---\ntitle: 青云宗\nkeywords: [青云门, 宗门, 宗]\nbrief: 正道第一大宗，坐落在青云山上\n---\n\n# 青云宗\n'
  );
  t.write('.novelforge/lore/地点/青崖镇.md', '# 青崖镇\n\n## 概要\n\n青云山脚下的小镇。镇上多铁匠。\n');
  t.write('.novelforge/lore/天书.md', '---\ntitle: 天书\n---\n\n# 天书\n');

  // 两章定稿过的细纲：黑水河没有条目（未建），青云宗有，林昭是人（不算设定）。
  t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。');
  t.write(
    '.novelforge/summaries/001-楔子.md',
    finalizedPlot(1, '楔子', '- 黑水河〔地点〕：镇外那条终年发黑的河\n- 青云宗〔门派〕：收徒\n- 林昭〔人物〕：主角')
  );
  t.write('chapters/002-入镇.md', '# 入镇\n\n他走进镇子。');
  t.write('.novelforge/summaries/002-入镇.md', finalizedPlot(2, '入镇', '- 黑水河〔地点〕：河上起了雾\n- 照骨镜〔物品〕'));
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle.db);
});

describe('views/nameIndex › 名词表', () => {
  let index;
  const byName = (name) => index.names.find((n) => n.name === name);
  before(async () => {
    index = await bundle.names.buildNameIndex(project);
  });

  test('是小说工程', () => {
    assert.equal(index.initialized, true);
  });

  test('角色卡：名字、别名、来源、类型空串、一句话取「身份」第一句、路径', () => {
    assert.deepEqual(byName('林昭'), {
      name: '林昭',
      aliases: ['阿昭', '小林'],
      source: 'character',
      category: '',
      brief: '青云宗外门弟子，十七岁。',
      path: '.novelforge/characters/林昭.md',
    });
  });

  test('没写「身份」的卡：一句话取标签', () => {
    assert.equal(byName('李叔').brief, '镇上铁匠、长辈');
    assert.equal(byName('李叔').path, '.novelforge/characters/配角/李叔.md');
  });

  test('名字里括号内外各一截都当别名；一个字的别名不要', () => {
    assert.deepEqual(byName('沈怀山（老沈）').aliases, ['沈怀山', '老沈', '沈先生']);
  });

  test('设定条目：关键词当别名（一个字的不要）、分类就是目录、一句话取 brief', () => {
    assert.deepEqual(byName('青云宗'), {
      name: '青云宗',
      aliases: ['青云门', '宗门'],
      source: 'lore',
      category: '门派',
      brief: '正道第一大宗，坐落在青云山上',
      path: '.novelforge/lore/门派/青云宗.md',
    });
  });

  test('没写 brief 的条目取正文第一句；根目录下的条目分类是空串', () => {
    assert.equal(byName('青崖镇').brief, '青云山脚下的小镇。');
    assert.equal(byName('青崖镇').category, '地点');
    assert.equal(byName('天书').category, '');
    assert.equal(byName('天书').brief, '');
  });

  test('未建条目：建议的分类、一句话取最近那一章的说明、没有路径与别名', () => {
    assert.deepEqual(byName('黑水河'), { name: '黑水河', aliases: [], source: 'unfiled', category: '地点', brief: '河上起了雾' });
  });

  test('只出现、没说明的未建条目一句话是空串', () => {
    assert.equal(byName('照骨镜').brief, '');
    assert.equal(byName('照骨镜').category, '物品');
  });

  test('「设定」一节里的人名、已有条目不算未建条目', () => {
    assert.deepEqual(
      index.names.filter((n) => n.source === 'unfiled').map((n) => n.name).sort(),
      ['照骨镜', '黑水河']
    );
  });

  test('顺序：角色卡（按名字）→ 设定条目 → 未建条目', () => {
    assert.deepEqual(
      index.names.map((n) => n.source),
      ['character', 'character', 'character', 'lore', 'lore', 'lore', 'unfiled', 'unfiled']
    );
  });
});

describe('views/nameIndex › 卡改了会更新', () => {
  test('没变时指纹不变', async () => {
    const a = bundle.names.nameIndexSig(await bundle.names.buildNameIndex(project));
    const b = bundle.names.nameIndexSig(await bundle.names.buildNameIndex(project));
    assert.equal(a, b);
  });

  test('改了一张卡的别名：表里换成新的，指纹跟着变', async () => {
    const before = bundle.names.nameIndexSig(await bundle.names.buildNameIndex(project));
    t.write(
      '.novelforge/characters/林昭.md',
      '---\nname: 林昭\naliases: [阿昭, 小林, 林师兄]\n---\n\n# 林昭\n\n## 身份\n青云宗外门弟子，十七岁。父母早亡，由李叔带大。\n'
    );
    const index = await bundle.names.buildNameIndex(project);
    assert.deepEqual(index.names.find((n) => n.name === '林昭').aliases, ['阿昭', '小林', '林师兄']);
    assert.notEqual(bundle.names.nameIndexSig(index), before);
  });

  test('新建一条设定：表里有了', async () => {
    t.write('.novelforge/lore/物品/照骨镜.md', '---\ntitle: 照骨镜\nbrief: 照得出人骨相的铜镜\n---\n\n# 照骨镜\n');
    project.invalidate();
    const index = await bundle.names.buildNameIndex(project);
    const entry = index.names.find((n) => n.name === '照骨镜');
    assert.equal(entry.source, 'lore', '建了条目就不再是未建条目');
    assert.equal(entry.category, '物品');
    assert.equal(index.names.filter((n) => n.name === '照骨镜').length, 1);
  });

  test('删掉一张卡：表里没了', async () => {
    fs.rmSync(t.rel('.novelforge/characters/沈怀山.md'));
    const index = await bundle.names.buildNameIndex(project);
    assert.equal(index.names.some((n) => n.name.startsWith('沈怀山')), false);
  });
});

describe('views/nameIndex › 读盘', () => {
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
      await bundle.names.buildNameIndex(project);
    } finally {
      fsp.readFile = original;
    }
    return reads;
  }
  const zone = (reads, prefix) => [...reads.keys()].filter((f) => f.startsWith(prefix));

  test('没变的时候：一张卡、一条设定都不读（细纲与章节借工程上的缓存，热的时候也一份不读）', async () => {
    await bundle.names.buildNameIndex(project);
    await Promise.all([project.listChapters(), project.listPlots()]);
    const reads = await measure();
    assert.deepEqual(
      [...zone(reads, '.novelforge/characters/'), ...zone(reads, '.novelforge/lore/'), ...zone(reads, '.novelforge/summaries/'), ...zone(reads, 'chapters/')],
      []
    );
  });

  test('改了一张卡：卡与条目各重读一次，正文一章都不读', async () => {
    t.write('.novelforge/characters/配角/李叔.md', '---\ntags: [镇上铁匠, 长辈, 话少]\n---\n\n# 李叔\n');
    const reads = await measure();
    assert.ok(reads.get('.novelforge/characters/配角/李叔.md') === 1);
    assert.deepEqual([...reads].filter(([, n]) => n > 1).map(([f]) => f), []);
    assert.deepEqual(zone(reads, 'chapters/'), []);
  });
});

describe('views/nameIndex › 还不是小说工程', () => {
  test('initialized: false，表是空的', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-name-index-bare-'));
    try {
      fs.mkdirSync(path.join(dir, '.novelforge', 'characters'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.novelforge', 'characters', '林昭.md'), '# 林昭\n');
      const bare = bundle.project.NovelProject.open(dir);
      assert.deepEqual(await bundle.names.buildNameIndex(bare), { initialized: false, names: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('controller › requestNameIndex', () => {
  let controller;
  const posted = [];
  before(() => {
    controller = new bundle.controller.ChatController(project);
    controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
  });
  after(() => controller.dispose());

  test('回 nameIndex：同一个 requestId、带指纹与整张表', async () => {
    await controller.handle({ type: 'requestNameIndex', requestId: 'nm-1' });
    const reply = posted.find((m) => m.type === 'nameIndex' && m.requestId === 'nm-1');
    assert.ok(reply, JSON.stringify(posted.map((m) => m.type)));
    assert.equal(typeof reply.sig, 'string');
    assert.ok(reply.index.names.some((n) => n.name === '林昭'));
  });

  test('带着对得上的 have：只回指纹、不带表', async () => {
    const first = posted.find((m) => m.type === 'nameIndex' && m.requestId === 'nm-1');
    await controller.handle({ type: 'requestNameIndex', requestId: 'nm-2', have: first.sig });
    const reply = posted.find((m) => m.type === 'nameIndex' && m.requestId === 'nm-2');
    assert.equal(reply.sig, first.sig);
    assert.equal('index' in reply, false);
  });

  test('have 对不上（卡改过）：照发整张表', async () => {
    const first = posted.find((m) => m.type === 'nameIndex' && m.requestId === 'nm-1');
    t.write('.novelforge/lore/天书.md', '---\ntitle: 天书\nbrief: 无字之书\n---\n\n# 天书\n');
    await controller.handle({ type: 'requestNameIndex', requestId: 'nm-3', have: first.sig });
    const reply = posted.find((m) => m.type === 'nameIndex' && m.requestId === 'nm-3');
    assert.notEqual(reply.sig, first.sig);
    assert.equal(reply.index.names.find((n) => n.name === '天书').brief, '无字之书');
  });
});
