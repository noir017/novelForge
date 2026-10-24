/**
 * 三期验收：从空工程开始，**跟着主按钮走**，一路写完前 3 章。
 *
 *   一句话 → 架构五件 → 情节大纲 → 第 1–5 章细纲（二期那一段，9 次调用）
 *   → 写第 1 章 → 定稿 → 写第 2 章 → 定稿 → 写第 3 章
 *
 * 每一步照前端的做法：取后端推来的下一步（`pipeline.next`），按它的 stage / capability /
 * target / range / writeMode 发送（定稿走工程动作），落盘卡片答「写入」。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 主按钮的顺序 | 第 20 条：写完一章先推定稿（D17、D23），定稿完转去下一章 |
 * | 写正文那几步的提示报「最多 8 次」 | D16：续写算进调用次数，动手之前写明 |
 * | 第 1 章用黄金第一章法则、后续章用连载法则 | 两套提示词（PT:720-855） |
 * | 第 2 章的装配：上一章结尾不许重演、后几章作边界、执行卡重列关键事件、全局要求 | 总计划 §2.3 |
 * | 第 2 章被截断，自动续写一轮 | §2.4 |
 * | 第 3 章开头重演了第 2 章结尾：卡片标红、写入要点两下 | §2.4：不替作者拒收 |
 * | 一共调了几次 | 第 4 条：二期 9 次 + 1 + 3 + 2 + 3 + 1 = 19（定稿是更新细纲 + 角色状态 + 认叙事线三次） |
 * | 定稿把同一份细纲照正文更新了 | 细纲并进摘要：定稿记 sourceHash、刷新 writtenFrom，不另存一份摘要 |
 * | 一张覆盖审阅都没弹 | 新章都是新建，没有东西可吞 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler, TIME_MARK, timeReply } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf } = require('../../helpers/outline');

let bundle;
let h;
let fake;
let t;
let project;
let controller;
let posted = [];

const IDEA = '一个从火里活下来的少年回到起火的镇子，发现幸存者不止他一个。';

const CONFIG_JSON = JSON.stringify({
  genre: '武侠',
  targetAudience: '男频',
  subGenre: '悬疑武侠',
  plotStructure: 'three_act',
  narrativePOV: 'third_limited',
  coreOutline: '林昭携残令回到青崖镇，追查七年前那场火，发现镇上的人集体缄默，而放火的人就在其中。',
  worldSetting: '江湖式微，镇与镇之间靠一份名册维系。',
  goldenFinger: '残令能照见持令人最后看见的一幕，每用一次要付出一段记忆。',
  protagonistProfile: '林昭，外冷内热，唯一的执念是找出放火的人。',
  globalGuidance: '1. 不写上帝视角\n2. 每章结尾留一个未决的问题\n3. 残令每次使用都有代价\n4. 对白要分得出是谁在说',
  writingStyle: '冷峻克制，短句为主，少用比喻，动作先于心理。',
});

const PREMISE = [
  '## 一句话前提', '当孤儿林昭回到青崖镇，必须找出放火的人，否则幸存者一个个死去。',
  '## 核心冲突链', '灭门之火 → 回镇 → 残令被认出 → 持令人接连出事 → 镇上集体缄默。',
  '## 爽点循环', '残令照见最后一幕，代价是记忆。',
  '## 悬念骨架', '显性：谁在杀持令人。隐藏：那场火是镇上的人一起放的。',
].join('\n\n');

const MANIFEST = JSON.stringify({
  slots: [
    { slotId: '1', name: '林昭', role: 'protagonist', narrativeDuty: '回镇追查', relations: [{ targetSlotId: '2', relation: '互相试探' }] },
    { slotId: '2', name: '沈氏', role: 'supporting', narrativeDuty: '客栈老板娘，知道一半真相', relations: [] },
    { slotId: '3', name: '李叔', role: 'antagonist', narrativeDuty: '守卫，守着镇上的秘密', relations: [{ targetSlotId: '1', relation: '处处设防' }] },
  ],
});

const WORLD = [
  '## 规则与漏洞', '名册决定谁算镇上的人；残令是名册的钥匙。',
  '## 阶层与资源', '守卫垄断出入，客栈垄断消息。',
  '## 深层危机', '名册上的人正在被一个个抹掉。',
].join('\n\n');

/** 一章一条，第 1–20 章（三幕 100 章的第一幕）。 */
const OUTLINE = outlineOf(20, {
  heading: false,
  titles: { 1: '停舟', 15: '名册' },
  text: { 1: '林昭进镇，残令被李叔认出。', 15: '持令人接连出事，名册的存在被揭开。' },
});

