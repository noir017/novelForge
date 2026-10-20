/**
 * 「转到…」（Ctrl+P）的匹配与排序（`media/src/editor/quickOpenCore.ts`，纯函数、零 DOM）。
 * 面板本身（按键、打开什么、焦点）在 tests/dom/standalone/quickOpen.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 章号 | `12` / `第12章` / `第 12 章` / `第十二章` / `十二` / 全角都直接命中第 12 章并排第一；中文数字含「十」「百」「零」的常见写法 |
 * | 标题、名字 | 子串优先于按先后顺序的模糊；开头就是、整个就是的更靠前；中文按字 |
 * | 别名 | 角色别名命中，小字里高亮那个别名 |
 * | 路径兜底 | 名字里没有的，按文件名 / 卷目录 / 路径找，小字换成那个路径 |
 * | 空输入 | 最近打开的（同一章的正文与细纲算一条、认不出的跳过）再接前几章 |
 * | 上限 | 最多列 50 条、报一共几条；几千章也不慢 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const {
  QUICK_OPEN_LIMIT,
  LEAD_CHAPTERS,
  RECENT_KEPT,
  buildCatalog,
  highlightSegments,
  matchChars,
  parseChapterNo,
  parseChineseNumber,
  pushRecent,
  searchQuickOpen,
} = loadModule('media/src/editor/quickOpenCore.ts');

/** 一份样本索引：分卷的章、只有细纲的章、第 120 章（章号前缀）、角色带别名、设定、文档、草稿。 */
function sampleIndex() {
  const ch = (no, title, volume, extra = {}) => {
    const stem = `${String(no).padStart(3, '0')}-${title}`;
    const dir = volume ? `${volume}/` : '';
    return {
      no,
      title,
      volume,
      chapterPath: `chapters/${dir}${stem}.md`,
      plotPath: `.novelforge/summaries/${dir}${stem}.md`,
      words: 3000 + no,
      ...extra,
    };
  };
  return {
    initialized: true,
    chapters: [
      ch(1, '楔子', ''),
      ch(2, '青山云外', '第一卷'),
      ch(3, '夜访', '第一卷'),
      ch(12, '夜入青云', '第一卷'),
      // 只有细纲、还没有正文。
      { no: 13, title: '青云夜', volume: '第二卷', plotPath: '.novelforge/summaries/第二卷/013-青云夜.md', words: 0 },
      ch(105, '林昭归来', '第二卷'),
      ch(120, '风雪', '第二卷'),
    ],
    characters: [
      { name: '林昭', aliases: ['阿昭', '小林'], path: '.novelforge/characters/林昭.md' },
      { name: '李叔', aliases: [], path: '.novelforge/characters/配角/李叔.md' },
    ],
    lore: [{ title: '示例设定', path: '.novelforge/lore/example-setting.md' }],
    docs: [
      { key: 'config', label: '小说配置', path: '.novelforge/config.md' },
      { key: 'outline', label: '情节大纲', path: '.novelforge/outline.md' },
      { key: 'style', label: '文风指南', path: '.novelforge/style.md' },
      { key: 'threads', label: '沈家旧案', path: '.novelforge/threads/沈家旧案.md' },
    ],
    drafts: [{ path: 'drafts/第一卷/003-夜访.md', name: '003-夜访.md', no: 3 }],
  };
}

const catalog = buildCatalog(sampleIndex());
const search = (q, opts) => searchQuickOpen(catalog, q, opts);
const names = (q, opts) => search(q, opts).hits.map((h) => h.entry.name);
const first = (q, opts) => search(q, opts).hits[0];
/** 一段字里高亮的那几个字，连起来。 */
const marked = (text, hits) => highlightSegments(text, hits).filter((s) => s.hit).map((s) => s.text).join('');

