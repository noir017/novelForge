/**
 * 正文层的装配（三期）：移植自 AI-Novel-Writer `first_chapter_draft` / `next_chapter_draft`
 * 的材料包与提示词。
 *
 * | 钉住什么 | 为什么 |
 * |---|---|
 * | 全局要求单独强制带，且不在架构那几条里重复 | 作者定的跨章规矩，每一章都得守；重复一遍就是两份 |
 * | 后 5 章细纲作边界，按章号窗口、只带排过的 | 没有边界，模型会把下一章的事提前演掉 |
 * | 执行卡在消息最末，带章末钩子与作者指导 | 模型对末尾最敏感；上游单章入口漏了钩子 |
 * | 第 1 章与后续章各一套法则，D8 禁令都在系统提示里 | 上游两套提示词（PT:720-855） |
 * | 上一章结尾写明「不可重演」 | 最常见的失败是把上一章最后一场重演一遍 |
 * | 接着写只要新增的那一段，从本章已写的末尾接 | 落盘是追加，模型要是重写整章就叠成两份 |
 * | 续写那几轮用精简配方 | 每一轮都付一次全价的材料包不值 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { installVscodeStub } = require('../../helpers/vscodeStub');
const { copyFixture } = require('../../helpers/tmpProject');
const { cleanup } = require('../../helpers/teardown');

const WRITE = { stage: 'manuscript', capability: 'generate' };

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

const ASK = '李叔这一章也要露一面。';

/** 第 N 章的细纲（D3 格式）。`events` 为空就是一个空壳。 */
function plotText(no, title, events, hook = `第${no}章的钩子`) {
  return [
    '---',
    `no: ${no}`,
    `title: ${title}`,
    'role: 发展',
    'characters: [林昭]',
    'targetWords: 1200',
    '---',
    '',
    `# 第${no}章 ${title}`,
    '',
    '## 本章目的',
    '',
    events ? `第${no}章的目的` : '',
    '',
    '## 关键事件',
    '',
    events,
    '',
    '## 章末钩子',
    '',
    events ? hook : '',
    '',
  ].join('\n');
}

let t;
let project;
let builderMod;
let vs;

const PLOT = (no, title) => `.novelforge/plots/${String(no).padStart(3, '0')}-${title}.md`;
const lastUser = (b) => b.messages[b.messages.length - 1].content;
const ids = (b) => new Map(b.items.map((i) => [i.id, i]));

before(async () => {
  t = copyFixture('manuscript-recipe');
  vs = installVscodeStub({ level: 'full', root: t.dir, config: {} });
  const plots = path.join(t.dir, '.novelforge/plots');
  fs.writeFileSync(path.join(plots, '004-井.md'), plotText(4, '井', '林昭夜里下到镇东的枯井，摸到一截烧黑的木牌。', '井底有人咳了一声。'));
  fs.writeFileSync(path.join(plots, '005-名册.md'), plotText(5, '名册', '沈氏拿出一本残缺的名册。'));
  // 第 6 章只是个空壳：边界里没有可写的事，不带。
  fs.writeFileSync(path.join(plots, '006.md'), plotText(6, '', ''));
  fs.writeFileSync(path.join(plots, '007-火场.md'), plotText(7, '火场', '七年前那场火的第一个证人开口。'));
  fs.writeFileSync(path.join(plots, '008-守卫.md'), plotText(8, '守卫', '年轻守卫的母亲失踪。'));
  fs.writeFileSync(path.join(plots, '009-令牌.md'), plotText(9, '令牌', '第三块令牌出现在李叔手里。'));
  // 第 10 章在「后 5 章」窗口之外（4 + 5 = 9）。
  fs.writeFileSync(path.join(plots, '010-夜雨.md'), plotText(10, '夜雨', '窗口外的第十章。'));

  const bundle = loadBundle({
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    prompts: './src/core/context/prompts.ts',
  });
  builderMod = bundle.builder;
  project = bundle.project.NovelProject.open(t.dir);
  project.prompts = bundle.prompts;
});

after(() => {
  vs?.restore?.();
  cleanup(t);
});