const TITLES = ['停舟', '令牌', '夜访', '井', '名册'];

/** 定稿那一次的应答：照正文更新过的细纲（八个中文键，与从前的摘要 JSON 同一份）。 */
const SUMMARY_JSON = (no) =>
  JSON.stringify({
    梗概: `第 ${no} 章：林昭在镇上又往前查了一步。`,
    出场人物: [{ name: '林昭', aliases: [] }],
    时间地点: '青崖镇，夜。',
    关键事件: [`第 ${no} 章的事`],
    状态变更: '林昭离真相近了一步。',
  });

/** 每一章正文的脚本（按执行卡里重列的关键事件认是第几章）。 */
function manuscript(no) {
  if (no === 1) {
    return { text: filler(900, 101), stop: 'end' };
  }
  if (no === 2) {
    // 写到一半被输出上限截断：续写一轮补上。
    return { text: filler(600, 201), stop: 'maxTokens' };
  }
  // 第 3 章开头把第 2 章的结尾又演了一遍。
  const ch2 = t.read('chapters/002-令牌.txt').trim();
  return { text: `${ch2.slice(-160)}\n\n${filler(900, 301)}`, stop: 'end' };
}

/** 按契约里认得出的那一段应答。 */
function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes('建立可检索的章节档案')) {
    // 定稿的 user 消息先给当前细纲再给正文，两块的块头都是「【第N章 标题 · …】」。
    const no = Number(/【第(\d+)章 /.exec(user)?.[1] ?? 0);
    return SUMMARY_JSON(no);
  }
  if (system.includes('依据本章正文更新角色的「当前状态」')) {
    return JSON.stringify({ updates: [{ name: '林昭', 当前状态: '在青崖镇，离真相近了一步。' }] });
  }
  // 叙事线认事件（每次定稿都跑）：还没排线，什么都认不出。
  if (system.includes('你是小说定稿事实审查员')) {
    return JSON.stringify({ events: [], newThreads: [], newForeshadowing: [] });
  }
  if (user.includes('请无缝续写当前章节正文')) {
    return { text: filler(500, 202), stop: 'end' };
  }
  const card = /- 必需事件：\n {2}- 第 (\d+) 章：/.exec(user);
  if (card && (user.includes('黄金第一章') || user.includes('连载更新核心法则'))) {
    return manuscript(Number(card[1]));
  }
  if (user.includes('【JSON 字段结构】')) return CONFIG_JSON;
  // 设定清单：三条一批就补完详情。
  if (user.includes('【设定清单合同】')) {
    return JSON.stringify({
      categories: ['地域', '信物', '制度'],
      entries: [
        { title: '青崖镇', category: '地域', keywords: [], brief: '偏僻小镇' },
        { title: '残令', category: '信物', keywords: [], brief: '照见最后一幕的令牌' },
        { title: '名册', category: '制度', keywords: [], brief: '决定谁算镇上的人' },
      ],
    });
  }
  if (user.includes('【冻结设定清单】')) {
    const titles = /【本批必须完整生成的条目】\n([^\n]+)/.exec(user)[1].split('、');
    return JSON.stringify({ entries: titles.map((title) => ({ title, body: `## 概要\n${title}。` })) });
  }
  if (user.includes('【冻结身份与关系清单】')) {
    const ids = /【本批必须完整生成的 slotId】\n([^\n]+)/.exec(user)[1].split('、');
    const names = { 1: '林昭', 2: '沈氏', 3: '李叔' };
    return JSON.stringify({
      entries: ids.map((id) => ({ slotId: id, name: names[id], 身份: `${names[id]}的身份`, 性格: '冷', 当前状态: '在青崖镇' })),
    });
  }
  if (user.includes('{"slots":[...]}')) return MANIFEST;
  if (user.includes('「故事前提」')) return PREMISE;
  if (user.includes('「世界观」')) return WORLD;
  if (user.includes('整合为全书的情节大纲')) return OUTLINE;
  const m = /chapterNumber 必须覆盖第 (\d+)(?:–(\d+))? 章的每一章/.exec(user);
  if (m) {
    const from = Number(m[1]);
    const to = Number(m[2] ?? m[1]);
    const blueprints = [];
    for (let no = from; no <= to; no++) {
      blueprints.push({
        chapterNumber: no,
        title: TITLES[no - 1] ?? `第${no}章`,
        synopsis: `第 ${no} 章林昭要弄清的一件事。`,
        characters: ['林昭', '沈氏'],
        timePlace: '青崖镇，夜。',
        // 关键事件与定稿一样是一条一件事的数组（⚑B）；执行卡里多条缩进列在「必需事件」下面。
        keyEvents: [`第 ${no} 章：林昭在镇上的两个场面里推进，残令照见一幕。`, '他为此付出代价。'],
        highlights: [`第 ${no} 章结尾：又一个持令人不见了。`],
        foreshadowing: [],
        stateChange: '林昭离真相近了一步。',
      });
    }
    return JSON.stringify({ blueprints });
  }
  // 故事时间（同步时单独一次，2026-10-24 重做）：都紧接上一章。
  if ((messages[0]?.content ?? '').includes(TIME_MARK)) {
    return timeReply(messages);
  }
  return '（认不出这一步）';
}

