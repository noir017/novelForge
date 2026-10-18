/**
 * 从已写正文补齐（拆书 A 的后一半，features/derive.ts）。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 全套 | 两次确认（先只报细纲，细纲出来再报其余）；按 细纲 → 配置 → 前提 → 角色卡 → 世界观 → 大纲 → 全书摘要 的顺序；第一步照正文写出 `summaries/NNN-<章名>.md`、带 sourceHash，直接算定稿过（不再另排一遍细纲）；之后主按钮照常续写大纲 |
 * | 设定条目 | 一条条目都没有时，建卡之后从名录建（出现 ≥2 章，没有就降到 1 章），次数算进第二次确认；没建成挂黄 ❗、后面照常补 |
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
  if (sys.includes('把定稿细纲里关于一个设定的记录整理成一条设定条目')) return 'lore';
  if (sys.includes('全书滚动摘要')) return 'global';
  if (user.includes('【JSON 字段结构】')) return 'config';
  if (user.includes('整理出这一段的情节大纲')) return 'outline';
  if (user.includes('「故事前提」')) return 'premise';
  if (user.includes('「世界观」')) return 'world';
  return '?';
}

/** 整理细纲时第 no 章记下的「设定」（第九节）。缺省一条都没有。 */
let loreOf = () => [];

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
        设定: loreOf(no),
      });
    }
    case 'card':
      return JSON.stringify({ aliases: [], tags: ['主角'], 身份: '宗门弟子', 性格: '隐忍', 当前状态: '在渡口' });
    case 'lore':
      return JSON.stringify({ brief: '青云宗的山门', keywords: ['山门'], body: '## 概要\n山门很高。\n\n## 规则与边界\n（未交代）\n\n## 现状\n（未交代）' });
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
    lore: './src/core/views/lore.ts',
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
  loreOf = () => [];
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

  // 设定清单不在补齐的件数里：有正文的书那一件本来就算填过。
  test('架构几件都补上了；配置的规模按作者给的总章数与已写的平均字数', async () => {
    t.project.invalidate();
    const facts = await bundle.pipe.buildBookFacts(t.project);
    assert.deepEqual(facts.settings, { config: true, premise: true, characters: true, world: true, lore: true });
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

describe('从已写正文补齐 · 设定条目（从名录建）', () => {
  let t;
  let calls;
  let failures;
  before(async () => {
    t = await fresh('derive-lore');
    // 每一章都记下「山门」（7 章）；「门外」只在第 3 章记过（1 章，不到 2 章的门槛）。
    loreOf = (no) => [
      { name: '山门', category: '地域', fact: '山门很高' },
      ...(no === 3 ? [{ name: '门外', category: '地域', fact: '' }] : []),
    ];
    h.expect('先整理细纲', '100', '开始补齐');
    calls = await bundle.derive.deriveFromText(t.project);
    failures = await bundle.errorLog.listActiveFailures(t.project);
  });

  test('确认框把设定条目算进去：出现 2 章以上的那几条，每条 1 次，解析不了的重来一次', () => {
    // 配置 1–3 + 前提 1 + 两张卡 2 + 世界观 1 + 设定条目 1（上限 2）+ 大纲 1 + 全书摘要 1（上限 5）
    assert.equal(
      h.confirms[1].message,
      '从已写正文补齐第 1–7 章：小说配置、故事前提、角色卡、世界观、设定条目、情节大纲、全书摘要，预计 8 次调用，最多 15 次。现在补？'
    );
    assert.match(h.confirms[1].detail, /设定条目：给山门建条目（细纲里出现 2 章以上、还没有条目/);
    assert.match(h.confirms[1].detail, /只读定稿细纲里提到它们的那几行，预计 1 次调用，最多 2 次/);
    assert.ok(!/门外/.test(h.confirms[1].detail), h.confirms[1].detail);
  });

  test('建卡之后、大纲之前建条目', () => {
    assert.deepEqual(kinds(), [...Array(7).fill('plot'), 'config', 'premise', 'card', 'card', 'world', 'lore', 'outline', 'global']);
    assert.equal(calls, 15);
  });

  test('条目建在名录给的分类目录里：标题、关键词、一句话、机器写的指纹、水位到最后一章定稿', async () => {
    t.project.invalidate();
    const entries = await t.project.listLore();
    assert.deepEqual(entries.map((e) => e.relPath), ['.novelforge/lore/地域/山门.md']);
    const [e] = entries;
    assert.equal(e.title, '山门');
    assert.equal(e.category, '地域');
    assert.equal(e.brief, '青云宗的山门');
    assert.equal(e.updatedThrough, 7);
    assert.ok(e.bodyHash && e.body.includes('山门很高'));
    // 建条目的原料只是定稿细纲里提到它的那几行，不重读正文。
    const lore = fake.calls.find((m) => kindOf(m) === 'lore');
    assert.match(lore[lore.length - 1].content, /- 第 1 章：山门很高/);
  });

  test('完成提示报出建了几条；没有挂失败', () => {
    assert.ok(h.toasts.some((x) => x.includes('设定条目 1 条')), h.toasts.join('|'));
    assert.equal(failures['.novelforge/lore'], undefined);
  });

  test('之后名录里「山门」有了条目，「门外」仍是未建条目', async () => {
    const index = await bundle.lore.buildLoreIndex(t.project);
    assert.deepEqual(index.unknown.map((u) => u.name), ['门外']);
    assert.deepEqual(index.known.map((r) => r.chapters.length), [7]);
  });
});

describe('从已写正文补齐 · 设定条目没建成也不停', () => {
  let t;
  let failures;
  before(async () => {
    t = await fresh('derive-lore-fail');
    // 只有一章记过设定：门槛降到 1 章。
    loreOf = (no) => (no === 3 ? [{ name: '山门', category: '地域', fact: '' }] : []);
    replyFn = (messages) => (kindOf(messages) === 'lore' ? '不是 JSON' : defaultReply(messages));
    h.expect('先整理细纲', '100', '开始补齐');
    await bundle.derive.deriveFromText(t.project);
    failures = await bundle.errorLog.listActiveFailures(t.project);
  });

  test('名录里没有出现 2 章以上的：降到 1 章', () => {
    assert.match(h.confirms[1].detail, /给山门建条目（细纲里出现 1 章以上/);
  });

  test('后面的大纲与全书摘要照常补', () => {
    assert.deepEqual(kinds().slice(-3), ['lore', 'outline', 'global']);
    assert.ok(!h.toasts.some((x) => x.startsWith('error:')), h.toasts.join('|'));
  });

  test('黄 ❗ 挂在「设定清单」那一行（设定目录）上；一条都没建', async () => {
    const onLore = failures['.novelforge/lore'] ?? [];
    assert.ok(onLore.some((f) => f.severity === 'warn' && f.message.includes('设定条目一条都没建成')), JSON.stringify(failures));
    assert.deepEqual(await t.project.listLore(), []);
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

  // 第 3、4 章没有正文、后面还有 3 章：多半是章号没接上，先问一句再只照第 1–2 章做。
  test('中间断了一截：先问要不要只照前一截做，不同意就一次都不调', async () => {
    const t = await fresh('derive-mid-gap');
    t.remove(CH(3));
    t.remove(CH(4));
    t.write('chapters/005-作话.md', '作者有话说');
    t.project.invalidate();
    const chapters = await t.project.listChapters();
    assert.deepEqual(bundle.pipe.chapterGapOf(chapters), { from: 3, to: 4, later: 3, last: 7 });
    assert.deepEqual(bundle.pipe.duplicateChapterNos(chapters), [5]);
    const facts = await bundle.pipe.buildBookFacts(t.project);
    assert.equal(bundle.pipeline.deriveBookNextStep(bundle.pipeline.deriveBookStage(facts), facts).projectAction, 'chapterGap');

    const before = h.confirms.length;
    h.expect(undefined);
    const n = await bundle.derive.deriveFromText(t.project);
    assert.equal(n, 0);
    assert.equal(fake.callCount(), 0);
    const c = h.confirms[before];
    assert.match(c.message, /第 3–4 章没有正文，后面还有 3 章已写（写到第 7 章）/);
    assert.deepEqual(c.actions, ['仍然继续']);
  });

  test('只到末尾没写完不算断：照常补齐', async () => {
    const t = await fresh('derive-tail');
    t.remove(CH(7));
    t.project.invalidate();
    assert.equal(bundle.pipe.chapterGapOf(await t.project.listChapters()), undefined);
  });
});
