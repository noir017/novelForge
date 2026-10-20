/**
 * 「名词补全」的匹配与排序（`media/src/editor/namesCore.ts`，纯函数、零 DOM）。
 * 弹出框本身（按键、插入、撤销、自动模式、组字保护）在 tests/dom/standalone/names.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 哪些文件补全 | 正文、草稿、细纲、角色卡、设定、大纲、叙事线；`setting`（含配置）、文风、`other`、没给 kind 不补 |
 * | 切表 | 正名在前、别名去重去空白、类型那一格（角色 / 分类 / 设定）、空名字跳过、前缀与全称表 |
 * | 查询词 | 从光标往前 1~4 个字、挑能匹配上名字开头的最长那段；碰到标点空白就停；匹配不上是空查询；不劈开代理对 |
 * | 匹配 | 只认开头、不分大小写；正名先于别名；一个名词一行；别名命中插别名 |
 * | 排序 | 最近在本文件出现（查询词之前，越近越前）→ 只在后面出现 → 没出现；同档角色 → 设定 → 未建条目、短的在前 |
 * | 边打边弹 | 至少 2 个字、打完整了不弹、剩下那截已在光标后面不弹、组字中 / 删字 / 粘贴 / 程序改写 / 有选区不弹 |
 * | 插入 | 换掉查询词（与选区），补全整个叫法，光标落在后面 |
 * | 名词高亮 | 正名与别名都认、不分大小写；长的优先不重叠；一个字的不认；英文要整词；卡自己那一份不标它自己；三种来源三种 class；撞了的叫法归表里排前面的；按字认回那一条 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const {
  AUTO_MIN_CHARS,
  MAX_QUERY,
  NAME_LIST_LIMIT,
  autoPopQuery,
  autoQueryAt,
  buildNameCatalog,
  buildNameMatcher,
  completionApplies,
  insertionFor,
  isNameChar,
  matchNames,
  nameItemOf,
  nameRanges,
  queryBefore,
  queryBetween,
} = loadModule('media/src/editor/namesCore.ts');

/** 样本表：角色（带别名）、设定（带关键词与分类）、未建条目。 */
function sample() {
  return buildNameCatalog({
    initialized: true,
    names: [
      { name: '林昭', aliases: ['阿昭', '小林'], source: 'character', category: '', brief: '青云宗外门弟子。', path: 'c/林昭.md' },
      { name: '林昭阳', aliases: [], source: 'character', category: '', brief: '', path: 'c/林昭阳.md' },
      { name: '沈怀山', aliases: ['老沈'], source: 'character', category: '', brief: '', path: 'c/沈怀山.md' },
      { name: '青云宗', aliases: ['青云门', '宗门'], source: 'lore', category: '门派', brief: '正道第一大宗', path: 'l/青云宗.md' },
      { name: '青崖镇', aliases: [], source: 'lore', category: '地点', brief: '', path: 'l/青崖镇.md' },
      { name: '太上忘情诀', aliases: [], source: 'lore', category: '', brief: '', path: 'l/太上忘情诀.md' },
      { name: '黑水河', aliases: [], source: 'unfiled', category: '地点', brief: '河上起了雾' },
      { name: 'Lin Zhao', aliases: [], source: 'character', category: '', brief: '', path: 'c/lin.md' },
    ],
  });
}

const match = (catalog, query, text = '', caret = text.length, extra = {}) =>
  matchNames(catalog, query, { text, start: caret - query.length, caret, ...extra });
const forms = (result) => result.items.map((c) => c.form);

describe('namesCore › 哪些文件补全', () => {
  test('正文、草稿、细纲、角色卡、设定、大纲、叙事线补全', () => {
    for (const kind of ['chapter', 'draft', 'plot', 'character', 'lore', 'outline', 'threads']) {
      assert.equal(completionApplies(kind), true, kind);
    }
  });

  test('架构几件（setting，含小说配置）、敏感词表（sensitive）、文风、全书摘要、技能、other、没给 kind 不补', () => {
    for (const kind of ['setting', 'sensitive', 'style', 'globalSummary', 'skill', 'other', undefined, '']) {
      assert.equal(completionApplies(kind), false, String(kind));
    }
  });
});

