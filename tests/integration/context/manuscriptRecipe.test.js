/**
 * 正文层的装配（三期）：移植自 AI-Novel-Writer `first_chapter_draft` / `next_chapter_draft`
 * 的材料包与提示词。
 *
 * | 钉住什么 | 为什么 |
 * |---|---|
 * | 全局要求单独强制带，且不在架构那几条里重复 | 作者定的跨章规矩，每一章都得守；重复一遍就是两份 |
 * | 后 5 章细纲作边界，按章号窗口、只带排过的 | 没有边界，模型会把下一章的事提前演掉 |
 * | 执行卡在消息最末，只带必需事件与作者指导，没有章节钩子 | 模型对末尾最敏感；章末钩子并进了「看点」，看点不是一件件到期的动作 |
 * | 更早几章的细纲都带：没定稿的标「计划」，定稿过的不标；定稿之后正文又改过的打 ⚠ | 先排完细纲再回头写时，计划就是唯一的前情；标出来模型才不把计划当已发生 |
 * | 第 1 章与后续章各一套法则，D8 禁令都在系统提示里 | 上游两套提示词（PT:720-855） |
 * | 上一章结尾写明「不可重演」 | 最常见的失败是把上一章最后一场重演一遍 |
 * | 接着写只要新增的那一段，从本章已写的末尾接 | 落盘是追加，模型要是重写整章就叠成两份 |
 * | 续写那几轮用精简配方，但带近几章的连续性事实 | 每一轮都付一次全价的材料包不值；一条前情都不带，死了的人会在续写里活过来 |
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
  chaptersDir: 'chapters',
  draftsDir: 'drafts',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
};

const ASK = '李叔这一章也要露一面。';

/** 第 N 章的细纲（计划，八节里填了梗概、出场人物、关键事件、看点）。`events` 为空就是一个空壳。 */
function plotText(no, title, events) {
  return [
    '---',
    `no: ${no}`,
    `title: ${title}`,
    'targetWords: 1200',
    '---',
    '',
    `# 第${no}章 ${title}`,
    '',
    '## 梗概',
    '',
    events ? `第${no}章的梗概` : '',
    '',
    '## 出场人物',
    '',
    events ? '林昭' : '',
    '',
    '## 关键事件',
    '',
    events,
    '',
    '## 看点',
    '',
    events ? `- 第${no}章的看点` : '',
    '',
  ].join('\n');
}

let t;
let project;
let builderMod;
let vs;

const PLOT = (no, title) => `.novelforge/summaries/${String(no).padStart(3, '0')}-${title}.md`;
const lastUser = (b) => b.messages[b.messages.length - 1].content;
const ids = (b) => new Map(b.items.map((i) => [i.id, i]));

