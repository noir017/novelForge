/**
 * 上下文装配全链路：优先级、预算、降级链、手动排除、附件截断、多轮历史封顶、
 * 四阶段配方与身份、provider 配额压缩，外加工程页快照与出场人物索引。
 * 迁自 scripts/smoke-builder.js（216 条断言，逐条对应）。
 *
 * ## 与原脚本的唯一差异：写盘用例改跑临时副本
 *
 * 原脚本直接往 git 追踪的 `sample-novel/` 里写：四阶段配方那节建
 * `.novelforge/plans|scenes`，工程页那节覆盖 `chapters/003-夜访.md`，两处都靠
 * `finally` 复原。这既与 tests/contract/sampleNovel.test.js 的 hash 断言打架，
 * 又会在中途崩溃时把仓库弄脏。这里改用 `copyFixture()` 复制一份出来跑——
 * **断言内容一字未改，变的只有工作目录**。
 *
 * ## 那份 vscode 桩其实是死代码
 *
 * `src/core/` 早已零 vscode 依赖（tests/contract/corePurity.test.js 守着这条），
 * `project.ts` 走 `node:fs/promises` 读盘，而 `external: ['vscode']` 让 bundle 里
 * 连一句 `require('vscode')` 都不剩——所以原脚本那 57 行桩一次都没被取用过。
 * 这里仍然装上：将来 core 若回退出 vscode 依赖，有桩会照常跑过、没桩会当场炸，
 * 炸出来远好过静默改变行为。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { installVscodeStub } = require('../../helpers/vscodeStub');
const { SAMPLE, copyFixture } = require('../../helpers/tmpProject');
const { cleanup } = require('../../helpers/teardown');

// 装配请求带 action（阶段 × 能力）与 target（在改哪个产物），
// 旧的 mode: 'write' | 'discuss' 对应正文阶段的 generate / discuss。
const WRITE = { stage: 'manuscript', capability: 'generate' };
const DISCUSS = { stage: 'manuscript', capability: 'discuss' };

const baseConfig = {
  providers: [
    { id: 'openai', kind: 'openai', baseUrl: 'https://api.openai.com/v1', models: [{ name: 'gpt-4o' }] },
  ],
  model: 'openai/gpt-4o',
  active: {
    ref: 'openai/gpt-4o',
    profile: { id: 'openai', kind: 'openai', baseUrl: 'https://api.openai.com/v1', models: [{ name: 'gpt-4o' }] },
    model: { name: 'gpt-4o' },
  },
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

/**
 * 默认目标是「第 4 章」——它还没落盘，所以 chapterRelPath 留空，
 * 由 targetOrder 定位「前文」边界。这正是续写下一章的真实情形。
 */
function req(ask, extra = {}) {
  return {
    action: WRITE,
    target: { kind: 'manuscript', chapterRelPath: '' },
    targetOrder: 4,
    ask,
    ...extra,
  };
}

const ids = (built) => new Map(built.items.map((i) => [i.id, i]));
/** 树是分层的，断言大多针对叶子，先摊平。 */
const flat = (nodes) => nodes.flatMap((n) => (n.kind === 'dir' ? flat(n.children) : [n]));

let vs;
let projectMod;
let builderMod;
let tokenizerMod;
let projectViewMod;
let castMod;
let project;

// 预算充裕那一轮的结果被后面几节反复引用（降级阈值、排除前后的用量对比），
// 与原脚本一样只算一次。
const outline = '林昭答应给年轻守卫看令牌，两人约定天亮后去见他母亲。沈氏在楼下听见了动静。';
let built;
let byId;
let inc;
let upToP2Tokens;
let ch3Full;
let ch3SummaryTokens;

before(async () => {
  vs = installVscodeStub({ level: 'full', root: SAMPLE, config: {} });
  // 一个 bundle 装全部：分开 bundle 会让每份产物各带一份 project.ts，
  // builder / projectView / cast 拿到的就不是同一个类了。
  const bundle = loadBundle({
    project: './src/core/model/project.ts',
    builder: './src/core/context/builder.ts',
    tokenizer: './src/core/context/tokenizer.ts',
    projectView: './src/core/views/projectView.ts',
    cast: './src/core/views/cast.ts',
  });
  projectMod = bundle.project;
  builderMod = bundle.builder;
  tokenizerMod = bundle.tokenizer;
  projectViewMod = bundle.projectView;
  castMod = bundle.cast;

  project = projectMod.NovelProject.open(SAMPLE);

  built = await builderMod.buildContext(project, req(outline, { targetWords: 2000 }), baseConfig);
  byId = ids(built);
  inc = (id) => byId.get(id) && (byId.get(id).status === 'included' || byId.get(id).status === 'degraded');

  const sumTokens = (pred) => built.items.filter(pred).reduce((s, i) => s + i.tokens, 0);
  upToP2Tokens = sumTokens((i) => i.priority <= 2);
  ch3Full = built.items.find((i) => i.id === 'chapterFull:3').tokens;
  const ch3Summary = (await project.readSummary((await project.listChapters()).find((c) => c.order === 3))).content;
  ch3SummaryTokens = tokenizerMod.estimateTokens(`【第3章 夜访】\n${ch3Summary}`);
});

after(() => vs.restore());

// ---------------------------------------------------------------------------

describe('NovelProject 读取示例工程', () => {
  let chapters;
  let stale;
  let cards;
  let lin;
  let lore;
  let style;
  let global;
  let nextOrder;

  before(async () => {
    chapters = await project.listChapters();
    stale = await project.staleChapters();
    cards = await project.listCharacters();
    lin = cards.find((c) => c.name === '林昭');
    lore = await project.listLore();
    style = await project.readStyleGuide();
    global = await project.readGlobalSummary();
    nextOrder = await project.nextChapterOrder();
  });

  test('扫描到 3 章', () => {
    assert.equal(chapters.length, 3);
  });

  test('章节按序号排序', () => {
    assert.equal(chapters.map((c) => c.order).join(','), '1,2,3');
  });

  test('标题取自正文 H1', () => {
    assert.equal(chapters[1].title, '客栈里的女人');
  });

  test('字数统计合理', () => {
    assert.ok(chapters[0].wordCount > 200 && chapters[0].wordCount < 600, String(chapters[0].wordCount));
  });

  test('示例工程无过期摘要', () => {
    assert.equal(stale.length, 0, `stale: ${stale.map((c) => c.order).join(',')}`);
  });

  test('读到 4 张角色卡', () => {
    assert.equal(cards.length, 4);
  });

  test('林昭卡有别名', () => {
    assert.ok(lin && lin.aliases.includes('阿昭'));
  });

  test('林昭卡标记为主角', () => {
    assert.ok(lin && lin.tags.includes('主角'));
  });

  test('林昭卡「当前状态」非空', () => {
    assert.ok(lin && lin.sections.当前状态.includes('停舟'));
  });

  test('读到 2 条设定', () => {
    assert.equal(lore.length, 2);
  });

  test('设定有 keywords', () => {
    assert.ok(lore.some((l) => l.keywords.includes('令牌')));
  });

  test('读到文风指南', () => {
    assert.ok(style.includes('禁用清单'));
  });

  test('读到全书摘要', () => {
    assert.ok(global.includes('未收伏笔'));
  });

  test('下一章序号为 4', () => {
    assert.equal(nextOrder, 4);
  });
});