describe('namesCore › 切表', () => {
  test('正名在前、别名去重去空白（与正名一样的去掉）', () => {
    const c = buildNameCatalog({
      initialized: true,
      names: [{ name: ' 林昭 ', aliases: ['阿昭', ' 阿昭', '', '林昭', '小林'], source: 'character', category: '', brief: '' }],
    });
    assert.deepEqual(c.items[0].forms.map((f) => [f.text, f.alias]), [['林昭', false], ['阿昭', true], ['小林', true]]);
    assert.deepEqual(c.items[0].aliases, ['阿昭', '小林']);
  });

  test('类型那一格：角色卡写「角色」，设定与未建条目写分类，没有分类写「设定」', () => {
    const c = sample();
    const badge = (name) => c.items.find((i) => i.name === name).badge;
    assert.equal(badge('林昭'), '角色');
    assert.equal(badge('青云宗'), '门派');
    assert.equal(badge('太上忘情诀'), '设定');
    assert.equal(badge('黑水河'), '地点');
  });

  test('空名字跳过；没给表时是空的', () => {
    assert.equal(buildNameCatalog({ initialized: true, names: [{ name: ' ', aliases: [], source: 'lore', category: '', brief: '' }] }).items.length, 0);
    assert.equal(buildNameCatalog(undefined).items.length, 0);
  });

  test('还不是小说工程：initialized 是 false', () => {
    assert.equal(buildNameCatalog({ initialized: false, names: [] }).initialized, false);
  });
});

describe('namesCore › 从光标前取查询词', () => {
  const c = sample();

  test(`最多往前取 ${MAX_QUERY} 个字，挑能匹配上名字开头的最长那段`, () => {
    assert.deepEqual(queryBefore(c, '他看见林', 4), { query: '林', start: 3 });
    assert.deepEqual(queryBefore(c, '他看见林昭', 5), { query: '林昭', start: 3 });
    assert.deepEqual(queryBefore(c, '那天青云', 4), { query: '青云', start: 2 });
    assert.deepEqual(queryBefore(c, '修太上忘情', 5), { query: '太上忘情', start: 1 });
  });

  test('超过 4 个字的名字：只看光标前 4 个字（再往前的不取）', () => {
    // 「太上忘情诀」打到「上忘情诀」时，往前 4 个字是「上忘情诀」，不是哪个名字的开头；3、2、1 个字也不是。
    assert.deepEqual(queryBefore(c, '太上忘情诀', 5), { query: '', start: 5 });
  });

  test('碰到标点、空白就停', () => {
    assert.deepEqual(queryBefore(c, '“林', 2), { query: '林', start: 1 });
    assert.deepEqual(queryBefore(c, '林 昭', 3), { query: '', start: 3 });
    assert.deepEqual(queryBefore(c, '青云，', 3), { query: '', start: 3 });
  });

  test('什么都匹配不上：空查询，起点就是光标', () => {
    assert.deepEqual(queryBefore(c, '他走了', 3), { query: '', start: 3 });
    assert.deepEqual(queryBefore(c, '', 0), { query: '', start: 0 });
  });

  test('光标在中间：只看光标前面', () => {
    assert.deepEqual(queryBefore(c, '林走了', 1), { query: '林', start: 0 });
  });

  test('英文不分大小写，查询词保留原样', () => {
    assert.deepEqual(queryBefore(c, 'see lin', 7), { query: 'lin', start: 4 });
  });

  test('不劈开代理对（𠀋 是一个字）', () => {
    const cc = buildNameCatalog({ initialized: true, names: [{ name: '𠀋山', aliases: [], source: 'lore', category: '', brief: '' }] });
    assert.deepEqual(queryBefore(cc, '去𠀋', 3), { query: '𠀋', start: 1 });
  });

  test('间隔号、连字符算名字里的字', () => {
    assert.equal(isNameChar('·'), true);
    assert.equal(isNameChar('-'), true);
    assert.equal(isNameChar('，'), false);
    assert.equal(isNameChar(' '), false);
  });

  test('手动弹出之后接着打字：起点到光标还是查询词；碰到标点、光标退到起点前面就不是了', () => {
    assert.equal(queryBetween('他看见林昭', 3, 5), '林昭');
    assert.equal(queryBetween('他看见林，', 3, 5), undefined);
    assert.equal(queryBetween('他看见', 3, 2), undefined);
    assert.equal(queryBetween('他看见', 3, 3), '');
  });
});

