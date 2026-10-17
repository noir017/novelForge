/**
 * 从已写正文补齐（拆书 A 的后一半，features/derive.ts）。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 全套 | 两次确认（先只报细纲，细纲出来再报其余）；按 细纲 → 配置 → 前提 → 角色卡 → 世界观 → 大纲 → 全书摘要 的顺序；第一步照正文写出 `summaries/NNN-<章名>.md`、带 sourceHash，直接算定稿过（不再另排一遍细纲）；之后主按钮照常续写大纲 |
 * | 再来一次 | 什么都齐了：零调用 |
 * | 只补空白 | 作者写过的前提、定稿过的细纲一个字不动；只排过计划的那一章拿着计划对照正文改，旧版进回收站 |
 * | 一件失败就停 | 大纲没整理成就不更新全书摘要，失败挂在大纲上（第 16 条） |
 * | 取消 | 细纲那一步不同意就一次都不调 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let replyFn;
const projects = [];

const TITLES = ['入宗', '雪夜', '旧案', '夜探', '执法堂', '下山', '渡口'];
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.md`;
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-${TITLES[no - 1]}.md`;
/** 第 no 章的正文：长短不一，好看出每章字数取的是已写各章的平均。 */
const text = (no) => `林昭第${no}次见到沈青。${'山门很高。'.repeat(40 + no * 10)}门外有人敲了三下。`;

const CONFIG_JSON = JSON.stringify({
  genre: '玄幻',
  targetAudience: '男频',
  subGenre: '宗门',
  plotStructure: 'three_act',
  narrativePOV: 'third_limited',
  coreOutline: '少年背着旧案入宗，查出宗门与旧案的关系。',
  worldSetting: '灵脉枯竭的九州。',
  goldenFinger: '残令。',
  protagonistProfile: '林昭，隐忍。',
  globalGuidance: '1. 不写上帝视角\n2. 每章留钩子\n3. 金手指有代价\n4. 对白分得出是谁',
  writingStyle: '冷峻克制。',
});

/** 这一次调用是哪一步。整理细纲（定稿的第一步）有没有当前细纲都以同一句开头。 */
function kindOf(messages) {
  const sys = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (sys.includes('建立可检索的章节档案')) return 'plot';
  if (sys.includes('负责维护一部长篇小说的人物档案')) return 'card';
  if (sys.includes('全书滚动摘要')) return 'global';
  if (user.includes('【JSON 字段结构】')) return 'config';
  if (user.includes('整理出这一段的情节大纲')) return 'outline';
  if (user.includes('「故事前提」')) return 'premise';
  if (user.includes('「世界观」')) return 'world';
  return '?';
}

function defaultReply(messages) {
  const user = messages[messages.length - 1].content;
  switch (kindOf(messages)) {
    case 'plot': {
      const no = Number(/第\s*(\d+)\s*章/.exec(user)?.[1] ?? 0);
      return JSON.stringify({
        梗概: `第 ${no} 章：林昭与沈青查旧案。`,
        出场人物: [{ name: '林昭', aliases: [] }, { name: '沈青', aliases: [] }],
        关键事件: [`第 ${no} 章查到一条线索`],
        连续性事实: [],
      });
    }
    case 'card':
      return JSON.stringify({ aliases: [], tags: ['主角'], 身份: '宗门弟子', 性格: '隐忍', 当前状态: '在渡口' });
    case 'global':
      return '## 主线\n\n林昭入宗查旧案，到了渡口。';
    case 'config':
      return CONFIG_JSON;
    case 'premise':
      return '## 一句话前提\n\n当孤儿遭遇灭门，必须入宗查案。\n\n## 核心冲突链\n\n灭门 → 入宗 → 查案。\n\n## 爽点循环\n\n残令。\n\n## 悬念骨架\n\n谁放的火。';
    case 'world':
      return '## 规则与漏洞\n\n灵脉决定修为。\n\n## 阶层与资源\n\n宗门垄断灵脉。\n\n## 深层危机\n\n灵脉在枯竭。';
    case 'outline': {
      const m = /里第 (\d+)(?:–(\d+))? 章实际发生/.exec(user);
      const from = Number(m[1]);
      const to = Number(m[2] ?? m[1]);
      const sections = [];
      for (let a = from; a <= to; a += 5) {
        const b = Math.min(to, a + 4);
        sections.push(`## 第${a}–${b}章：查案\n\n林昭在第 ${a}–${b} 章一路查下去。`);
      }
      return sections.join('\n\n');
    }
    default:
      return '';
  }
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    derive: './src/core/features/derive.ts',
    pipe: './src/core/views/pipeline.ts',
    pipeline: './src/core/model/pipeline.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({
    supportsVscodeLm: true,
    settings: () => ({ providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }], models: ['p/m'], concurrency: 1 }),
    overrides: { reviewReplace: undefined },
  });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { reply: (messages) => replyFn(messages) });
});

