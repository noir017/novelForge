/**
 * 规划时的角色图谱（docs/design/plans/2026-10-24-planning-roster-plotlist.md）：大纲、细纲不再全员一人一段。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 拆细纲（第 3 级）：近 20 章出场的给一段，角色卡层整张带的只点名，更早出场的与没出场的只列名字；明细写清各几人 | 写到八十章、四十几张卡时全员一人一段上万 token，详细度调到哪一级都不少；第 2 条 |
 * | 「精简」角色卡只带要点（没有人物关系）：不点名，照给一段；往前只看 10 章 | 点了名、卡里又没有关系，这一段就丢了 |
 * | 作者在明细里取消了的角色卡：图谱里照给一段 | 不然这个人只剩名字 |
 * | 「完整」全员一段，与从前一样 | 第 4 级不封顶 |
 * | 续写大纲：区间前 20 章出场的给一段；作者这一次的话里提到的有整张卡 | 大纲、细纲同一个带法 |
 * | 刚开书（一份细纲都没有）：全员一段 | 谁算活跃无从判断，宁可多带 |
 * | 批次拆细纲：这一批空壳的梗概里提到的人给一段 | 这一次要排的那几章算在「近几章」里 |
 * | 架构阶段（世界观）全员一段，不变 | 世界观要照着所有人写 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

const pad3 = (n) => String(n).padStart(3, '0');
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;

const config = (extra = {}) => ({
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
  ...extra,
});

/** 一份排过的细纲；`stub` 是只有梗概的空壳。 */
function plotText(no, cast, synopsis = `林昭在第${no}章往下查。`, stub = false) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    synopsis,
    ...(stub ? [] : ['', '## 出场人物', '', cast.join('、'), '', '## 关键事件', '', `- 第${no}章的事。`]),
    '',
  ].join('\n');
}

const card = (name, tag) =>
  `---\nname: ${name}\ntags: [${tag}]\n---\n\n# ${name}\n\n## 身份\n\n${name}的身份。\n\n## 人物关系\n\n${name}的关系。\n\n## 当前状态\n\n${name}的状态。\n`;

/** 第 1–60 章排过；周婶只在第 10 章、老陈只在第 45 章、沈青在第 55–61 章出场；李叔、阿九一章都没出场。 */
function castOf(no) {
  if (no === 10) return ['林昭', '周婶'];
  if (no === 45) return ['林昭', '老陈'];
  if (no >= 55) return ['林昭', '沈青'];
  return ['林昭'];
}

const PLOT_ONE = { action: { stage: 'plot', capability: 'generate' }, target: { kind: 'plot', plotRelPath: PLOT(61) }, ask: '' };
const OUTLINE = { action: { stage: 'outline', capability: 'generate' }, target: { kind: 'outline' }, ask: '', range: { from: 62, to: 81 } };

let bundle;
before(() => {
  bundle = loadBundle({ host: './src/core/host.ts', project: './src/core/model/project.ts', builder: './src/core/context/builder.ts' });
  bundle.host.initHost(makeFakeHost().host);
});

async function withProject(fn, { plots = true, stubs = [] } = {}) {
  const t = await makeTempProject(bundle.project, { prefix: 'planningRoster', title: '图谱' });
  try {
    t.write('.novelforge/characters/林昭.md', card('林昭', '主角'));
    for (const name of ['沈青', '老陈', '周婶', '李叔', '阿九']) {
      t.write(`.novelforge/characters/${name}.md`, card(name, '配角'));
    }
    if (plots) {
      for (let no = 1; no <= 61; no++) {
        t.write(PLOT(no), plotText(no, castOf(no)));
      }
      for (const [no, synopsis] of stubs) {
        t.write(PLOT(no), plotText(no, [], synopsis, true));
      }
    }
    t.project.invalidate();
    return await fn((request, extra) => bundle.builder.buildContext(t.project, request, config(extra)));
  } finally {
    cleanup(t.dir);
  }
}

const roster = (built) => built.items.find((i) => i.id === 'roster');
/** 图谱里给了一段的人（名字那一行下面跟着「身份：」）。 */
const described = (item) => [...item.text.matchAll(/^- (\S+?)［/gm)].map((m) => m[1]);
/** 只列名字的那一行。 */
const namedLine = (item) => item.text.split('\n').find((l) => l.startsWith('其余角色')) ?? '';
const cardedLine = (item) => item.text.split('\n').find((l) => l.startsWith('整张卡在下面')) ?? '';