describe('namesCore › 匹配', () => {
  const c = sample();

  test('只认开头：「昭」不匹配「林昭」', () => {
    assert.deepEqual(forms(match(c, '昭')), []);
  });

  test('一个名词只列一行，正名对得上就是正名', () => {
    assert.deepEqual(forms(match(c, '林')), ['林昭', '林昭阳']);
  });

  test('正名对不上、别名对得上：插别名，标着别名', () => {
    const r = match(c, '阿');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].form, '阿昭');
    assert.equal(r.items[0].viaAlias, true);
    assert.equal(r.items[0].item.name, '林昭');
  });

  test('设定的关键词也是别名', () => {
    assert.deepEqual(match(c, '宗').items.map((x) => [x.form, x.item.name]), [['宗门', '青云宗']]);
  });

  test('不分大小写', () => {
    assert.deepEqual(forms(match(c, 'lin')), ['Lin Zhao']);
  });

  test('高亮查询词那几个字（码位）', () => {
    assert.deepEqual(match(c, '青云').items[0].hits, [0, 1]);
  });

  test('空查询列全部', () => {
    assert.equal(match(c, '').total, c.items.length);
  });

  test(`最多列 ${NAME_LIST_LIMIT} 条，报一共几条`, () => {
    const many = buildNameCatalog({
      initialized: true,
      names: Array.from({ length: 80 }, (_, i) => ({ name: `甲${i}`, aliases: [], source: 'lore', category: '', brief: '' })),
    });
    const r = match(many, '甲');
    assert.equal(r.items.length, NAME_LIST_LIMIT);
    assert.equal(r.total, 80);
  });
});

describe('namesCore › 排序', () => {
  const c = sample();

  test('没出现过：角色 → 设定 → 未建条目', () => {
    const r = match(c, '');
    const sources = r.items.map((x) => x.item.source);
    assert.deepEqual(sources, [...sources].sort((a, b) => ['character', 'lore', 'unfiled'].indexOf(a) - ['character', 'lore', 'unfiled'].indexOf(b)));
  });

  test('最近在本文件出现的排前面：越近越前', () => {
    const text = '沈怀山推门进来。青崖镇下着雨。';
    const r = match(c, '', text);
    assert.deepEqual(forms(r).slice(0, 2), ['青崖镇', '沈怀山']);
  });

  test('别名出现过也算', () => {
    const r = match(c, '', '老沈笑了。');
    assert.equal(r.items[0].item.name, '沈怀山');
  });

  test('只在光标后面出现过的排在前面出现过的后面、没出现过的前面', () => {
    const text = '林昭说完。|青云宗来人了。';
    const caret = text.indexOf('|');
    const r = matchNames(c, '', { text, start: caret, caret });
    assert.deepEqual(r.items.slice(0, 2).map((x) => [x.form, x.rank]), [['林昭', 0], ['青云宗', 1]]);
  });

  test('正在打的那几个字不算「出现过」', () => {
    // 光标前的「林昭」就是查询词本身：不算之前出现过（rank 2），否则每次都把正在打的那个排第一。
    const r = match(c, '林昭', '他看见林昭');
    assert.deepEqual(r.items.map((x) => [x.form, x.rank]), [['林昭', 2], ['林昭阳', 2]]);
  });

  test('同一档里短的在前', () => {
    assert.deepEqual(forms(match(c, '林昭')), ['林昭', '林昭阳']);
  });
});

