/**
 * 审稿与修稿的装配（五期）：移植自 AI-Novel-Writer 的 `consistency_check` / `refine_from_review`。
 *
 * | 钉住什么 | 为什么 |
 * |---|---|
 * | 审稿带这一章全文、细纲、冻结的目标清单 | 审的就是它；目标从细纲冻结 |
 * | 后续章节标「非既定历史」 | 审稿最常见的误判是拿计划当历史 |
 * | 前几章的连续性事实：定稿过的带、没定稿的说清楚 | 上游审稿读的就是已定稿历史；过期的不作数（第 2 条） |
 * | 审稿不带历史对话与文风 | 审稿判的是正文，文笔不在审查范围里 |
 * | 修稿带整章原文与勾选清单，没有写正文那一套法则 | 那一套在教它「写一章」，修稿要「只改这几处」 |
 * | 修稿续写带原文与已修订的末尾 | 模型得知道剩下那半章原来怎么写的 |
 * | 重写时 `revision` 是整章（精修） | 从前只带 3000 token 的尾巴，前半章凭空重写 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { installVscodeStub } = require('../../helpers/vscodeStub');
const { copyFixture } = require('../../helpers/tmpProject');
const { cleanup } = require('../../helpers/teardown');

const REVIEW = { stage: 'manuscript', capability: 'review' };
const WRITE = { stage: 'manuscript', capability: 'generate' };
const P3 = '.novelforge/plots/003-夜访.md';

const config = {
  providers: [{ id: 'p', kind: 'openai', baseUrl: 'https://x/v1', models: [{ name: 'm' }] }],
  model: 'p/m',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  recentChaptersFullText: 2,
  prevChapterTailChars: 1500,
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
};

let t;
let project;
let builderMod;
let review;
let vs;
let chapter3;

const lastUser = (b) => b.messages[b.messages.length - 1].content;
const system = (b) => b.messages[0].content;
const byKind = (b, kind) => b.items.filter((i) => i.kind === kind);

before(async () => {
  t = copyFixture('review-recipe');
  vs = installVscodeStub({ level: 'full', root: t.dir, config: {} });
  // 第 2 章定稿过、带连续性事实；第 1 章的摘要改成过期的（sourceHash 对不上）。
  const s2 = path.join(t.dir, '.novelforge/summaries/002-客栈里的女人.md');
  fs.appendFileSync(s2, '\n## 连续性事实\n\n- 沈氏住进走廊尽头的房间 〔证据：「住进走廊尽头的房间」〕\n- 林昭否认知道七年前的火\n');
  const s1 = path.join(t.dir, '.novelforge/summaries/001-楔子.md');
  fs.writeFileSync(s1, fs.readFileSync(s1, 'utf8').replace(/sourceHash: \w+/, 'sourceHash: stale000'));
  // 第 4 章排了细纲：审第 3 章时它是「后续章节计划」。
  fs.writeFileSync(
    path.join(t.dir, '.novelforge/plots/004-井.md'),
    ['---', 'no: 4', 'title: 井', 'characters: [林昭]', 'targetWords: 650', '---', '', '# 第4章 井', '', '## 本章目的', '', '下井', '', '## 关键事件', '', '林昭夜里下到镇东的枯井。', '', '## 章末钩子', '', '井底有人咳了一声。', ''].join('\n')
  );

  const bundle = loadBundle({
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    review: './src/core/model/review.ts',
  });
  builderMod = bundle.builder;
  review = bundle.review;
  project = bundle.project.NovelProject.open(t.dir);
  chapter3 = await project.readChapterText(await project.getChapter(3));
});

after(() => {
  vs?.restore?.();
  cleanup(t);
});

describe('审稿配方 · 第 3 章', () => {
  let b;
  let goals;
  before(async () => {
    const plot = await project.getPlot(3);
    goals = review.freezeGoals(plot.sections.关键事件, plot.sections.章末钩子);
    b = await builderMod.buildContext(
      project,
      {
        action: REVIEW,
        target: { kind: 'manuscript', plotRelPath: P3 },
        ask: '重点看年轻守卫的动机',
        reviewGoals: goals,
        history: [{ id: 'x', role: 'user', content: '之前聊过的话', at: '' }],
      },
      config
    );
  });

  test('系统提示是审稿编辑，带审查原则与事实的优先级', () => {
    assert.match(system(b), /严谨的小说审稿编辑/);
    assert.match(system(b), /举证审查/);
    assert.match(system(b), /后续章节计划：还没有发生的事/);
    assert.doesNotMatch(system(b), /AI 味反制/);
  });

  test('待审正文是整章，P0 强制', () => {
    const [full] = byKind(b, 'chapterFull');
    assert.equal(full.status, 'included');
    assert.equal(full.priority, 0);
    assert.equal(full.text, chapter3.trim());
    assert.ok(lastUser(b).includes('# 待审正文'));
  });

  test('本章细纲与冻结清单都在；钩子单列最后一项', () => {
    assert.ok(byKind(b, 'plot').some((i) => i.source === P3));
    assert.match(lastUser(b), /【本章目标逐项核对｜冻结清单】/);
    const listed = JSON.parse(/冻结清单：(\[.*\])/.exec(lastUser(b))[1]);
    assert.equal(listed.length, goals.length);
    assert.match(listed[listed.length - 1].text, /^章末钩子：/);
  });

  test('后续章节标「非既定历史」', () => {
    assert.equal(byKind(b, 'boundary').length, 1);
    assert.match(lastUser(b), /# 后续章节计划（非既定历史/);
    assert.doesNotMatch(lastUser(b), /后续章节预告/);
  });

  test('前几章的连续性事实：定稿过的带，过期的说清楚为什么不带', () => {
    const facts = byKind(b, 'facts');
    const f2 = facts.find((i) => i.id === 'facts:2');
    assert.equal(f2.status, 'included');
    assert.match(f2.text, /- 沈氏住进走廊尽头的房间/);
    assert.doesNotMatch(f2.text, /证据/);
    const f1 = facts.find((i) => i.id === 'facts:1');
    assert.equal(f1.status, 'dropped');
    assert.match(f1.note, /过期/);
    assert.ok(lastUser(b).includes('# 前几章的连续性事实（已定稿'));
  });

  test('出场角色卡、上一章结尾都带；历史对话与文风不带', () => {
    assert.ok(byKind(b, 'character').some((i) => i.label.includes('年轻守卫')));
    assert.equal(byKind(b, 'prevTail').length, 1);
    assert.equal(byKind(b, 'history').length, 0);
    assert.equal(byKind(b, 'style').length, 0);
  });

  test('作者的话是「重点检查的方面」；契约是 JSON 并说清引文找不到会丢', () => {
    assert.match(lastUser(b), /# 作者要求重点检查的方面[^\n]*\n\n重点看年轻守卫的动机/);
    assert.match(lastUser(b), /引文在正文里找不到的问题会被丢弃/);
    assert.match(lastUser(b), /只输出一个可由 JSON\.parse 读取的 JSON 对象/);
    assert.doesNotMatch(lastUser(b), /本章执行卡/);
  });

  test('重来一次：说明上一次为什么被丢弃', async () => {
    const again = await builderMod.buildContext(
      project,
      { action: REVIEW, target: { kind: 'manuscript', plotRelPath: P3 }, ask: '', reviewGoals: goals, step: { kind: 'reviewRetry', why: 'invalid', reason: '缺少 items 数组' } },
      config
    );
    assert.match(lastUser(again), /未通过合同校验（缺少 items 数组），已被丢弃/);
  });

  test('细纲没有关键事件：goalReviews 输出空数组', async () => {
    const empty = await builderMod.buildContext(
      project,
      { action: REVIEW, target: { kind: 'manuscript', plotRelPath: P3 }, ask: '', reviewGoals: [] },
      config
    );
    assert.match(lastUser(empty), /goalReviews 输出空数组/);
  });
});

describe('修稿配方 · 第 3 章', () => {
  const BRIEF = '【已确认纳入本次修稿的审稿项】\n1. [角色状态 / 严重] 年轻守卫的伤写在了右脸\n   相关原文：……';
  let b;
  before(async () => {
    b = await builderMod.buildContext(
      project,
      {
        action: WRITE,
        target: { kind: 'manuscript', plotRelPath: P3 },
        ask: '',
        writeMode: 'revise',
        revision: { previousDraft: chapter3, feedback: BRIEF },
      },
      config
    );
  });

  test('系统提示是修稿编辑，不带写正文那一套', () => {
    assert.match(system(b), /只依据人工确认的审稿意见进行必要修改/);
    assert.doesNotMatch(system(b), /硬性要求/);
    assert.doesNotMatch(system(b), /AI 味反制/);
  });

  test('整章原文与勾选清单，强制', () => {
    const [rev] = byKind(b, 'revision');
    assert.equal(rev.status, 'included');
    assert.ok(rev.text.includes(chapter3.trim()));
    assert.ok(rev.text.includes(BRIEF));
    assert.ok(lastUser(b).includes('# 待修稿原文与审稿意见'));
    assert.doesNotMatch(lastUser(b), /请基于上一版重写/);
  });

  test('契约是修复原则，没有执行卡、篇幅合同与连载法则', () => {
    assert.match(lastUser(b), /【修复原则】/);
    assert.match(lastUser(b), /清单没有指到的段落原样保留，一字不改/);
    assert.doesNotMatch(lastUser(b), /本章执行卡/);
    assert.doesNotMatch(lastUser(b), /篇幅合同/);
    assert.doesNotMatch(lastUser(b), /连载更新核心法则/);
  });

  test('文风、全局要求强制带；细纲、角色卡、上一章结尾作参照；不带近章全文与摘要', () => {
    assert.equal(byKind(b, 'style')[0]?.status, 'included');
    assert.equal(byKind(b, 'guidance')[0]?.status, 'included');
    assert.ok(byKind(b, 'plot').length > 0);
    assert.ok(byKind(b, 'character').length > 0);
    assert.equal(byKind(b, 'prevTail').length, 1);
    assert.equal(byKind(b, 'manuscriptFull').length, 0);
    assert.equal(byKind(b, 'plotSummary').length, 0);
  });

  test('续写那几轮：原文、清单与已修订的末尾', async () => {
    const c = await builderMod.buildContext(
      project,
      {
        action: WRITE,
        target: { kind: 'manuscript', plotRelPath: P3 },
        ask: '',
        writeMode: 'revise',
        revision: { previousDraft: chapter3, feedback: BRIEF },
        step: { kind: 'continuation', tail: '已经修到这里了。', written: 300, recovery: false },
      },
      config
    );
    assert.ok(byKind(c, 'revision')[0].text.includes(BRIEF));
    assert.match(lastUser(c), /# 已修订正文（末尾，从这里接着输出）\n\n已经修到这里了。/);
    assert.match(lastUser(c), /上一轮修稿输出因长度限制而中断/);
    assert.equal(byKind(c, 'character').length, 0);
  });
});

describe('重写（精修）· 第 3 章', () => {
  test('revision 带整章上一版，本章细纲也在', async () => {
    const long = `${'很长的一段正文。'.repeat(1500)}\n\n结尾这一句。`;
    const b = await builderMod.buildContext(
      project,
      {
        action: WRITE,
        target: { kind: 'manuscript', plotRelPath: P3 },
        ask: '打斗写紧一点',
        writeMode: 'rewrite',
        revision: { previousDraft: long, feedback: '照细纲重写' },
      },
      config
    );
    const [rev] = byKind(b, 'revision');
    assert.ok(rev.text.includes(long.trim()), '上一版整章都在');
    assert.ok(byKind(b, 'plot').some((i) => i.source === P3));
    assert.match(lastUser(b), /请基于上一版重写/);
    assert.match(lastUser(b), /本章执行卡/);
  });
});
