/**
 * 设定的格式（model/loreFile.ts）与细纲「设定」一节（model/plotFile.ts）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 几种手写写法都认、认不出的不崩、同名只留第一行 | 第 1 条：作者会手改 |
 * | 「（无）」读回来是空数组，渲染回去还是「（无）」 | 标题在 = 记过；没有设定也要留下记过的痕迹 |
 * | 分类路径规范成 `a/b`，「未分类」是空串 | 分类就是目录，每本书自己定、可以嵌套 |
 * | 「设定」一节不进内容指纹 | 补记老章节不能把它们全挂上 ⟳ |
 * | 没有这一节是 undefined，有标题没内容是空数组 | 「还没记过」与「记过、没有」是两回事 |
 * | 两趟认条目：关键词抢不走别人的标题 | 同 views/cast.ts 的角色卡 |
 * | 认提到：最长匹配，落在别人更长的名字里的不算 | 「圣地秘境」不该把上位概念「秘境」整条带进来 |
 * | 「暗设」一节拆得出来，一句话不取它 | 写正文时不带暗设（完善设定） |
 * | 待完善只认空的、占位、全是「（未交代）」 | 不按字数猜：作者写了两行就是够了 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const lf = loadModule('src/core/model/loreFile.ts');
const pf = loadModule('src/core/model/plotFile.ts');

describe('「设定」一节的一行一条', () => {
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

describe('条目的一句话与认名字（含暗设与待完善：完善设定，2026-10-19）', () => {
  test('有 brief 用 brief；没有取正文第一句，跳过小标题与列表记号，截到 40 字', () => {
    assert.equal(lf.loreBrief({ brief: '一句话', body: '别的' }), '一句话');
    assert.equal(lf.loreBrief({ brief: '', body: '## 概要\n\n- 偏僻小镇，前不着村。镇口设卡。' }), '偏僻小镇，前不着村。');
    assert.equal(lf.loreBrief({ brief: '', body: '字'.repeat(80) }).length, lf.LORE_ENTRY_LIMITS.brief);
    assert.equal(lf.loreBrief({ brief: '', body: '' }), '');
  });

  test('缺 brief 取第一句时跳过「暗设」：一句话会进写正文的上下文', () => {
    assert.equal(lf.loreBrief({ brief: '', body: '## 暗设\n\n阁主是魔尊转世。\n\n## 概要\n\n九层木楼。' }), '九层木楼。');
  });

  test('暗设：以「暗设」开头的二级标题到下一个一二级标题为止，几节都收', () => {
    const body = [
      '## 概要',
      '',
      '九层木楼。',
      '',
      '## 暗设（未揭示）',
      '',
      '阁主是魔尊转世。',
      '### 细节',
      '三层以上无人上去过。',
      '',
      '## 现状',
      '',
      '闭阁。',
      '',
      '## 暗设',
      '密道通往后山。',
    ].join('\n');
    const { visible, hidden } = lf.splitLoreHidden(body);
    assert.equal(visible, '## 概要\n\n九层木楼。\n\n## 现状\n\n闭阁。');
    assert.equal(hidden, '阁主是魔尊转世。\n### 细节\n三层以上无人上去过。\n\n密道通往后山。');
  });

  test('没有暗设原样返回；别的标题、三级标题「### 暗设」不认（当明面）；空的、undefined 不崩', () => {
    assert.deepEqual(lf.splitLoreHidden('## 概要\n\n九层木楼。'), { visible: '## 概要\n\n九层木楼。', hidden: '' });
    assert.equal(lf.splitLoreHidden('### 暗设\n秘密').hidden, '');
    assert.equal(lf.splitLoreHidden('## 秘密\n秘密').hidden, '');
    assert.deepEqual(lf.splitLoreHidden(''), { visible: '', hidden: '' });
    assert.deepEqual(lf.splitLoreHidden(undefined), { visible: '', hidden: '' });
  });

  test('待完善：空的、新建设定的占位、三节全是「（未交代）」；写了一点就不算', () => {
    assert.equal(lf.loreThin({ body: '' }), 'empty');
    assert.equal(lf.loreThin({ body: '## 暗设\n\n阁主是魔尊转世。' }), 'empty');
    assert.equal(lf.loreThin({ body: '## 概要\n\n## 现状\n' }), 'empty');
    assert.equal(lf.loreThin({ body: `${lf.LORE_PLACEHOLDER_PREFIX}：它是什么……）` }), 'placeholder');
    assert.equal(
      lf.loreThin({ body: '## 概要\n\n（未交代）\n\n## 规则与边界\n\n- (未交代)\n\n## 现状\n\n（未交代）' }),
      'untold'
    );
    assert.equal(lf.loreThin({ body: '## 概要\n\n九层木楼。\n\n## 现状\n\n（未交代）' }), undefined);
    assert.equal(lf.loreThin({ body: '两行字，作者觉得够了。' }), undefined);
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

  // 2026-10-25 外部报告：写到第 83 章，「圣地秘境」一出现「秘境」那一条（各个秘境的汇总）就整条进上下文。
  test('最长匹配：每一处都落在别人更长的名字里的不算；单独出现的照算', () => {
    const concept = { title: '秘境', keywords: [] };
    const holy = { title: '圣地秘境', keywords: ['圣地'] };
    const magic = { title: '魔法', keywords: ['法术'] };
    const all = [concept, holy, magic];
    const hits = (text, names) => [...lf.loreMentionsIn(text, all, names)].map(([e, w]) => `${e.title}:${w}`);
    assert.deepEqual(hits('主角随教众潜入圣地秘境'), ['圣地秘境:圣地秘境']);
    assert.deepEqual(hits('圣地秘境和别的秘境不一样'), ['秘境:秘境', '圣地秘境:圣地秘境']);
    assert.deepEqual(hits('她在练习魔法'), ['魔法:魔法']);
    // 名录里记着、还没建条目的名字也算别人的名字。
    assert.deepEqual(hits('幻池秘境里不能开口', []), ['秘境:秘境']);
    assert.deepEqual(hits('幻池秘境里不能开口', ['幻池秘境']), []);
    // 一样长的不算包住；自己更长的关键词包住自己的标题照算自己。
    assert.deepEqual(hits('秘境', ['秘境']), ['秘境:秘境']);
    const gate = { title: '秘境', keywords: ['秘境入口'] };
    assert.deepEqual([...lf.loreMentionsIn('走到秘境入口', [gate]).values()], ['秘境']);
    // 一个字的不认，空文本什么都没有。
    assert.equal(lf.loreMentionsIn('', all).size, 0);
    assert.equal(lf.loreMentionsIn('牌', [{ title: '牌', keywords: [] }]).size, 0);
  });

  // 真跑（2026-10-18，gemini-3-flash-lite）：「伪人」的关键词里有人名「沈怀山」，「青羊镇」与「沈家老宅」
  // 互相写进对方的关键词——写正文时一提到这个人、这个地方，就把不相干的条目整条带进来。
  test('机器写的关键词：人名、别的条目的标题、一个字的、与标题重复的都不要', () => {
    assert.deepEqual(
      lf.cleanLoreKeywords('伪人', ['伪人', '沈怀山', '皮囊怪物', '鬼', '青羊镇', ' 皮囊怪物 '], {
        titles: ['青羊镇', '伪人'],
        people: ['沈默', '沈怀山'],
      }),
      ['皮囊怪物']
    );
  });

  test('名录里另记着的名字也不要：「魔法体系」不能把「寒冰锁」收成关键词', () => {
    // 收了的话，往后各章记下的「寒冰锁」都被认成「魔法体系」，它永远建不出自己的条目。
    assert.deepEqual(
      lf.cleanLoreKeywords('魔法体系', ['魔法', '寒冰锁', '奥术飞弹', '施法'], {
        titles: [],
        people: [],
        recorded: ['寒冰锁', '奥术飞弹', '魔法体系'],
      }),
      ['魔法', '施法']
    );
  });
});

describe('细纲的「设定」一节', () => {
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

  test('读出「设定」一节，连续性事实不被它吃进去', () => {
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

  test('「设定」一节不进内容指纹', () => {
    const with_ = pf.parsePlotFile(FILE, '.novelforge/summaries/003-夜访.md');
    const without = pf.parsePlotFile(FILE.replace(/## 设定[\s\S]*$/, ''), '.novelforge/summaries/003-夜访.md');
    assert.equal(pf.plotContentHash(with_), pf.plotContentHash(without));
  });

  test('渲染：给了才写，写在七节之后；读回来一样', () => {
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

describe('模型给的「设定」', () => {
  test('对象、字符串、整段多行都认；同名只留一条', () => {
    assert.deepEqual(
      lf.loreLinesFromJson([
        { name: '青崖镇', category: '地域', fact: '镇口设卡' },
        { title: '过所', note: '出入凭证' },
        '崖字令牌〔信物〕：不止一块',
        { name: '「青崖镇」', fact: '重复的' },
        { category: '没有名字' },
        42,
      ]),
      [
        { name: '青崖镇', category: '地域', note: '镇口设卡' },
        { name: '过所', category: '', note: '出入凭证' },
        { name: '崖字令牌', category: '信物', note: '不止一块' },
      ]
    );
    assert.deepEqual(lf.loreLinesFromJson('- 后山〔地域〕\n- 黑市'), [
      { name: '后山', category: '地域', note: '' },
      { name: '黑市', category: '', note: '' },
    ]);
    assert.deepEqual(lf.loreLinesFromJson(undefined), []);
  });

  const TEXT = '林昭进了青崖镇。镇口的守卫查验过所，见了令牌就放行。停舟客栈是镇上唯一的客栈。';
  const entries = [
    { slug: '地域/青崖镇', title: '青崖镇', keywords: ['青崖'], category: '地域' },
    { slug: '信物/崖字令牌', title: '崖字令牌', keywords: ['令牌'], category: '信物' },
  ];

  test('名字要逐字出现在正文里；人名不算；已有条目换成标题与实际目录', () => {
    const r = lf.verifyLoreLines(
      [
        { name: '青崖', category: '地点', note: '' },
        { name: '令牌', category: '物品', note: '' },
        { name: '黑市', category: '地点', note: '' },
        { name: '林昭', category: '人物', note: '' },
        { name: '停舟客栈', category: '地域/青崖', note: '' },
      ],
      TEXT,
      { entries, people: ['林昭'] }
    );
    assert.deepEqual(r.lines, [
      { name: '青崖镇', category: '地域', note: '' },
      { name: '崖字令牌', category: '信物', note: '' },
      { name: '停舟客栈', category: '地域/青崖', note: '' },
    ]);
    assert.deepEqual(
      r.dropped.map((d) => [d.name, d.why]),
      [
        ['黑市', '正文里没有这个名字'],
        ['林昭', '是角色卡上的人'],
      ]
    );
  });

  test('说明要在正文里找得到依据，找不到清空说明、留下名字', () => {
    const r = lf.verifyLoreLines(
      [
        { name: '停舟客栈', category: '', note: '镇上唯一的客栈' },
        { name: '青崖镇', category: '', note: '建在海底的城市' },
      ],
      TEXT,
      { entries, people: [] }
    );
    assert.deepEqual(r.lines, [
      { name: '停舟客栈', category: '', note: '镇上唯一的客栈' },
      { name: '青崖镇', category: '地域', note: '' },
    ]);
    assert.equal(r.cleared.length, 1);
    assert.ok(r.cleared[0].why.includes('建在海底的城市'));
  });

  test('最多 12 行', () => {
    const names = Array.from({ length: 15 }, (_, i) => `地名${String.fromCharCode(0x4e00 + i)}`);
    const r = lf.verifyLoreLines(
      names.map((name) => ({ name, category: '', note: '' })),
      names.join('，'),
      { entries: [], people: [] }
    );
    assert.equal(r.lines.length, lf.LORE_LINE_LIMITS.lines);
    assert.equal(r.dropped.length, 3);
  });
});