describe('namesCore › 边打边弹的判定', () => {
  const c = sample();
  /** 在 `before` 末尾打进 `typed`（键盘或输入法上屏），返回判定。 */
  const typed = (before, typedText, extra = {}) => {
    const text = before + typedText;
    return autoPopQuery(c, {
      source: 'composition',
      change: { at: before.length, removed: '', inserted: typedText },
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
      ...extra,
    });
  };

  test(`至少 ${AUTO_MIN_CHARS} 个字才弹：「沈怀」弹、「沈」不弹`, () => {
    assert.deepEqual(typed('他看见', '沈怀'), { query: '沈怀', start: 3 });
    assert.equal(typed('他看见', '沈'), undefined);
  });

  test('打完整了不弹：「沈怀山」', () => {
    assert.equal(typed('他看见沈怀', '山'), undefined);
  });

  test('打完整了不弹，哪怕还有更长的名字以它开头：「林昭」（还有「林昭阳」）', () => {
    assert.equal(typed('', '林昭'), undefined);
  });

  test('别名的开头也弹：「青云」→ 青云宗 / 青云门', () => {
    assert.deepEqual(typed('', '青云'), { query: '青云', start: 0 });
  });

  test('剩下那截已经在光标后面：不弹', () => {
    const text = '沈怀山';
    assert.equal(
      autoPopQuery(c, { source: 'typing', change: { at: 1, removed: '', inserted: '怀' }, text, selectionStart: 2, selectionEnd: 2 }),
      undefined
    );
  });

  test('键盘打字也弹', () => {
    assert.ok(typed('', '青崖', { source: 'typing' }));
  });

  test('组字中途不弹', () => {
    assert.equal(typed('', '沈怀', { composing: true }), undefined);
  });

  test('删字、粘贴、程序改写、撤销不弹', () => {
    assert.equal(typed('', '沈怀', { source: 'input' }), undefined);
    assert.equal(typed('', '沈怀', { source: 'program' }), undefined);
    assert.equal(typed('', '沈怀', { source: 'undo' }), undefined);
    assert.equal(
      autoPopQuery(c, { source: 'typing', change: { at: 2, removed: '山', inserted: '' }, text: '沈怀', selectionStart: 2, selectionEnd: 2 }),
      undefined
    );
  });

  test('没有 change（组字中途那几下）不弹', () => {
    assert.equal(autoPopQuery(c, { source: 'composition', text: '沈怀', selectionStart: 2, selectionEnd: 2 }), undefined);
  });

  test('有选区、光标不在插进来的字后面：不弹', () => {
    assert.equal(typed('', '沈怀', { selectionStart: 0 }), undefined);
    assert.equal(typed('', '沈怀', { selectionStart: 1, selectionEnd: 1 }), undefined);
  });

  test('接着打了别的字：不再是哪个名字的开头，不弹', () => {
    assert.equal(typed('沈怀', '了'), undefined);
  });

  test('退格之后重判（autoQueryAt）：还是没打完的开头就留着', () => {
    assert.deepEqual(autoQueryAt(c, '青云', 2), { query: '青云', start: 0 });
    assert.equal(autoQueryAt(c, '青', 1), undefined);
  });

  test('边打边弹只列没打完的：正好是查询词的那个叫法不列', () => {
    const r = match(c, '青云', '青云', 2, { unfinished: true });
    assert.deepEqual(forms(r), ['青云宗']);
  });
});

describe('namesCore › 插入时替换哪一段', () => {
  test('换掉查询词，补全整个名字，光标落在后面', () => {
    // 「他看见林」，查询词「林」从 3 起，光标在 4。
    assert.deepEqual(insertionFor(3, 4, 4, '林昭'), { start: 3, end: 4, text: '林昭', caret: 5 });
  });

  test('空查询：在光标处插入', () => {
    assert.deepEqual(insertionFor(4, 4, 4, '青云宗'), { start: 4, end: 4, text: '青云宗', caret: 7 });
  });

  test('有选区：连选中的一起换掉', () => {
    assert.deepEqual(insertionFor(3, 4, 6, '林昭'), { start: 3, end: 6, text: '林昭', caret: 5 });
  });

  test('别名插别名', () => {
    assert.deepEqual(insertionFor(0, 1, 1, '阿昭').text, '阿昭');
  });
});