// ---------------------------------------------------------------------------

describe('装配：预算充裕（128k）', () => {
  test('P0 系统提示已注入', () => {
    assert.ok(inc('system'));
  });

  test('P0 纲要已注入', () => {
    assert.ok(inc('ask'));
  });

  test('P1 文风指南已注入', () => {
    assert.ok(inc('style'));
  });

  test('P1 全书摘要已注入', () => {
    assert.ok(inc('globalSummary'));
  });

  test('P3 第 3 章原文已注入', () => {
    assert.ok(inc('chapterFull:3'));
  });

  test('P3 第 2 章原文已注入', () => {
    assert.ok(inc('chapterFull:2'));
  });

  test('P4 第 1 章降级为摘要注入', () => {
    assert.ok(inc('chapterSummary:1'));
  });

  // 预算充裕时整章原文已含结尾，P0 的结尾片段应被撤掉以免重复。
  test('整章原文注入后结尾片段被撤销', () => {
    assert.equal(byId.get('prevTail:3').status, 'dropped');
  });

  test('撤销原因写明了重复', () => {
    assert.ok(byId.get('prevTail:3').note.includes('无需重复'));
  });

  test('第 3 章原文标注为接续点', () => {
    assert.ok(byId.get('chapterFull:3').note.includes('续写将从此处接续'));
  });

  test('上一章结尾在 prompt 中只出现一次', () => {
    const occurrences = built.messages[1].content.split('雨已经停了。窗外月亮出来').length - 1;
    assert.equal(occurrences, 1);
  });

  test('user 含接续指示', () => {
    assert.ok(built.messages[1].content.includes('无缝接下去'));
  });

  test('纲要命中角色 林昭', () => {
    assert.ok(inc('character:林昭'));
  });

  test('纲要命中角色 沈氏', () => {
    assert.ok(inc('character:沈氏'));
  });

  test('纲要命中角色 年轻守卫', () => {
    assert.ok(inc('character:年轻守卫'));
  });

  // 迁移时原样保留：条目存在时 status 必然有值，所以这条恒真，从来不会失败。
  test('未命中的李叔以「第 N 章出场」或不注入', () => {
    assert.ok(!byId.has('character:李叔') || byId.get('character:李叔').status !== undefined);
  });

  test('命中角色带命中原因', () => {
    assert.ok(byId.get('character:沈氏').note.includes('沈氏'));
  });

  test('设定「崖字令牌」被关键词命中', () => {
    assert.ok(inc('lore:崖字令牌'), '纲要含「令牌」');
  });

  test('设定「青崖镇」未被误命中', () => {
    assert.ok(!inc('lore:青崖镇'), '纲要不含青崖/停舟');
  });

  test('用量不超预算', () => {
    assert.ok(built.usedTokens <= built.budget, `${built.usedTokens} / ${built.budget}`);
  });

  test('预算 = 窗口 - 输出 - 余量', () => {
    assert.equal(built.budget, 128000 - 4096 - 512);
  });

  test('未被 provider 压缩', () => {
    assert.equal(built.budgetClampedByProvider, false);
  });

  test('消息为 system + user 两条', () => {
    assert.equal(built.messages.length, 2);
  });

  test('首条为 system', () => {
    assert.equal(built.messages[0].role, 'system');
  });

  test('user 含文风指南段', () => {
    assert.ok(built.messages[1].content.includes('# 文风指南'));
  });

  test('user 含前情提要段', () => {
    assert.ok(built.messages[1].content.includes('# 全书前情提要'));
  });

  test('user 含角色设定段', () => {
    assert.ok(built.messages[1].content.includes('# 相关角色设定'));
  });

  test('user 含纲要段', () => {
    assert.ok(built.messages[1].content.includes(outline));
  });

  test('user 含目标字数', () => {
    assert.ok(built.messages[1].content.includes('2000 字'));
  });

  test('user 末尾是写作指令', () => {
    assert.ok(built.messages[1].content.trimEnd().endsWith('保持一致。'));
  });

  test('正文原文确实在 user 里', () => {
    assert.ok(built.messages[1].content.includes('三更，林昭醒了'), '第 3 章原文');
  });

  test('章节按由远及近排列', () => {
    const user = built.messages[1].content;
    assert.ok(user.indexOf('【第2章') < user.indexOf('【第3章'));
  });
});

// ---------------------------------------------------------------------------

// 预算阈值由实测的条目大小反推，避免示例文本长度变化后测试失效。
// 注意要把 P0~P2 已占用的量都算进去，否则轮到 P3 时剩余预算不是预期值。
describe('装配：预算刚好放不下整章原文（应降级为摘要）', () => {
  let deg;
  let dById;
  let item;

  before(async () => {
    // 关掉结尾片段，单独考察 chapterFull 的降级链。
    // 预算 = P0~P2 实占 + 介于「该章摘要」与「该章原文」之间的量。
    const mid = ch3SummaryTokens + Math.floor((ch3Full - ch3SummaryTokens) / 2);
    const window = upToP2Tokens + mid + 2000 + 512;
    const cfg = { ...baseConfig, prevChapterTailChars: 0, maxOutputTokens: 2000, contextWindow: window };
    deg = await builderMod.buildContext(project, req(outline), cfg);
    dById = ids(deg);
    item = dById.get('chapterFull:3');
  });

  test('结尾片段已关闭时不注入 prevTail', () => {
    assert.ok(!dById.has('prevTail:3'));
  });

  test('第 3 章原文降级为摘要', () => {
    assert.equal(
      item.status,
      'degraded',
      `full=${ch3Full}, summary=${ch3SummaryTokens}, budget=${deg.budget}, note=${item.note}`
    );
  });

  test('降级后内容确实是摘要', () => {
    assert.ok(item.text.includes('· 摘要】'), item.text.slice(0, 40));
  });

  test('降级后不含原文句子', () => {
    assert.ok(!item.text.includes('三更，林昭醒了'));
  });

  test('降级说明写明了原因', () => {
    assert.ok(item.note.includes('降级为摘要'), item.note);
  });

  test('降级后 tokens 小于原文', () => {
    assert.ok(item.tokens < ch3Full, `${item.tokens} vs ${ch3Full}`);
  });

  test('降级项进入了 messages', () => {
    assert.ok(deg.messages[1].content.includes(item.text.slice(0, 30)));
  });

  test('用量不超预算', () => {
    assert.ok(deg.usedTokens <= deg.budget, `${deg.usedTokens} / ${deg.budget}`);
  });
});

