/**
 * 设定名录的「待完善」（views/lore.ts 的 `thin`，完善设定 · 2026-10-19）：接下来几章要用、却还是空的设定。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 只认没定稿、也还没写正文（没有章节文件或 0 字）的细纲「设定」一节 | 往前看：定稿过的是往回记那一半；写了正文的章已经写过去了 |
 * | 没有条目的、条目是薄的（空的 / 占位 / 三节全是未交代 / 只有暗设）都算，写得有内容的不算 | 作者写了两行就是作者认为够了（不按字数猜） |
 * | 人名不算 | 同名录别处 |
 * | 关键词认得出条目就算那一条，名字给条目标题、分类给条目所在目录 | 与名录别处同一个认法 |
 * | 没有条目的分类取「设定」一节多数票，名字取出现最多的写法 | 「展开」时后端按它建空条目 |
 * | 要用到的章升序，按最早那一章升序，同一章按名字 | 最先要写到的排在最前面 |
 * | 缺省不算（`opts.thin` 才算），只要出现章的调用方不付这份钱；不改动定稿那一半 | 按需算 |
 * | 工程树快照带上它，一行的说明是「第 N 章起要用 · 种类」 | 工程页「待完善」那一组照抄 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let index;

function plot(no, title, { finalized = false, lore } = {}) {
  return [
    '---',
    `no: ${no}`,
    `title: ${title}`,
    ...(finalized ? ['sourceHash: h' + no] : []),
    '---',
    '',
    `# 第${no}章 ${title}`,
    '',
    '## 关键事件',
    '',
    '- 有事发生',
    ...(lore === undefined ? [] : ['', '## 设定', '', lore]),
    '',
  ].join('\n');
}

function entry(title, body, keywords = []) {
  return `---\ntitle: ${title}\nkeywords: [${keywords.join(', ')}]\n---\n\n# ${title}\n\n${body}\n`;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    lore: './src/core/views/lore.ts',
    projectView: './src/core/views/projectView.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'lorethin' });
  // 条目：天机阁是空的（关键词「天机」），镇魂钟是新建设定的占位，阁规三节全是未交代，旧事只有暗设，青崖镇写得有内容。
  t.write('.novelforge/lore/宗门/天机阁.md', entry('天机阁', '', ['天机']));
  t.write('.novelforge/lore/法宝/镇魂钟.md', entry('镇魂钟', '（在这里写这条设定：它是什么、有什么规矩……）'));
  t.write(
    '.novelforge/lore/规矩/阁规.md',
    entry('阁规', '## 概要\n\n（未交代）\n\n## 规则与边界\n\n- （未交代）\n\n## 现状\n\n（未交代）')
  );
  t.write('.novelforge/lore/秘闻/旧事.md', entry('旧事', '## 暗设\n\n二十年前的大火是阁主放的。'));
  t.write('.novelforge/lore/地域/青崖镇.md', entry('青崖镇', '偏僻小镇，镇口设卡。'));
  t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\naliases: [阿昭]\n---\n\n# 林昭\n');

  // 第 1 章定稿过；第 2 章写了正文没定稿；第 3 章有章节文件但 0 字；第 4、5 章还没有章节文件。
  t.write('chapters/001-雨夜.md', '# 雨夜\n\n第一章的正文。\n');
  t.write('chapters/002-客栈.md', '# 客栈\n\n第二章的正文。\n');
  t.write('chapters/003-空章.md', '');
  t.write('.novelforge/summaries/001-雨夜.md', plot(1, '雨夜', { finalized: true, lore: '- 天机阁〔宗门〕\n- 断魂香〔物品〕' }));
  t.write('.novelforge/summaries/002-客栈.md', plot(2, '客栈', { lore: '- 黑市〔地域〕\n- 天机阁' }));
  t.write(
    '.novelforge/summaries/003-空章.md',
    plot(3, '空章', { lore: '- 天机阁〔宗门〕\n- 九层楼〔建筑〕\n- 林昭〔人物〕' })
  );
  t.write(
    '.novelforge/summaries/004-登楼.md',
    plot(4, '登楼', { lore: '- 九层楼〔地标〕\n- 青崖镇〔地域〕\n- 镇魂钟〔法宝〕\n- 阁规' })
  );
  t.write('.novelforge/summaries/005-旧案.md', plot(5, '旧案', { lore: '- 九层楼〔建筑〕\n- 旧事〔秘闻〕\n- 天机〔宗门〕' }));
  t.project.invalidate();

  index = await bundle.lore.buildLoreIndex(t.project, {}, { thin: true });
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

const item = (name) => index.thin.find((x) => x.name === name);

describe('待完善：认哪些', () => {
  test('按最早要用到的章升序，同一章按名字；写得有内容的、人名、定稿过的与已经写了正文的章都不算', () => {
    assert.deepEqual(
      index.thin.map((x) => [x.name, x.first]),
      [
        ['九层楼', 3],
        ['天机阁', 3],
        ['阁规', 4],
        ['镇魂钟', 4],
        ['旧事', 5],
      ]
    );
  });

  test('四种：还没有条目 / 空的 / 占位 / 三节全是未交代；只有暗设的明面是空的，算空的', () => {
    assert.deepEqual(
      Object.fromEntries(index.thin.map((x) => [x.name, x.kind])),
      { 九层楼: 'missing', 天机阁: 'empty', 阁规: 'untold', 镇魂钟: 'placeholder', 旧事: 'empty' }
    );
  });
});

describe('待完善：每一条给什么', () => {
  test('有条目的：名字是条目标题、分类是条目所在目录、带路径；关键词认出来的章也算它的', () => {
    const x = item('天机阁');
    assert.equal(x.category, '宗门');
    assert.equal(x.relPath, '.novelforge/lore/宗门/天机阁.md');
    // 第 2 章已经写了正文、第 1 章定稿过：都不算；第 5 章写的是关键词「天机」。
    assert.deepEqual(x.chapters, [3, 5]);
    assert.equal(x.first, 3);
  });

  test('没有条目的：分类取「设定」一节的多数票，不带路径', () => {
    const x = item('九层楼');
    assert.equal(x.category, '建筑');
    assert.equal(x.relPath, undefined);
    assert.deepEqual(x.chapters, [3, 4, 5]);
  });

  test('「设定」一节没写分类、又有条目的，分类照样是条目所在目录', () => {
    assert.equal(item('阁规').category, '规矩');
  });
});

describe('按需算', () => {
  test('缺省不算：thin 是空的', async () => {
    const plain = await bundle.lore.buildLoreIndex(t.project);
    assert.deepEqual(plain.thin, []);
  });

  test('定稿那一半不受影响：未建条目只认定稿过的「设定」一节', () => {
    assert.deepEqual(
      index.unknown.map((u) => u.name),
      ['断魂香']
    );
    assert.equal(index.finalizedCount, 1);
  });

  test('种类的文案', () => {
    assert.deepEqual(bundle.lore.THIN_LORE_LABEL, {
      missing: '还没有条目',
      empty: '只有一句话',
      placeholder: '只有占位',
      untold: '三节全是未交代',
    });
  });
});

describe('工程树快照', () => {
  test('loreThin 照名录的顺序，一行的说明是「第 N 章起要用 · 种类」，有条目的带路径', async () => {
    t.project.invalidate();
    const tree = await bundle.projectView.buildProjectTree(t.project);
    assert.deepEqual(
      tree.loreThin.map((x) => [x.name, x.category, x.detail]),
      [
        ['九层楼', '建筑', '第 3 章起要用 · 还没有条目'],
        ['天机阁', '宗门', '第 3 章起要用 · 只有一句话'],
        ['阁规', '规矩', '第 4 章起要用 · 三节全是未交代'],
        ['镇魂钟', '法宝', '第 4 章起要用 · 只有占位'],
        ['旧事', '秘闻', '第 5 章起要用 · 只有一句话'],
      ]
    );
    const tianji = tree.loreThin.find((x) => x.name === '天机阁');
    assert.equal(tianji.relPath, '.novelforge/lore/宗门/天机阁.md');
    assert.equal(tianji.kind, 'empty');
    assert.deepEqual(tianji.chapters, [3, 5]);
    assert.equal('relPath' in tree.loreThin[0], false);
  });
});