after(() => {
  for (const t of projects) cleanup(t.dir, bundle?.db);
});

/** 一个只有 7 章正文的工程（导入原稿之后的样子）。 */
async function fresh(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '补齐测试' });
  projects.push(t);
  for (let no = 1; no <= TITLES.length; no++) {
    t.write(CH(no), `# ${TITLES[no - 1]}\n\n${text(no)}\n`);
  }
  t.project.invalidate();
  fake.reset();
  replyFn = defaultReply;
  return t;
}
const kinds = () => fake.calls.map(kindOf);

describe('从已写正文补齐 · 全套', () => {
  let t;
  let calls;
  before(async () => {
    t = await fresh('derive-all');
    // 先整理细纲 → 总章数 → 开始补齐
    h.expect('先整理细纲', '100', '开始补齐');
    calls = await bundle.derive.deriveFromText(t.project);
  });

  test('第一次只报细纲的次数', () => {
    assert.equal(
      h.confirms[0].message,
      '从已写正文补齐第 1–7 章：先照正文给 7 章整理细纲（没定稿的、定稿后正文改过的），调用 7 次模型。现在开始？'
    );
  });

  test('第一次说清其余几样细纲出来再问：建卡次数要看细纲里认出了谁', () => {
    assert.match(h.confirms[0].detail, /细纲出来之后再算建卡、设定与情节大纲要调几次/);
  });

  test('总章数没写就问一句，缺省 100', () => {
    assert.equal(h.inputs.length, 1);
    assert.equal(h.inputs[0].value, '100');
    assert.equal(h.inputs[0].validate('3'), '填一个不小于 7 的整数');
    assert.equal(h.inputs[0].validate('120'), undefined);
  });

  test('第二次把其余几样一次列全，次数按细纲算准；不再另排细纲', () => {
    // 配置 1–3 + 前提 1 + 两张卡 2 + 世界观 1 + 大纲 1 + 全书摘要 1（上限 5）
    assert.equal(
      h.confirms[1].message,
      '从已写正文补齐第 1–7 章：小说配置、故事前提、角色卡、世界观、情节大纲、全书摘要，预计 7 次调用，最多 13 次。现在补？'
    );
  });

  test('第二次的说明：配置按总章数与已写的平均字数展开', () => {
    assert.match(h.confirms[1].detail, /按 100 章 × \d+ 字展开/);
  });

  test('第二次的说明：建卡的人取细纲里出场 2 章以上的', () => {
    assert.match(h.confirms[1].detail, /给林昭、沈青建卡（细纲里出场 2 章以上/);
  });

  test('第二次的说明：大纲照细纲整理', () => {
    assert.match(h.confirms[1].detail, /照细纲整理第 1–7 章，每次 20 章，1 次调用/);
  });

  test('第二次的说明：叙事线不排', () => {
    assert.match(h.confirms[1].detail, /叙事线不排/);
  });

  test('按链路顺序一件一件来', () => {
    assert.deepEqual(kinds(), [
      ...Array(7).fill('plot'),
      'config',
      'premise',
      'card',
      'card',
      'world',
      'outline',
      'global',
    ]);
  });

  test('返回实际次数', () => {
    assert.equal(calls, 14);
  });

  test('没有细纲的章照正文从头整理：一次都没带「当前细纲」', () => {
    const plotCalls = fake.calls.filter((m) => kindOf(m) === 'plot');
    assert.ok(plotCalls.every((m) => m[m.length - 1].content.includes('请为下面这一章整理细纲')));
  });

  test('架构四件都补上了；配置的规模按作者给的总章数与已写的平均字数', async () => {
    t.project.invalidate();
    const facts = await bundle.pipe.buildBookFacts(t.project);
    assert.deepEqual(facts.settings, { config: true, premise: true, characters: true, world: true });
    const book = await t.project.readBookConfig();
    assert.equal(book.totalChapters, 100);
    assert.ok(book.wordsPerChapter >= 100 && book.wordsPerChapter % 100 === 0, String(book.wordsPerChapter));
    assert.ok(t.has('.novelforge/characters/林昭.md') && t.has('.novelforge/characters/沈青.md'));
  });

  test('大纲覆盖到已写的最后一章', async () => {
    const facts = await bundle.pipe.buildBookFacts(t.project);
    assert.equal(facts.outlineCoverage, 7);
  });

  test('细纲落在 summaries/NNN-<章名>.md，一章一份', () => {
    const missing = [1, 2, 3, 4, 5, 6, 7].filter((no) => !t.has(PLOT(no)));
    assert.deepEqual(missing, []);
  });

  test('细纲的标题用章节自己的', async () => {
    t.project.invalidate();
    const titles = [];
    for (let no = 1; no <= 7; no++) titles.push((await t.project.getPlot(no)).title);
    assert.deepEqual(titles, TITLES);
  });

  test('细纲带着正文的 sourceHash：这几章直接算定稿过', async () => {
    const chapters = await t.project.listChapters();
    const unfinalized = [];
    for (const chapter of chapters) {
      if (!(await t.project.finalizedPlotOf(chapter))) unfinalized.push(chapter.order);
    }
    assert.deepEqual(unfinalized, []);
  });

  test('照正文整理出来的细纲不记目标字数（那是计划那一侧的账）', async () => {
    const plot = await t.project.getPlot(3);
    assert.equal(plot.targetWords, undefined);
  });

  test('流水线：每一章都是完成，正文不挂 ⟳', async () => {
    const rows = [];
    for (let no = 1; no <= 7; no++) {
      const plot = await t.project.getPlot(no);
      const row = await bundle.pipe.buildPlotPipeline(t.project, { no, plot });
      rows.push(`${row.stage}${row.chapter?.upstreamStale ? '⟳' : ''}`);
    }
    assert.deepEqual(rows, Array(7).fill('done'));
  });

  test('写大纲时不带技能、提示词说清是整理', () => {
    const outlineCall = fake.calls.find((m) => kindOf(m) === 'outline');
    assert.match(outlineCall[0].content, /这一次不是从零创作：作者已经写到第 7 章/);
    assert.ok(!outlineCall[outlineCall.length - 1].content.includes('补充写作 Skill'));
  });

  test('之后主按钮照常往后规划：续写第 8 章起的大纲', async () => {
    t.project.invalidate();
    const facts = await bundle.pipe.buildBookFacts(t.project);
    const stage = bundle.pipeline.deriveBookStage(facts);
    const step = bundle.pipeline.deriveBookNextStep(stage, facts);
    assert.equal(step.label, '续写情节大纲（第 8–27 章）');
    assert.equal(step.projectAction, undefined);
  });

  test('全书摘要更新到第 7 章', async () => {
    assert.equal((await t.project.readManifest()).globalSummaryThrough, 7);
  });

  test('完成提示报出补了什么与次数', () => {
    assert.ok(h.toasts.some((x) => x.includes('已从第 1–7 章补上：7 章细纲、') && x.includes('调用 14 次')), h.toasts.join('|'));
  });

  test('再来一次：什么都齐了，零调用、不弹框', async () => {
    fake.reset();
    h.expect();
    const n = await bundle.derive.deriveFromText(t.project);
    assert.equal(n, 0);
    assert.equal(fake.callCount(), 0);
    assert.equal(h.confirms.length, 0);
    assert.ok(h.toasts.some((x) => x.includes('都已经有了')), h.toasts.join('|'));
  });
});