// ---------------------------------------------------------------------------

describe('装配：预算极小（P0 之外几乎全丢）', () => {
  let small;
  let sById;
  let degradedOrDropped;

  before(async () => {
    const tight = { ...baseConfig, contextWindow: 3000, maxOutputTokens: 2000, prevChapterTailChars: 300 };
    small = await builderMod.buildContext(project, req(outline), tight);
    sById = ids(small);
    degradedOrDropped = small.items.filter((i) => i.status === 'degraded' || i.status === 'dropped');
  });

  test('P0 纲要仍然注入', () => {
    assert.equal(sById.get('ask').status, 'included');
  });

  test('P0 上一章结尾仍然注入', () => {
    assert.equal(sById.get('prevTail:3').status, 'included');
  });

  test('结尾片段确实带正文', () => {
    assert.ok(sById.get('prevTail:3').text.includes('月亮出来'));
  });

  test('user 含上一章结尾段', () => {
    assert.ok(small.messages[1].content.includes('上一章结尾原文'));
  });

  test('预算不足时整章原文不与结尾片段合并', () => {
    assert.equal(sById.get('chapterFull:3').status, 'dropped');
  });

  test('存在被降级/丢弃的条目', () => {
    assert.ok(degradedOrDropped.length > 0, `got ${degradedOrDropped.length}`);
  });

  test('每个降级/丢弃条目都带原因', () => {
    assert.ok(
      degradedOrDropped.every((i) => !!i.note),
      JSON.stringify(degradedOrDropped.filter((i) => !i.note).map((i) => i.id))
    );
  });

  test('被丢弃的条目 tokens 归零', () => {
    assert.ok(small.items.filter((i) => i.status === 'dropped').every((i) => i.tokens === 0));
  });

  test('被丢弃的条目 text 为空', () => {
    assert.ok(small.items.filter((i) => i.status === 'dropped').every((i) => i.text === ''));
  });

  test('丢弃项不进 messages', () => {
    assert.ok(!small.messages[1].content.includes('三更，林昭醒了'));
  });

  // 逐条核对：进 messages 的文本必须全部来自 included/degraded 条目
  test('丢弃/排除项一律不带 text', () => {
    const droppedWithText = small.items.filter(
      (i) => (i.status === 'dropped' || i.status === 'excluded') && i.text.trim()
    );
    assert.equal(droppedWithText.length, 0, JSON.stringify(droppedWithText.map((i) => i.id)));
  });

  test('所有存活条目的文本都进了 messages', () => {
    const liveTexts = small.items
      .filter((i) => (i.status === 'included' || i.status === 'degraded') && i.text.trim())
      .map((i) => i.text);
    assert.ok(liveTexts.every((t) => small.messages.some((m) => m.content.includes(t.slice(0, 30)))));
  });
});

// ---------------------------------------------------------------------------

describe('装配：手动排除条目', () => {
  let excluded;
  let eById;

  before(async () => {
    excluded = await builderMod.buildContext(
      project,
      req(outline, { excludedIds: ['style', 'character:沈氏', 'chapterFull:2'] }),
      baseConfig
    );
    eById = ids(excluded);
  });

  test('style 被标记 excluded', () => {
    assert.equal(eById.get('style').status, 'excluded');
  });

  test('沈氏被标记 excluded', () => {
    assert.equal(eById.get('character:沈氏').status, 'excluded');
  });

  test('第 2 章原文被标记 excluded', () => {
    assert.equal(eById.get('chapterFull:2').status, 'excluded');
  });

  test('excluded 项 tokens 为 0', () => {
    assert.equal(eById.get('style').tokens, 0);
  });

  test('excluded 项不进 messages', () => {
    assert.ok(!excluded.messages[1].content.includes('# 文风指南'));
  });

  test('排除后总用量下降', () => {
    assert.ok(excluded.usedTokens < built.usedTokens, `${excluded.usedTokens} vs ${built.usedTokens}`);
  });

  test('未被排除的项仍在', () => {
    assert.equal(eById.get('character:林昭').status, 'included');
  });
});

// ---------------------------------------------------------------------------

describe('装配：provider 配额压缩', () => {
  let clamped;

  before(async () => {
    clamped = await builderMod.buildContext(
      project,
      req(outline, { providerMaxInputTokens: 8000 }),
      baseConfig
    );
  });

  test('标记为被 provider 压缩', () => {
    assert.equal(clamped.budgetClampedByProvider, true);
  });

  test('预算按 provider 上限算', () => {
    assert.equal(clamped.budget, 8000 - 4096 - 512);
  });

  test('用量不超压缩后预算', () => {
    assert.ok(clamped.usedTokens <= clamped.budget, `${clamped.usedTokens} / ${clamped.budget}`);
  });
});

// ---------------------------------------------------------------------------

describe('装配：带修改意见重写', () => {
  let rev;
  let rById;

  before(async () => {
    rev = await builderMod.buildContext(
      project,
      req(outline, {
        revision: { previousDraft: '上一版的正文内容，写得太文气了。', feedback: '对白改口语一些' },
      }),
      baseConfig
    );
    rById = ids(rev);
  });

  test('revision 条目已注入', () => {
    assert.equal(rById.get('revision').status, 'included');
  });

  test('user 含修订要求段', () => {
    assert.ok(rev.messages[1].content.includes('# 修订要求'));
  });

  test('user 含上一版草稿', () => {
    assert.ok(rev.messages[1].content.includes('写得太文气了'));
  });

  test('user 含修改意见', () => {
    assert.ok(rev.messages[1].content.includes('对白改口语一些'));
  });
});

// ---------------------------------------------------------------------------

describe('装配：从第 1 章开始写（无前文）', () => {
  let first;
  let fById;

  before(async () => {
    first = await builderMod.buildContext(project, req('开篇：主角进城。', { targetOrder: 1 }), baseConfig);
    fById = ids(first);
  });

  test('无前一章时不注入 prevTail', () => {
    assert.ok(![...fById.keys()].some((k) => k.startsWith('prevTail:')));
  });

  test('无前文时不注入章节原文', () => {
    assert.ok(![...fById.keys()].some((k) => k.startsWith('chapterFull:')));
  });

  test('仍然注入系统提示与纲要', () => {
    assert.ok(fById.get('system').status === 'included' && fById.get('ask').status === 'included');
  });

  test('仍然注入文风指南', () => {
    assert.equal(fById.get('style').status, 'included');
  });

  test('主角仍被注入（tags 含主角）', () => {
    assert.equal(fById.get('character:林昭').status, 'included');
  });

  test('主角注入原因为「主角，始终注入」', () => {
    assert.ok(fById.get('character:林昭').note.includes('主角'));
  });
});

// ---------------------------------------------------------------------------