describe('quickOpenCore › 章号', () => {
  for (const [q, no] of [
    ['12', 12],
    ['012', 12],
    ['第12章', 12],
    ['第 12 章', 12],
    ['12章', 12],
    ['第12', 12],
    ['第十二章', 12],
    ['十二', 12],
    ['第十二', 12],
    ['１２', 12],
    ['十', 10],
    ['第二十章', 20],
    ['第一百零五章', 105],
    ['一百零五', 105],
    ['一百一十二', 112],
    ['一百十', 110],
    ['两百', 200],
    ['第一〇五回', 105],
    ['一千零一', 1001],
    ['三万', 30000],
  ]) {
    test(`「${q}」认成第 ${no} 章`, () => {
      assert.equal(parseChapterNo(q), no);
    });
  }

  for (const q of ['', '第', '第一卷', '12a', '三叔', '夜访', 'ch12', '第12章夜']) {
    test(`「${q}」不是章号`, () => {
      assert.equal(parseChapterNo(q), undefined);
    });
  }

  test('中文数字逐位写（一二三 = 123）与单个字', () => {
    assert.equal(parseChineseNumber('一二三'), 123);
    assert.equal(parseChineseNumber('零'), 0);
    assert.equal(parseChineseNumber('两'), 2);
    assert.equal(parseChineseNumber('二十三'), 23);
    assert.equal(parseChineseNumber('abc'), undefined);
  });

  for (const q of ['12', '第12章', '第 12 章', '第十二章', '十二', '１２']) {
    test(`「${q}」直接命中第 12 章并排第一`, () => {
      const hit = first(q);
      assert.equal(hit.entry.key, 'chapter:12');
      assert.equal(hit.score, 1000);
    });
  }

  test('章号命中时小字里的「第 12 章」高亮', () => {
    const hit = first('第十二章');
    assert.equal(hit.detail, '第 12 章 · 第一卷 · 3012 字');
    assert.equal(marked(hit.detail, hit.detailHits), '第 12 章');
  });

  test('只打阿拉伯数字时也列出以它开头的章（12 → 第 120 章），排在第 12 章之后', () => {
    const keys = search('12').hits.map((h) => h.entry.key);
    assert.deepEqual(keys.slice(0, 2), ['chapter:12', 'chapter:120']);
  });

  test('中文章号不带前缀那一档（十二 只命中第 12 章，不拉出第 120 章）', () => {
    assert.ok(!search('十二').hits.some((h) => h.entry.key === 'chapter:120'));
  });

  test('「一百零五」命中第 105 章并排第一', () => {
    assert.equal(first('一百零五').entry.key, 'chapter:105');
  });

  test('章号对不上任何一章时不报错，照样按名字找', () => {
    assert.deepEqual(search('第九十九章').hits, []);
  });
});

describe('quickOpenCore › 标题、名字与别名', () => {
  test('标题子串命中，匹配的字高亮', () => {
    const hit = first('夜访');
    assert.equal(hit.entry.key, 'chapter:3');
    assert.equal(marked(hit.entry.name, hit.nameHits), '夜访');
  });

  test('子串优先于按先后顺序的模糊（青云：「夜入青云」「青云夜」在「青山云外」前面）', () => {
    const list = names('青云');
    assert.ok(list.indexOf('青山云外') > list.indexOf('夜入青云'), list.join('、'));
    assert.ok(list.indexOf('青山云外') > list.indexOf('青云夜'), list.join('、'));
  });

  test('开头就是的子串排在中间才有的前面（青云夜 在 夜入青云 前面）', () => {
    const list = names('青云');
    assert.ok(list.indexOf('青云夜') < list.indexOf('夜入青云'), list.join('、'));
  });

  test('整个就是的排在只是开头的前面（林昭 的角色卡在「林昭归来」前面）', () => {
    const list = names('林昭');
    assert.deepEqual(list.slice(0, 2), ['林昭', '林昭归来']);
  });

  test('模糊匹配按字的先后顺序（林归 → 林昭归来，高亮林、归两个字）', () => {
    const hit = first('林归');
    assert.equal(hit.entry.name, '林昭归来');
    assert.equal(marked(hit.entry.name, hit.nameHits), '林归');
  });

  test('字的顺序反了不算（归林 不命中林昭归来的名字）', () => {
    assert.ok(!search('归林').hits.some((h) => h.entry.name === '林昭归来' && h.nameHits.length > 0));
  });

  test('只有细纲的章照样找得到，小字说「只有细纲」', () => {
    const hit = first('青云夜');
    assert.equal(hit.entry.key, 'chapter:13');
    assert.equal(hit.detail, '第 13 章 · 第二卷 · 只有细纲');
    assert.equal(hit.entry.path, '.novelforge/summaries/第二卷/013-青云夜.md');
  });

  test('角色别名命中角色卡，小字里高亮那个别名', () => {
    const hit = first('阿昭');
    assert.equal(hit.entry.name, '林昭');
    assert.equal(hit.entry.kind, 'character');
    assert.equal(hit.detail, '别名 阿昭 / 小林');
    assert.equal(marked(hit.detail, hit.detailHits), '阿昭');
  });

  test('第二个别名的高亮落在它自己身上', () => {
    const hit = first('小林');
    assert.equal(marked(hit.detail, hit.detailHits), '小林');
  });

  test('名字命中排在别名命中前面', () => {
    const idx = buildCatalog({
      initialized: true,
      chapters: [],
      characters: [
        { name: '老周', aliases: ['掌柜'], path: 'a.md' },
        { name: '掌柜', aliases: [], path: 'b.md' },
      ],
      lore: [],
      docs: [],
      drafts: [],
    });
    assert.deepEqual(searchQuickOpen(idx, '掌柜').hits.map((h) => h.entry.path), ['b.md', 'a.md']);
  });

  test('设定标题、文档名都认', () => {
    assert.equal(first('示例').entry.kind, 'lore');
    assert.equal(first('大纲').entry.name, '情节大纲');
    assert.equal(first('大纲').entry.badge, '架构');
    assert.equal(first('文风').entry.badge, '文档');
    // 叙事线一条线一项，名字是线名，类型标记写「叙事线」。
    assert.equal(first('旧案').entry.badge, '叙事线');
  });

  test('英文不分大小写', () => {
    assert.equal(first('EXAMPLE').entry.kind, 'lore');
  });

  test('查询里的空白不算（林 昭 = 林昭）', () => {
    assert.equal(first('林 昭').entry.name, '林昭');
  });
});