describe('从已写正文补齐 · 只补空白', () => {
  let t;
  /** 第 2 章：作者定稿过、sourceHash 对得上正文的细纲。 */
  let finalizedText;
  /** 第 3 章：作者排过、还没定稿的计划。 */
  let planText;
  before(async () => {
    t = await fresh('derive-blank');
    t.write('.novelforge/config.md', '---\ntotalChapters: 50\nwordsPerChapter: 2000\n---\n\n# 小说配置\n\n## 核心梗概\n\n作者自己写的梗概。\n');
    t.write('.novelforge/premise.md', '# 故事前提\n\n## 一句话前提\n\n作者写的前提。\n\n## 核心冲突链\n\n作者写的冲突链。\n');
    const ch2 = (await t.project.listChapters()).find((c) => c.order === 2);
    finalizedText = [
      '---', 'no: 2', 'title: 作者的标题', `sourceHash: ${ch2.contentHash}`, 'cast: [林昭, 沈青]', '---', '',
      '# 第2章 作者的标题', '', '## 梗概', '', '作者定稿的梗概。', '', '## 出场人物', '', '林昭、沈青', '',
      '## 关键事件', '', '作者定稿的事件。', '',
    ].join('\n');
    t.write(PLOT(2), finalizedText);
    planText = [
      '---', 'no: 3', 'title: 作者排的', 'targetWords: 999', '---', '',
      '# 第3章 作者排的', '', '## 梗概', '', '作者排的梗概。', '', '## 关键事件', '', '作者排的事件。', '',
      '## 看点', '', '- 作者想的看点。', '',
    ].join('\n');
    t.write(PLOT(3), planText);
    t.project.invalidate();
    h.expect('先整理细纲', '开始补齐');
    await bundle.derive.deriveFromText(t.project);
  });

  test('配置与前提已经有了：不问总章数、不调那两件', () => {
    assert.equal(h.inputs.length, 0);
    assert.ok(!kinds().includes('config') && !kinds().includes('premise'), kinds().join(','));
    assert.match(t.read('.novelforge/config.md'), /作者自己写的梗概/);
    assert.match(t.read('.novelforge/premise.md'), /作者写的冲突链/);
  });

  test('定稿过、对得上正文的第 2 章不算在内：只给 6 章整理细纲', () => {
    assert.match(h.confirms[0].message, /先照正文给 6 章整理细纲/);
  });

  test('定稿过的第 2 章细纲一个字不动', () => {
    assert.equal(t.read(PLOT(2)), finalizedText);
  });

  test('排过计划的第 3 章：拿着当前细纲与正文对照着改', () => {
    const call = fake.calls.find((m) => kindOf(m) === 'plot' && m[m.length - 1].content.includes('【第3章 旧案 · 当前细纲】'));
    assert.match(call[call.length - 1].content, /## 梗概\n作者排的梗概。/);
  });

  test('第 3 章的计划原样进了回收站', () => {
    assert.equal(t.read(`.novelforge/.trash/${PLOT(3)}`), planText);
  });

  test('第 3 章反向更新之后：作者起的标题与目标字数留着', async () => {
    t.project.invalidate();
    const plot = await t.project.getPlot(3);
    assert.deepEqual({ title: plot.title, targetWords: plot.targetWords }, { title: '作者排的', targetWords: 999 });
  });

  test('第 3 章反向更新之后：八节换成照正文整理的那一版', async () => {
    const plot = await t.project.getPlot(3);
    assert.equal(plot.sections.梗概, '第 3 章：林昭与沈青查旧案。');
  });
});

describe('从已写正文补齐 · 一件失败就停', () => {
  let t;
  before(async () => {
    t = await fresh('derive-fail');
    replyFn = (messages) => (kindOf(messages) === 'outline' ? '' : defaultReply(messages));
    h.expect('先整理细纲', '100', '开始补齐');
    await bundle.derive.deriveFromText(t.project);
  });

  test('大纲没整理成：不更新全书摘要', () => {
    assert.ok(!kinds().includes('global'), kinds().join(','));
  });

  test('第一步整理好的细纲留着', () => {
    assert.ok(t.has(PLOT(1)));
  });

  test('失败挂在大纲上，提示说清停在哪、前面补上了什么', async () => {
    const failures = await bundle.errorLog.listActiveFailures(t.project);
    const onOutline = failures['.novelforge/outline.md'] ?? [];
    assert.ok(onOutline.some((f) => f.message.includes('情节大纲')), JSON.stringify(failures));
    assert.ok(
      h.toasts.some((x) => x.startsWith('error:') && x.includes('小说配置') && x.includes('情节大纲（第 1–7 章）没补上')),
      h.toasts.join('|')
    );
  });
});

describe('从已写正文补齐 · 取消与没有正文', () => {
  test('细纲那一步不同意：一次都不调', async () => {
    const t = await fresh('derive-cancel');
    h.expect(undefined);
    const n = await bundle.derive.deriveFromText(t.project);
    assert.equal(n, 0);
    assert.equal(fake.callCount(), 0);
  });

  test('第 1 章没有正文：说清要从第 1 章起连续', async () => {
    const t = await fresh('derive-gap');
    t.remove(CH(1));
    t.project.invalidate();
    h.expect();
    const n = await bundle.derive.deriveFromText(t.project);
    assert.equal(n, 0);
    assert.ok(h.toasts.some((x) => x.startsWith('error:') && x.includes('从第 1 章起连续')), h.toasts.join('|'));
  });
});