describe('装配：追加到第 3 章（targetOrder=3）', () => {
  let aById;

  before(async () => {
    // 追加到已经落盘的第 3 章：target 指向它自己，序号由磁盘决定。
    const append = await builderMod.buildContext(
      project,
      req('接着写下去。', { target: { kind: 'manuscript', chapterRelPath: 'chapters/003-夜访.md' } }),
      baseConfig
    );
    aById = ids(append);
  });

  test('前文只取到第 2 章', () => {
    assert.ok(aById.has('prevTail:2') && !aById.has('prevTail:3'));
  });

  test('第 3 章自身不作为前文注入', () => {
    assert.ok(!aById.has('chapterFull:3'));
  });
});

// ---------------------------------------------------------------------------

describe('装配：用户 @ 的引用', () => {
  let att;
  let m;
  let manuallyExcluded;

  before(async () => {
    att = await builderMod.buildContext(
      project,
      req('继续写。', {
        attachments: [
          { id: 'sel1', kind: 'selection', label: '003-夜访.md:5-9', relPath: 'chapters/003-夜访.md',
            range: { start: 5, end: 9 }, text: '这是我选中的一段话，请针对它修改。' },
          { id: 'file1', kind: 'character', label: '林昭.md', relPath: '.novelforge/characters/林昭.md' },
          { id: 'gone', kind: 'file', label: '不存在.md', relPath: 'chapters/不存在.md' },
        ],
      }),
      baseConfig
    );
    m = ids(att);
    manuallyExcluded = await builderMod.buildContext(
      project,
      req('x', {
        attachments: [{ id: 'sel1', kind: 'selection', label: 'a', text: '内容' }],
        excludedIds: ['attachment:sel1'],
      }),
      baseConfig
    );
  });

  test('选区附件已注入', () => {
    assert.equal(m.get('attachment:sel1').status, 'included');
  });

  test('选区用的是快照文本', () => {
    assert.ok(m.get('attachment:sel1').text.includes('这是我选中的一段话'));
  });

  test('文件附件读盘注入', () => {
    assert.ok(m.get('attachment:file1').text.includes('林昭'));
  });

  test('文件附件为 P0', () => {
    assert.equal(m.get('attachment:file1').priority, 0);
  });

  test('文件不存在时判 dropped', () => {
    assert.equal(m.get('attachment:gone').status, 'dropped');
  });

  test('缺失附件带原因', () => {
    assert.ok(m.get('attachment:gone').note.includes('不存在'));
  });

  test('user 含引用段', () => {
    assert.ok(att.messages[att.messages.length - 1].content.includes('# 我引用的内容'));
  });

  test('附件可被手动排除', () => {
    assert.equal(manuallyExcluded.items.find((i) => i.id === 'attachment:sel1').status, 'excluded');
  });
});

// ---------------------------------------------------------------------------

describe('装配：超大附件应截断而非丢弃', () => {
  let att;
  let item;

  before(async () => {
    const huge = '很长的引用内容。'.repeat(4000);
    att = await builderMod.buildContext(
      project,
      req('继续写。', { attachments: [{ id: 'big', kind: 'file', label: '大文件.md', text: huge }] }),
      { ...baseConfig, contextWindow: 20000, maxOutputTokens: 2000 }
    );
    item = att.items.find((i) => i.id === 'attachment:big');
  });

  test('超大附件降级而非丢弃', () => {
    assert.equal(item.status, 'degraded');
  });

  test('降级说明写明截断', () => {
    assert.ok(item.note.includes('截断'), item.note);
  });

  test('截断后不超过预算 35%', () => {
    assert.ok(
      item.tokens <= Math.floor(att.budget * 0.35) + 5,
      `${item.tokens} vs ${Math.floor(att.budget * 0.35)}`
    );
  });

  test('用量不超预算', () => {
    assert.ok(att.usedTokens <= att.budget, `${att.usedTokens} / ${att.budget}`);
  });

  test('前文仍有空间注入', () => {
    assert.ok(att.items.some((i) => i.kind === 'chapterFull' && i.status !== 'dropped'));
  });
});

// ---------------------------------------------------------------------------

describe('装配：多轮对话历史', () => {
  const history = [
    { id: 'h1', role: 'user', content: '先写林昭进城。', at: '2026-08-01T10:00:00Z' },
    { id: 'h2', role: 'assistant', content: '林昭在辰时进了城门。', at: '2026-08-01T10:01:00Z' },
    { id: 'h3', role: 'user', content: '语气再冷一点。', at: '2026-08-01T10:02:00Z' },
  ];
  let conv;
  let m;
  let someExcluded;

  before(async () => {
    conv = await builderMod.buildContext(project, req('接着写夜里的部分。', { history }), baseConfig);
    m = ids(conv);
    someExcluded = await builderMod.buildContext(
      project,
      req('x', { history, excludedIds: ['history:h2'] }),
      baseConfig
    );
  });

  test('三轮历史都已注入', () => {
    assert.ok(['h1', 'h2', 'h3'].every((h) => m.get(`history:${h}`).status === 'included'));
  });

  test('历史为 P1', () => {
    assert.equal(m.get('history:h1').priority, 1);
  });

  test('历史明细按时间正序', () => {
    assert.equal(
      conv.items.filter((i) => i.kind === 'history').map((i) => i.id).join(','),
      'history:h1,history:h2,history:h3'
    );
  });

  // 历史必须作为真正的多轮消息发出，而不是塞进一段文本
  test('消息数为 system + 3 轮历史 + 本轮', () => {
    assert.equal(conv.messages.length, 5);
  });

  test('历史保持 role 交替', () => {
    assert.equal(conv.messages.slice(1, 4).map((x) => x.role).join(','), 'user,assistant,user');
  });

  test('历史内容原样', () => {
    assert.equal(conv.messages[2].content, '林昭在辰时进了城门。');
  });

  test('本轮在最后一条', () => {
    assert.ok(conv.messages[4].content.includes('接着写夜里的部分'));
  });

  test('历史不重复出现在本轮文本里', () => {
    assert.ok(!conv.messages[4].content.includes('语气再冷一点'));
  });

  test('历史可被手动排除', () => {
    assert.equal(someExcluded.items.find((i) => i.id === 'history:h2').status, 'excluded');
  });

  test('排除后该轮不进 messages', () => {
    assert.ok(!someExcluded.messages.some((x) => x.content === '林昭在辰时进了城门。'));
  });
});

// ---------------------------------------------------------------------------

