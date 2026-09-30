/**
 * 五期验收：审一章 → 丢掉伪造的引文 → 按勾选修稿（截断续写一轮、合并视图交回的那一份落盘）→
 * 修稿太短报错 → 下一章的细纲排了死人，主按钮先亮预检卡。
 *
 * 工程：第 1–2 章写好且定稿，第 3 章排好细纲（排着角色卡上已经死了的沈秋）。假模型按系统提示
 * 认是哪一步：审稿 / 修稿 / 写正文。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 报告只剩引文站得住的问题，notes 写着丢了哪条 | 引文找不到的丢弃（总计划 §5 五期验收第一条） |
 * | 目标 4 项（3 条关键事件 + 章末钩子），「未完成」没给引文的降待核实 | 「没写到」只能判待核实 |
 * | 审稿 1 次调用、没有落盘卡片、会话文件里存着报告 | D22 |
 * | 修稿发出去的那一次：整章原文 + 只有勾选的两条 | 作者没勾的不该出现在模型眼前 |
 * | 截断一次再续完：调用 2 次；覆盖审阅拿到修订稿；落盘的是合并结果 | W11 |
 * | 修订稿不到原稿六成：报错，磁盘不变 | 修稿后长度低于阈值时报错（总计划 §5 五期验收第二条） |
 * | 修过稿，主按钮先推重新定稿第 2 章 | 摘要跟着修订稿走 |
 * | 主按钮写第 3 章：先亮预检卡，「先不写」零调用，再按一次「仅本次忽略」照写 | 一致性预检零调用、可以仅本次忽略 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let fake;
let project;
let controller;
let posted = [];
let gateAnswer = () => 'proceed';
const queues = { review: [], revise: [], write: [] };

const P2 = '.novelforge/plots/002-客栈.md';
const CH2_REL = 'chapters/002-客栈.md';

const CH2 = [
  '雨下了一整夜。林昭推开客栈的门，檐下的灯笼被风吹得直晃。',
  '沈氏在柜台后看着他，没说话。她把那块残令收进了袖中。',
  filler(900, 7),
  '“你明天就走？”她问。林昭点了点头，说：“天一亮就走。”',
].join('\n\n');

const REVIEW = JSON.stringify({
  summary: '一处硬伤，一处角色状态不一致',
  items: [
    { category: '剧情合理性', severity: 'error', quote: '她把那块残令收进了袖中', description: '第 1 章林昭已经把残令交给了李叔' },
    { category: '角色状态', severity: 'warning', quote: '林昭点了点头', description: '他左臂有伤，动作写得如常' },
    { category: '角色状态', severity: 'warning', quote: '林昭拔剑指着沈氏的喉咙', description: '正文里根本没有这一句' },
  ],
  goalReviews: [
    { id: 'g1', status: 'completed', description: '回到了客栈', evidence: [{ quote: '林昭推开客栈的门' }] },
    { id: 'g2', status: 'unmet', description: '细纲要他当晚离开，正文里他说天亮再走', evidence: [{ quote: '天一亮就走' }] },
    { id: 'g3', status: 'unmet', description: '正文里没写到沈氏收下残令', evidence: [] },
    { id: 'g4', status: 'unknown', description: '结尾没有写到敲门', evidence: [] },
  ],
});

function kindOf(messages) {
  const sys = messages[0]?.content ?? '';
  if (sys.includes('严谨的小说审稿编辑')) return 'review';
  if (sys.includes('只依据人工确认的审稿意见')) return 'revise';
  return 'write';
}

function attach() {
  controller.attach({
    kind: 'sidebar',
    post: (m) => {
      posted.push(m);
      if (m.type === 'gate') {
        void controller.handle({ type: 'gateResult', requestId: m.requestId, verdict: gateAnswer(m) });
      }
    },
    reveal() {},
  });
}

const gates = () => posted.filter((m) => m.type === 'gate');
const lastAssistant = () =>
  [...posted.filter((m) => m.type === 'turnDone').map((m) => m.turn)].reverse().find((x) => x.role === 'assistant');
const promptsOf = (kind) => fake.calls.filter((c) => kindOf(c) === kind).map((c) => c[c.length - 1].content);
const readCh2 = async () => project.readChapterText(await project.getChapter(2));

async function nextStep() {
  posted = [];
  await controller.handle({ type: 'requestPipeline' });
  return posted.filter((m) => m.type === 'pipeline').pop()?.next;
}

/** 照前端 `runNextStep` 的做法按下主按钮。 */
async function press(step) {
  posted = [];
  await controller.handle({
    type: 'send',
    payload: { text: '', stage: step.stage, capability: step.capability, target: step.target, targetNo: step.no ?? 1, writeMode: step.writeMode, attachments: [], excludedIds: [] },
  });
}

