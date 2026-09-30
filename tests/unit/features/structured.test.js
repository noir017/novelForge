/**
 * 结构化产物的解码：细纲批次、角色图谱两段式、小说配置，以及语法修复的证据校验。
 *
 * 全部是纯函数（features/structuredJson.ts、blueprint.ts、roster.ts、novelConfig.ts），
 * 生成链怎么用它们在 tests/integration/generation/structuredChain.test.js。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 语法修复证据 | 修过的那份只许补闭合括号、改标点；改一个字就拒收（不许借修复补造事实） |
 * | 细纲批次 | 缺必填字段报诊断（交给拆半 / 紧凑重建）；超长截断不作废；新角色必须在出场名单里 |
 * | 角色图谱 | 清单里关系不闭合、没标主角照收并说明；详情以冻结清单为准；关系由清单生成到双方卡上 |
 * | 小说配置 | 英文键映射到七节；「全局要求」的合同；保留作者原文；规范化草稿能按 config.md 读回来 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const J = loadModule('src/core/features/structuredJson.ts');
const B = loadModule('src/core/features/blueprint.ts');
const R = loadModule('src/core/features/roster.ts');
const C = loadModule('src/core/features/novelConfig.ts');
const A = loadModule('src/core/features/artifact.ts');
const S = loadModule('src/core/model/settingFile.ts');

const item = (no, over = {}) => ({
  chapterNumber: no,
  title: `第${no}章标题`,
  role: '铺垫',
  purpose: `第 ${no} 章的目的`,
  keyEvents: `第 ${no} 章的关键事件，落在两个场面上。`,
  characters: ['林昭', '沈青'],
  suspenseHook: `第 ${no} 章的钩子`,
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

describe('blueprint.ts · 细纲批次', () => {
  test('合格的一批：三节对上 D3，新角色带出来', () => {
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [item(1, { newCharacters: [{ name: '沈青', role: 'supporting' }] }), item(2)],
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.items.map((b) => b.no), [1, 2]);
    assert.deepEqual(r.items[0].newCharacters, [{ name: '沈青', role: '配角' }]);
    const plot = B.blueprintToPlot(r.items[0]);
    assert.equal(plot.sections.本章目的, '第 1 章的目的');
    assert.equal(plot.sections.章末钩子, '第 1 章的钩子');
  });

  test('裸数组、围栏、JSON 前后的废话都认', () => {
    assert.equal(B.decodeBlueprints(JSON.stringify([item(3)])).ok, true);
    assert.equal(B.decodeBlueprints('```json\n' + JSON.stringify({ blueprints: [item(3)] }) + '\n```').ok, true);
    assert.equal(B.decodeBlueprints('好的：' + JSON.stringify({ blueprints: [item(3)] }) + '祝顺利').ok, true);
  });

  test('缺必填字段、钩子为空、没有出场角色：报诊断，路径说得出是哪一格', () => {
    const noHook = B.decodeBlueprints(JSON.stringify({ blueprints: [item(1), item(2, { suspenseHook: '' })] }));
    assert.equal(noHook.ok, false);
    assert.equal(noHook.diagnostic.code, 'empty_value');
    assert.equal(noHook.diagnostic.path, 'blueprints[1].suspenseHook');

    const { keyEvents, ...rest } = item(1);
    void keyEvents;
    assert.equal(B.decodeBlueprints(JSON.stringify({ blueprints: [rest] })).diagnostic.code, 'missing_field');
    assert.equal(B.decodeBlueprints(JSON.stringify({ blueprints: [item(1, { characters: [] })] })).diagnostic.path, 'blueprints[0].characters');
    assert.equal(B.decodeBlueprints('{"blueprints": [').diagnostic.code, 'not_json');
    assert.equal(B.decodeBlueprints('{"x": 1}').diagnostic.code, 'no_list');
  });

  test('超长不作废：截断并说明；标题在标点处断开', () => {
    const r = B.decodeBlueprints(JSON.stringify({
      blueprints: [item(1, { keyEvents: '事'.repeat(1300), title: '夜入青云。林昭在雨夜翻进了宗门的后墙' })],
    }));
    assert.equal(r.ok, true);
    assert.equal(r.items[0].keyEvents.length, 1200);
    assert.equal(r.items[0].title, '夜入青云');
    assert.match(r.warnings.join('\n'), /第 1 章的 keyEvents 超过 1200 字/);
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
});

describe('novelConfig.ts · 小说配置', () => {
  const generated = {
    genre: '玄幻',
    targetAudience: '男频',
    subGenre: '东方玄幻 · 宗门',
    plotStructure: 'three_act',
    narrativePOV: 'third_limited',
    coreOutline: '少年背着旧案入宗，查出宗门与灭门案的关系。',
    worldSetting: '灵脉枯竭的九州。',
    goldenFinger: '一块能回放死者最后一刻的残令。',
    protagonistProfile: '林昭，隐忍，想替父洗冤。',
    globalGuidance: '1. 不写上帝视角\n2. 每章留钩子\n3. 金手指每次使用都有代价\n4. 对白要分得出是谁在说',
    writingStyle: '冷峻克制，短句为主。',
  };

  test('英文键映射到七节，文风单独拿出来', () => {
    const r = C.decodeNovelConfig(JSON.stringify(generated));
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
    assert.equal(r.value.sections.金手指, generated.goldenFinger);
    assert.equal(r.value.structure, 'three_act');
    assert.equal(r.value.writingStyle, '冷峻克制，短句为主。');
    assert.equal(r.value.sections.一句话, undefined);
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
    const art = A.parseArtifact(act, raw, { kind: 'plot', plotRelPath: '.novelforge/plots/001.md' }, { from: 1, to: 3 });
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
    const raw = JSON.stringify({ blueprints: [item(4, { role: '小高潮' })] });
    for (const capability of ['generate', 'settle']) {
      const art = A.parseArtifact({ stage: 'plot', capability }, raw);
      assert.equal(art.kind, 'plot');
      assert.equal(art.sections.关键事件, item(4).keyEvents);
      assert.equal(art.role, '小高潮');
      assert.deepEqual(art.characters, ['林昭', '沈青']);
    }
  });

  test('大纲带区间', () => {
    const art = A.parseArtifact({ stage: 'outline', capability: 'generate' }, '## 第21–40章：风起\n……', undefined, { from: 21, to: 40 });
    assert.deepEqual(art.range, { from: 21, to: 40 });
  });
});