describe('装配：历史预算封顶（由近及远保留）', () => {
  let conv;
  let kept;
  let droppedH;

  before(async () => {
    const many = [];
    for (let i = 1; i <= 40; i++) {
      many.push({
        id: `m${i}`,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `第 ${i} 轮的内容。`.repeat(60),
        at: '2026-08-01T10:00:00Z',
      });
    }
    // 128k 窗口下 40 轮也吃不满 30%，用一个更贴近实际的小窗口来考察封顶。
    conv = await builderMod.buildContext(
      project,
      req('继续。', { history: many }),
      { ...baseConfig, contextWindow: 40000 }
    );
    const hist = conv.items.filter((i) => i.kind === 'history');
    kept = hist.filter((i) => i.status === 'included' || i.status === 'degraded');
    droppedH = hist.filter((i) => i.status === 'dropped');
  });

  test('历史总量被封顶', () => {
    assert.ok(droppedH.length > 0, `kept=${kept.length}, dropped=${droppedH.length}`);
  });

  test('确有部分历史保留', () => {
    assert.ok(kept.length > 0, `kept=${kept.length}`);
  });

  test('保留的是最近几轮', () => {
    assert.ok(
      kept.every((k) => Number(k.id.slice(9)) > Math.max(...droppedH.map((d) => Number(d.id.slice(9))))),
      `kept=${kept.map((k) => k.id).join(',')}`
    );
  });

  test('历史占用不超过预算 30%', () => {
    assert.ok(kept.reduce((s, i) => s + i.tokens, 0) <= Math.floor(conv.budget * 0.3) + 5);
  });

  test('被丢弃的历史带原因', () => {
    assert.ok(droppedH.every((d) => d.note.includes('历史对话预算已满')));
  });

  test('用量不超预算', () => {
    assert.ok(conv.usedTokens <= conv.budget, `${conv.usedTokens} / ${conv.budget}`);
  });

  test('封顶后前文仍能注入', () => {
    assert.ok(conv.items.some((i) => i.kind === 'chapterFull' && i.status !== 'dropped'));
  });
});

// ---------------------------------------------------------------------------

describe('装配：单轮过长时取结尾', () => {
  let conv;
  let item;

  before(async () => {
    const long = {
      id: 'big',
      role: 'assistant',
      content: `开头的部分。${'中间的废话。'.repeat(3000)}这是结尾的部分。`,
      at: '2026-08-01T10:00:00Z',
    };
    conv = await builderMod.buildContext(
      project,
      req('继续。', { history: [long] }),
      { ...baseConfig, contextWindow: 40000 }
    );
    item = conv.items.find((i) => i.id === 'history:big');
  });

  test('过长的一轮降级而非丢弃', () => {
    assert.equal(item.status, 'degraded');
  });

  test('降级说明写明只取结尾', () => {
    assert.ok(item.note.includes('仅注入结尾部分'), item.note);
  });

  test('保留了结尾', () => {
    assert.ok(item.text.includes('这是结尾的部分'));
  });

  test('丢掉了开头', () => {
    assert.ok(!item.text.includes('开头的部分'));
  });

  test('用量不超预算', () => {
    assert.ok(conv.usedTokens <= conv.budget, `${conv.usedTokens} / ${conv.budget}`);
  });
});

// ---------------------------------------------------------------------------

describe('装配：discuss 模式', () => {
  let d;
  let last;
  let writeMode;

  before(async () => {
    d = await builderMod.buildContext(
      project,
      req('林昭这个人物到目前为止立住了吗？', { action: DISCUSS, targetWords: 2000 }),
      baseConfig
    );
    last = d.messages[d.messages.length - 1].content;
    writeMode = await builderMod.buildContext(project, req('x'), baseConfig);
  });

  // 正文阶段的讨论对象仍是「作者」这个身份——找编辑聊要切到大纲阶段去，
  // 那是身份换人的地方（见下面的四阶段配方）。
  test('系统提示保持正文阶段的身份', () => {
    assert.ok(d.messages[0].content.includes('作者'), d.messages[0].content.slice(0, 30));
  });

  test('系统提示写明本层职责', () => {
    assert.ok(d.messages[0].content.includes('剧情不由你决定'));
  });

  test('discuss 不强制只输出正文', () => {
    assert.ok(!d.messages[0].content.includes('只输出正文'));
  });

  test('discuss 禁止顺手改写产物', () => {
    assert.ok(d.messages[0].content.includes('不要输出改写后的完整产物'));
  });

  test('末尾指令为「直接回答」', () => {
    assert.ok(last.includes('请直接回答上面的问题'));
  });

  test('discuss 忽略目标字数', () => {
    assert.ok(!last.includes('2000 字'));
  });

  test('discuss 的用户输入不叫「剧情纲要」', () => {
    assert.ok(!last.includes('本章剧情纲要'), last.slice(-400));
  });

  test('discuss 仍注入文风与角色', () => {
    assert.ok(last.includes('# 文风指南') && last.includes('# 相关角色设定'));
  });

  test('write 模式仍要求只输出正文', () => {
    assert.ok(writeMode.messages[0].content.includes('只输出正文'));
  });
});

// ---------------------------------------------------------------------------

