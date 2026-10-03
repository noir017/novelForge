/**
 * 写完一章之后的几项确定性检查与续写回退点（model/manuscriptCheck.ts，五期补遗 §1）。
 *
 * - 比喻词按三个词合计数，说明里逐个列；
 * - 拉丁字母缩写：两个以上大写字母连写才算，全角折成半角，去重；
 * - 「本章不出场」：后面几章才排到的人，本章与前面排过的不算；
 * - 提前登场：名字或两个字以上的别名出现了，引那一句；
 * - 回退点：与钩子最像的那一段起切；找不到切最后约四分之一；至少留一半；只有一段不切。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const m = loadModule('src/core/model/manuscriptCheck.ts');

describe('manuscriptCheck · 比喻词', () => {
  test('三个词合计', () => {
    assert.equal(m.countSimiles('仿佛一场梦。犹如隔世。宛如新生，仿佛未醒。'), 4);
    assert.equal(m.countSimiles('没有比喻。'), 0);
  });

  test('说明里逐个列，0 次的不列', () => {
    assert.equal(m.describeSimiles('仿佛，仿佛，宛如'), '「仿佛」2 次、「宛如」1 次');
  });
});

describe('manuscriptCheck · 对白占比', () => {
  test('带引号的段占全部段的比例', () => {
    assert.equal(m.dialogueShare('他走了。\n\n“站住。”\n\n她说：「别走」。\n\n雨停了。'), 0.5);
  });

  test('没有段时不提醒', () => {
    assert.equal(m.dialogueShare(''), 1);
  });
});

describe('manuscriptCheck · 停在半句', () => {
  test('结尾不是句末标点就算停在半句', () => {
    assert.equal(m.endsMidSentence('他已经到了极限，全身'), true);
    assert.equal(m.endsMidSentence('他已经到了极限，全身，'), true);
  });

  test('句号、问叹号、省略号、收引号、破折号收尾都不算；末尾空白先去掉', () => {
    for (const t of ['走了。', '走了？', '走了！', '走了……', '“走了。”', '「走了」', '他走了——', '走了。\n\n  ']) {
      assert.equal(m.endsMidSentence(t), false, t);
    }
  });

  test('空文本不算', () => {
    assert.equal(m.endsMidSentence(''), false);
    assert.equal(m.endsMidSentence('  \n'), false);
  });
});

describe('manuscriptCheck · 拉丁字母缩写', () => {
  test('两个以上大写字母连写才算，去重、按出现顺序', () => {
    assert.deepEqual(m.latinAcronyms('他的PTSD又发作了，PTSD让他头晕，CPU也烧了。'), ['PTSD', 'CPU']);
  });

  test('单个字母、小写、混写的单词不算', () => {
    assert.deepEqual(m.latinAcronyms('A 字头，ok，iPhone，Hello'), []);
  });

  test('全角字母折成半角', () => {
    assert.deepEqual(m.latinAcronyms('严重的ＰＴＳＤ'), ['PTSD']);
  });
});

describe('manuscriptCheck · 本章不出场', () => {
  test('后面几章才排到、本章与前面都没排过的人，按第一次排到的章号', () => {
    const out = m.notYetOnStage({
      self: ['陆烬'],
      previous: [{ no: 1, characters: ['陆烬', '陈婆婆'] }],
      ahead: [
        { no: 5, characters: ['陆瑶', '沈秋'] },
        { no: 4, characters: ['陆烬', '沈秋', '陈婆婆'] },
      ],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(out)), [
      { name: '沈秋', no: 4 },
      { name: '陆瑶', no: 5 },
    ]);
  });

  test('没有后文就是空的', () => {
    assert.deepEqual(m.notYetOnStage({ self: ['甲'], previous: [], ahead: [] }), []);
  });
});

describe('manuscriptCheck · 提前登场', () => {
  test('名字出现了：引第一次出现的那一句', () => {
    const text = '雾越来越浓。\n\n巷子尽头站着一个人。是沈秋。他没有看陆烬。';
    const out = m.findEarlyEntrances(text, [{ name: '沈秋', no: 4 }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, '沈秋');
    assert.equal(out[0].no, 4);
    assert.equal(out[0].quote, '是沈秋。');
  });

  test('别名也认；单字别名不认', () => {
    const text = '“秋哥来了。”有人喊。';
    assert.equal(m.findEarlyEntrances(text, [{ name: '沈秋', no: 4, aliases: ['秋哥'] }]).length, 1);
    assert.equal(m.findEarlyEntrances('秋天到了。', [{ name: '沈秋', no: 4, aliases: ['秋'] }]).length, 0);
  });

  test('没出现就是空的', () => {
    assert.deepEqual(m.findEarlyEntrances('陆烬独自走了。', [{ name: '沈秋', no: 4 }]), []);
  });

  // 真实模型试跑：角色图谱起的名字是「镇守人（陈道源）」，正文里写的是「陈道源」或别名「陈老爷」。
  test('名字带括号：括号里外各一截也认', () => {
    assert.deepEqual(m.namesOf('镇守人（陈道源）', ['陈老爷', '某']), ['镇守人（陈道源）', '镇守人', '陈道源', '陈老爷']);
    assert.equal(m.findEarlyEntrances('陈道源坐在太师椅上。', [{ name: '镇守人（陈道源）', no: 4 }]).length, 1);
  });

  test('本章细纲自己提到的人不算「不出场」（按名字、括号里外与别名认）', () => {
    const list = [
      { name: '镇守人（陈道源）', no: 4, aliases: ['陈老爷'] },
      { name: '红姑', no: 5, aliases: [] },
    ];
    const kept = m.dropMentioned(list, '老客提醒他祠堂里的陈老爷正在到处搜寻火场里的漏网之鱼。');
    assert.deepEqual(kept.map((x) => x.name), ['红姑']);
  });
});

describe('manuscriptCheck · 回退点', () => {
  const para = (ch, n) => ch.repeat(n);

  test('与钩子最像的那一段起切', () => {
    const hook = '陆烬看清了枷锁缝隙里刻着的守门人族徽';
    const text = [
      para('甲', 300),
      para('乙', 300),
      para('丙', 200),
      '他借着月光，终于看清了枷锁缝隙里刻着的那枚族徽——守门人的标志。',
      '陆烬握紧了刀。',
    ].join('\n\n');
    const r = m.rewindPoint(text, hook);
    assert.ok(r);
    assert.equal(r.byHook, true);
    assert.equal(r.paragraphs, 2);
    assert.equal(r.keep, [para('甲', 300), para('乙', 300), para('丙', 200)].join('\n\n'));
    assert.ok(r.cut.startsWith('他借着月光'));
  });

  test('找不到钩子：从末尾切约四分之一', () => {
    const text = [para('甲', 400), para('乙', 300), para('丙', 200), para('丁', 100)].join('\n\n');
    const r = m.rewindPoint(text, '一个根本没写到的钩子');
    assert.ok(r);
    assert.equal(r.byHook, false);
    // 最后两段 300 字，正好过了四分之一（250）。
    assert.equal(r.paragraphs, 2);
    assert.equal(r.keep, [para('甲', 400), para('乙', 300)].join('\n\n'));
  });

  test('至少留一半：钩子落在前半截时不按它切', () => {
    const hook = '守门人族徽';
    const text = ['守门人族徽就在这里', para('乙', 400), para('丙', 400)].join('\n\n');
    const r = m.rewindPoint(text, hook);
    assert.ok(r);
    assert.equal(r.byHook, false);
    assert.ok(r.keep.length >= r.cut.length);
  });

  test('只有一段：没法切', () => {
    assert.equal(m.rewindPoint(para('甲', 500), '钩子'), undefined);
  });

  // 真实正文一段只有六十来字，钩子那一幕拆在两三段里：单看哪一段都不够像，三段一窗才认得出。
  test('钩子拆在几段短段落里：按窗口认', () => {
    const hook = '陆烬借着月光看清了枷锁缝隙中刻着的族徽，那竟是属于守门人家族的标志';
    const text = [
      ...Array.from({ length: 12 }, (_, i) => para('甲乙丙丁戊己庚辛'[i % 8], 60)),
      '他借着月光凑近了枷锁。',
      '缝隙中刻着一枚族徽。',
      '那竟是守门人家族的标志。',
    ].join('\n\n');
    const r = m.rewindPoint(text, hook);
    assert.ok(r);
    assert.equal(r.byHook, true);
    assert.equal(r.paragraphs, 3);
  });

  test('认不出钩子时最多切 600 字', () => {
    const text = Array.from({ length: 20 }, (_, i) => para('甲乙丙丁戊己庚辛'[i % 8], 200)).join('\n\n');
    const r = m.rewindPoint(text, '没写到的钩子');
    assert.ok(r);
    assert.equal(r.byHook, false);
    assert.equal(r.paragraphs, 3);
  });
});

// 百章实验：全局要求写着「严禁使用现代科学或心理学词汇」，正文照样写了「能量」33 次——没人数。
describe('manuscriptCheck · 禁用词', () => {
  test('文风指南禁用词表里括起来的词', () => {
    assert.deepEqual(m.bannedTerms({ styleBanList: '不使用「不禁」「顿时」“仿佛整个世界”这类套话' }), ['不禁', '顿时', '仿佛整个世界']);
  });

  test('全局要求：只收表禁止的那一个分句里括起来的词，要用的词不收', () => {
    const guidance = '严禁使用“系统”“面板”一类词，情绪须用“惊悸”、“心病”表达；不要写「众所周知」。';
    assert.deepEqual(m.bannedTerms({ guidance }), ['系统', '面板', '众所周知']);
  });

  test('古代、修真一类题材带上内置的现代说法；都市不带', () => {
    assert.ok(m.bannedTerms({ genre: '仙侠 凡人流' }).includes('能量'));
    assert.ok(m.bannedTerms({ genre: '历史' }).includes('神经'));
    assert.deepEqual(m.bannedTerms({ genre: '都市' }), []);
  });

  test('去重；太长的不算词', () => {
    assert.deepEqual(m.bannedTerms({ styleBanList: '「能量」「这是一句很长很长的话不是词」', genre: '仙侠' }).filter((t) => t === '能量').length, 1);
    assert.ok(!m.bannedTerms({ styleBanList: '「这是一句很长很长的话不是词」' }).length);
  });

  test('数几次，按次数排；说明里逐个列', () => {
    const list = m.countBanned('能量涌动，神经一跳，能量又散了。', ['神经', '能量', '坐标']);
    assert.deepEqual(list, [{ term: '能量', count: 2 }, { term: '神经', count: 1 }]);
    assert.equal(m.describeBanned(list), '「能量」2 次、「神经」1 次');
  });

  test('比喻词也数「如同」「好似」', () => {
    assert.equal(m.countSimiles('如同死水，好似梦境，恍如隔世，宛若新生。'), 4);
  });
});