describe('quickOpenCore › 路径兜底', () => {
  test('名字里没有的按路径找（第一卷 → 那一卷的章），小字换成命中的路径并高亮', () => {
    const hits = search('第一卷').hits;
    const keys = hits.map((h) => h.entry.key);
    for (const k of ['chapter:2', 'chapter:3', 'chapter:12']) {
      assert.ok(keys.includes(k), keys.join('、'));
    }
    assert.ok(!keys.includes('chapter:1'));
    const ch3 = hits.find((h) => h.entry.key === 'chapter:3');
    assert.equal(ch3.detail, 'chapters/第一卷/003-夜访.md');
    assert.equal(marked(ch3.detail, ch3.detailHits), '第一卷');
  });

  test('文件名兜底（example → 标题是「示例设定」的那一条）', () => {
    const hit = first('example');
    assert.equal(hit.entry.name, '示例设定');
    assert.equal(marked(hit.detail, hit.detailHits), 'example');
  });

  test('路径命中排在名字命中后面（夜访：章节、草稿名字都有，路径里有的不抢前面）', () => {
    const hits = search('夜访').hits;
    assert.equal(hits[0].entry.key, 'chapter:3');
    assert.ok(hits.every((h, i) => i === 0 || h.score <= hits[i - 1].score));
  });

  test('路径模糊也认（smrs → summaries 下的细纲）', () => {
    assert.ok(search('smrs').total > 0);
  });

  test('哪儿都没有：一条都不给', () => {
    assert.deepEqual(search('zzzz'), { hits: [], total: 0 });
  });
});

describe('quickOpenCore › 空输入与最近打开的', () => {
  test('没有最近打开的：列前几章，按章号', () => {
    const { hits } = search('');
    assert.deepEqual(hits.map((h) => h.entry.no), [1, 2, 3, 12, 13, 105, 120]);
    assert.ok(hits.every((h) => h.group === 'chapters'));
  });

  test('最近打开的排在前面，再接前几章（已经列过的章不重复）', () => {
    const { hits } = search('', {
      recent: ['.novelforge/characters/林昭.md', 'chapters/第一卷/003-夜访.md'],
    });
    assert.deepEqual(hits.slice(0, 2).map((h) => h.entry.key), ['file:.novelforge/characters/林昭.md', 'chapter:3']);
    assert.deepEqual(hits.slice(0, 2).map((h) => h.group), ['recent', 'recent']);
    assert.equal(hits.filter((h) => h.entry.key === 'chapter:3').length, 1);
    assert.equal(hits[2].group, 'chapters');
  });

  test('同一章的正文与细纲算一条；不在索引里的（删了、不是这几类）跳过', () => {
    const { hits } = search('', {
      recent: [
        '.novelforge/summaries/第一卷/012-夜入青云.md',
        'chapters/第一卷/012-夜入青云.md',
        'notes/随手记.md',
        '.novelforge/outline.md',
      ],
    });
    const recent = hits.filter((h) => h.group === 'recent').map((h) => h.entry.key);
    assert.deepEqual(recent, ['chapter:12', 'file:.novelforge/outline.md']);
  });

  test('最近打开的最多列 8 条，前几章最多 10 章', () => {
    const big = buildCatalog({
      initialized: true,
      chapters: Array.from({ length: 30 }, (_, i) => ({ no: i + 1, title: `章${i + 1}`, volume: '', chapterPath: `chapters/${i + 1}.md`, words: 1 })),
      characters: [],
      lore: [],
      docs: [],
      drafts: [],
    });
    const recent = Array.from({ length: 12 }, (_, i) => `chapters/${30 - i}.md`);
    const { hits } = searchQuickOpen(big, '', { recent });
    assert.equal(hits.filter((h) => h.group === 'recent').length, 8);
    assert.equal(hits.filter((h) => h.group === 'chapters').length, LEAD_CHAPTERS);
  });

  test('pushRecent：新的在前、去重、只留 20 条', () => {
    assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
    const long = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const out = pushRecent(long, 'new');
    assert.equal(out.length, RECENT_KEPT);
    assert.equal(out[0], 'new');
  });
});