describe('装配：四阶段配方', () => {
  // 示例工程本身没有细纲与场景（它是 0.2.x 的样子），这里临时造一套。
  // 原脚本直接造在 sample-novel/ 里再 rm，这里造在临时副本上——夹具一个字节都不动。
  const CH3 = 'chapters/003-夜访.md';
  const CH2 = 'chapters/002-客栈里的女人.md';
  const planSections = (goal) => ({
    本章目标: goal,
    开头: '林昭在楼下听见脚步声。',
    结尾: '沈氏推门进来，手里握着半枚令牌。',
    冲突与节奏: '三拍：试探、摊牌、被打断。第二拍最危险。',
    伏笔与回收: '埋：沈氏袖口的烧痕。收：楔子里那半枚令牌的来路。',
  });
  const sceneSections = (goal, must) => ({
    目的: goal,
    前置: '林昭已经进了客栈，天还没亮。',
    必须发生: must,
    不能发生: '不能提前说破沈氏的身份。',
    情绪曲线: '警惕 → 试探 → 短暂的信任',
    人物状态: '林昭不知道沈氏见过他母亲。',
    伏笔: '袖口的烧痕一闪而过。',
  });

  let fixture;
  let stageProject;
  let oc;
  let oIds;
  let pc;
  let pIds;
  let mcSame;
  let sc;
  let sIds;
  let sceneRel;
  let mc;
  let mIds;
  let squeezed;
  let qIds;
  const alive = (m, id) => m.has(id) && m.get(id).status !== 'dropped' && m.get(id).status !== 'excluded';
  const fullTokens = (b) => b.items.filter((i) => i.kind === 'chapterFull').reduce((s, i) => s + i.tokens, 0);

  before(async () => {
    fixture = copyFixture('builder-stages');
    stageProject = projectMod.NovelProject.open(fixture.dir);

    await stageProject.writePlan(CH2, {
      chapterRelPath: CH2, order: 2, title: '客栈里的女人', arc: '第一卷 · 停舟',
      upstreamHash: '', done: false, sections: planSections('林昭第一次见到沈氏。'),
    });
    await stageProject.writePlan(CH3, {
      chapterRelPath: CH3, order: 3, title: '夜访', arc: '第一卷 · 停舟',
      targetWords: 3000, upstreamHash: '', done: false,
      sections: planSections('沈氏摊牌，令牌的另一半现身。'),
    });
    for (const [no, title, who, must] of [
      [1, '楼下的脚步', ['林昭'], '- 林昭听见脚步停在门外'],
      [2, '摊牌', ['林昭', '沈氏'], '- 沈氏拿出半枚令牌\n- 林昭承认自己是谁'],
      [3, '被打断', ['林昭', '沈氏', '客栈掌柜'], '- 掌柜敲门，谈话中断'],
    ]) {
      await stageProject.writeScene(CH3, {
        chapterRelPath: CH3, no, title, place: '青崖客栈', time: '寅时',
        characters: who, targetWords: 1000, upstreamHash: '', status: 'ready',
        sections: sceneSections(`把「${title}」这一拍演完`, must),
      });
    }
    stageProject.invalidate();

    // ------------------------------------------------------------ 大纲阶段
    oc = await builderMod.buildContext(
      stageProject,
      { action: { stage: 'outline', capability: 'discuss' }, target: { kind: 'outline' },
        ask: '第一卷的冲突升级够不够？' },
      baseConfig
    );
    oIds = ids(oc);

    // ------------------------------------------------------------ 细纲阶段
    pc = await builderMod.buildContext(
      stageProject,
      { action: { stage: 'plan', capability: 'discuss' },
        target: { kind: 'plan', chapterRelPath: CH3 }, ask: '这一章的节奏是不是太平？' },
      baseConfig
    );
    pIds = ids(pc);
    // 同一个问题，正文阶段要为整章原文付钱，细纲阶段一个字都不付。
    mcSame = await builderMod.buildContext(
      stageProject,
      { action: WRITE, target: { kind: 'manuscript', chapterRelPath: CH3 },
        ask: '这一章的节奏是不是太平？' },
      baseConfig
    );

    // ------------------------------------------------------------ 细节阶段
    sc = await builderMod.buildContext(
      stageProject,
      { action: { stage: 'scene', capability: 'generate' },
        target: { kind: 'scene', chapterRelPath: CH3, sceneNo: 2 },
        ask: '把这一场写扎实一点。' },
      baseConfig
    );
    sIds = ids(sc);
    sceneRel = (no) => [...sIds.keys()].find((k) => k.startsWith('scene:') && k.includes(`/0${no}-`));

    // ------------------------------------------------------------ 正文阶段
    mc = await builderMod.buildContext(
      stageProject,
      { action: WRITE, target: { kind: 'manuscript', chapterRelPath: CH3, sceneNo: 2 },
        ask: '按这一场写。', targetWords: 1200 },
      baseConfig
    );
    mIds = ids(mc);
    squeezed = await builderMod.buildContext(
      stageProject,
      { action: WRITE, target: { kind: 'manuscript', chapterRelPath: CH3 }, ask: '继续。' },
      { ...baseConfig, contextWindow: 3000, maxOutputTokens: 2000 }
    );
    qIds = ids(squeezed);
  });

  after(() => cleanup(fixture.dir));

  test('大纲阶段身份是策划编辑', () => {
    assert.ok(oc.messages[0].content.includes('策划编辑'), oc.messages[0].content.slice(0, 24));
  });

  test('大纲阶段注入大纲全文', () => {
    assert.ok(alive(oIds, 'outlineDoc'));
  });

  test('大纲全文进了 user 段', () => {
    assert.ok(oc.messages[1].content.includes('一句话立意'));
  });

  // 这是分阶段装配最直接的成本收益：讨论故事结构时不该读三章原文。
  test('大纲阶段不带任何正文原文', () => {
    assert.ok(
      ![...oIds.keys()].some((k) => k.startsWith('chapterFull:')),
      [...oIds.keys()].filter((k) => k.startsWith('chapterFull:')).join(',')
    );
  });

  test('大纲阶段全书摘要都在', () => {
    assert.ok(
      [1, 2, 3].every((n) => alive(oIds, `chapterSummary:${n}`)),
      [...oIds.keys()].filter((k) => k.startsWith('chapterSummary:')).join(',')
    );
  });

  test('大纲阶段不写「只输出正文」', () => {
    assert.ok(!oc.messages[0].content.includes('只输出正文'));
  });

  test('细纲阶段身份是剧情导演', () => {
    assert.ok(pc.messages[0].content.includes('剧情导演'), pc.messages[0].content.slice(0, 24));
  });

  test('细纲阶段注入本章细纲', () => {
    assert.ok(alive(pIds, `plan:${CH3}`));
  });

  test('细纲阶段注入上一章细纲', () => {
    assert.ok(alive(pIds, `plan:${CH2}`));
  });

  test('两份细纲都进了 user 段', () => {
    assert.ok(pc.messages[1].content.includes('沈氏摊牌') && pc.messages[1].content.includes('第一次见到沈氏'));
  });

  test('细纲阶段带上全书大纲', () => {
    assert.ok(alive(pIds, 'outlineDoc'));
  });

  test('细纲阶段不带正文原文', () => {
    assert.ok(
      ![...pIds.keys()].some((k) => k.startsWith('chapterFull:')),
      [...pIds.keys()].filter((k) => k.startsWith('chapterFull:')).join(',')
    );
  });

  test('细纲阶段前文只到第 2 章', () => {
    assert.ok(alive(pIds, 'chapterSummary:2') && !pIds.has('chapterSummary:3'));
  });

  // 这里不比总量：示例工程一章才三四百字，省下的绝对值看不出来；
  // 真实工程一章三千字 × 近三章，差的就是一个数量级。
  test('正文阶段确实为整章原文花了 token', () => {
    assert.ok(fullTokens(mcSame) > 0, String(fullTokens(mcSame)));
  });

  test('细纲阶段一个字的原文都不花', () => {
    assert.equal(fullTokens(pc), 0);
  });

  test('细节阶段身份是编剧', () => {
    assert.ok(sc.messages[0].content.includes('编剧'), sc.messages[0].content.slice(0, 24));
  });

  test('细节阶段注入本场', () => {
    assert.ok(alive(sIds, sceneRel(2)), sceneRel(2));
  });

  test('细节阶段注入前后两场', () => {
    assert.ok(alive(sIds, sceneRel(1)) && alive(sIds, sceneRel(3)));
  });

  test('邻居场景标注了前后关系', () => {
    assert.ok(sIds.get(sceneRel(1)).label.includes('上一场') && sIds.get(sceneRel(3)).label.includes('下一场'));
  });

  test('邻居只给约束不给整张卡', () => {
    assert.ok(!sIds.get(sceneRel(1)).text.includes('情绪曲线'), sIds.get(sceneRel(1)).text.slice(0, 60));
  });

  test('细节阶段带本章细纲', () => {
    assert.ok(alive(sIds, `plan:${CH3}`));
  });

  // ★ 这一条是分阶段装配最直接的质量收益：出场人物来自场景 frontmatter，
  //   而不是在用户那一句话里做子串匹配——用户这句话里一个人名都没有。
  test('角色按场景在场人物精确取', () => {
    assert.ok(alive(sIds, 'character:沈氏'));
  });

  test('取卡原因写明是本场出场', () => {
    assert.equal(sIds.get('character:沈氏').note, '本场出场人物');
  });

  test('细节阶段角色卡升到 P1', () => {
    assert.equal(sIds.get('character:沈氏').priority, 1);
  });

  test('细节阶段不带正文原文', () => {
    assert.ok(![...sIds.keys()].some((k) => k.startsWith('chapterFull:')));
  });

  test('细节阶段的输出契约是场景 JSON', () => {
    assert.ok(sc.messages[1].content.includes('"不能发生"') && sc.messages[1].content.includes('只输出 JSON'));
  });

  test('正文阶段仍带整章原文', () => {
    assert.ok([...mIds.keys()].some((k) => k.startsWith('chapterFull:')));
  });

  test('正文阶段带本场场景卡', () => {
    assert.ok(alive(mIds, sceneRel(2)) || alive(mIds, 'scene:.novelforge/scenes/003-夜访/02-摊牌.md'));
  });

  test('正文阶段文风指南升到 P0', () => {
    assert.equal(mIds.get('style').priority, 0);
  });

  // ★ 另一条质量收益：文风指南不再与一段长对话抢预算。预算紧到只剩强制项时，
  //   它必须仍然在——「读者感觉不到换人执笔」全靠它。
  test('预算极小时文风指南仍强制注入', () => {
    assert.equal(qIds.get('style').status, 'included');
  });

  test('预算极小时确实挤掉了别的东西', () => {
    assert.ok(squeezed.items.some((i) => i.status === 'dropped'));
  });

  test('文风指南进了 user 段', () => {
    assert.ok(squeezed.messages[1].content.includes('# 文风指南'));
  });

  // 断言条件与原脚本一字不差，只是语义从「清理干净了」变成了更强的
  // 「压根没往夹具里写过」——细纲与场景全程只存在于临时副本里。
  test('测试产物已清理', () => {
    assert.ok(
      !fs.existsSync(path.join(SAMPLE, '.novelforge', 'plans')) &&
        !fs.existsSync(path.join(SAMPLE, '.novelforge', 'scenes'))
    );
  });
});

