/**
 * 设定的格式（model/loreFile.ts）与细纲第九节「设定」（model/plotFile.ts）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 几种手写写法都认、认不出的不崩、同名只留第一行 | 第 1 条：作者会手改 |
 * | 「（无）」读回来是空数组，渲染回去还是「（无）」 | 标题在 = 记过；没有设定也要留下记过的痕迹 |
 * | 分类路径规范成 `a/b`，「未分类」是空串 | 分类就是目录，每本书自己定、可以嵌套 |
 * | 第九节不进内容指纹 | 补记老章节不能把它们全挂上 ⟳ |
 * | 没有这一节是 undefined，有标题没内容是空数组 | 「还没记过」与「记过、没有」是两回事 |
 * | 两趟认条目：关键词抢不走别人的标题 | 同 views/cast.ts 的角色卡 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const lf = loadModule('src/core/model/loreFile.ts');
const pf = loadModule('src/core/model/plotFile.ts');

describe('第九节「设定」的一行一条', () => {
  test('〔〕【】[] 都认，冒号全角半角都认，没写分类也行', () => {
    const lines = lf.parseLoreLines(
      [
        '- 青崖镇〔地域/青崖〕',
        '- 停舟客栈【地域/青崖】：镇上唯一的客栈',
        '* 崖字令牌[信物]: 不止一块',
        '1. 过所：出入城镇的凭证',
        '后山',
      ].join('\n')
    );
    assert.deepEqual(lines, [
      { name: '青崖镇', category: '地域/青崖', note: '' },
      { name: '停舟客栈', category: '地域/青崖', note: '镇上唯一的客栈' },
      { name: '崖字令牌', category: '信物', note: '不止一块' },
      { name: '过所', category: '', note: '出入城镇的凭证' },
      { name: '后山', category: '', note: '' },
    ]);
  });

  test('同一个名字（归一后）只留第一行；空行、占位、（无）跳过', () => {
    const lines = lf.parseLoreLines(['- 青崖镇〔地域〕：甲', '', '（待补充）', '（无）', '- 「青崖镇」：乙'].join('\n'));
    assert.deepEqual(lines, [{ name: '青崖镇', category: '地域', note: '甲' }]);
  });

  test('超长的名字、分类、说明按上限截短', () => {
    const [line] = lf.parseLoreLines(`- ${'名'.repeat(50)}〔${'类'.repeat(60)}〕：${'说'.repeat(100)}`);
    assert.equal(line.name.length, lf.LORE_LINE_LIMITS.name);
    assert.equal(line.category.length, lf.LORE_LINE_LIMITS.category);
    assert.equal(line.note.length, lf.LORE_LINE_LIMITS.note);
  });

  test('渲染：没有就写「（无）」，读回来是空数组；有就一行一条往返不变', () => {
    assert.equal(lf.renderLoreLines([]), '（无）');
    assert.deepEqual(lf.parseLoreLines(lf.renderLoreLines([])), []);
    const lines = [
      { name: '青崖镇', category: '地域/青崖', note: '' },
      { name: '过所', category: '', note: '出入城镇的凭证' },
    ];
    assert.equal(lf.renderLoreLines(lines), '- 青崖镇〔地域/青崖〕\n- 过所：出入城镇的凭证');
    assert.deepEqual(lf.parseLoreLines(lf.renderLoreLines(lines)), lines);
  });

  test('分类路径：反斜杠、全角斜杠当 /，空段丢掉，「未分类」是空串', () => {
    assert.equal(lf.normalizeLoreCategory(' 宗门 \\ 正道／ '), '宗门/正道');
    assert.equal(lf.normalizeLoreCategory('未分类'), '');
    assert.equal(lf.loreCategoryOfSlug('宗门/正道/青云宗'), '宗门/正道');
    assert.equal(lf.loreCategoryOfSlug('青云宗'), '');
  });
});

describe('条目的一句话与认名字', () => {
  test('有 brief 用 brief；没有取正文第一句，跳过小标题与列表记号，截到 40 字', () => {
    assert.equal(lf.loreBrief({ brief: '一句话', body: '别的' }), '一句话');
    assert.equal(lf.loreBrief({ brief: '', body: '## 概要\n\n- 偏僻小镇，前不着村。镇口设卡。' }), '偏僻小镇，前不着村。');
    assert.equal(lf.loreBrief({ brief: '', body: '字'.repeat(80) }).length, lf.LORE_ENTRY_LIMITS.brief);
    assert.equal(lf.loreBrief({ brief: '', body: '' }), '');
  });

  test('先标题后关键词：关键词抢不走别人的标题', () => {
    const a = { slug: 'a', title: '青崖镇', keywords: ['青崖', '停舟'] };
    const b = { slug: 'b', title: '停舟', keywords: [] };
    const lookup = lf.createLoreLookup([a, b]);
    assert.equal(lookup.find('停舟'), b);
    assert.equal(lookup.find('「青崖」'), a);
    assert.equal(lookup.find('后山'), undefined);
  });

  test('提到没有：标题或两个字以上的关键词作为子串出现', () => {
    const entry = { title: '崖字令牌', keywords: ['令牌', '牌'] };
    assert.equal(lf.loreMentionIn('林昭把令牌交了出去', entry), '令牌');
    assert.equal(lf.loreMentionIn('门牌上写着字', entry), undefined);
  });
});

describe('细纲的第九节', () => {
  const FILE = [
    '---',
    'no: 3',
    'title: 夜访',
    'sourceHash: abc',
    '---',
    '',
    '# 第3章 夜访',
    '',
    '## 关键事件',
    '',
    '- 年轻守卫潜入',
    '',
    '## 连续性事实',
    '',
    '- 林昭的令牌被看见了',
    '',
    '## 设定',
    '',
    '- 停舟客栈〔地域〕：二层木楼',
    '- 崖字令牌〔信物〕',
    '',
  ].join('\n');

  test('读出第九节，连续性事实不被它吃进去', () => {
    const plot = pf.parsePlotFile(FILE, '.novelforge/summaries/003-夜访.md');
    assert.deepEqual(plot.lore, [
      { name: '停舟客栈', category: '地域', note: '二层木楼' },
      { name: '崖字令牌', category: '信物', note: '' },
    ]);
    assert.equal(plot.sections.连续性事实, '- 林昭的令牌被看见了');
  });

  test('没有这一节是 undefined；有标题、写着（无）是空数组', () => {
    const none = pf.parsePlotFile(FILE.replace(/## 设定[\s\S]*$/, ''), '.novelforge/summaries/003-夜访.md');
    assert.equal(none.lore, undefined);
    const empty = pf.parsePlotFile(FILE.replace(/## 设定[\s\S]*$/, '## 设定\n\n（无）\n'), '.novelforge/summaries/003-夜访.md');
    assert.deepEqual(empty.lore, []);
  });

  test('第九节不进内容指纹', () => {
    const with_ = pf.parsePlotFile(FILE, '.novelforge/summaries/003-夜访.md');
    const without = pf.parsePlotFile(FILE.replace(/## 设定[\s\S]*$/, ''), '.novelforge/summaries/003-夜访.md');
    assert.equal(pf.plotContentHash(with_), pf.plotContentHash(without));
  });

  test('渲染：给了才写，写在八节之后；读回来一样', () => {
    const plot = pf.parsePlotFile(FILE, '.novelforge/summaries/003-夜访.md');
    const text = pf.renderPlotFile({ ...plot, sourceHash: 'abc', done: false });
    assert.ok(text.indexOf('## 设定') > text.indexOf('## 连续性事实'));
    assert.deepEqual(pf.parsePlotFile(text, plot.relPath).lore, plot.lore);
    const bare = pf.renderPlotFile({ ...plot, lore: undefined, done: false });
    assert.ok(!bare.includes('## 设定'));
    const empty = pf.renderPlotFile({ ...plot, lore: [], done: false });
    assert.ok(empty.includes('## 设定\n\n（无）'));
  });
});
