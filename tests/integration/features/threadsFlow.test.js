/**
 * 七期验收：从排好前 5 章细纲的工程起，工程页「从细纲排出」叙事线，再「批量写章」第 1–3 章、
 * 写完即定稿。
 *
 *   排线 → 写第 1 章 → 定稿（摘要 + 叙事线）→ 写第 2 章 → 定稿 → 写第 3 章 → 定稿
 *
 * 经 controller 发出去（与工程页那一颗按钮、弹窗提交的消息一样），假模型按脚本应答。
 * 没有角色卡：角色状态那一步不调，次数好数。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | `threads.md` 里有排出的线；第 1、2 章定稿各给对的线追加了带证据的事件 | 定稿第三步 |
 * | 一条伪造证据的事件被丢弃 | 证据逐字校验是那道闸 |
 * | **第 3 章写正文那一次的装配里**有「进行中的叙事线」，带着第 2 章那条事件的证据；计划中、没到区间的那条不在 | 这一期存在的理由：后一章读得到前面埋下的线 |
 * | 作者手改过的一行在三次定稿之后原样还在 | 第 3 条：机器只追加 |
 * | 实际调用次数 ≤ 两个确认框报的上限之和 | 第 4 条 |
 * | 工程页那一行的计数对得上 | 回收了的算已收 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;
let controller;

const TITLES = ['停舟', '令牌', '夜访', '井', '名册'];
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.md`;
const THREADS = '.novelforge/threads.md';
const AUTHOR_INTENT = '- 意图：作者改过的：名册上少了的那一页在沈氏手里。';

function chapterText(no) {
  return [
    filler(260, no * 10 + 1),
    `林昭在第${no}章摸了摸怀里的玉佩。`,
    `沈氏在第${no}章翻开名册，手指停在第${no}行。`,
    filler(260, no * 10 + 2),
  ].join('\n\n');
}

let ch3Prompt = '';
/** 每一章判叙事线那一次答什么。 */
const EVENTS = {
  1: [
    { thread: '玉佩的来历', type: '埋下', evidence: '林昭在第1章摸了摸怀里的玉佩。', reason: '玉佩第一次露面' },
    { thread: '名册之谜', type: '埋下', evidence: '名册上被人撕掉了一页', reason: '正文里没有这一句' },
  ],
  2: [{ thread: '名册之谜', type: '埋下', evidence: '沈氏在第2章翻开名册', reason: '名册第一次出现' }],
  3: [{ thread: '玉佩的来历', type: '回收', evidence: '林昭在第3章摸了摸怀里的玉佩', reason: '身世揭开' }],
};

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes('只从作者给的故事前提、情节大纲与各章细纲里提出跨章的伏笔')) {
    return JSON.stringify({
      threads: [
        { title: '玉佩的来历', type: '伏笔', from: 1, to: 3, intent: '玉佩是沈家旧物。' },
        { title: '名册之谜', type: '悬念', from: 2, to: 5, intent: '名册上少了一页。' },
        { title: '师父的身份', type: '伏笔', from: 10, to: 20, intent: '师父另有身份。' },
      ],
    });
  }
  const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
  if (system.includes('建立可检索的章节档案')) {
    return JSON.stringify({
      梗概: `第 ${no} 章。`,
      出场人物: [{ name: '林昭', aliases: [] }, { name: '沈氏', aliases: [] }],
      时间地点: '青崖镇。',
      关键事件: [`第 ${no} 章的事`],
      新增伏笔: [],
      状态变更: '',
      连续性事实: [`沈氏在第${no}章翻开了名册`],
    });
  }
  if (system.includes('你是小说定稿事实审查员')) {
    return JSON.stringify({ events: EVENTS[no] ?? [] });
  }
  const hook = /- 章节钩子：第 (\d+) 章结尾/.exec(user);
  if (hook) {
    const n = Number(hook[1]);
    if (n === 3) {
      ch3Prompt = user;
    }
    return { text: chapterText(n), stop: 'end' };
  }
  return '（认不出这一步）';
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    pipelineModel: './src/core/model/pipeline.ts',
    threadsFile: './src/core/model/threadsFile.ts',
    projectView: './src/core/views/projectView.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
    recentChaptersFullText: 0,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });

  t = await makeTempProject(bundle.project, { prefix: 'phase7', title: '青崖记' });
  project = t.project;
  t.write('.novelforge/config.md', '---\ntotalChapters: 30\nwordsPerChapter: 600\n---\n\n# 小说配置\n\n## 核心梗概\n\n回镇查案。\n');
  t.write('.novelforge/premise.md', '# 故事前提\n\n## 一句话前提\n\n林昭回镇，必须找出放火的人。\n\n## 悬念骨架\n\n玉佩与名册。\n');
  t.write('.novelforge/world.md', '# 世界观\n\n## 规则与漏洞\n\n名册决定谁算镇上的人。\n');
  t.write('.novelforge/outline.md', '# 情节大纲\n\n## 第1–20章：第一幕\n\n林昭进镇，一路查名册。\n');
  const ws = new bundle.ws.Workspace(project);
  for (let no = 1; no <= 5; no++) {
    await ws.writePlot({
      no,
      title: TITLES[no - 1],
      role: '铺垫',
      characters: ['林昭', '沈氏'],
      targetWords: 600,
      upstreamHash: '',
      done: false,
      sections: { 本章目的: `第 ${no} 章的目的`, 关键事件: `第 ${no} 章林昭又往前查了一步。`, 章末钩子: `第 ${no} 章结尾：又一个人不见了。` },
    });
  }
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  controller.attach({ kind: 'sidebar', post: () => {}, reveal() {} });
  // 工程页「从细纲排出」：后端弹确认框，作者点「开始排」。
  h.expect('开始排');
  await controller.handle({ type: 'projectAction', action: 'generateThreads' });
  // 作者看了一眼，改了一条线的意图。
  t.write(THREADS, t.read(THREADS).replace('- 意图：名册上少了一页。', AUTHOR_INTENT));
  project.invalidate();
  // 与工程页弹窗提交的那一条一样：弹窗已经报过调用次数，带 confirmed。
  await controller.handle({
    type: 'projectAction',
    action: 'writeManuscripts',
    range: { from: 1, to: 3 },
    mode: 'finalize',
    confirmed: true,
  });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('七期验收：排叙事线，再批量写章第 1–3 章、写完即定稿', () => {
  const threads = () => bundle.threadsFile.parseThreads(t.read(THREADS));
  const byTitle = (title) => threads().find((x) => x.title === title);

  test('threads.md 里有排出的三条线', () => {
    assert.deepEqual(threads().map((x) => x.title), ['玉佩的来历', '名册之谜', '师父的身份']);
    assert.ok(t.has(CH(3)) && !t.has(CH(4)));
  });

  test('定稿各给对的线追加了带证据的事件；伪造证据的那条没记', () => {
    assert.deepEqual(
      byTitle('玉佩的来历').events.map((e) => [e.chapter, e.type, e.evidence]),
      [
        [1, '埋下', '林昭在第1章摸了摸怀里的玉佩。'],
        [3, '回收', '林昭在第3章摸了摸怀里的玉佩'],
      ]
    );
    assert.deepEqual(byTitle('名册之谜').events.map((e) => [e.chapter, e.type]), [[2, '埋下']]);
    assert.ok(!t.read(THREADS).includes('名册上被人撕掉了一页'));
    assert.deepEqual(byTitle('师父的身份').events, []);
  });

  test('第 3 章写正文时：带着进行中的叙事线与第 2 章那条事件的证据', () => {
    const at = ch3Prompt.indexOf('# 进行中的叙事线');
    assert.ok(at > 0, ch3Prompt.slice(0, 2000));
    const section = ch3Prompt.slice(at, ch3Prompt.indexOf('\n---\n', at));
    assert.ok(section.includes('- 名册之谜（悬念 · 已埋下 · 第 2 章埋、第 5 章前收；第 5 章之前不要揭开）'), section);
    assert.ok(section.includes('最近：第 2 章「沈氏在第2章翻开名册」'), section);
    assert.ok(section.includes('作者改过的：名册上少了的那一页在沈氏手里。'), section);
    // 玉佩第 3 章才回收：写第 3 章时它还是已埋下、计划在本章前后回收。
    assert.ok(section.includes('- 玉佩的来历（伏笔 · 已埋下 · 第 1 章埋、第 3 章前收；计划在本章前后回收，以本章细纲为准）'), section);
    assert.ok(!section.includes('师父的身份'), section);
  });

  test('作者手改过的那一行在三次定稿之后原样还在', () => {
    assert.ok(t.read(THREADS).includes(AUTHOR_INTENT), t.read(THREADS));
  });

  test('一共 10 次：排线 1 次，一章写一次、摘要一次、叙事线一次；没超过两个确认框的上限', () => {
    assert.equal(fake.callCount(), 10);
    const plan = bundle.pipelineModel.planWriteBatch({ from: 1, to: 3, mode: 'finalize', writtenNos: [], plotFilledNos: [1, 2, 3, 4, 5] });
    assert.ok(fake.callCount() <= 1 + plan.calls.max);
  });

  test('工程页那一行：3 条，2 条进行中，1 条已收', async () => {
    project.invalidate();
    const tree = await bundle.projectView.buildProjectTree(project);
    assert.deepEqual(tree.threads, { exists: true, total: 3, open: 2, closed: 1, overdue: 0 });
  });
});