function attach() {
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict: 'proceed' });
      }
    },
    reveal() {},
  });
}

async function nextStep() {
  posted = [];
  await controller.handle({ type: 'requestPipeline' });
  return posted.filter((m) => m.type === 'pipeline').pop()?.next;
}

/** 照前端 `runNextStep` 的做法按下主按钮。返回这一步的落盘卡片（定稿没有卡片）。 */
async function press(step) {
  posted = [];
  if (step.projectAction) {
    await controller.handle({ type: 'projectAction', action: step.projectAction, relPath: step.target.plotRelPath });
    return undefined;
  }
  const payload =
    step.form === 'idea'
      ? {
          text: IDEA,
          stage: 'setting',
          capability: 'generate',
          target: { kind: 'setting', doc: 'config' },
          targetNo: 1,
          setup: { totalChapters: 30, wordsPerChapter: 1000 },
        }
      : {
          text: '',
          stage: step.stage,
          capability: step.capability,
          target: step.target,
          targetNo: step.no ?? step.range?.from ?? 1,
          range: step.range,
          writeMode: step.writeMode,
        };
  await controller.handle({ type: 'send', payload: { ...payload, attachments: [], excludedIds: [] } });
  return posted.filter((m) => m.type === 'gate').pop();
}

/** 第 i 次调用的 user 消息。 */
const userOf = (i) => fake.calls[i][fake.calls[i].length - 1].content;
/** 第一次调用里认得出是第几章正文的那一次（按执行卡重列的关键事件）。 */
const firstWriteCallOf = (no) =>
  fake.calls.findIndex((c) => {
    const u = c[c.length - 1].content;
    return u.includes(`- 必需事件：\n  - 第 ${no} 章：`) && !u.includes('请无缝续写当前章节正文');
  });