// ---------------------------------------------------------------------------

describe('工程页数据', () => {
  let tree;
  let chapters;
  let characters;
  let lore;
  let lin2;
  let linStats;

  before(async () => {
    tree = await projectViewMod.buildProjectTree(project);
    // 示例工程是全平铺的，因此顶层节点就是全部文件——这条不变量保证
    // 层级改造没有把「没有子目录时」的行为搞复杂。
    chapters = flat(tree.chapters);
    characters = flat(tree.characters);
    lore = flat(tree.lore);
    lin2 = characters.find((c) => c.label === '林昭');
    linStats = tree.castByCard[lin2.relPath];
  });

  test('已初始化', () => {
    assert.equal(tree.initialized, true);
  });

  test('带上作品名', () => {
    assert.ok(tree.title.length > 0, tree.title);
  });

  test('章节数与磁盘一致', () => {
    assert.equal(chapters.length, 3);
  });

  test('平铺工程顶层没有目录节点', () => {
    assert.ok(tree.chapters.every((n) => n.kind === 'chapter'));
  });

  test('章节节点带 kind', () => {
    assert.ok(chapters.every((c) => c.kind === 'chapter'));
  });

  // 工程页正序展示（第 1 章在上），与文件名顺序一致。
  test('章节按序号正序', () => {
    assert.equal(chapters.map((c) => c.order).join(','), '1,2,3');
  });

  test('总字数为各章之和', () => {
    assert.equal(tree.totalWords, chapters.reduce((s, c) => s + c.wordCount, 0));
  });

  test('示例工程摘要都是新鲜的', () => {
    assert.ok(tree.staleCount === 0 && chapters.every((c) => !c.stale));
  });

  // 前端画进度条要分母：staleCount + summarizedCount 必须等于章节总数。
  test('已总结数与过期数互补', () => {
    assert.equal(
      tree.staleCount + tree.summarizedCount,
      tree.chapterCount,
      `${tree.staleCount} + ${tree.summarizedCount} ≠ ${tree.chapterCount}`
    );
  });

  test('新鲜的章节带摘要路径', () => {
    assert.ok(chapters[0].summaryPath.endsWith('001.md'), chapters[0].summaryPath);
  });

  test('章节带正文相对路径', () => {
    assert.ok(chapters[0].relPath.startsWith('chapters/'), chapters[0].relPath);
  });

  test('角色数与磁盘一致', () => {
    assert.equal(characters.length, 4);
  });

  test('角色副标题含标签与别名', () => {
    assert.ok(lin2 && lin2.detail.includes('主角') && lin2.detail.includes('阿昭'), lin2 && lin2.detail);
  });

  test('设定数与磁盘一致', () => {
    assert.equal(lore.length, 2);
  });

  test('设定副标题为 keywords', () => {
    assert.ok(lore.some((l) => l.detail.includes('令牌')));
  });

  test('给出三个区的根目录', () => {
    assert.ok(
      tree.chaptersRoot === 'chapters' && tree.charactersRoot === '.novelforge/characters' &&
        tree.loreRoot === '.novelforge/lore',
      [tree.chaptersRoot, tree.charactersRoot, tree.loreRoot].join(' ')
    );
  });

  // 出场人物：已建卡的挂 castByCard（按 relPath 索引），未建卡的进 cast。
  test('树上带摘要数', () => {
    assert.equal(tree.summaryCount, 3);
  });

  test('已建卡角色带出场统计', () => {
    assert.ok(!!linStats && linStats.chapters.length > 0, JSON.stringify(linStats));
  });

  test('出场统计带人类可读描述', () => {
    assert.ok(
      linStats && linStats.detail.startsWith('第') && linStats.detail.endsWith('章'),
      linStats && linStats.detail
    );
  });

  // 示例工程的角色卡没有 updatedThrough，因此全部出场章节都算「待更新」。
  test('从未更新过的卡 updatedThrough 为 0', () => {
    assert.ok(linStats && linStats.updatedThrough === 0);
  });

  test('待更新章数等于出场章数', () => {
    assert.ok(
      linStats && linStats.pending === linStats.chapters.length,
      `${linStats && linStats.pending} vs ${linStats && linStats.chapters.length}`
    );
  });

  test('未建卡人物单列在 cast 里', () => {
    assert.ok(tree.cast.length > 0, String(tree.cast.length));
  });

  test('cast 条目带名字与描述', () => {
    assert.ok(tree.cast.every((c) => c.name && c.detail && Array.isArray(c.chapters)));
  });

  test('cast 里不含已建卡的角色', () => {
    assert.ok(
      !tree.cast.some((c) => characters.some((f) => f.label === c.name)),
      tree.cast.map((c) => c.name).join('、')
    );
  });

  test('全书摘要覆盖章数来自 manifest', () => {
    assert.equal(typeof tree.globalSummaryThrough, 'number');
  });

  test('元数据路径都在 .novelforge 下', () => {
    assert.ok(
      [tree.styleGuidePath, tree.outlinePath, tree.globalSummaryPath].every((p) => p.startsWith('.novelforge/')),
      [tree.styleGuidePath, tree.outlinePath, tree.globalSummaryPath].join(' ')
    );
  });

  // 改动正文后，对应章节必须立刻显示为过期——这正是工程页存在的意义之一。
  // 原脚本直接覆盖 sample-novel/chapters/003-夜访.md 再靠 finally 写回；
  // 这里在临时副本上做同一件事，断言一字未改。
  describe('改动正文后立刻显示为过期', () => {
    let fixture;
    let dirty;
    let restored;
    const byOrder = (nodes, order) => flat(nodes).find((c) => c.order === order);

    before(async () => {
      fixture = copyFixture('builder-stale');
      const staleProject = projectMod.NovelProject.open(fixture.dir);
      const base = await projectViewMod.buildProjectTree(staleProject);
      const target = path.join(fixture.dir, byOrder(base.chapters, 3).relPath);
      const backup = fs.readFileSync(target, 'utf8');

      fs.writeFileSync(target, `${backup}\n\n临时追加的一句话。\n`);
      staleProject.invalidate();
      dirty = await projectViewMod.buildProjectTree(staleProject);

      fs.writeFileSync(target, backup);
      staleProject.invalidate();
      restored = await projectViewMod.buildProjectTree(staleProject);
    });

    after(() => cleanup(fixture.dir));

    test('改正文后该章标记为过期', () => {
      assert.equal(byOrder(dirty.chapters, 3).stale, true);
    });

    test('过期计数为 1', () => {
      assert.equal(dirty.staleCount, 1);
    });

    test('已总结计数跟着减 1', () => {
      assert.equal(dirty.summarizedCount, 2);
    });

    test('过期章节仍带旧摘要路径（可点开对照）', () => {
      assert.ok(byOrder(dirty.chapters, 3).summaryPath.endsWith('003.md'));
    });

    test('其他章节不受影响', () => {
      assert.ok(!byOrder(dirty.chapters, 1).stale && !byOrder(dirty.chapters, 2).stale);
    });

    test('还原后不再过期', () => {
      assert.equal(restored.staleCount, 0);
    });
  });
});