describe('quickOpenCore › 上限与性能', () => {
  const many = buildCatalog({
    initialized: true,
    chapters: Array.from({ length: 3000 }, (_, i) => ({
      no: i + 1,
      title: `第${i + 1}回的标题林昭`,
      volume: `第${Math.floor(i / 100) + 1}卷`,
      chapterPath: `chapters/第${Math.floor(i / 100) + 1}卷/${String(i + 1).padStart(4, '0')}.md`,
      plotPath: `.novelforge/summaries/第${Math.floor(i / 100) + 1}卷/${String(i + 1).padStart(4, '0')}.md`,
      words: 3000,
    })),
    characters: [],
    lore: [],
    docs: [],
    drafts: [],
  });

  test('最多列 50 条，报一共几条', () => {
    const { hits, total } = searchQuickOpen(many, '林昭');
    assert.equal(hits.length, QUICK_OPEN_LIMIT);
    assert.equal(total, 3000);
  });

  test('上限可以调小；章号命中的那一章仍排第一', () => {
    const { hits } = searchQuickOpen(many, '1', { limit: 5 });
    assert.equal(hits.length, 5);
    assert.equal(hits[0].entry.no, 1);
    assert.deepEqual(hits.slice(1).map((h) => h.entry.no), [10, 11, 12, 13]);
  });

  test('结果按分数从高到低', () => {
    const { hits } = searchQuickOpen(many, '林');
    assert.ok(hits.every((h, i) => i === 0 || h.score <= hits[i - 1].score));
  });

  test('三千章、连着打二十个字也不卡（宽松的上限，只挡「每打一个字排一遍整本书再排序」那种量级）', () => {
    const started = Date.now();
    for (const q of ['林', '林昭', '第', '第1', '第12', '第123', '123', '标题', '卷', 'smr', '回的', '第五十卷', '0', '9', '99', '999', '一百', '第一百章', 'zz', '昭林']) {
      searchQuickOpen(many, q);
    }
    assert.ok(Date.now() - started < 2000, `${Date.now() - started}ms`);
  });
});

describe('quickOpenCore › 小工具', () => {
  test('matchChars：子串给连着的下标，模糊给按顺序的下标', () => {
    const text = Array.from('林昭归来');
    assert.deepEqual(matchChars(text, Array.from('昭归')).hits, [1, 2]);
    assert.equal(matchChars(text, Array.from('昭归')).sub, true);
    const fuzzy = matchChars(text, Array.from('林来'));
    assert.deepEqual(fuzzy.hits, [0, 3]);
    assert.equal(fuzzy.sub, false);
    assert.equal(fuzzy.gaps, 2);
    assert.equal(matchChars(text, Array.from('来林')), undefined);
  });

  test('highlightSegments：连着的高亮并成一截，按码位切（不劈开代理对）', () => {
    assert.deepEqual(highlightSegments('林昭归来', [0, 1, 3]), [
      { text: '林昭', hit: true },
      { text: '归', hit: false },
      { text: '来', hit: true },
    ]);
    assert.deepEqual(highlightSegments('𠀋字', [1]), [
      { text: '𠀋', hit: false },
      { text: '字', hit: true },
    ]);
  });

  test('还不是小说工程的索引：空的，标着 initialized: false', () => {
    const empty = buildCatalog({ initialized: false, chapters: [], characters: [], lore: [], docs: [], drafts: [] });
    assert.equal(empty.initialized, false);
    assert.deepEqual(searchQuickOpen(empty, '').hits, []);
  });

  test('章节的打开路径：有正文是正文，没有正文是细纲', () => {
    const ch12 = catalog.entries.find((e) => e.key === 'chapter:12');
    assert.equal(ch12.path, 'chapters/第一卷/012-夜入青云.md');
    assert.deepEqual(ch12.paths, ['chapters/第一卷/012-夜入青云.md', '.novelforge/summaries/第一卷/012-夜入青云.md']);
  });

  test('没有标题的章主名称是「第 N 章」，但这几个字不参与名字匹配（章号另认）', () => {
    const c = buildCatalog({
      initialized: true,
      chapters: [{ no: 7, title: '', volume: '', chapterPath: 'chapters/007.md', words: 0 }],
      characters: [], lore: [], docs: [], drafts: [],
    });
    assert.equal(c.entries[0].name, '第 7 章');
    assert.equal(searchQuickOpen(c, '7').hits[0].score, 1000);
    assert.equal(c.entries[0].detail, '第 7 章 · 0 字');
  });
});
