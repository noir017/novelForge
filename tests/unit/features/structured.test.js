/**
 * 结构化产物的解码：细纲批次、角色图谱两段式、小说配置，以及语法修复的证据校验。
 *
 * 全部是纯函数（features/structuredJson.ts、blueprint.ts、roster.ts、novelConfig.ts），
 * 生成链怎么用它们在 tests/integration/generation/structuredChain.test.js。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 语法修复证据 | 修过的那份只许补闭合括号、改标点；改一个字就拒收（不许借修复补造事实） |
 * | 转写有没有照抄 | 细纲试点：转写的每段文字都得出自原文，去掉列表记号、并条拆条、换引号不算改；「无」换成空的 |
 * | 细纲批次 | 缺必填字段报诊断（交给拆半 / 紧凑重建）；可以空着的四个字段宽松收；超长截断不作废；新角色必须在出场名单里；关键事件是一条一件事的数组，给成一段字按换行与分号切 |
 * | 角色图谱 | 清单里关系不闭合、没标主角照收并说明；详情以冻结清单为准；关系由清单生成到双方卡上 |
 * | 设定清单 | 分类规范成目录路径；已有条目照抄名字、以实际目录为准；人名丢掉；超过 30 条只留 30 条；详情以冻结清单为准、三节合计 300 字 |
 * | 小说配置 | 英文键映射到七节；「全局要求」的合同；保留作者原文；规范化草稿能按 config.md 读回来 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const J = loadModule('src/core/features/structuredJson.ts');
const B = loadModule('src/core/features/blueprint.ts');
const R = loadModule('src/core/features/roster.ts');
const L = loadModule('src/core/features/loreList.ts');
const C = loadModule('src/core/features/novelConfig.ts');
const A = loadModule('src/core/features/artifact.ts');
const S = loadModule('src/core/model/settingFile.ts');

const item = (no, over = {}) => ({
  chapterNumber: no,
  title: `第${no}章标题`,
  synopsis: `第 ${no} 章的梗概`,
  characters: ['林昭', '沈青'],
  timePlace: `第 ${no} 章的时间地点`,
  keyEvents: [`第 ${no} 章林昭在山门外踩点`, `第 ${no} 章翻墙进了后院`],
  highlights: [`第 ${no} 章的爽点`, `第 ${no} 章的钩子`],
  stateChange: `第 ${no} 章之后的处境`,
  threads: [{ line: '林昭与沈青', type: '推进', what: `第 ${no} 章两人联手` }],
  ...over,
});

describe('structuredJson.ts · 语法修复的证据校验', () => {
  test('看起来是 JSON 却解析不了，才值得修', () => {
    assert.equal(J.isRepairableJsonSyntax('{"a": 1,}'), true);
    assert.equal(J.isRepairableJsonSyntax('```json\n{"a": [1, 2}\n```'), true);
    assert.equal(J.isRepairableJsonSyntax('{"a": 1}'), false);
    assert.equal(J.isRepairableJsonSyntax('好的，这是细纲：{"a": 1'), false);
  });

  test('只补闭合括号、删多余逗号：通过', () => {
    assert.equal(J.preservesJsonEvidence('{"a": [1, "x"', '{"a": [1, "x"]}'), true);
    assert.equal(J.preservesJsonEvidence('{"a": 1,}', '{"a": 1}'), true);
  });

  // 复跑报告问题 7（rerun-repro.js 第 2 段）：拆细纲时模型在结尾多写了一个 `]`，修复只删了它，却被判成改了内容、整批拒收。
  test('只动了最后一个值后面那一串收尾括号（多删少补、换一个）：通过；中间的括号动了照旧拒收', () => {
    const bad = '{"blueprints":[{"chapterNumber":13,"title":"甲","threads":[{"line":"主线","type":"推进","what":"乙"}]}]]}';
    const fixed = '{"blueprints":[{"chapterNumber":13,"title":"甲","threads":[{"line":"主线","type":"推进","what":"乙"}]}]}';
    assert.equal(J.preservesJsonEvidence(bad, fixed), true);
    assert.equal(J.preservesJsonEvidence('{"a": [{"b": 1}}', '{"a": [{"b": 1}]}'), true);
    assert.equal(J.preservesJsonEvidence('{"a": [{"b": 1}]]]}', '{"a": [{"b": 1}]}'), true);
    // 最后一个值之前的括号动了：哪个值属于哪个对象可能变了，不认。
    assert.equal(J.preservesJsonEvidence('{"a": [1]], "b": 2}', '{"a": [1], "b": 2}'), false);
    assert.equal(J.preservesJsonEvidence('{"a": [1]], "b": 2}', '{"a": [1, "b", 2]}'), false);
    // 尾巴上动了括号，值却改了：照旧拒收。
    assert.equal(J.preservesJsonEvidence(bad, fixed.replace('乙', '丙')), false);
  });

  test('改了一个字、补了一个值、调了顺序：一律拒收', () => {
    assert.equal(J.preservesJsonEvidence('{"a": "林昭"', '{"a": "林照"}'), false);
    assert.equal(J.preservesJsonEvidence('{"a": 1', '{"a": 1, "b": 2}'), false);
    assert.equal(J.preservesJsonEvidence('{"a": 1, "b": 2', '{"b": 2, "a": 1}'), false);
    assert.equal(J.preservesJsonEvidence('{"a": 1', '{"a": 1'), false);
  });

  test('唯一一个完整对象：两个就说不清哪个是答案', () => {
    assert.deepEqual(J.singleJsonObject('前言 {"a": 1} 后记').value, { a: 1 });
    assert.equal(J.singleJsonObject('{"a": 1} {"b": 2}').reason, 'multiple');
    assert.equal(J.singleJsonObject('{"a": {"b": 1}').reason, 'truncated');
  });
});

// 细纲试点（2026-10-25）：写细纲的模型按小标题写，转写模型照抄成 JSON——每一段文字都得出自原文。
describe('structuredJson.ts · 转写有没有照抄', () => {
  const SKIP = new Set(['chapterNumber', 'type']);
  const source = ['## 第3章：雨夜', '### 关键事件', '- 林昭在山门外踩点。', '- 他翻墙进了后院，落在「藏书阁」门口。', '### 叙事线', '- 青云旧案·推进：林昭摸到藏书阁。'].join('\n');

  test('去掉行首的「-」、把两行并成一条、换个引号：都算照抄', () => {
    const value = {
      title: '雨夜',
      keyEvents: ['林昭在山门外踩点', '林昭在山门外踩点。他翻墙进了后院，落在"藏书阁"门口'],
      threads: [{ line: '青云旧案', type: '推进', what: '林昭摸到藏书阁。' }],
    };
    assert.deepEqual(J.unfaithfulStrings(source, value, SKIP), []);
  });

  test('改了一个字、补了原文没有的一句：交回那几段', () => {
    const value = { keyEvents: ['林昭在山门外踩点。', '林昭在山门外踩了点。', '沈青在井边等他。'] };
    assert.deepEqual(J.unfaithfulStrings(source, value, SKIP), ['林昭在山门外踩了点。', '沈青在井边等他。']);
  });

  test('按对应关系填的键不比；交回的最多几段，长的截到 30 字', () => {
    assert.deepEqual(J.unfaithfulStrings(source, { chapterNumber: 3, threads: [{ type: '收束' }] }, SKIP), []);
    const long = '这一句是原文里根本没有的很长很长的一段话，转写模型自己编出来的，比三十个字还要长一些。';
    const off = J.unfaithfulStrings(source, { a: [long, '甲', '乙', '丙'] }, SKIP);
    assert.equal(off.length, 3);
    assert.ok(off[0].endsWith('…') && Array.from(off[0]).length === 31, off[0]);
  });

  // 坏了语法的 JSON 也交给转写理顺：原文里的 \n 还是转义的样子，还原了再比。
  test('原文是坏了语法的 JSON：转义还原了再比', () => {
    const broken = '{"blueprints":[{"keyEvents":"林昭踩点；\\n翻墙进了后院",}]}';
    assert.deepEqual(J.unfaithfulStrings(broken, { keyEvents: ['林昭踩点', '翻墙进了后院'] }, SKIP), []);
  });

  test('「无」换成空的，列表里的去掉', () => {
    assert.deepEqual(J.withoutNone({ a: '无', b: ['无', '甲', '（无）'], c: { d: '无。' }, e: 3, f: '无名氏' }), {
      a: '',
      b: ['甲'],
      c: { d: '' },
      e: 3,
      f: '无名氏',
    });
  });

  test('整段是 JSON 就取它，否则取唯一一个完整对象；都不是给 undefined', () => {
    assert.deepEqual(J.jsonValueOf('[1, 2]'), [1, 2]);
    assert.deepEqual(J.jsonValueOf('好的：{"a": 1}'), { a: 1 });
    assert.equal(J.jsonValueOf('## 第3章：雨夜'), undefined);
  });
});

describe('blueprint.ts · 细纲批次', () => {
  test('合格的一批：字段对上细纲七节，新角色带出来', () => {
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [item(1, { newCharacters: [{ name: '沈青', role: 'supporting' }] }), item(2)],
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.items.map((b) => b.no), [1, 2]);
    assert.deepEqual(r.items[0].newCharacters, [{ name: '沈青', role: '配角' }]);
    const plot = B.blueprintToPlot(r.items[0]);
    assert.deepEqual(plot.sections, {
      梗概: '第 1 章的梗概',
      出场人物: '林昭、沈青',
      时间地点: '第 1 章的时间地点',
      关键事件: '- 第 1 章林昭在山门外踩点\n- 第 1 章翻墙进了后院',
      看点: '- 第 1 章的爽点\n- 第 1 章的钩子',
      状态变更: '第 1 章之后的处境',
      连续性事实: '',
    });
    assert.equal(plot.title, '第1章标题');
    // 叙事线的计划（二期）不进细纲：随产物带着，写入时写进各条线。
    assert.deepEqual(plot.threads, [{ line: '林昭与沈青', type: '推进', what: '第 1 章两人联手' }]);
  });

  // 设定名录：settings 可选、宽松收；isNew 的随细纲建空条目，其余只进「设定」一节。
  test('settings：可选、宽松收，落盘成「设定」一节；超过 8 条只留前 8 条', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `地名${i}`, category: '地域' }));
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [
        item(1, { settings: [{ name: '古井', category: '地域/青崖', isNew: true, note: '镇北的枯井' }, '青崖镇〔地域〕'] }),
        item(2),
        item(3, { settings: many }),
        item(4, { settings: '不是数组也不作废' }),
      ],
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.items[0].settings, [
      { name: '古井', category: '地域/青崖', note: '镇北的枯井', isNew: true },
      { name: '青崖镇', category: '地域', note: '', isNew: false },
    ]);
    assert.deepEqual(B.blueprintToPlot(r.items[0]).lore, [
      { name: '古井', category: '地域/青崖', note: '镇北的枯井' },
      { name: '青崖镇', category: '地域', note: '' },
    ]);
    assert.deepEqual(r.items[1].settings, []);
    assert.equal(r.items[2].settings.length, 8);
    assert.ok(r.warnings.some((w) => w.includes('第 3 章列了 10 条设定')), r.warnings.join('\n'));
    assert.equal(r.items[3].settings.length, 1);
    // 生成链交给气泡、采纳时重新解析的是规范化的那一份：settings 不能在这一步丢掉。
    assert.deepEqual(B.decodeBlueprints(B.renderBlueprints(r.items)).items[0].settings, r.items[0].settings);
  });

  test('单章（落定 / 写细纲）也认 settings；没写就不带，落盘时沿用磁盘那份', () => {
    const withLore = A.parsePlotStrict(JSON.stringify({ blueprints: [item(1, { settings: [{ name: '古井', category: '地域' }] })] }));
    assert.deepEqual(withLore.lore, [{ name: '古井', category: '地域', note: '' }]);
    const without = A.parsePlotStrict(JSON.stringify({ blueprints: [item(1)] }));
    assert.equal(without.lore, undefined);
  });

  // 过渡章不动哪条线是常事：为一个空数组作废整批再调一次不划算。
  test('时间地点 / 看点 / 状态变更 / threads 可以缺、可以空，形状写错了照收', () => {
    const { timePlace, highlights, threads, stateChange, ...bare } = item(1);
    void timePlace;
    void highlights;
    void threads;
    void stateChange;
    const r = B.decodeBlueprints(JSON.stringify({ blueprints: [bare, item(2, { highlights: '一行写成的看点', threads: '不是数组', stateChange: ['甲', '乙'] })] }));
    assert.equal(r.ok, true);
    assert.deepEqual([r.items[0].timePlace, r.items[0].highlights, r.items[0].stateChange], ['', [], '']);
    // 没写 threads：不带这个字段（写入时不动原来的计划）；写成别的形状：当空的，说一句。
    assert.equal(r.items[0].threads, undefined);
    assert.deepEqual(r.items[1].threads, []);
    assert.match(r.warnings.join('\n'), /第 2 章的叙事线计划（threads）不是列表/);
    assert.deepEqual(r.items[1].highlights, ['一行写成的看点']);
    assert.equal(r.items[1].stateChange, '甲；乙');
  });

  test('看点超过条数与字数：截断并说明', () => {
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [item(1, { highlights: Array.from({ length: 7 }, (_, i) => `看点${i}`) })],
    }));
    assert.equal(r.items[0].highlights.length, 5);
    assert.match(r.warnings.join('\n'), /highlights 列了 7 条/);
  });

  // 叙事线二期：原来的 foreshadowing 换成 threads（一章最多 6 条）。合同的形状在解码这一步只认结构，线认不认得出落盘时才知道。
  test('threads：类型、伏笔名、线名逐条校验，没收的写进说明；同一条只留一条，一章最多 6 条；规范化输出原样认得', () => {
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [
        item(1, {
          threads: [
            { line: '林昭与沈青', type: '推进', what: '两人联手' },
            { line: '林昭与沈青', type: '推进', what: '同一条线同一种类型，重复' },
            { line: '', type: '埋', foreshadowing: '玉佩的来历', what: '玉佩露面', resolve: 9 },
            { line: '青崖旧案', type: '收', foreshadowing: '断剑', what: '断剑出水', resolve: 9 },
            { line: '青崖旧案', type: '放弃', what: '计划里不认' },
            { line: '青崖旧案', type: '埋', what: '没写是哪一条伏笔' },
            { type: '关系', what: '没写是哪一条线' },
            { line: '青崖旧案', type: '收束', what: '这条线走完了' },
            { line: '甲', type: '推进', what: '第 5 条' },
            { line: '乙', type: '推进', what: '第 6 条' },
            { line: '丙', type: '推进', what: '第 7 条，超了' },
          ],
        }),
      ],
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.items[0].threads, [
      { line: '林昭与沈青', type: '推进', what: '两人联手' },
      { line: '', type: '埋', foreshadowing: '玉佩的来历', what: '玉佩露面', resolve: 9 },
      { line: '青崖旧案', type: '收', foreshadowing: '断剑', what: '断剑出水' },
      { line: '青崖旧案', type: '收束', what: '这条线走完了' },
      { line: '甲', type: '推进', what: '第 5 条' },
      { line: '乙', type: '推进', what: '第 6 条' },
    ]);
    const w = r.warnings.join('\n');
    assert.match(w, /青崖旧案 放弃：类型不是推进 \/ 关系 \/ 收束 \/ 埋 \/ 收之一，没收/);
    assert.match(w, /青崖旧案 埋：没写是哪一条伏笔，没收/);
    assert.match(w, /？ 关系：没写是哪一条线，没收/);
    assert.match(w, /丙 推进：一章最多写 6 条，没收/);
    assert.deepEqual(B.decodeBlueprints(B.renderBlueprints(r.items)).items[0].threads, r.items[0].threads);
  });

  test('单章（落定 / 写细纲）也认 threads，没写就不带', () => {
    const one = A.parsePlotStrict(JSON.stringify({ blueprints: [item(3, { threads: [{ line: '林昭与沈青', type: '关系', what: '结盟' }, { type: '收' }] })] }));
    assert.deepEqual(one.threads, [{ line: '林昭与沈青', type: '关系', what: '结盟' }]);
    assert.match(one.planNotes.join('\n'), /第 3 章的叙事线计划 ？ 收：没写是哪一条伏笔/);
    const without = A.parsePlotStrict(JSON.stringify({ blueprints: [item(3, { threads: undefined })] }));
    assert.equal(without.threads, undefined);
    assert.equal(without.planNotes, undefined);
  });

  test('裸数组、围栏、JSON 前后的废话都认', () => {
    assert.equal(B.decodeBlueprints(JSON.stringify([item(3)])).ok, true);
    assert.equal(B.decodeBlueprints('```json\n' + JSON.stringify({ blueprints: [item(3)] }) + '\n```').ok, true);
    assert.equal(B.decodeBlueprints('好的：' + JSON.stringify({ blueprints: [item(3)] }) + '祝顺利').ok, true);
  });

  test('缺必填字段、梗概为空、没有出场角色：报诊断，路径说得出是哪一格', () => {
    const noSynopsis = B.decodeBlueprints(JSON.stringify({ blueprints: [item(1), item(2, { synopsis: '' })] }));
    assert.equal(noSynopsis.ok, false);
    assert.equal(noSynopsis.diagnostic.code, 'empty_value');
    assert.equal(noSynopsis.diagnostic.path, 'blueprints[1].synopsis');

    const { keyEvents, ...rest } = item(1);
    void keyEvents;
    const missing = B.decodeBlueprints(JSON.stringify({ blueprints: [rest] }));
    assert.equal(missing.diagnostic.code, 'missing_field');
    assert.equal(missing.diagnostic.path, 'blueprints[0].keyEvents');
    assert.equal(B.decodeBlueprints(JSON.stringify({ blueprints: [item(1, { characters: [] })] })).diagnostic.path, 'blueprints[0].characters');
    assert.equal(B.decodeBlueprints('{"blueprints": [').diagnostic.code, 'not_json');
    assert.equal(B.decodeBlueprints('{"x": 1}').diagnostic.code, 'no_list');
  });

  test('标题在标点处断开', () => {
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [item(1, { title: '夜入青云。林昭在雨夜翻进了宗门的后墙' })],
    }));
    assert.equal(r.ok, true);
    assert.equal(r.items[0].title, '夜入青云');
  });

  // 关键事件和定稿写出来的一样是一条一件事的列表（⚑B）：定稿才能逐条改，而不是把一整段重写一遍。
  describe('关键事件：一条一件事的列表', () => {
    const events = (keyEvents) => B.decodeBlueprints(JSON.stringify({ blueprints: [item(1, { keyEvents })] }));

    test('数组按条收，去掉行首的编号与「-」，空条不算', () => {
      const r = events(['1. 林昭踩点', '- 失手惊动守卫', '  ', '翻墙进了后院']);
      assert.equal(r.ok, true);
      assert.deepEqual(r.items[0].keyEvents, ['林昭踩点', '失手惊动守卫', '翻墙进了后院']);
      assert.deepEqual(r.warnings, []);
    });

    test('一条里带了换行就按行拆开：落盘后一行就是一条', () => {
      assert.deepEqual(events(['林昭踩点\n失手惊动守卫']).items[0].keyEvents, ['林昭踩点', '失手惊动守卫']);
    });

    // 一条里的分号不切：一件事可以有前后两拍。
    test('数组里一条带分号不切', () => {
      assert.deepEqual(events(['林昭翻墙；落在后院']).items[0].keyEvents, ['林昭翻墙；落在后院']);
    });

    test('给成一段字照收：按换行与分号切成条，去掉列表记号', () => {
      assert.deepEqual(events('林昭踩点；失手惊动守卫;翻墙进了后院').items[0].keyEvents, ['林昭踩点', '失手惊动守卫', '翻墙进了后院']);
      assert.deepEqual(events('- 林昭踩点\n- 翻墙进了后院').items[0].keyEvents, ['林昭踩点', '翻墙进了后院']);
      assert.deepEqual(events('一整段写成的关键事件，没有分号。').items[0].keyEvents, ['一整段写成的关键事件，没有分号。']);
    });

    test('空数组、只有空白或记号：empty_value', () => {
      for (const v of [[], [''], ['  ', '-'], '', '；', '- \n-']) {
        const r = events(v);
        assert.equal(r.ok, false, JSON.stringify(v));
        assert.equal(r.diagnostic.code, 'empty_value', JSON.stringify(v));
        assert.equal(r.diagnostic.path, 'blueprints[0].keyEvents');
      }
    });

    test('形状不对：invalid_type', () => {
      for (const v of [42, { a: '林昭踩点' }, ['林昭踩点', 3], [{ event: '林昭踩点' }], null, true]) {
        const r = events(v);
        assert.equal(r.ok, false, JSON.stringify(v));
        assert.equal(r.diagnostic.code, 'invalid_type', JSON.stringify(v));
        assert.equal(r.diagnostic.path, 'blueprints[0].keyEvents');
      }
    });

    test('超过 8 条：只留前面的，并说明', () => {
      assert.equal(B.BLUEPRINT_LIMITS.keyEventItems, 8);
      const r = events(Array.from({ length: 10 }, (_, i) => `事件${i}`));
      assert.equal(r.ok, true);
      assert.deepEqual(r.items[0].keyEvents, Array.from({ length: 8 }, (_, i) => `事件${i}`));
      assert.match(r.warnings.join('\n'), /第 1 章的 keyEvents 列了 10 条，只留前 8 条/);
    });

    test('合计超过 1200 字：从超出的那一条起截掉，并说明', () => {
      const r = events(['甲'.repeat(500), '乙'.repeat(500), '丙'.repeat(500), '丁'.repeat(10)]);
      assert.equal(r.ok, true);
      assert.deepEqual(r.items[0].keyEvents, ['甲'.repeat(500), '乙'.repeat(500), '丙'.repeat(200)]);
      assert.equal(r.items[0].keyEvents.join('').length, 1200);
      assert.match(r.warnings.join('\n'), /第 1 章的 keyEvents 超过 1200 字，已截断/);
    });

    test('合计正好 1200 字：不截、不说明', () => {
      const r = events(['甲'.repeat(600), '乙'.repeat(600)]);
      assert.equal(r.items[0].keyEvents.join('').length, 1200);
      assert.deepEqual(r.warnings, []);
    });

    test('一段字超长：切完再按合计字数截', () => {
      const r = events('事'.repeat(1300));
      assert.deepEqual(r.items[0].keyEvents, ['事'.repeat(1200)]);
      assert.match(r.warnings.join('\n'), /第 1 章的 keyEvents 超过 1200 字/);
    });

    test('落盘成一条一行，规范化输出写回数组', () => {
      const r = events('林昭踩点；翻墙进了后院');
      assert.equal(B.blueprintToPlot(r.items[0]).sections.关键事件, '- 林昭踩点\n- 翻墙进了后院');
      assert.deepEqual(JSON.parse(B.renderBlueprints(r.items)).blueprints[0].keyEvents, ['林昭踩点', '翻墙进了后院']);
    });
  });

  test('新角色不在出场名单里：不建卡，并说明', () => {
    const r = B.decodeBlueprints(JSON.stringify({ blueprints: [item(1, { newCharacters: [{ name: '周岳', role: 'minor' }] })] }));
    assert.deepEqual(r.items[0].newCharacters, []);
    assert.match(r.warnings[0], /周岳/);
  });

  test('覆盖检查：漏章、重复、越界', () => {
    const r = B.decodeBlueprints(JSON.stringify({ blueprints: [item(1), item(1), item(7)] }));
    assert.deepEqual(B.checkCoverage(r.items, [1, 2, 3]), { missing: [2, 3], duplicate: [1], unexpected: [7] });
  });

  test('规范化输出能原样解回来', () => {
    const r = B.decodeBlueprints(JSON.stringify({ blueprints: [item(4, { newCharacters: [{ name: '沈青', role: '配角' }] })] }));
    const again = B.decodeBlueprints(B.renderBlueprints(r.items));
    assert.deepEqual(again.items, r.items);
  });

  test('新角色带性别：规范成「男」「女」，原样解回来；没给的不多一个键', () => {
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [item(4, { characters: ['林昭', '沈青', '周岳'], newCharacters: [{ name: '沈青', role: 'supporting', gender: 'female' }, { name: '周岳', role: 'minor' }] })],
    }));
    assert.deepEqual(r.items[0].newCharacters, [{ name: '沈青', role: '配角', gender: '女' }, { name: '周岳', role: '次要' }]);
    assert.deepEqual(B.decodeBlueprints(B.renderBlueprints(r.items)).items, r.items);
  });
});

describe('roster.ts · 角色图谱两段式', () => {
  const manifest = {
    slots: [
      { slotId: '1', name: '林昭', role: 'protagonist', narrativeDuty: '背着旧案入宗', relations: [{ targetSlotId: '2', relation: '同门，互相试探' }] },
      { slotId: '2', name: '沈青', role: 'supporting', narrativeDuty: '引路人', relations: [] },
      { slotId: '3', name: '周岳', role: 'antagonist', narrativeDuty: '执法堂首座', relations: [{ targetSlotId: '9', relation: '？' }, { targetSlotId: '3', relation: '自己' }] },
    ],
  };

  test('清单：关系指向清单外或自己的丢掉并说明，定位换成中文', () => {
    const r = R.decodeManifest(JSON.stringify(manifest));
    assert.equal(r.ok, true);
    assert.deepEqual(r.slots.map((s) => s.role), ['主角', '配角', '反派']);
    assert.deepEqual(r.slots[2].relations, []);
    assert.equal(r.warnings.filter((w) => /周岳/.test(w)).length, 2);
  });

  test('清单：人太少、没标主角照收，写进说明；一个人都没有才失败', () => {
    const two = R.decodeManifest(JSON.stringify({ slots: [{ slotId: 'a', name: '甲', role: 'minor', relations: [] }, { slotId: 'b', name: '乙', role: 'x', relations: [] }] }));
    assert.equal(two.ok, true);
    assert.match(two.warnings.join('\n'), /2 人/);
    assert.match(two.warnings.join('\n'), /没有标出主角/);
    assert.equal(R.decodeManifest('{"slots": []}').ok, false);
    assert.equal(R.decodeManifest('不是 JSON').ok, false);
  });

  test('详情：以冻结清单为准，清单外的人丢掉，超长截断', () => {
    const { slots } = R.decodeManifest(JSON.stringify(manifest));
    const r = R.decodeDetails(JSON.stringify({
      entries: [
        { slotId: '1', name: '林昭', 身份: '青河镇孤儿', 性格: '隐忍', 当前状态: '在宗门外', aliases: ['阿昭', '林昭'] },
        { name: '沈青', 外貌: '青衫'.repeat(80) },
        { slotId: '99', name: '路人' },
      ],
    }), slots.slice(0, 2));
    assert.equal(r.ok, true);
    assert.deepEqual(r.items.map((d) => d.slotId), ['1', '2']);
    assert.deepEqual(r.items[0].aliases, ['阿昭']);
    assert.equal(r.items[1].sections.外貌.length, 120);
    assert.match(r.warnings.join('\n'), /路人/);
  });

  test('拼卡：关系写到双方卡上，叙事职责接在身份后，详情缺席的人照样建卡', () => {
    const { slots } = R.decodeManifest(JSON.stringify(manifest));
    const { items } = R.decodeDetails(JSON.stringify({ entries: [{ slotId: '1', 身份: '青河镇孤儿' }] }), slots);
    const { entries, warnings } = R.assembleRoster(slots, items);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].sections.身份, '青河镇孤儿\n叙事职责：背着旧案入宗');
    assert.equal(entries[0].sections.人物关系, '- 与沈青：同门，互相试探');
    assert.equal(entries[1].sections.人物关系, '- 与林昭：林昭眼中——同门，互相试探');
    assert.match(warnings.join('\n'), /沈青.*详情没有生成/);
    // 规范化输出能被 artifact.ts 的 parseRoster 读回来（采纳时重新解析的那一份）。
    const back = A.parseRoster(R.renderRoster(entries));
    assert.deepEqual(back.map((e) => [e.name, e.role]), [['林昭', '主角'], ['沈青', '配角'], ['周岳', '反派']]);
    assert.equal(back[0].sections.人物关系, entries[0].sections.人物关系);
  });

  test('性别在清单里定：规范写法、拼卡带上、规范化输出读得回来；没给的就没有', () => {
    const withGender = {
      slots: [
        { ...manifest.slots[0], gender: 'male' },
        { ...manifest.slots[1], gender: '女性' },
        { ...manifest.slots[2], gender: '未知' },
      ],
    };
    const { slots } = R.decodeManifest(JSON.stringify(withGender));
    assert.deepEqual(slots.map((s) => s.gender), ['男', '女', undefined]);
    const { entries } = R.assembleRoster(slots, []);
    assert.deepEqual(entries.map((e) => e.gender), ['男', '女', undefined]);
    const text = R.renderRoster(entries);
    assert.match(text, /"性别": "女"/);
    assert.deepEqual(A.parseRoster(text).map((e) => e.gender), ['男', '女', undefined]);
  });
});

describe('loreList.ts · 设定清单两段式', () => {
  /** 已有条目的最小形状（listLore 读出来的样子）。 */
  const entry = (title, category = '', keywords = []) => ({
    slug: `${category ? `${category}/` : ''}${title}`,
    relPath: `.novelforge/lore/${category ? `${category}/` : ''}${title}.md`,
    title,
    keywords,
    brief: '',
    category,
    body: '',
  });
  const none = { categories: [], entries: [], people: [] };
  const row = (title, category, over = {}) => ({ title, category, keywords: [], brief: `${title}是什么`, ...over });
  const twelve = Array.from({ length: 12 }, (_, i) => row(`地点${i + 1}`, '地域'));

  test('清单：分类规范成目录路径，条目带一句话与关键词；人名丢掉并说明', () => {
    const r = L.decodeLoreManifest(
      JSON.stringify({
        categories: ['宗门／正道', ' 地域 ', '丹药法宝', '宗门/正道', '..'],
        entries: [
          row('青云宗', '宗门/正道', { keywords: ['青云门', '青云宗', '林昭'], brief: '正道第一大宗'.repeat(10) }),
          row('林昭', '地域'),
          row('青崖镇', ''),
          row('青云宗', '宗门/正道'),
          ...twelve,
        ],
      }),
      { ...none, people: ['林昭'] }
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.categories, ['宗门/正道', '地域', '丹药法宝']);
    const qy = r.slots.find((s) => s.title === '青云宗');
    assert.equal(qy.category, '宗门/正道');
    // 关键词去掉标题本身与人名；一句话截到 40 字。
    assert.deepEqual(qy.keywords, ['青云门']);
    assert.equal(Array.from(qy.brief).length, 40);
    assert.ok(!r.slots.some((s) => s.title === '林昭'));
    assert.equal(r.slots.find((s) => s.title === '青崖镇').category, '');
    const warnings = r.warnings.join('\n');
    assert.match(warnings, /林昭.*人不是设定/);
    assert.match(warnings, /青崖镇.*未分类/);
    assert.match(warnings, /青云宗.*不止一次/);
    assert.match(warnings, /「\.\.」当不了目录名/);
    assert.match(warnings, /一句话超过 40 字/);
  });

  test('清单：已有条目照抄名字、分类以实际目录为准；分类不在表里的补进目录树并说明', () => {
    const known = { categories: ['宗门'], entries: [entry('青云宗', '宗门', ['青云门'])], people: [] };
    const r = L.decodeLoreManifest(
      JSON.stringify({ categories: ['地域'], entries: [row('青云门', '地域'), row('镇妖塔', '禁地'), ...twelve] }),
      known
    );
    assert.equal(r.ok, true);
    assert.equal(r.slots[0].title, '青云宗');
    assert.equal(r.slots[0].category, '宗门');
    assert.equal(r.slots[1].category, '禁地');
    assert.deepEqual(r.categories, ['地域', '禁地']);
    assert.match(r.warnings.join('\n'), /镇妖塔.*禁地.*不在 categories 里/);
    // 一级分类按本书已有的加这次新排的数：宗门 + 地域 + 禁地 = 3 个，够数不报。
    assert.ok(!/一级分类/.test(r.warnings.join('\n')), r.warnings.join('\n'));
  });

  test('清单：条数不够照收并说明，超过 30 条只留前 30 条（次数是按 30 条报的）；一条能用的都没有才失败', () => {
    const few = L.decodeLoreManifest(JSON.stringify({ categories: ['甲', '乙', '丙'], entries: [row('青崖镇', '甲')] }), none);
    assert.equal(few.ok, true);
    assert.match(few.warnings.join('\n'), /1 条，合同要求 12–30 条/);
    const many = L.decodeLoreManifest(
      JSON.stringify({ categories: ['甲', '乙', '丙'], entries: Array.from({ length: 33 }, (_, i) => row(`物${i + 1}`, '甲')) }),
      none
    );
    assert.equal(many.slots.length, 30);
    assert.match(many.warnings.join('\n'), /超过 30 条，「物31」及之后的没收/);
    assert.equal(L.decodeLoreManifest('{"categories":[],"entries":[]}', none).ok, false);
    assert.equal(L.decodeLoreManifest('不是 JSON', none).ok, false);
    assert.equal(L.decodeLoreManifest('{"slots":[{"name":"甲"}]}', none).ok, false);
  });

  test('详情：以冻结清单为准，清单外的丢掉；三节规范化，超过 300 字截断并说明', () => {
    const { slots } = L.decodeLoreManifest(
      JSON.stringify({ categories: ['地域', '宗门', '法宝'], entries: [row('青崖镇', '地域'), row('青云宗', '宗门'), row('崖字令', '法宝')] }),
      none
    );
    const r = L.decodeLoreDetails(
      JSON.stringify({
        entries: [
          { title: '青崖镇', body: '## 概要\n偏僻小镇。\n\n## 规则与边界\n镇口设卡查过所。' },
          { title: '青云宗', body: { 概要: '正道大宗。', 规则与边界: '门规森严。'.repeat(60), 现状: '封山。' } },
          { title: '路人甲', body: '## 概要\n随便' },
        ],
      }),
      slots
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.items.map((d) => d.title), ['青崖镇', '青云宗']);
    // 没写的那一节写「（未交代）」：节在，作者一眼看得出这里还没东西。
    assert.equal(r.items[0].body, '## 概要\n偏僻小镇。\n\n## 规则与边界\n镇口设卡查过所。\n\n## 现状\n（未交代）');
    const qy = r.items[1].body;
    assert.match(qy, /^## 概要\n正道大宗。\n\n## 规则与边界\n/);
    // 规则与边界单节上限 250 字。
    assert.equal(Array.from(/## 规则与边界\n([^\n]*)/.exec(qy)[1]).length, 250);
    const warnings = r.warnings.join('\n');
    assert.match(warnings, /青云宗.*正文超长，已截断/);
    assert.match(warnings, /路人甲/);
    assert.equal(L.decodeLoreDetails('{"items":[]}', slots).ok, false);
  });

  test('正文：三节合计不超过 300 字，从超出的那一节起截掉；一节都认不出的整段当概要', () => {
    const long = L.normalizeLoreBody({ 概要: '甲'.repeat(150), 规则与边界: '乙'.repeat(200), 现状: '丙'.repeat(100) });
    assert.equal(long.clipped, true);
    const chars = long.body.replace(/## \S+\n/g, '').replace(/（未交代）/g, '').replace(/\n/g, '');
    assert.equal(Array.from(chars).length, 300);
    assert.match(long.body, /## 现状\n（未交代）/);
    assert.deepEqual(L.normalizeLoreBody('一座塔，镇着妖。'), { body: '## 概要\n一座塔，镇着妖。\n\n## 规则与边界\n（未交代）\n\n## 现状\n（未交代）', clipped: false });
    assert.deepEqual(L.normalizeLoreBody(''), { body: '', clipped: false });
  });

  test('拼条目：正文缺席的照样建（只有一句话）；规范化输出能被采纳时读回来', () => {
    const { categories, slots } = L.decodeLoreManifest(
      JSON.stringify({ categories: ['地域', '宗门', '法宝'], entries: [row('青崖镇', '地域', { keywords: ['青崖'] }), row('青云宗', '宗门')] }),
      none
    );
    const { entries, warnings } = L.assembleLoreList(slots, [{ title: '青崖镇', body: '## 概要\n偏僻小镇。' }]);
    assert.deepEqual(entries.map((e) => [e.title, e.category, !!e.body]), [['青崖镇', '地域', true], ['青云宗', '宗门', false]]);
    assert.match(warnings.join('\n'), /青云宗.*正文没有生成出来/);
    const art = A.parseArtifact(
      { stage: 'setting', capability: 'generate' },
      L.renderLoreList(categories, entries),
      { kind: 'setting', doc: 'lore' }
    );
    assert.equal(art.kind, 'loreList');
    assert.deepEqual(art.categories, ['地域', '宗门', '法宝']);
    assert.deepEqual(art.entries[0].keywords, ['青崖']);
    assert.equal(art.entries[0].brief, '青崖镇是什么');
    assert.equal(A.describeArtifact(art), '设定清单 · 2 条 · 3 个分类');
    assert.equal(A.isArtifactEmpty(art), false);
    // 模型第一次调用的原样清单（agent 那条路）也认：没有正文就是空的。
    const raw = A.parseArtifact({ stage: 'setting', capability: 'generate' }, JSON.stringify({ entries: [row('青崖镇', '地域')] }), {
      kind: 'setting',
      doc: 'lore',
    });
    assert.deepEqual(raw.categories, ['地域']);
    assert.equal(raw.entries[0].body, '');
    assert.equal(A.isArtifactEmpty(A.parseArtifact({ stage: 'setting', capability: 'generate' }, '没有清单', { kind: 'setting', doc: 'lore' })), true);
  });
});

describe('novelConfig.ts · 小说配置', () => {
  const generated = {
    genre: '玄幻',
    targetAudience: '男频',
    subGenre: '东方玄幻 · 宗门',
    plotStructure: 'three_act',
    narrativePOV: 'third_limited',
    coreOutline: '少年背着旧案入宗，查出宗门与灭门案的关系。',
    sellingPoints: '残令回放死者最后一刻：每次都在众人面前翻案。',
    worldSetting: '灵脉枯竭的九州。',
    goldenFinger: '一块能回放死者最后一刻的残令。',
    protagonistProfile: '林昭，隐忍，想替父洗冤。',
    globalGuidance: '1. 不写上帝视角\n2. 每章留钩子\n3. 金手指每次使用都有代价\n4. 对白要分得出是谁在说',
    writingStyle: '冷峻克制，短句为主。',
  };

  test('英文键映射到八节，文风单独拿出来', () => {
    const r = C.decodeNovelConfig(JSON.stringify(generated));
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
    assert.equal(r.value.sections.金手指, generated.goldenFinger);
    assert.equal(r.value.structure, 'three_act');
    assert.equal(r.value.writingStyle, '冷峻克制，短句为主。');
    assert.equal(r.value.sections.核心卖点, generated.sellingPoints);
    assert.equal(r.value.sections.一句话, undefined);
  });

  test('logline 只在作者没写一句话时补上', () => {
    const r = C.decodeNovelConfig(JSON.stringify({ ...generated, logline: '模型补的一句话' }));
    assert.equal(r.value.sections.一句话, '模型补的一句话');
    const empty = { sections: {} };
    assert.equal(C.mergeWithAuthor(empty, r.value, { preserve: false }).sections.一句话, '模型补的一句话');
    const authored = { sections: { 一句话: '作者的脑洞' } };
    assert.equal(C.mergeWithAuthor(authored, r.value, { preserve: false }).sections.一句话, '作者的脑洞');
    assert.equal(C.mergeWithAuthor(authored, r.value, { preserve: false, idea: '新脑洞' }).sections.一句话, '新脑洞');
  });

  test('缺字段、枚举写错：照收并说明，不作废', () => {
    const r = C.decodeNovelConfig(JSON.stringify({ ...generated, goldenFinger: undefined, plotStructure: '三段式' }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, ['goldenFinger']);
    assert.equal(r.value.structure, undefined);
    assert.match(r.warnings[0], /三段式/);
    assert.equal(C.decodeNovelConfig('我觉得这个脑洞可以这样写').ok, false);
  });

  test('「全局要求」的合同：4–8 条、600 字内、不逐章列大纲', () => {
    assert.equal(C.isGuidanceValid(generated.globalGuidance), true);
    assert.match(C.guidanceProblem('只有一条'), /1 条/);
    assert.match(C.guidanceProblem('字'.repeat(601)), /601 字/);
    assert.match(C.guidanceProblem('第1章：入宗\n第2章：试炼\n规则三\n规则四'), /逐章列大纲/);
  });

  test('保留作者原文：长文本原文在前、生成的追加在后；作者选过的类型不改', () => {
    const existing = S.parseBookConfig(
      ['---', 'genre: 仙侠', 'totalChapters: 60', '---', '# 小说配置', '## 一句话', '少年入宗', '## 金手指', '残令能看见死者最后一眼'].join('\n'),
      '.novelforge/config.md'
    );
    const { value } = C.decodeNovelConfig(JSON.stringify(generated));
    const merged = C.mergeWithAuthor(existing, value, {
      idea: '少年入宗查旧案',
      setup: { totalChapters: 100, wordsPerChapter: 3000 },
      preserve: true,
    });
    assert.equal(merged.genre, '仙侠');
    assert.equal(merged.subGenre, '东方玄幻 · 宗门');
    assert.equal(merged.totalChapters, 100);
    assert.equal(merged.sections.金手指, `残令能看见死者最后一眼\n\n${generated.goldenFinger}`);
    // 新的一句话包含了旧的，就用新的，不叠两遍。
    assert.equal(merged.sections.一句话, '少年入宗查旧案');
  });

  test('不保留原文时（对话里的修改意见）生成的那一份就是新版，漏掉的节沿用旧的', () => {
    const existing = S.parseBookConfig('# 小说配置\n## 参考作品\n《雪中》\n## 金手指\n旧金手指', '');
    const { value } = C.decodeNovelConfig(JSON.stringify(generated));
    const merged = C.mergeWithAuthor(existing, value, { preserve: false });
    assert.equal(merged.sections.金手指, generated.goldenFinger);
    assert.equal(merged.sections.参考作品, '《雪中》');
  });

  test('规范化草稿按 config.md 读回来，文风那一节单独拿出', () => {
    const { value } = C.decodeNovelConfig(JSON.stringify(generated));
    const merged = C.mergeWithAuthor(S.parseBookConfig('', ''), value, { idea: '少年入宗', setup: { totalChapters: 100, wordsPerChapter: 3000 }, preserve: true });
    const draft = C.renderConfigDraft(merged, value.writingStyle);
    const art = A.parseArtifact({ stage: 'setting', capability: 'generate' }, draft, { kind: 'setting', doc: 'config' });
    assert.equal(art.kind, 'settingDoc');
    assert.equal(art.sections.一句话, '少年入宗');
    assert.equal(art.sections.金手指, generated.goldenFinger);
    assert.equal(art.config.totalChapters, 100);
    assert.equal(art.config.structure, 'three_act');
    assert.equal(art.style, '冷峻克制，短句为主。');
    // 文风不混进配置的任何一节（D14）。
    assert.ok(!Object.values(art.sections).some((v) => /冷峻克制/.test(v)));
  });

  test('重写配置：作者在编辑器里切的分段格式原样带过去（模型不生成它）', () => {
    const existing = S.parseBookConfig('---\nparagraphStyle: indent\n---\n# 小说配置\n## 一句话\n少年入宗', '');
    const { value } = C.decodeNovelConfig(JSON.stringify(generated));
    for (const preserve of [true, false]) {
      const merged = C.mergeWithAuthor(existing, value, { preserve });
      assert.equal(merged.paragraphStyle, 'indent');
      const art = A.parseArtifact({ stage: 'setting', capability: 'generate' }, C.renderConfigDraft(merged), { kind: 'setting', doc: 'config' });
      assert.equal(art.config.paragraphStyle, 'indent', '草稿读回来那份也带着');
    }
  });

  test('模型第一次调用的原样输出（英文键 JSON）也认得', () => {
    const art = A.parseArtifact({ stage: 'setting', capability: 'generate' }, JSON.stringify(generated), { kind: 'setting', doc: 'config' });
    assert.equal(art.sections.核心梗概, generated.coreOutline);
    assert.equal(art.config.pov, 'third_limited');
  });
});

describe('artifact.ts · 细纲批次与单章', () => {
  const act = { stage: 'plot', capability: 'generate' };

  test('给了区间就是一批：只留区间内的章，按章号升序', () => {
    const raw = JSON.stringify({ blueprints: [item(3), item(1), item(9), item(2)] });
    const art = A.parseArtifact(act, raw, { kind: 'plot', plotRelPath: '.novelforge/summaries/001.md' }, { from: 1, to: 3 });
    assert.equal(art.kind, 'plotBatch');
    assert.deepEqual(art.items.map((b) => b.no), [1, 2, 3]);
    assert.match(A.describeArtifact(art), /第 1–3 章（3 章）/);
  });

  // 批次路径不做全文兜底：解不出来就是空的，采纳时说「解析不出」，什么都不写。
  test('一批解不出来就是空产物', () => {
    const art = A.parseArtifact(act, '这几章我觉得可以这样排……', undefined, { from: 1, to: 5 });
    assert.equal(A.isArtifactEmpty(art), true);
  });

  test('单章也认批次合同的单项形式（生成与落定契约一致）', () => {
    const raw = JSON.stringify({ blueprints: [item(4)] });
    for (const capability of ['generate', 'settle']) {
      const art = A.parseArtifact({ stage: 'plot', capability }, raw);
      assert.equal(art.kind, 'plot');
      assert.equal(art.sections.关键事件, '- 第 4 章林昭在山门外踩点\n- 第 4 章翻墙进了后院');
      assert.equal(art.sections.梗概, '第 4 章的梗概');
      assert.equal(art.sections.出场人物, '林昭、沈青');
      assert.equal(art.sections.看点, '- 第 4 章的爽点\n- 第 4 章的钩子');
      assert.equal(art.title, '第4章标题');
    }
  });

  test('大纲带区间', () => {
    const art = A.parseArtifact({ stage: 'outline', capability: 'generate' }, '## 第21–40章：风起\n……', undefined, { from: 21, to: 40 });
    assert.deepEqual(art.range, { from: 21, to: 40 });
  });
});