before(async () => {
  t = copyFixture('manuscript-recipe');
  vs = installVscodeStub({ level: 'full', root: t.dir, config: {} });
  // 第 4 章《空匣》示例工程里本来就排好了细纲（计划，还没写正文）；后面几章在这里补上。
  const plots = path.join(t.dir, '.novelforge/summaries');
  // 关键事件一条一行（与定稿的写法一样）；边界里一章一行，条与条之间用「；」接。
  fs.writeFileSync(path.join(plots, '005-名册.md'), plotText(5, '名册', '- 沈氏拿出一本残缺的名册。\n- 名册上第三个名字被划掉了。'));
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
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(4, '空匣') }, ask: ASK, targetWords: 1200 },
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
    assert.ok(ahead.text.includes('第5章 名册：沈氏拿出一本残缺的名册。；名册上第三个名字被划掉了。\n'), ahead.text);
  });

  test('边界在本章细纲之后、补充要求之前，写明不许提前写', () => {
    const user = lastUser(b);
    const [plot, boundary, askAt] = ['# 细纲', '# 后续章节预告', '# 这一章的补充要求'].map((h) => user.indexOf(h));
    assert.ok(plot >= 0 && plot < boundary && boundary < askAt, `${plot} / ${boundary} / ${askAt}`);
    assert.match(user, /绝对不要在本章提前写出/);
  });

  // 关键事件是一条一行的列表：多条时缩进列在「必需事件」下面，按原来的顺序，一条一项地核对。
  test('执行卡压在消息最末：必需事件、作者本章指导', () => {
    const user = lastUser(b);
    const card = user.slice(user.indexOf('【本章执行卡'));
    assert.ok(user.indexOf('【本章执行卡') > user.indexOf('【本章篇幅】'));
    assert.ok(
      card.includes(
        '- 必需事件：\n  - 林昭随年轻守卫赶到镇西旧宅，门虚掩、屋里无人，衣柜被翻得一团乱，装令牌的木匣空着。\n' +
          '  - 年轻守卫承认左脸的伤是昨夜在家门口挨的，打他的人蒙着脸、只问令牌在哪。\n' +
          '  - 两人回镇口当面问李叔，李叔先装不认识。\n' +
          '  - 林昭亮出自己那块牌子，李叔才压低声音说出持牌的人七年前都在那场火里，随即把两人赶走。\n'
      ),
      card
    );
    assert.ok(card.includes(`- 作者本章指导：${ASK}`), card);
    assert.match(user.trimEnd(), /现在开始写作。[^\n]*$/);
  });

  // 章末钩子并进了「看点」：爽点与章末悬念混在一起，不是一件件到期的动作，细纲整份已经在上面。
  test('执行卡里没有章节钩子', () => {
    const user = lastUser(b);
    const card = user.slice(user.indexOf('【本章执行卡'));
    assert.doesNotMatch(card, /章节钩子|看点/);
  });

  test('篇幅只给大概：约 N 字，不必精确，不给区间', () => {
    assert.ok(lastUser(b).includes('约 1200 字，不必精确，也不用数字数'));
    assert.ok(!/±\d+%/.test(lastUser(b)));
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
    assert.match(system, /按本章细纲约定的结束状态收束/);
    assert.doesNotMatch(system, /章末钩子/);
    assert.ok(!system.includes('留出继续往下写的余地'), '一章一纲之后这一章该停在细纲约定的结束状态上');
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

describe('正文配方 · 写第 5 章（第 4 章只排了细纲、还没写正文）', () => {
  let b;
  let byId;
  before(async () => {
    b = await builderMod.buildContext(
      project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(5, '名册') }, ask: '', targetWords: 1200 },
      config
    );
    byId = ids(b);
  });

  // 近章全文的窗口是第 3、4 章：第 4 章没有正文、不认领，留给早前细纲那一层；第 1、2 章在窗口之外，也由那一层带。
  test('第 4 章没有正文：近章全文不带它', () => {
    assert.ok(!byId.has('manuscriptFull:4'));
    assert.equal(byId.get('manuscriptFull:3').status, 'included');
  });

  test('没定稿的第 4 章照样带它的细纲，块头标「计划」并写明', () => {
    const p4 = byId.get('plotSummary:4');
    assert.equal(p4.status, 'included');
    assert.equal(p4.label, '第 4 章《空匣》 · 细纲');
    assert.equal(p4.source, PLOT(4, '空匣'));
    assert.ok(p4.text.startsWith('【第 4 章《空匣》 · 计划】\n## 梗概'), p4.text.slice(0, 80));
    assert.match(p4.text, /李叔先装不认识/);
    assert.equal(p4.note, '还没定稿：带的是写之前的计划');
  });

  test('定稿过、对得上正文的第 1 章不标「计划」，也没有说明', () => {
    const p1 = byId.get('plotSummary:1');
    assert.equal(p1.status, 'included');
    assert.ok(p1.text.startsWith('【第 1 章《楔子》】\n'), p1.text.slice(0, 40));
    assert.equal(p1.note, undefined);
  });

  // 第 4 章还没写，第 5 章不该「从第 3 章结尾无缝接下去」——那等于让模型跳过第 4 章的事件。
  // builder.ts 的兜底提示只在「结尾片段被整章正文取代」时才说。
  test('前一章还没写时，不带上一章结尾，也不让模型从更早那一章的结尾无缝接下去', () => {
    const user = lastUser(b);
    assert.ok(!b.items.some((i) => i.kind === 'prevTail'));
    assert.ok(!user.includes('结尾的最终状态之后无缝接下去'), user.slice(-300));
  });

  test('消息里一节「早前各章细纲」，说清标「计划」的还没定稿', () => {
    const user = lastUser(b);
    const at = user.indexOf('# 早前各章细纲（由远及近；标「计划」的还没定稿，不一定是正文写成的样子）');
    assert.ok(at >= 0, user.slice(0, 400));
    const section = user.slice(at, user.indexOf('\n---\n', at));
    assert.ok(section.indexOf('【第 1 章《楔子》】') < section.indexOf('【第 4 章《空匣》 · 计划】'), section.slice(0, 200));
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
    assert.match(user, /大约再写 \d+ 字，不必精确/);
    assert.ok(!user.includes('【本章篇幅】'));
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
    // 第 2 章的细纲定稿过、填上连续性事实：续写那几轮也要看见它（百章实验里续写写了一章的大半）。
    const s2 = path.join(t.dir, '.novelforge/summaries/002-客栈里的女人.md');
    fs.writeFileSync(s2, fs.readFileSync(s2, 'utf8').replace(/(## 连续性事实\n\n)（待补充）/, '$1- 沈氏住进走廊尽头的房间'));
    project.invalidate();
    const base = { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(4, '空匣') }, ask: ASK, targetWords: 1200 };
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

  test('带近几章定稿的连续性事实', () => {
    assert.ok(b.items.some((i) => i.kind === 'facts' && i.status === 'included' && i.text.includes('沈氏住进走廊尽头的房间')));
    assert.match(lastUser(b), /# 前几章的连续性事实（已定稿/);
  });

  test('已写末尾就是生成链给的那一段', () => {
    assert.equal(b.items.find((i) => i.kind === 'chapterSoFar').text, step.tail);
    assert.match(lastUser(b), /大约再写 500 字/);
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

describe('正文配方 · 早前某章定稿之后正文又改过', () => {
  let item;
  before(async () => {
    const ch1 = path.join(t.dir, 'chapters/001-楔子.md');
    const backup = fs.readFileSync(ch1, 'utf8');
    fs.writeFileSync(ch1, `${backup}\n\n作者后来补的一句。\n`);
    project.invalidate();
    try {
      const b = await builderMod.buildContext(
        project,
        { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT(5, '名册') }, ask: '', targetWords: 1200 },
        config
      );
      item = ids(b).get('plotSummary:1');
    } finally {
      fs.writeFileSync(ch1, backup);
      project.invalidate();
    }
  });

  // 定稿过就不是计划；但细纲是照改之前的正文更新的，明细里要看得出它可能没跟上。
  test('照样带，不标「计划」，说明里打 ⚠', () => {
    assert.equal(item.status, 'included');
    assert.ok(item.text.startsWith('【第 1 章《楔子》】\n'), item.text.slice(0, 40));
    assert.equal(item.note, '⚠ 定稿之后正文又改过，这份细纲可能没跟上');
  });
});