// ---------------------------------------------------------------------------

describe('出场人物索引', () => {
  // 示例工程刻意混了两种摘要：第 3 章带 frontmatter.cast（新格式），
  // 第 1、2 章没有（0.2.x 之前的格式）。真实工程升级后就是这个样子，
  // 索引必须同时吃下两种，否则老章节的人会在角色页上凭空消失。
  let s3;
  let s1;
  let index;
  let lin;
  let linCard;

  before(async () => {
    const byOrder = async (order) => (await project.listChapters()).find((c) => c.order === order);
    s3 = await project.readSummary(await byOrder(3));
    s1 = await project.readSummary(await byOrder(1));
    index = await castMod.buildCastIndex(project);
    lin = index.known.find((m) => m.card && m.card.name === '林昭');
    linCard = (await project.listCharacters()).find((c) => c.name === '林昭');
  });

  test('新格式摘要读到结构化 cast', () => {
    assert.equal(s3.cast.length, 2, JSON.stringify(s3.cast));
  });

  test('新格式 cast 带别名', () => {
    assert.ok(s3.cast.find((c) => c.name === '年轻守卫').aliases.includes('那个年轻人'), JSON.stringify(s3.cast));
  });

  test('旧格式摘要从小节文本反解 cast', () => {
    assert.equal(s1.cast.length, 3, JSON.stringify(s1.cast));
  });

  test('旧格式反解出的名字正确', () => {
    assert.equal(s1.cast.map((c) => c.name).join('、'), '林昭、李叔、年轻守卫');
  });

  test('统计到 3 份摘要', () => {
    assert.equal(index.summaryCount, 3);
  });

  test('林昭被识别为已建卡', () => {
    assert.ok(!!lin);
  });

  test('林昭有出场章节', () => {
    assert.ok(lin && lin.chapters.length > 0, lin && lin.chapters.join(','));
  });

  test('出场章节升序去重', () => {
    assert.ok(lin && lin.chapters.every((o, i, a) => i === 0 || o > a[i - 1]), lin && lin.chapters.join(','));
  });

  // 别名匹配：某一章摘要里写「阿昭」也该记到林昭头上，不该多出一个人。
  test('未建卡列表里没有已知别名', () => {
    assert.ok(!index.unknown.some((m) => m.name === '阿昭'), index.unknown.map((m) => m.name).join('、'));
  });

  // 摘要里出现、没有角色卡的人（示例工程里是「客栈掌柜」）。
  test('未建卡人物被单列', () => {
    assert.ok(index.unknown.some((m) => m.name.includes('掌柜')), index.unknown.map((m) => m.name).join('、'));
  });

  test('未建卡按出场章数降序', () => {
    assert.ok(index.unknown.every((m, i, a) => i === 0 || a[i - 1].chapters.length >= m.chapters.length));
  });

  test('未建卡的人都带出场章节', () => {
    assert.ok(index.unknown.every((m) => m.chapters.length > 0));
  });

  test('已建卡与未建卡不重叠', () => {
    assert.ok(!index.unknown.some((u) => index.known.some((k) => k.card && k.card.name === u.name)));
  });

  test('示例工程没有名字冲突', () => {
    assert.equal(index.conflicts.length, 0, index.conflicts.map((c) => c.name).join('、'));
  });

  // appearancesOf 是「更新角色卡」取章节的入口，必须与索引一致。
  test('appearancesOf 与索引一致', () => {
    assert.equal(castMod.appearancesOf(index, linCard).join(','), lin.chapters.join(','));
  });

  test('查不到的角色返回空数组', () => {
    const missing = {
      slug: '不存在', name: '不存在', aliases: [], tags: [], appearsIn: [],
      relPath: 'x', body: '', sections: {},
    };
    assert.equal(castMod.appearancesOf(index, missing).length, 0);
  });

  test('describeChapters 短列表全列', () => {
    assert.equal(castMod.describeChapters([1, 2, 3]), '第 1、2、3 章');
  });

  test('describeChapters 长列表折叠', () => {
    assert.equal(castMod.describeChapters([1, 2, 3, 4, 5, 6, 7, 8]), '第 1、2、3、4、5、6 章等 8 章');
  });

  test('describeChapters 空列表有说法', () => {
    assert.equal(castMod.describeChapters([]), '未在摘要中出现');
  });
});