describe('正文配方 · 写第 4 章（后续章）', () => {
  let b;
  let byId;
  before(async () => {
    b = await builderMod.buildContext(
      project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(4, '井') }, ask: ASK, targetWords: 1200 },
      config
    );
    byId = ids(b);
  });

  test('全局要求单独成段、强制带', () => {
    const g = byId.get('guidance');
    assert.equal(g.status, 'included');
    assert.equal(g.priority, 0);
    assert.match(g.text, /悬疑靠信息差推进/);
    assert.ok(lastUser(b).includes('# 全局要求（每一章都要遵守）'));
  });

  test('架构那几条（P1）里不再重复全局要求', () => {
    const cfg = byId.get('setting:config');
    assert.equal(cfg.priority, 1);
    assert.ok(!cfg.text.includes('悬疑靠信息差推进'), cfg.text);
    assert.match(cfg.note, /全局要求/);
    assert.ok(byId.has('setting:premise'));
    assert.ok(byId.has('setting:world'));
    // 全局要求在整条消息里只出现一次。
    assert.equal(lastUser(b).split('悬疑靠信息差推进').length, 2);
  });

  test('后 5 章细纲作边界：按章号窗口（5–9），空壳不带，窗口外的不带', () => {
    const ahead = b.items.find((i) => i.kind === 'boundary');
    assert.ok(ahead, b.items.map((i) => i.id).join(','));
    assert.equal(ahead.priority, 0);
    assert.equal(ahead.status, 'included');
    for (const no of [5, 7, 8, 9]) {
      assert.ok(ahead.text.includes(`第${no}章`), ahead.text);
    }
    assert.ok(!ahead.text.includes('第6章'), ahead.text);
    assert.ok(!ahead.text.includes('窗口外的第十章'), ahead.text);
  });

  test('边界在本章细纲之后、补充要求之前，写明不许提前写', () => {
    const user = lastUser(b);
    const [plot, boundary, askAt] = ['# 细纲', '# 后续章节预告', '# 这一章的补充要求'].map((h) => user.indexOf(h));
    assert.ok(plot >= 0 && plot < boundary && boundary < askAt, `${plot} / ${boundary} / ${askAt}`);
    assert.match(user, /绝对不要在本章提前写出/);
  });

  test('执行卡压在消息最末：必需事件、章节钩子、作者本章指导', () => {
    const user = lastUser(b);
    const card = user.slice(user.indexOf('【本章执行卡'));
    assert.ok(user.indexOf('【本章执行卡') > user.indexOf('【本章篇幅合同】'));
    assert.match(card, /- 必需事件：林昭夜里下到镇东的枯井/);
    assert.match(card, /- 章节钩子：井底有人咳了一声。/);
    assert.ok(card.includes(`- 作者本章指导：${ASK}`), card);
    assert.match(user.trimEnd(), /现在开始写作。[^\n]*$/);
  });

  test('篇幅合同 ±20%', () => {
    assert.ok(lastUser(b).includes('目标 1200 字；可接受范围 960–1440 字（±20%）'));
  });

  test('后续章：连载更新法则，不是黄金第一章', () => {
    const user = lastUser(b);
    assert.match(user, /【网文连载更新核心法则】/);
    assert.ok(!user.includes('黄金第一章'));
    assert.match(user, /不得引用、摘要、回放或重演上一章结尾/);
  });

  test('上一章结尾写明「只作边界，不可重演」', () => {
    const user = lastUser(b);
    // 第 3 章正文整章注入时结尾片段被取代，那时换一种说法，同样写明不许重演。
    assert.ok(
      user.includes('# 上一章结尾原文（只作边界，不可重演）') || /结尾的最终状态之后无缝接下去，不要重演它的结尾/.test(user),
      user.slice(0, 400)
    );
  });

  test('系统提示：D8 四条禁令、作者事实、文风边界、格式、视角', () => {
    const system = b.messages[0].content;
    for (const rule of project.prompts.ANTI_AI_RULES) {
      assert.ok(system.includes(rule), rule);
    }
    assert.match(system, /【不可偏离的作者事实】/);
    assert.match(system, /【文风适用边界】/);
    assert.match(system, /中文双引号/);
    assert.match(system, /叙事视角：第三人称限知/);
    assert.match(system, /章末钩子收束/);
    assert.ok(!system.includes('留出继续往下写的余地'), '一章一纲之后这一章该停在钩子上');
  });

  test('P1：出场角色、架构、大纲里本章那一节', () => {
    assert.ok(b.items.some((i) => i.kind === 'character' && i.priority === 1));
    const slice = b.items.find((i) => i.kind === 'outlineDoc');
    assert.equal(slice.priority, 1);
  });
});