describe('规划时的角色图谱：只给近期活跃的一段', () => {
  test('拆细纲第 3 级：老陈（第 45 章）给一段，主角与本章计划出场的只点名，周婶、李叔、阿九只列名字', () =>
    withProject(async (build) => {
      const built = await build(PLOT_ONE);
      const r = roster(built);
      assert.equal(r.status, 'included');
      assert.equal(r.label, '角色图谱（6 人）');
      assert.deepEqual(described(r), ['老陈']);
      assert.ok(r.text.includes('- 老陈［配角］\n  身份：老陈的身份。'), r.text);
      assert.equal(cardedLine(r), '整张卡在下面「相关角色设定」里：林昭、沈青。');
      assert.ok(['周婶', '李叔', '阿九'].every((n) => namedLine(r).includes(n)), namedLine(r));
      assert.match(namedLine(r), /^其余角色（近 20 章没出场，只列名字；再出场时照用这些名字）：/);
      assert.ok(!r.text.includes('周婶的身份'), '只列名字的不带身份');
      assert.match(
        r.note,
        /^1 人（主角、近 20 章出场的、这一次提到的）取身份、人物关系、当前状态的开头；整张卡在「相关角色设定」的 2 人只点名；其余 3 人只列名字（上下文详细度「详细」）$/
      );
      // 点了名的两张卡确实整张带了。
      for (const name of ['林昭', '沈青']) {
        const c = built.items.find((i) => i.label === `角色 · ${name}`);
        assert.ok(c && c.status === 'included' && c.text.includes(`${name}的关系`), JSON.stringify(c));
      }
    }));

  test('「精简」：只往前看 10 章（老陈只列名字）；角色卡只带要点，不点名、照给一段', () =>
    withProject(async (build) => {
      const r = roster(await build(PLOT_ONE, { contextDetail: 1 }));
      assert.deepEqual(described(r).sort(), ['林昭', '沈青'].sort());
      assert.equal(cardedLine(r), '');
      assert.ok(namedLine(r).includes('老陈') && namedLine(r).startsWith('其余角色（近 10 章没出场'), namedLine(r));
    }));

  test('作者在明细里取消了沈青的卡：图谱里照给沈青一段', () =>
    withProject(async (build) => {
      const id = (await build(PLOT_ONE)).items.find((i) => i.label === '角色 · 沈青').id;
      const r = roster(await build({ ...PLOT_ONE, excludedIds: [id] }));
      assert.ok(described(r).includes('沈青'), r.text);
      assert.equal(cardedLine(r), '整张卡在下面「相关角色设定」里：林昭。');
    }));

  test('「完整」：全员一段，与从前一样', () =>
    withProject(async (build) => {
      const r = roster(await build(PLOT_ONE, { contextDetail: 4 }));
      assert.equal(described(r).length, 6);
      assert.equal(namedLine(r), '');
      assert.equal(r.note, '每人只取身份、人物关系、当前状态的开头；完整角色卡在正文层才带');
    }));

  test('批次拆细纲：这一批空壳的梗概里提到周婶，周婶给一段', () =>
    withProject(
      async (build) => {
        const r = roster(
          await build({ action: { stage: 'plot', capability: 'generate' }, target: { kind: 'plot', plotRelPath: PLOT(62) }, ask: '', range: { from: 62, to: 64 } })
        );
        assert.ok(described(r).includes('周婶'), r.text);
        assert.ok(namedLine(r).includes('李叔') && !namedLine(r).includes('周婶'), namedLine(r));
      },
      { stubs: [[62, '林昭出镇。'], [63, '周婶回到镇上。'], [64, '林昭回来。']] }
    ));
});

describe('续写大纲与架构', () => {
  test('续写第 62–81 章：区间前 20 章出场的沈青、老陈给一段；作者提到的阿九有整张卡、只点名', () =>
    withProject(async (build) => {
      const built = await build({ ...OUTLINE, ask: '让阿九在这一卷回来' });
      const r = roster(built);
      assert.deepEqual(described(r).sort(), ['沈青', '老陈'].sort());
      assert.ok(cardedLine(r).includes('阿九') && cardedLine(r).includes('林昭'), cardedLine(r));
      assert.ok(namedLine(r).includes('周婶') && namedLine(r).includes('李叔'), namedLine(r));
      assert.ok(built.items.some((i) => i.label === '角色 · 阿九' && i.status === 'included'));
    }));

  test('刚开书（一份细纲都没有）：续写第 1–20 章时全员一段', () =>
    withProject(
      async (build) => {
        const r = roster(await build({ ...OUTLINE, range: { from: 1, to: 20 } }));
        assert.equal(described(r).length, 6);
        assert.equal(namedLine(r), '');
      },
      { plots: false }
    ));

  test('架构阶段（世界观）全员一段，不变', () =>
    withProject(async (build) => {
      const r = roster(
        await build({ action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'world' }, ask: '' })
      );
      assert.equal(described(r).length, 6);
      assert.equal(r.note, '每人只取身份、人物关系、当前状态的开头；完整角色卡在正文层才带');
    }));
});