describe('三期验收：一句话 → 写完前 3 章', () => {
  const steps = [];
  const gates = [];
  let finalStep;

  before(async () => {
    bundle = loadBundle({
      host: './src/core/host.ts',
      project: './src/core/model/project.ts',
      registry: './src/core/llm/registry.ts',
      provider: './src/core/llm/provider.ts',
      controller: './src/core/controller/index.ts',
      pipelineModel: './src/core/model/pipeline.ts',
      plotFile: './src/core/model/plotFile.ts',
      db: './src/core/runtime/db.ts',
    });
    const settings = {
      providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
      models: ['p/m'],
      concurrency: 1,
    };
    h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
    bundle.host.initHost(h.host);
    fake = installFakeProvider(bundle.registry, {
      reply: (messages) => reply(messages),
      errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
    });
    t = await makeTempProject(bundle.project, { prefix: 'phase3', title: '青崖记' });
    project = t.project;
    controller = new bundle.controller.ChatController(project);
    attach();

    // 二期那七步 + 写 / 定稿 / 写 / 定稿 / 写。
    for (let i = 0; i < 12; i++) {
      const step = await nextStep();
      assert.ok(step, `第 ${i + 1} 步没有下一步`);
      steps.push(step);
      gates.push(await press(step));
    }
    finalStep = await nextStep();
  });

  after(() => {
    controller?.dispose();
    if (t) cleanup(t.dir, bundle?.db);
  });

  test('主按钮的顺序：拆完细纲之后，写一章、定稿一章', () => {
    assert.deepEqual(steps.slice(7).map((s) => s.label), [
      '写第 1 章',
      '同步第 1 章',
      '写第 2 章',
      '同步第 2 章',
      '写第 3 章',
    ]);
  });

  test('写完第 3 章，主按钮推第 3 章的定稿', () => {
    assert.equal(finalStep?.label, '同步第 3 章', JSON.stringify(finalStep));
    assert.equal(finalStep?.no, 3);
  });

  test('写正文那几步的提示报「1 次，最多 8 次」', () => {
    for (const s of steps.filter((x) => x.label.startsWith('写第'))) {
      assert.deepEqual(s.calls, bundle.pipelineModel.WRITE_CALLS, s.label);
    }
  });

  // 第 4 条：二期 9 次 + 第 1 章 1 + 定稿 4 + 第 2 章 2（截断续写一轮）+ 定稿 4 + 第 3 章 1。
  // 定稿四次：照正文更新细纲一次，林昭有角色卡、再更新一次角色状态（四期，D17），认一次叙事线（叙事线重做：
  // 线是空的也认），推一次故事时间（2026-10-24 重做）。
  test('一共调了 21 次模型', () => {
    assert.equal(fake.callCount(), 21);
  });

  test('三章都落在 chapters/，标题取细纲的，正文写了进去', async () => {
    const chapters = await project.listChapters();
    // 正文是 .txt（2026-10-24）：标题只在文件名里，不写标题行。
    assert.deepEqual(chapters.map((c) => c.relPath), ['chapters/001-停舟.txt', 'chapters/002-令牌.txt', 'chapters/003-夜访.txt']);
    assert.deepEqual(chapters.map((c) => c.title), ['停舟', '令牌', '夜访']);
    assert.ok(!t.read('chapters/001-停舟.txt').startsWith('#'));
    assert.ok(t.read('chapters/001-停舟.txt').includes(filler(900, 101)));
  });

  test('第 2 章：截断后续写的那一轮拼在后面', () => {
    const text = t.read('chapters/002-令牌.txt');
    assert.ok(text.includes(`${filler(600, 201)}\n\n${filler(500, 202)}`), text.slice(0, 80));
    assert.match(gates[9].detail, /1100 \/ 1000 字 · 已达标/);
    assert.match(gates[9].detail, /这一轮一共调了 2 次模型（续写 1 轮）/);
  });

  test('第 3 章：开头重演了第 2 章结尾——卡片标红、写入要点两下', () => {
    assert.match(gates[11].danger, /与上一章结尾大段重合/);
    assert.equal(gates[11].confirm, '确定仍要写入');
    assert.ok(gates[7].danger === undefined && gates[9].danger === undefined);
  });

  test('第 1 章用黄金第一章法则', () => {
    const u = userOf(firstWriteCallOf(1));
    assert.match(u, /【网文「黄金第一章」创作法则】/);
    assert.ok(!u.includes('# 上一章结尾原文'));
  });

  test('第 2 章用连载法则', () => {
    assert.match(userOf(firstWriteCallOf(2)), /【网文连载更新核心法则】/);
  });

  test('第 2 章的装配：上一章结尾只作边界，不许重演', () => {
    const u = userOf(firstWriteCallOf(2));
    assert.ok(u.includes('# 上一章结尾原文（只作边界，不可重演）') || u.includes('不要重演它的结尾'), u.slice(0, 600));
  });

  test('第 2 章的装配：后几章的细纲作边界', () => {
    const u = userOf(firstWriteCallOf(2));
    const boundary = u.slice(u.indexOf('# 后续章节预告'));
    assert.ok(['第3章', '第4章', '第5章'].every((x) => boundary.includes(x)), boundary.slice(0, 400));
  });

  test('第 2 章的执行卡按原来的顺序一条一项重列本章细纲的关键事件', () => {
    const u = userOf(firstWriteCallOf(2));
    assert.ok(u.includes('- 必需事件：\n  - 第 2 章：林昭在镇上的两个场面里推进，残令照见一幕。\n  - 他为此付出代价。\n'), u.slice(-800));
  });

  // 章末钩子并进了「看点」：看点里爽点与章末悬念混在一起，不是一件件到期的动作，执行卡不重列它。
  test('第 2 章的执行卡不再单列章节钩子', () => {
    assert.doesNotMatch(userOf(firstWriteCallOf(2)), /- 章节钩子：/);
  });

  test('第 2 章的装配带着全局要求', () => {
    assert.match(userOf(firstWriteCallOf(2)), /# 全局要求（每一章都要遵守）[\s\S]*不写上帝视角/);
  });

  test('第 2 章的装配里带着第 1 章（前文）', () => {
    const u = userOf(firstWriteCallOf(2));
    assert.ok(u.includes('第 1 章《停舟》'), u.slice(0, 800));
  });

  // 细纲并进摘要之后不另存一份单章摘要：定稿就是把同一份细纲照正文改写，记下正文的指纹。
  test('第 1、2 章定稿过：细纲的 sourceHash 对得上正文', async () => {
    const chapters = await project.listChapters();
    const finalized = await Promise.all(chapters.map((ch) => project.finalizedPlotOf(ch)));
    assert.deepEqual(finalized.map((p) => p?.no), [1, 2, undefined]);
  });

  test('定稿后的细纲换成了模型照正文更新的那一份', async () => {
    const plots = await Promise.all([1, 2].map((no) => project.getPlot(no)));
    assert.deepEqual(
      plots.map((p) => p.sections.梗概),
      ['第 1 章：林昭在镇上又往前查了一步。', '第 2 章：林昭在镇上又往前查了一步。']
    );
  });

  test('第 3 章写完还没定稿：细纲仍是计划，没有 sourceHash', async () => {
    assert.equal((await project.getPlot(3)).sourceHash, '');
  });

  // writtenFrom：第 1、2 章定稿时刷成更新后的内容指纹，第 3 章是正文落盘时记的——三章都不挂 ⟳。
  test('三章细纲的 writtenFrom 都对得上内容指纹', async () => {
    const plots = await Promise.all([1, 2, 3].map((no) => project.getPlot(no)));
    assert.deepEqual(
      plots.map((p) => p.writtenFrom),
      plots.map((p) => bundle.plotFile.plotContentHash(p))
    );
  });

  test('一张覆盖审阅都没弹', () => {
    assert.equal(h.reviewed.length, 0, JSON.stringify(h.reviewed.map((r) => r.relPath)));
  });
});