describe('正文配方 · 写第 1 章', () => {
  let b;
  before(async () => {
    b = await builderMod.buildContext(
      project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(1, '楔子') }, ask: '', targetWords: 800 },
      config
    );
  });

  test('黄金第一章法则，不是连载法则', () => {
    const user = lastUser(b);
    assert.match(user, /【网文「黄金第一章」创作法则】/);
    assert.ok(!user.includes('连载更新核心法则'));
  });

  test('系统提示不说「从上一章结尾接续」', () => {
    assert.ok(!b.messages[0].content.includes('直接从上一章结尾的情境自然接续'));
    assert.match(b.messages[0].content, /正在为一部新作写第一章/);
  });

  test('作者没说话时执行卡里没有「作者本章指导」', () => {
    assert.ok(!lastUser(b).includes('作者本章指导'));
  });
});

describe('正文配方 · 接着写第 3 章', () => {
  let b;
  let chapterText;
  before(async () => {
    const chapter = (await project.listChapters()).find((c) => c.order === 3);
    chapterText = await project.readChapterText(chapter);
    b = await builderMod.buildContext(
      project,
      {
        action: WRITE,
        target: { kind: 'manuscript', plotRelPath: PLOT(3, '夜访') },
        ask: '',
        targetWords: 2000,
        writeMode: 'continue',
      },
      config
    );
  });

  test('带上本章已写正文的末尾，紧挨着指令', () => {
    const so = b.items.find((i) => i.kind === 'chapterSoFar');
    assert.equal(so.status, 'included');
    assert.ok(chapterText.trim().endsWith(so.text.slice(-20)), so.text.slice(-40));
    const user = lastUser(b);
    assert.ok(user.indexOf('# 本章已写正文') > user.indexOf('# 细纲'));
    assert.ok(user.indexOf('# 本章已写正文') < user.indexOf('【本章执行卡'));
  });

  test('契约：只写新增的那一段，报剩余字数，不再给整章的篇幅合同', () => {
    const user = lastUser(b);
    assert.match(user, /请无缝续写当前章节正文/);
    assert.match(user, /只输出新增正文，不要复述已写内容/);
    assert.match(user, /剩余约 \d+ 字/);
    assert.ok(!user.includes('【本章篇幅合同】'));
    assert.match(user.trimEnd(), /现在接着写。/);
  });

  test('不带上一章结尾，也不说「从上一章结尾接下去」', () => {
    assert.ok(!b.items.some((i) => i.kind === 'prevTail'));
    assert.ok(!lastUser(b).includes('无缝接下去，不要重演它的结尾'));
  });

  test('不是接着写时不带本章已写正文', async () => {
    const plain = await builderMod.buildContext(
      project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(3, '夜访') }, ask: '', targetWords: 2000 },
      config
    );
    assert.ok(!plain.items.some((i) => i.kind === 'chapterSoFar'));
  });
});

describe('正文配方 · 续写那几轮（精简配方）', () => {
  let b;
  let recovery;
  const step = { kind: 'continuation', tail: '他推开了井边那扇门。门后是一段向下的石阶。', written: 700, remaining: 500, recovery: false };
  before(async () => {
    const base = { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(4, '井') }, ask: ASK, targetWords: 1200 };
    b = await builderMod.buildContext(project, { ...base, step }, config);
    recovery = await builderMod.buildContext(project, { ...base, step: { ...step, recovery: true } }, config);
  });

  test('只带接着写要看的：细纲、边界、已写末尾、文风、全局要求、出场角色', () => {
    const kinds = new Set(b.items.map((i) => i.kind));
    for (const k of ['plot', 'boundary', 'chapterSoFar', 'style', 'guidance']) {
      assert.ok(kinds.has(k), k);
    }
    for (const k of ['manuscriptFull', 'plotSummary', 'globalSummary', 'prevTail', 'setting']) {
      assert.ok(!kinds.has(k), k);
    }
  });

  test('已写末尾就是生成链给的那一段', () => {
    assert.equal(b.items.find((i) => i.kind === 'chapterSoFar').text, step.tail);
    assert.match(lastUser(b), /剩余约 500 字/);
  });

  test('恢复那一轮开头说清「上一轮已丢弃」', () => {
    assert.match(lastUser(recovery), /已被全部丢弃/);
    assert.match(lastUser(recovery), /唯一一次无进展恢复机会/);
    assert.ok(!lastUser(b).includes('已被全部丢弃'));
  });

  test('执行卡照样在最末', () => {
    const user = lastUser(b);
    assert.ok(user.lastIndexOf('【本章执行卡') > user.lastIndexOf('# 本章已写正文'));
  });
});