describe('namesCore › 名词高亮：正文里哪几段是名字', () => {
  const matcher = () => buildNameMatcher(sample());
  /** [那一段字, class] */
  const marks = (text, selfPath) =>
    nameRanges(matcher(), text, selfPath).map((r) => [text.slice(r.start, r.end), r.cls.replace('ed-hl-name-', '')]);

  test('正名、别名（角色别名与设定关键词）都认，三种来源三种 class', () => {
    assert.deepEqual(marks('阿昭走进青云门，沈怀山在黑水河边等他。'), [
      ['阿昭', 'character'],
      ['青云门', 'lore'],
      ['沈怀山', 'character'],
      ['黑水河', 'unfiled'],
    ]);
  });

  test('长的优先、不重叠：林昭阳不认成林昭；同一处起头取最长的', () => {
    assert.deepEqual(marks('林昭阳看着林昭。'), [
      ['林昭阳', 'character'],
      ['林昭', 'character'],
    ]);
  });

  test('一个字的叫法不认（满屏都是），两个字起认', () => {
    const one = buildNameMatcher(
      buildNameCatalog({
        initialized: true,
        names: [
          { name: '道', aliases: [], source: 'lore', category: '概念', brief: '', path: 'l/道.md' },
          { name: '灵气', aliases: ['气'], source: 'lore', category: '概念', brief: '', path: 'l/灵气.md' },
        ],
      })
    );
    const text = '道心不稳，气息全乱，灵气倒灌。';
    assert.deepEqual(nameRanges(one, text).map((r) => text.slice(r.start, r.end)), ['灵气']);
  });

  test('英文叫法不分大小写、要整词：Linear 里那一截不算', () => {
    assert.deepEqual(marks('lin zhao said hi. LIN ZHAO again. Lin Zhaoxyz no.'), [
      ['lin zhao', 'character'],
      ['LIN ZHAO', 'character'],
    ]);
  });

  test('卡或条目自己那一份里不标它自己，别的照标', () => {
    assert.deepEqual(marks('林昭，外号阿昭，青云宗弟子。', 'c/林昭.md'), [['青云宗', 'lore']]);
  });

  test('两条叫法撞了：归表里排前面的那条（角色先于设定）', () => {
    const clash = buildNameMatcher(
      buildNameCatalog({
        initialized: true,
        names: [
          { name: '林昭', aliases: ['小林'], source: 'character', category: '', brief: '', path: 'c/林昭.md' },
          { name: '小林寺', aliases: ['小林'], source: 'lore', category: '门派', brief: '', path: 'l/小林寺.md' },
        ],
      })
    );
    assert.equal(nameItemOf(clash, '小林').name, '林昭');
    const text = '小林去了小林寺。';
    assert.deepEqual(
      nameRanges(clash, text).map((r) => [text.slice(r.start, r.end), r.item.name]),
      [
        ['小林', '林昭'],
        ['小林寺', '小林寺'],
      ]
    );
  });

  test('按那一段字认回表里那一条（悬停浮窗用）：不分大小写，不认识的给 undefined', () => {
    const m = matcher();
    assert.equal(nameItemOf(m, '阿昭').name, '林昭');
    assert.equal(nameItemOf(m, 'LIN ZHAO').name, 'Lin Zhao');
    assert.equal(nameItemOf(m, '路人甲'), undefined);
  });

  test('空表、空文字：什么都不标', () => {
    assert.deepEqual(nameRanges(buildNameMatcher(buildNameCatalog({ initialized: true, names: [] })), '林昭'), []);
    assert.deepEqual(nameRanges(matcher(), ''), []);
  });
});