function summary(no, title, hash, facts = '') {
  return [
    '---', `chapter: ${no}`, `title: ${title}`, `sourceHash: ${hash}`, 'generatedBy: novel-forge', '---', '',
    `# 第${no}章 ${title} · 摘要`, '', '## 梗概', '', `第 ${no} 章的事。`, '', '## 出场人物', '', '林昭', '',
    ...(facts ? ['## 连续性事实', '', facts, ''] : []),
  ].join('\n');
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
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
    reply: (messages) => queues[kindOf(messages)].shift() ?? '（脚本里没有这一步）',
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'phase5', title: '青崖记' });
  project = t.project;
  t.write('.novelforge/config.md', '---\ntotalChapters: 10\nwordsPerChapter: 1000\n---\n\n# 小说配置\n\n## 核心梗概\n\n回镇查案。\n');
  // 架构三件与大纲借示例工程的：全书状态机要它们齐了，才会走到「写第 N 章」。
  const sample = (rel) => fs.readFileSync(path.join(__dirname, '../../../sample-novel/.novelforge', rel), 'utf8');
  t.write('.novelforge/premise.md', sample('premise.md'));
  t.write('.novelforge/world.md', sample('world.md'));
  t.write('.novelforge/outline.md', sample('outline.md'));
  const ws = new bundle.ws.Workspace(project);
  const empty = bundle.plotFile.emptyPlotSections();
  const plot = async (no, title, characters, events, hook) =>
    ws.writePlot({ no, title, role: '', characters, targetWords: 1000, upstreamHash: '', done: false, sections: { ...empty, 本章目的: `第 ${no} 章的目的`, 关键事件: events, 章末钩子: hook } });
  await plot(1, '雨夜', ['林昭'], '林昭回镇，把残令交给李叔', '李叔认出了残令');
  await plot(2, '客栈', ['林昭', '沈氏'], '林昭回到客栈；林昭当晚离开青崖镇；沈氏收下残令', '门外有人敲了三下');
  await plot(3, '渡口', ['林昭', '沈秋'], '林昭在渡口等沈秋', '船上没有人');
  await ws.createChapter(1, '雨夜', filler(1000, 1));
  await ws.createChapter(2, '客栈', CH2);
  await project.syncManifest();
  // 两章都定稿过：摘要的 sourceHash 对得上正文。
  const ch1 = await project.getChapter(1);
  const ch2 = await project.getChapter(2);
  t.write('.novelforge/summaries/001-雨夜.md', summary(1, '雨夜', ch1.contentHash, '- 林昭把残令交给了李叔'));
  t.write('.novelforge/summaries/002-客栈.md', summary(2, '客栈', ch2.contentHash));
  t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\nstateThrough: 2\n---\n\n# 林昭\n\n## 当前状态\n\n左臂受伤，住在客栈\n');
  t.write('.novelforge/characters/沈秋.md', '---\nname: 沈秋\nstateThrough: 2\n---\n\n# 沈秋\n\n## 当前状态\n\n已死亡（第 2 章夜里死在渡口）\n');
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  attach();
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('五期验收', () => {
  let reviewTurn;

  describe('审第 2 章', () => {
    before(async () => {
      queues.review.push({ text: REVIEW, stop: 'end' });
      fake.calls.length = 0;
      posted = [];
      await controller.handle({
        type: 'send',
        payload: { text: '', stage: 'manuscript', capability: 'review', target: { kind: 'manuscript', plotRelPath: P2 }, targetNo: 2, attachments: [], excludedIds: [] },
      });
      reviewTurn = lastAssistant();
    });

    test('一次调用，没有落盘卡片', () => {
      assert.equal(fake.calls.length, 1);
      assert.equal(gates().length, 0);
    });

    test('伪造引文的那一条被丢掉；notes 写着丢了哪条', () => {
      const report = reviewTurn.review.report;
      assert.deepEqual(report.issues.map((i) => i.description), ['第 1 章林昭已经把残令交给了李叔', '他左臂有伤，动作写得如常']);
      assert.equal(report.dropped.length, 1);
      assert.match(reviewTurn.review.notes.join('\n'), /「正文里根本没有这一句」引文在正文里找不到/);
    });

    test('目标 4 项：3 条关键事件 + 章末钩子；「未完成」没给引文的降待核实', () => {
      const goals = reviewTurn.review.report.goals;
      assert.deepEqual(goals.map((g) => [g.kind, g.status]), [
        ['event', 'completed'],
        ['event', 'unmet'],
        ['event', 'unknown'],
        ['hook', 'unknown'],
      ]);
    });

    test('审稿的装配里有前一章定稿留下的事实', () => {
      assert.match(promptsOf('review')[0], /# 前几章的连续性事实（已定稿[^\n]*\n\n【第 1 章《雨夜》】\n- 林昭把残令交给了李叔/);
    });

    test('会话文件里存着报告', () => {
      const file = path.join(project.sessionsDir, `${controller.current.id}.json`);
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(json.turns.find((x) => x.id === reviewTurn.id).review.report.chapterNo, 2);
    });
  });

  describe('勾 1 条问题 + 1 项未完成，按勾选修稿', () => {
    let before2;
    before(async () => {
      before2 = await readCh2();
      const revised = before2
        .replace('她把那块残令收进了袖中。', '她看了一眼他空着的手，什么也没问。')
        .replace('“天一亮就走。”', '“今晚就走。”');
      const cut = Math.floor(revised.length * 0.6);
      queues.revise.push({ text: revised.slice(0, cut), stop: 'maxTokens' }, { text: revised.slice(cut), stop: 'end' });
      h.reviewed.length = 0;
      h.setReviewVerdict(({ proposed }) => ({ merged: `${proposed.trim()}\n\n作者在合并视图里补的一句。\n` }));
      fake.calls.length = 0;
      await controller.handle({ type: 'reviseChapter', turnId: reviewTurn.id, picks: ['i1', 'g2'] });
    });

    test('发出去的那一次：整章原文 + 只有勾选的两条', () => {
      const [first] = promptsOf('revise');
      assert.ok(first.includes(before2.trim()), '整章原文');
      assert.match(first, /1\. \[剧情合理性 \/ 严重\] 第 1 章林昭已经把残令交给了李叔/);
      assert.match(first, /2\. \[本章目标 \/ 未完成\] 关键事件：林昭当晚离开青崖镇/);
      assert.doesNotMatch(first, /他左臂有伤/);
      assert.doesNotMatch(first, /门外有人敲了三下」?\n   判断/);
    });

    test('截断一次再续完：调用 2 次', () => {
      assert.equal(fake.calls.length, 2);
      assert.match(promptsOf('revise')[1], /上一轮修稿输出因长度限制而中断/);
    });

    test('覆盖审阅拿到的是修订稿，请求了合并；落盘的是合并结果', async () => {
      assert.equal(h.reviewed.length, 1);
      assert.equal(h.reviewed[0].merge, true);
      assert.match(h.reviewed[0].proposed, /她看了一眼他空着的手/);
      const now = await readCh2();
      assert.match(now, /今晚就走/);
      assert.match(now, /作者在合并视图里补的一句。/);
      assert.doesNotMatch(now, /残令收进了袖中/);
    });

    test('修稿不记 writtenFrom（细纲改过的 ⟳ 不因为修了一次稿就消掉）', async () => {
      // 第 2 章是作者手写落盘的（从没记过 writtenFrom），修稿之后也不该冒出来一个。
      assert.ok(!(await project.getPlot(2)).writtenFrom);
    });
  });

  describe('修订稿不到原稿六成', () => {
    test('报错，磁盘不变', async () => {
      const before3 = await readCh2();
      const fresh = await (async () => {
        queues.review.push({ text: JSON.stringify({ summary: 'x', items: [{ category: '角色状态', severity: 'warning', quote: '林昭点了点头', description: '动作如常' }], goalReviews: [] }), stop: 'end' });
        posted = [];
        await controller.handle({
          type: 'send',
          payload: { text: '', stage: 'manuscript', capability: 'review', target: { kind: 'manuscript', plotRelPath: P2 }, targetNo: 2, attachments: [], excludedIds: [] },
        });
        return lastAssistant();
      })();
      queues.revise.push({ text: '林昭托着左臂，点了点头。', stop: 'end' });
      h.reviewed.length = 0;
      posted = [];
      await controller.handle({ type: 'reviseChapter', turnId: fresh.id, picks: ['i1'] });
      assert.match(lastAssistant().error, /修订稿明显短于原稿/);
      assert.equal(h.reviewed.length, 0);
      assert.equal(await readCh2(), before3);
    });
  });

  describe('主按钮写第 3 章：细纲排着已经死了的沈秋', () => {
    // 修过稿，第 2 章的摘要就过期了：主按钮先推重新定稿（连续性事实与角色状态要跟着修订稿走）。
    test('修稿之后下一步是重新定稿第 2 章；定稿之后才是写第 3 章', async () => {
      assert.equal((await nextStep()).label, '定稿第 2 章');
      const ch2 = await project.getChapter(2);
      t.write('.novelforge/summaries/002-客栈.md', summary(2, '客栈', ch2.contentHash));
      project.invalidate();
      assert.equal((await nextStep()).label, '写第 3 章');
    });

    test('先亮预检卡；「先不写」一次模型都不调', async () => {
      fake.calls.length = 0;
      gateAnswer = (m) => (m.name === 'preflight' ? 'skip' : 'proceed');
      await press(await nextStep());
      assert.equal(fake.calls.length, 0);
      const [g] = gates();
      assert.equal(g.name, 'preflight');
      assert.match(g.danger, /沈秋的当前状态（截至第 2 章）写着「已死亡」，本章细纲仍安排这个人出场/);
      assert.match(lastAssistant().content, /这一次先不写——没有调用模型/);
      assert.ok(!t.has('chapters/003-渡口.md'));
    });

    test('再按一次、选「仅本次忽略」：照写', async () => {
      fake.calls.length = 0;
      gateAnswer = () => 'proceed';
      queues.write.push({ text: filler(900, 30), stop: 'end' });
      await press(await nextStep());
      assert.equal(fake.calls.length, 1);
      assert.deepEqual(gates().map((g) => g.name), ['preflight', 'artifact']);
      assert.ok(t.has('chapters/003-渡口.md'));
    });
  });
});
