/**
 * 写完一章之后的几项确定性检查与续写回退点（model/manuscriptCheck.ts，五期补遗 §1）。
 *
 * - 比喻词按三个词合计数，说明里逐个列；
 * - 拉丁字母缩写：两个以上大写字母连写才算，全角折成半角，去重；
 * - 「本章不出场」：后面几章才排到的人，本章与前面排过的不算；
 * - 提前登场：名字或两个字以上的别名出现了，引那一句；
 * - 回退点：与钩子最像的那一段起切；找不到切最后约四分之一；至少留一半；只有一段不切。
 * - 找位置（内置编辑器的写作体检也打包这几个）：`locateTerms` 每个词各找各的、不重叠，与 `split` 数的一样多
 *   （计数都建在它上面）；`foldCase` 只折拉丁字母、长度不变；`latinAcronymRanges` 每一处都给、位置是原文的。
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

describe('manuscriptCheck · 找位置（计数都建在它上面）', () => {
  test('每个词各找各的、从左往右、不重叠；叠在同一段字上的两个词各算各的', () => {
    const hits = m.locateTerms('数据库里的数据，数据数据', ['数据', '数据库', '没有']);
    assert.deepEqual(JSON.parse(JSON.stringify(hits)), [
      { term: '数据', offsets: [0, 5, 8, 10] },
      { term: '数据库', offsets: [0] },
      { term: '没有', offsets: [] },
    ]);
  });

  test('同一个词不重叠：「aaa」里的「aa」只有一处（与 split 一样）', () => {
    assert.deepEqual(m.locateTerms('aaaa', ['aa'])[0].offsets, [0, 2]);
    assert.deepEqual(m.locateTerms('aaa', ['aa'])[0].offsets, [0]);
  });

  test('重复的词各给一份、空串没有命中、空文字不抛', () => {
    const hits = m.locateTerms('能量能量', ['能量', '', '能量']);
    assert.deepEqual(hits.map((h) => h.offsets), [[0, 2], [], [0, 2]]);
    assert.deepEqual(m.locateTerms(undefined, ['能量'])[0].offsets, []);
  });

  test('与 split 数出来的一样多（固定样本 + 随机 300 段）', () => {
    const alphabet = ['能', '量', '数', '据', 'a', 'b', '，', '仿', '佛'];
    const terms = ['能量', '数据', '量能', 'ab', 'aa', '仿佛', '能'];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let k = 0; k < 300; k++) {
      const text = Array.from({ length: Math.floor(rand() * 60) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      const hits = m.locateTerms(text, terms);
      for (const h of hits) {
        assert.equal(h.offsets.length, text.split(h.term).length - 1, `${text} / ${h.term}`);
        for (const at of h.offsets) {
          assert.equal(text.slice(at, at + h.term.length), h.term);
        }
      }
    }
  });

  test('foldCase：英文不分大小写、全角字母当半角；位置是原文的', () => {
    const text = 'Hello HELLO ｈｅｌｌｏ ＨＥＬＬＯ hello';
    assert.deepEqual(m.locateTerms(text, ['hello'], { foldCase: true })[0].offsets, [0, 6, 12, 18, 24]);
    assert.deepEqual(m.locateTerms(text, ['HeLLo'], { foldCase: true })[0].offsets, [0, 6, 12, 18, 24]);
    // 不折时区分大小写（禁用词就是这么数的）。
    assert.deepEqual(m.locateTerms(text, ['hello'])[0].offsets, [24]);
  });

  test('foldLatin 只折拉丁字母、一个字换一个字', () => {
    const text = 'ABCｘｙｚＸＹＺ能量Ωé';
    const folded = m.foldLatin(text);
    assert.equal(folded, 'abcxyzxyz能量Ωé');
    assert.equal(folded.length, text.length);
  });

  test('countBanned / countSimiles / describeSimiles 的数与 locateTerms 一致', () => {
    const text = '能量涌动，仿佛潮水；能量退去，犹如梦醒，仿佛未醒。';
    assert.deepEqual(m.countBanned(text, ['能量', '神经']), [{ term: '能量', count: 2 }]);
    assert.equal(m.countSimiles(text), 3);
    assert.equal(m.describeSimiles(text), '「仿佛」2 次、「犹如」1 次');
    assert.deepEqual(m.locateSimiles(text).filter((h) => h.offsets.length).map((h) => [h.term, h.offsets]), [
      ['仿佛', [5, 20]],
      ['犹如', [15]],
    ]);
  });

  test('latinAcronymRanges：每一处都给、按出现顺序、全角的位置是原文的', () => {
    const text = 'PTSD 与ＰＴＳＤ，还有CPU。';
    assert.deepEqual(JSON.parse(JSON.stringify(m.latinAcronymRanges(text))), [
      { term: 'PTSD', start: 0, end: 4 },
      { term: 'PTSD', start: 6, end: 10 },
      { term: 'CPU', start: 13, end: 16 },
    ]);
    assert.deepEqual(m.latinAcronyms(text), ['PTSD', 'CPU']);
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

// 章末钩子并进「看点」之后不再按钩子找收尾那一场，一律从末尾按比例切。
describe('manuscriptCheck · 回退点', () => {
  const para = (ch, n) => ch.repeat(n);

  test('从末尾切约四分之一', () => {
    const text = [para('甲', 400), para('乙', 300), para('丙', 200), para('丁', 100)].join('\n\n');
    const r = m.rewindPoint(text);
    assert.ok(r);
    // 最后两段 300 字，正好过了四分之一（250）。
    assert.equal(r.paragraphs, 2);
    assert.equal(r.keep, [para('甲', 400), para('乙', 300)].join('\n\n'));
    assert.equal(r.cut, [para('丙', 200), para('丁', 100)].join('\n\n'));
  });

  test('至少留一半', () => {
    const text = [para('甲', 100), para('乙', 400), para('丙', 400)].join('\n\n');
    const r = m.rewindPoint(text);
    assert.ok(r);
    assert.ok(r.keep.length >= r.cut.length);
  });

  test('只有一段：没法切', () => {
    assert.equal(m.rewindPoint(para('甲', 500)), undefined);
  });

  test('最多切 600 字', () => {
    const text = Array.from({ length: 20 }, (_, i) => para('甲乙丙丁戊己庚辛'[i % 8], 200)).join('\n\n');
    const r = m.rewindPoint(text);
    assert.ok(r);
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
