/**
 * 上下文装配全链路：优先级、预算、降级链、手动排除、附件截断、多轮历史封顶、
 * 四阶段配方与身份（架构 / 大纲 / 细纲 / 正文）、provider 配额压缩，外加工程页
 * 快照与出场人物索引。
 *
 * 轴是**章**，而且只有一条：细纲号 = 章号。`plots/NNN-标题.md` 是那一章的细纲
 * （本章目的 / 关键事件 / 章末钩子），`chapters/NNN-标题.md` 是那一章的正文（装配器
 * 读它），架构三件是 `config.md` / `premise.md` / `world.md`。从前的卷、剧情段、
 * 中转站 `manuscripts/` 与拆章都删掉了。
 *
 * 示例工程（sample-novel）：config 30 章 × 400 字，大纲三段区间，第 1–3 章细纲与
 * 正文都在、摘要都新鲜，第 4 章什么都还没有。
 *
 * ## 写盘用例一律跑临时副本
 *
 * `sample-novel/` 有 hash 断言（tests/contract/sampleNovel.test.js），任何写入都会
 * 把它弄红。需要写盘的经 `copyFixture()` 复制一份出来跑。
 *
 * ## 那份 vscode 桩其实是死代码
 *
 * `src/core/` 早已零 vscode 依赖（tests/contract/corePurity.test.js 守着这条），
 * `project.ts` 走 `node:fs/promises` 读盘，而 `external: ['vscode']` 让 bundle 里
 * 连一句 `require('vscode')` 都不剩。这里仍然装上：将来 core 若回退出 vscode
 * 依赖，有桩会照常跑过、没桩会当场炸，炸出来远好过静默改变行为。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { installVscodeStub } = require('../../helpers/vscodeStub');
const { SAMPLE, copyFixture } = require('../../helpers/tmpProject');
const { cleanup } = require('../../helpers/teardown');

/**
 * 细纲的写入在 `core/workspace/`：写入要记上游指纹、删除要进 `.trash/`，那些是
 * 网关的活。`NovelProject` 这一层只留领域查询。
 */
let wsMod;
const wsOf = (p) => new wsMod.Workspace(p);

// 装配请求带 action（阶段 × 能力）与 target（在改哪个产物）。
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

const PLOT1 = '.novelforge/plots/001-楔子.md';
const PLOT2 = '.novelforge/plots/002-客栈里的女人.md';
const PLOT3 = '.novelforge/plots/003-夜访.md';
/** 第 4 章细纲**应该**在的位置。文件还不存在——状态机给出的 target 就是这个样子。 */
const PLOT4 = '.novelforge/plots/004.md';
// 摘要挂在**正文**（章节）上（见 model/project.ts 的路径分界）。
const CH1 = 'chapters/001-楔子.md';
const CH3 = 'chapters/003-夜访.md';

/**
 * 默认目标是「第 4 章的正文」——它的细纲还没落盘，target 指向细纲应在的位置，
 * 装配器按路径里的章号定位「前文」边界。这正是往下写新一章的真实情形。
 */
function req(ask, extra = {}) {
  return {
    action: WRITE,
    target: { kind: 'manuscript', plotRelPath: PLOT4 },
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
// 只算一次。`ASK` 是作者这一轮说的话——正文层里它是「这一章的补充要求」，
// 写正文的依据是那一章的细纲。
const ASK ='林昭答应给年轻守卫看令牌，两人约定天亮后去见他母亲。沈氏在楼下听见了动静。';
let built;
let byId;
let inc;
let upToP2Tokens;
let p3Full;
let p3SummaryTokens;

before(async () => {
  vs = installVscodeStub({ level: 'full', root: SAMPLE, config: {} });
  // 一个 bundle 装全部：分开 bundle 会让每份产物各带一份 project.ts，
  // builder / projectView / cast 拿到的就不是同一个类了。
  const bundle = loadBundle({
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    builder: './src/core/context/builder.ts',
    tokenizer: './src/core/context/tokenizer.ts',
    projectView: './src/core/views/projectView.ts',
    cast: './src/core/views/cast.ts',
  });
  wsMod = bundle.ws;
  projectMod = bundle.project;
  builderMod = bundle.builder;
  tokenizerMod = bundle.tokenizer;
  projectViewMod = bundle.projectView;
  castMod = bundle.cast;

  project = projectMod.NovelProject.open(SAMPLE);

  built = await builderMod.buildContext(project, req(ASK, { targetWords: 2000 }), baseConfig);
  byId = ids(built);
  inc = (id) => byId.get(id) && (byId.get(id).status === 'included' || byId.get(id).status === 'degraded');

  const sumTokens = (pred) => built.items.filter(pred).reduce((s, i) => s + i.tokens, 0);
  upToP2Tokens = sumTokens((i) => i.priority <= 2);
  p3Full = built.items.find((i) => i.id === 'manuscriptFull:3').tokens;
  const p3Summary = (await project.readSummary(CH3)).content;
  p3SummaryTokens = tokenizerMod.estimateTokens(`【第 3 章《夜访》 · 摘要】\n${p3Summary}`);
});

after(() => vs.restore());

// ---------------------------------------------------------------------------

describe('NovelProject 读取示例工程', () => {
  let plots;
  let stale;
  let cards;
  let lin;
  let lore;
  let style;
  let global;
  let nextNo;
  let manuscript;
  let bookConfig;
  let filled;

  before(async () => {
    plots = await project.listPlots();
    stale = await project.staleChapters();
    cards = await project.listCharacters();
    lin = cards.find((c) => c.name === '林昭');
    lore = await project.listLore();
    style = await project.readStyleGuide();
    global = await project.readGlobalSummary();
    nextNo = await project.nextPlotNo();
    manuscript = await project.readChapterText(
      (await project.listChapters()).find((c) => c.order === 1)
    );
    bookConfig = await project.readBookConfig();
    filled = await project.settingFilled();
  });

  test('扫描到 3 章细纲', () => {
    assert.equal(plots.length, 3);
  });

  test('细纲按章号排序', () => {
    assert.equal(plots.map((p) => p.no).join(','), '1,2,3');
  });

  test('细纲平铺在 plots/ 根下', () => {
    assert.deepEqual(plots.map((p) => p.relPath), [PLOT1, PLOT2, PLOT3]);
  });

  test('标题取自 frontmatter', () => {
    assert.equal(plots[1].title, '客栈里的女人');
  });

  // 「关键事件」是判「排过没有」的唯一判据。
  test('关键事件非空（示例工程的章都排过）', () => {
    assert.ok(plots.every((p) => p.sections.关键事件.trim()), plots.map((p) => p.no).join(','));
  });

  test('细纲带规划字段（role / characters / targetWords）', () => {
    assert.equal(plots[2].role, '小高潮');
    assert.deepEqual(plots[2].characters, ['林昭', '年轻守卫']);
    assert.equal(plots[2].targetWords, 650);
  });

  test('正文读得到，字数统计合理', () => {
    assert.ok(manuscript.length > 200 && manuscript.length < 600, String(manuscript.length));
  });

  test('示例工程无过期摘要', () => {
    assert.equal(stale.length, 0, `stale: ${stale.map((c) => c.order).join(',')}`);
  });

  // 整条链的两个长度锚点。
  test('小说配置读得到规模参数', () => {
    assert.equal(bookConfig.totalChapters, 30);
    assert.equal(bookConfig.wordsPerChapter, 400);
  });

  test('架构四件都填过', () => {
    assert.deepEqual(filled, { config: true, premise: true, characters: true, world: true });
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

  test('下一个细纲号为 4', () => {
    assert.equal(nextNo, 4);
  });
});

// ---------------------------------------------------------------------------

describe('装配：预算充裕（128k）', () => {
  test('P0 系统提示已注入', () => {
    assert.ok(inc('system'));
  });

  test('P0 这一轮的要求已注入', () => {
    assert.ok(inc('ask'));
  });

  test('P0 文风指南已注入', () => {
    assert.ok(inc('style'));
  });

  test('P2 全书摘要已注入', () => {
    assert.ok(inc('globalSummary'));
  });

  test('P3 第 3 章正文已注入', () => {
    assert.ok(inc('manuscriptFull:3'));
  });

  test('P3 第 2 章正文已注入', () => {
    assert.ok(inc('manuscriptFull:2'));
  });

  test('P4 第 1 章降级为摘要注入', () => {
    assert.ok(inc('plotSummary:1'));
  });

  // 第 4 章的细纲还没落盘：本章细纲那一层是空的，不凭空造一条。
  test('细纲未落盘时不注入本章细纲', () => {
    assert.ok(![...byId.keys()].some((k) => k.startsWith('plot:')), [...byId.keys()].join(','));
  });

  // 预算充裕时整章正文已含结尾，P0 的结尾片段应被撤掉以免重复。
  test('整章正文注入后结尾片段被撤销', () => {
    assert.equal(byId.get('prevTail:3').status, 'dropped');
  });

  test('撤销原因写明了重复', () => {
    assert.ok(byId.get('prevTail:3').note.includes('无需重复'));
  });

  test('第 3 章正文标注为接续点', () => {
    assert.ok(byId.get('manuscriptFull:3').note.includes('续写将从此处接续'));
  });

  test('上一章结尾在 prompt 中只出现一次', () => {
    const occurrences = built.messages[1].content.split('雨已经停了。窗外月亮出来').length - 1;
    assert.equal(occurrences, 1);
  });

  test('user 含接续指示', () => {
    assert.ok(built.messages[1].content.includes('无缝接下去'));
  });

  test('要求里点名的角色 林昭', () => {
    assert.ok(inc('character:林昭'));
  });

  test('要求里点名的角色 沈氏', () => {
    assert.ok(inc('character:沈氏'));
  });

  test('要求里点名的角色 年轻守卫', () => {
    assert.ok(inc('character:年轻守卫'));
  });

  test('命中角色带命中原因', () => {
    assert.ok(byId.get('character:沈氏').note.includes('沈氏'));
  });

  test('设定「崖字令牌」被关键词命中', () => {
    assert.ok(inc('lore:崖字令牌'), '要求里含「令牌」');
  });

  test('设定「青崖镇」未被误命中', () => {
    assert.ok(!inc('lore:青崖镇'), '要求里不含青崖/停舟');
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

  test('user 含这一轮的要求', () => {
    assert.ok(built.messages[1].content.includes(ASK));
  });

  // 正文层的依据是细纲，作者这一句是补充要求——从前这里叫「本段剧情纲要」，
  // 那是细纲还不存在时的说法。
  test('要求那一段的小标题是「这一章的补充要求」', () => {
    assert.ok(built.messages[1].content.includes('# 这一章的补充要求'), built.messages[1].content.slice(-600));
  });

  test('user 含目标字数', () => {
    assert.ok(built.messages[1].content.includes('2000 字'));
  });

  test('正文原文确实在 user 里', () => {
    assert.ok(built.messages[1].content.includes('三更，林昭醒了'), '第 3 章正文');
  });

  test('前文正文按由远及近排列', () => {
    const user = built.messages[1].content;
    assert.ok(user.indexOf('【第 2 章') < user.indexOf('【第 3 章'));
  });
});

// ---------------------------------------------------------------------------

// 预算阈值由实测的条目大小反推，避免示例文本长度变化后测试失效。
// 注意要把 P0~P2 已占用的量都算进去，否则轮到 P3 时剩余预算不是预期值。
describe('装配：预算刚好放不下整章正文（应降级为摘要）', () => {
  let deg;
  let dById;
  let item;

  before(async () => {
    // 关掉结尾片段，单独考察 manuscriptFull 的降级链。
    const mid = p3SummaryTokens + Math.floor((p3Full - p3SummaryTokens) / 2);
    const window = upToP2Tokens + mid + 2000 + 512;
    const cfg = { ...baseConfig, prevChapterTailChars: 0, maxOutputTokens: 2000, contextWindow: window };
    deg = await builderMod.buildContext(project, req(ASK), cfg);
    dById = ids(deg);
    item = dById.get('manuscriptFull:3');
  });

  test('结尾片段已关闭时不注入 prevTail', () => {
    assert.ok(!dById.has('prevTail:3'));
  });

  test('第 3 章正文降级为摘要', () => {
    assert.equal(
      item.status,
      'degraded',
      `full=${p3Full}, summary=${p3SummaryTokens}, budget=${deg.budget}, note=${item.note}`
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
    assert.ok(item.tokens < p3Full, `${item.tokens} vs ${p3Full}`);
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
    small = await builderMod.buildContext(project, req(ASK), tight);
    sById = ids(small);
    degradedOrDropped = small.items.filter((i) => i.status === 'degraded' || i.status === 'dropped');
  });

  test('P0 这一轮的要求仍然注入', () => {
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

  test('预算不足时整章正文不与结尾片段合并', () => {
    assert.equal(sById.get('manuscriptFull:3').status, 'dropped');
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
      req(ASK, { excludedIds: ['style', 'character:沈氏', 'manuscriptFull:2'] }),
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

  test('第 2 章正文被标记 excluded', () => {
    assert.equal(eById.get('manuscriptFull:2').status, 'excluded');
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
      req(ASK, { providerMaxInputTokens: 8000 }),
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
      req(ASK, {
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
    // target 里没有路径可认章号（老会话、手搓的请求）时，靠 targetNo 定位前文边界。
    first = await builderMod.buildContext(
      project,
      req('开篇：主角进城。', { target: { kind: 'manuscript', plotRelPath: '' }, targetNo: 1 }),
      baseConfig
    );
    fById = ids(first);
  });

  test('无前一章时不注入 prevTail', () => {
    assert.ok(![...fById.keys()].some((k) => k.startsWith('prevTail:')));
  });

  test('无前文时不注入正文原文', () => {
    assert.ok(![...fById.keys()].some((k) => k.startsWith('manuscriptFull:')));
  });

  test('仍然注入系统提示与这一轮的要求', () => {
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

describe('装配：接着写第 3 章（target 指向它自己）', () => {
  let aById;

  before(async () => {
    // 接着写已经落盘的第 3 章：target 指向它自己，章号由磁盘上的细纲决定。
    const append = await builderMod.buildContext(
      project,
      req('接着写下去。', { target: { kind: 'manuscript', plotRelPath: PLOT3 } }),
      baseConfig
    );
    aById = ids(append);
  });

  test('前文只取到第 2 章', () => {
    assert.ok(aById.has('prevTail:2') && !aById.has('prevTail:3'));
  });

  test('第 3 章自身不作为前文注入', () => {
    assert.ok(!aById.has('manuscriptFull:3'));
  });

  test('第 3 章的细纲作为写作依据注入', () => {
    assert.equal(aById.get(`plot:${PLOT3}`).status, 'included');
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
          { id: 'sel1', kind: 'selection', label: '003-夜访.md:5-9',
            relPath: CH3,
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
    assert.ok(att.items.some((i) => i.kind === 'manuscriptFull' && i.status !== 'dropped'));
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

describe('装配：已写入的产物不随历史回灌（五期补遗 §1.4）', () => {
  // 跟着主按钮写完第 1 章、写入；又讨论了一句；这一轮写第 2 章。
  const history = [
    { id: 'w1', role: 'user', content: '多写点雪。', command: '写正文', at: '2026-08-01T10:00:00Z' },
    { id: 'w2', role: 'assistant', content: '雪下了一夜。第 1 章正文全文……', acceptedTo: 'chapters/001-夜入青云.md', at: '2026-08-01T10:01:00Z' },
    { id: 'd1', role: 'user', content: '第 2 章要不要让沈氏先开口？', at: '2026-08-01T10:02:00Z' },
    { id: 'd2', role: 'assistant', content: '可以，让她先问残令的下落。', at: '2026-08-01T10:03:00Z' },
    { id: 'x1', role: 'user', content: '再来一版。', command: '写正文', at: '2026-08-01T10:04:00Z' },
    { id: 'x2', role: 'assistant', content: '没采纳的那一版正文……', artifact: { where: '第 1 章', summary: '正文', overwrites: true, declined: true }, at: '2026-08-01T10:05:00Z' },
  ];
  let conv;
  let m;

  before(async () => {
    conv = await builderMod.buildContext(project, req('写第 2 章。', { history }), baseConfig);
    m = ids(conv);
  });

  test('写入了的那一轮与发起它的命令都不带，明细里说清落在哪', () => {
    assert.equal(m.get('history:w2').status, 'dropped');
    assert.match(m.get('history:w2').note, /已写入「chapters\/001-夜入青云\.md」，以磁盘上那一份为准/);
    assert.equal(m.get('history:w1').status, 'dropped');
    assert.match(m.get('history:w1').note, /产物已写入/);
  });

  test('讨论与没采纳的那一版照旧带', () => {
    for (const id of ['d1', 'd2', 'x1', 'x2']) {
      assert.equal(m.get(`history:${id}`).status, 'included', id);
    }
  });

  test('messages 里没有写入了的那份正文', () => {
    assert.ok(!conv.messages.some((x) => x.content.includes('第 1 章正文全文')));
    assert.ok(conv.messages.some((x) => x.content === '没采纳的那一版正文……'));
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
    assert.ok(conv.items.some((i) => i.kind === 'manuscriptFull' && i.status !== 'dropped'));
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

  // 发生什么由细纲定，正文层只管怎么写——讨论时也是这个身份。
  test('系统提示写明本层职责', () => {
    assert.ok(d.messages[0].content.includes('发生什么不由你决定'), d.messages[0].content.slice(0, 200));
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

  test('discuss 仍注入文风与角色', () => {
    assert.ok(last.includes('# 文风指南') && last.includes('# 相关角色设定'));
  });

  test('write 模式仍要求只输出正文', () => {
    assert.ok(writeMode.messages[0].content.includes('只输出正文'));
  });
});

// ---------------------------------------------------------------------------

/**
 * 四阶段配方：架构 → 大纲 → 细纲 → 正文（context/recipes.ts）。
 *
 * 卷那一层删掉之后配方换成这四张。每一档钉的都是「这一层该带什么、不该带什么」，
 * 而不是「装配器能不能跑」：
 *
 * - **架构层**带 `settingDocs`（P0 force）：四件一件吃一件，前提要照着配置写、世界观
 *   要照着前提与角色写，少了上一件，这一件就是凭空编的。它**不看正文**——这一层在
 *   第一章之前，也不该被已经写出来的东西带着走。
 * - **大纲层**看全局：架构三件 + 大纲全文 + 全书摘要，不读正文原文。
 * - **细纲层**看这一章在大纲里的位置、前几章排到哪（上文）、下一章要接到哪（下文），
 *   不读正文原文——排细纲要的是走向，不是措辞。
 * - **正文层**的 `plotSelf` 与文风指南都是 P0 force：细纲**就是**写正文的依据，
 *   文风是「读者感觉不到换人执笔」的唯一保障。
 */
describe('装配：四阶段配方', () => {
  let sc;
  let sIds;
  let sq;
  let sqIds;
  let sx;
  let sxIds;
  let sChars;
  let sConfig;
  let oc;
  let oIds;
  let og;
  let pc;
  let pIds;
  let pg;
  let mcSame;
  let mc;
  let mIds;
  let squeezed;
  let qIds;
  const SETTING_IDS = ['setting:config', 'setting:premise', 'setting:world'];
  const tiny = { ...baseConfig, contextWindow: 3000, maxOutputTokens: 2000 };
  const alive = (m, id) => m.has(id) && m.get(id).status !== 'dropped' && m.get(id).status !== 'excluded';
  const fullTokens = (b) => b.items.filter((i) => i.kind === 'manuscriptFull').reduce((s, i) => s + i.tokens, 0);
  const lastOf = (b) => b.messages[b.messages.length - 1].content;
  const keysOf = (m, prefix) => [...m.keys()].filter((k) => k.startsWith(prefix));
  const build = (request, cfg = baseConfig) => builderMod.buildContext(project, request, cfg);
  const settingReq = (doc, extra = {}) => ({
    action: { stage: 'setting', capability: 'generate' },
    target: { kind: 'setting', doc },
    ask: '前提要更狠一点。',
    ...extra,
  });

  before(async () => {
    // ------------------------------------------------------------ 架构阶段
    sc = await build(settingReq('premise'));
    sIds = ids(sc);
    sq = await build(settingReq('premise'), tiny);
    sqIds = ids(sq);
    sx = await build(settingReq('premise', { excludedIds: ['setting:premise'] }));
    sxIds = ids(sx);
    sChars = await build(settingReq('characters', { ask: '' }));
    sConfig = await build(settingReq('config', { ask: '悬疑武侠' }));

    // ------------------------------------------------------------ 大纲阶段
    oc = await build({
      action: { stage: 'outline', capability: 'discuss' },
      target: { kind: 'outline' },
      ask: '第一幕的冲突升级够不够？',
    });
    oIds = ids(oc);
    og = await build({
      action: { stage: 'outline', capability: 'generate' },
      target: { kind: 'outline' },
      ask: '续写第二幕。',
    });

    // ------------------------------------------------------------ 细纲阶段
    // 选第 2 章：它前后都有细纲，上文与下文两层才都有东西可装。
    pc = await build({
      action: { stage: 'plot', capability: 'discuss' },
      target: { kind: 'plot', plotRelPath: PLOT2 },
      ask: '这一章的节奏是不是太平？',
    });
    pIds = ids(pc);
    pg = await build({
      action: { stage: 'plot', capability: 'generate' },
      target: { kind: 'plot', plotRelPath: PLOT2 },
      ask: '沈氏的试探再狠一点。',
      targetWords: 650,
    });
    // 同一个问题，正文阶段要为前几章的整章正文付钱，细纲阶段一个字都不付。
    mcSame = await build({
      action: WRITE,
      target: { kind: 'manuscript', plotRelPath: PLOT2 },
      ask: '这一章的节奏是不是太平？',
    });

    // ------------------------------------------------------------ 正文阶段
    mc = await build({
      action: WRITE,
      target: { kind: 'manuscript', plotRelPath: PLOT3 },
      ask: '多写一点雨停之后的静。',
      targetWords: 1200,
    });
    mIds = ids(mc);
    squeezed = await build({ action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT3 }, ask: '继续。' }, tiny);
    qIds = ids(squeezed);
  });

  // ------------------------------------------------------------ 架构

  test('架构阶段身份是网文策划编辑', () => {
    assert.ok(sc.messages[0].content.includes('资深网文策划编辑'), sc.messages[0].content.slice(0, 40));
  });

  test('架构阶段说清不排章节、不写正文', () => {
    assert.ok(sc.messages[0].content.includes('你不排章节，也不写正文'), sc.messages[0].content.slice(0, 400));
  });

  // ★ 这一层的全部依据。正在生成的那一件（前提）也照带：目标已有内容时，
  //   那一版就是修改的底稿。
  test('★ 架构三件都带上了', () => {
    assert.ok(SETTING_IDS.every((id) => alive(sIds, id)), keysOf(sIds, 'setting:').join(','));
  });

  test('架构三件是 P0', () => {
    assert.ok(SETTING_IDS.every((id) => sIds.get(id).priority === 0));
  });

  test('架构三件进了「# 故事架构」段', () => {
    const user = lastOf(sc);
    assert.ok(user.includes('# 故事架构') && user.includes('【故事前提】'), user.slice(0, 200));
    assert.ok(user.includes('林昭带着一块残缺'), '配置的核心梗概应在里面');
  });

  test('架构阶段带上已有的角色', () => {
    assert.ok(alive(sIds, 'character:林昭'), keysOf(sIds, 'character:').join(','));
  });

  test('架构阶段不带任何正文原文', () => {
    assert.ok(
      keysOf(sIds, 'manuscriptFull:').length === 0 && keysOf(sIds, 'prevTail:').length === 0,
      [...sIds.keys()].join(',')
    );
  });

  test('架构阶段也不带摘要（不被已经写出来的东西带着走）', () => {
    assert.ok(keysOf(sIds, 'plotSummary:').length === 0 && !sIds.has('globalSummary'), [...sIds.keys()].join(','));
  });

  // ★ 预算紧到只剩强制项时它们必须仍然在：少了上一件，这一件就是凭空编的。
  test('★ 预算极小时架构三件仍强制注入', () => {
    assert.ok(
      SETTING_IDS.every((id) => sqIds.get(id).status === 'included'),
      JSON.stringify(SETTING_IDS.map((id) => sqIds.get(id)?.status))
    );
  });

  test('预算极小时挤掉的是角色与大纲，且写明原因', () => {
    const lost = sq.items.filter((i) => i.status === 'dropped');
    assert.ok(lost.some((i) => i.kind === 'character') && lost.every((i) => i.note), JSON.stringify(lost.map((i) => i.id)));
  });

  // 一件一条：重写前提时作者可能不想让旧前提带偏模型。
  test('架构文档一件一条，可以单独取消', () => {
    assert.equal(sxIds.get('setting:premise').status, 'excluded');
    assert.ok(!lastOf(sx).includes('【故事前提】') && lastOf(sx).includes('【小说配置】'));
  });

  test('输出契约按这一件的小节来', () => {
    const user = lastOf(sc);
    assert.ok(user.includes('「故事前提」') && user.includes('## 核心冲突链') && user.includes('## 悬念骨架'), user.slice(-500));
  });

  // 角色图谱分两步（上游 AI-Novel-Writer 的两段式）：第一步只出一张身份清单。
  test('角色图谱第一步的契约是身份清单', () => {
    const user = lastOf(sChars);
    assert.ok(user.includes('角色图谱') && user.includes('{"slots":[...]}') && user.includes('narrativeDuty'), user.slice(-600));
  });

  // ★ 上游内置模板里的这段设计原则从来没发出去过（只发 taskGuidance）。这里补上。
  test('★ 角色图谱带上设计原则：盟友、对手、避免脸谱化', () => {
    const user = lastOf(sChars);
    assert.ok(
      user.includes('至少 1 位与主角有深度羁绊的盟友') && user.includes('至少 1 位与主角理念对立的竞争者') && user.includes('切忌脸谱化'),
      user.slice(-1600)
    );
  });

  // 「全局要求」会被每一章读一遍：逐章大纲写在这里是最贵的越界。
  test('小说配置的契约禁止逐章列大纲', () => {
    assert.ok(lastOf(sConfig).includes('不要逐章列大纲'), lastOf(sConfig).slice(-500));
  });

  test('架构阶段不写「只输出正文」', () => {
    assert.ok(!sc.messages[0].content.includes('只输出正文'));
  });

  // ------------------------------------------------------------ 大纲

  test('大纲阶段身份是长篇策划编辑', () => {
    assert.ok(oc.messages[0].content.includes('资深长篇小说策划编辑'), oc.messages[0].content.slice(0, 40));
  });

  test('大纲阶段注入大纲全文（P0）', () => {
    assert.ok(alive(oIds, 'outlineDoc'));
    assert.equal(oIds.get('outlineDoc').priority, 0);
  });

  test('大纲全文进了「# 情节大纲」段', () => {
    const user = lastOf(oc);
    assert.ok(user.includes('# 情节大纲') && user.includes('第1–10章：第一幕 · 停舟'), user.slice(0, 400));
  });

  test('大纲阶段带架构三件（P0）', () => {
    assert.ok(SETTING_IDS.every((id) => alive(oIds, id) && oIds.get(id).priority === 0), keysOf(oIds, 'setting:').join(','));
  });

  // 这是分阶段装配最直接的成本收益：讨论故事结构时不该读三章正文。
  test('大纲阶段不带任何正文原文', () => {
    assert.ok(keysOf(oIds, 'manuscriptFull:').length === 0, keysOf(oIds, 'manuscriptFull:').join(','));
  });

  test('大纲阶段全书摘要都在', () => {
    assert.ok(
      [1, 2, 3].every((n) => alive(oIds, `plotSummary:${n}`)),
      keysOf(oIds, 'plotSummary:').join(',')
    );
  });

  test('大纲阶段不写「只输出正文」', () => {
    assert.ok(!oc.messages[0].content.includes('只输出正文'));
  });

  test('大纲的输出契约要求按章号区间分节', () => {
    assert.ok(lastOf(og).includes('按章号区间分节'), lastOf(og).slice(-400));
  });

  // ------------------------------------------------------------ 细纲

  test('细纲阶段身份是剧情编剧', () => {
    assert.ok(pc.messages[0].content.includes('剧情编剧'), pc.messages[0].content.slice(0, 24));
  });

  // ★ 一章一纲的落点：从前这一层禁止写画面、只许写抽象的因果链，跑出来的正文是
  //   梗概体的流水账。现在「关键事件」可以写到具体场面。
  test('★ 细纲可以写具体场面（不再禁止写画面）', () => {
    const system = pc.messages[0].content;
    assert.ok(system.includes('关键事件可以写具体场面'), system.slice(0, 500));
    assert.ok(!system.includes('不写画面'), system.slice(0, 500));
  });

  test('但细纲仍然不是正文', () => {
    assert.ok(pc.messages[0].content.includes('不是正文'), pc.messages[0].content.slice(0, 500));
  });

  test('细纲阶段注入本章细纲（P0）', () => {
    assert.ok(alive(pIds, `plot:${PLOT2}`));
    assert.equal(pIds.get(`plot:${PLOT2}`).priority, 0);
  });

  test('注入上一章细纲（上文）', () => {
    assert.ok(alive(pIds, `plot:${PLOT1}`) && pIds.get(`plot:${PLOT1}`).label.includes('上文'), keysOf(pIds, 'plot:').join(','));
  });

  // ★ 少了它，改中间某一章时模型不知道后面已经排好了什么，收尾会与下一章的开头
  //   撞车或断裂——「转折突兀」多半出在这里。
  test('★ 注入下一章细纲（下文）', () => {
    assert.ok(alive(pIds, `plot:${PLOT3}`) && pIds.get(`plot:${PLOT3}`).label.includes('下文'), keysOf(pIds, 'plot:').join(','));
  });

  // 前后章只注入两节：上文要「发生了什么、留下了什么悬念」，下文要「要去哪、要发生什么」。
  test('上文只给关键事件与章末钩子', () => {
    const text = pIds.get(`plot:${PLOT1}`).text;
    assert.ok(text.includes('关键事件：') && text.includes('章末钩子：') && !text.includes('本章目的：'), text);
  });

  test('下文只给本章目的与关键事件', () => {
    const text = pIds.get(`plot:${PLOT3}`).text;
    assert.ok(text.includes('本章目的：') && text.includes('关键事件：') && !text.includes('章末钩子：'), text);
  });

  test('三份细纲都进了「# 细纲」段', () => {
    const user = lastOf(pc);
    assert.ok(user.includes('# 细纲'), user.slice(-800));
    assert.ok(
      user.includes('【第 2 章《客栈里的女人》 · 细纲 ｜ 铺垫】') &&
        user.includes('【第 1 章《楔子》 · 上文】') &&
        user.includes('【第 3 章《夜访》 · 下文】'),
      user.slice(-1500)
    );
  });

  // 排第 2 章用不着全书大纲：只带覆盖它的那一节（总计划 §2.3）。
  test('细纲阶段只带大纲里覆盖本章的那一节', () => {
    assert.ok(alive(pIds, 'outlineSlice:2-2') && !pIds.has('outlineDoc'), keysOf(pIds, 'outline').join(','));
    assert.ok(pIds.get('outlineSlice:2-2').text.includes('第一幕'), pIds.get('outlineSlice:2-2').text);
  });

  // 细纲是从架构与大纲里拆出来的：设定四件在这一层也是 P0（总计划 §2.3）。
  test('细纲阶段带架构三件（P0）', () => {
    assert.ok(SETTING_IDS.every((id) => alive(pIds, id) && pIds.get(id).priority === 0), keysOf(pIds, 'setting:').join(','));
  });

  test('细纲阶段不带正文原文', () => {
    assert.ok(keysOf(pIds, 'manuscriptFull:').length === 0, keysOf(pIds, 'manuscriptFull:').join(','));
  });

  test('细纲阶段前文只到第 1 章', () => {
    assert.ok(alive(pIds, 'plotSummary:1') && !pIds.has('plotSummary:2') && !pIds.has('plotSummary:3'));
  });

  // 这里不比总量：示例工程一章才三四百字，省下的绝对值看不出来；
  // 真实工程一章三千字 × 近两章，差的就是一个数量级。
  test('正文阶段确实为整章正文花了 token', () => {
    assert.ok(fullTokens(mcSame) > 0, String(fullTokens(mcSame)));
  });

  test('细纲阶段一个字的正文都不花', () => {
    assert.equal(fullTokens(pc), 0);
  });

  // 单章也用批次合同的单项形式（第 22 条：两个入口契约一致），三个字段对到 D3 三节。
  test('细纲的输出契约是蓝图合同的单项形式', () => {
    const user = lastOf(pg);
    assert.ok(
      ['{"blueprints":[...]}', 'purpose', 'keyEvents', 'suspenseHook', '"chapterNumber":2'].every((k) => user.includes(k)),
      user.slice(-1600)
    );
  });

  test('契约要 role 与计划出场的人', () => {
    assert.ok(lastOf(pg).includes('"role":"…"') && lastOf(pg).includes('"characters":["…"]'), lastOf(pg).slice(-600));
  });

  test('契约说章末钩子必填', () => {
    assert.ok(lastOf(pg).includes('suspenseHook 始终必填'), lastOf(pg).slice(-1600));
  });

  // 容量合同（上游 DC:131-142）：单章按细纲自己的目标字数算 ±20%。
  test('给了目标字数时契约里有容量合同', () => {
    assert.ok(lastOf(pg).includes('每章正文目标约 650 字，可接受范围 520–780 字'), lastOf(pg).slice(-2400));
  });

  // ------------------------------------------------------------ 正文

  test('正文阶段仍带整章正文', () => {
    assert.ok(keysOf(mIds, 'manuscriptFull:').length > 0, [...mIds.keys()].join(','));
  });

  // ★ 细纲**就是**写正文的依据——所以它是 P0 force。
  //   少了它，模型手上只有文风与前文尾巴，会自己编一章出来。
  test('★ 正文阶段带本章细纲', () => {
    assert.ok(alive(mIds, `plot:${PLOT3}`), [...mIds.keys()].join(','));
  });

  test('正文阶段的本章细纲是 P0', () => {
    assert.equal(mIds.get(`plot:${PLOT3}`).priority, 0);
  });

  // 预算紧到只剩强制项时它必须仍然在：没有细纲的正文是凭空编的。
  test('预算极小时本章细纲仍强制注入', () => {
    assert.equal(qIds.get(`plot:${PLOT3}`).status, 'included', JSON.stringify(qIds.get(`plot:${PLOT3}`)));
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

  // 本层产物紧挨着指令：模型对末尾的东西最敏感，这一章的细纲该在它读完前文之后、
  // 读到「现在请你做什么」之前。
  test('本章细纲在前文之后、补充要求之前', () => {
    const user = lastOf(mc);
    const [full, plot, askAt] = ['# 前文正文', '# 细纲', '# 这一章的补充要求'].map((h) => user.indexOf(h));
    assert.ok(full >= 0 && full < plot && plot < askAt, `${full} / ${plot} / ${askAt}`);
  });

  // 三期：目标字数只在篇幅合同里说一次（±20%），从前另有一行「约 N 字（±15%）」，
  // 两个比例谁也分不清哪个算数。
  test('目标字数写进系统提示与篇幅合同', () => {
    assert.ok(mc.messages[0].content.includes('篇幅约 1200 字'), mc.messages[0].content);
    assert.ok(lastOf(mc).includes('目标 1200 字；可接受范围 960–1440 字（±20%）'), lastOf(mc).slice(-600));
    assert.ok(!lastOf(mc).includes('±15%'));
  });

  // 五期补遗 §1.5：民国背景的书里冒出 PTSD。正文与前面几个阶段的系统提示都带这一条。
  test('系统提示要求用词贴合年代（正文与细纲都有）', async () => {
    assert.match(mc.messages[0].content, /用词贴合故事的年代与世界观.*PTSD/);
    const plotCtx = await builderMod.buildContext(
      project,
      { action: { stage: 'plot', capability: 'generate' }, target: { kind: 'plot', plotRelPath: PLOT4 }, ask: '' },
      baseConfig
    );
    assert.match(plotCtx.messages[0].content, /4\. 用词贴合故事的年代与世界观/);
  });
});

// ---------------------------------------------------------------------------

/**
 * 架构三件「填过的才带」：模板里的占位（`（待补充）`）不是内容，送进 prompt 等于
 * 告诉模型「世界观：（待补充）」。文件整个不在也只是少一条，**绝不抛**（第 1 条）。
 */
describe('装配：架构文档填过的才带', () => {
  let fixture;
  let b;
  let bIds;

  before(async () => {
    fixture = copyFixture('builder-setting');
    fixture.write(
      '.novelforge/world.md',
      '---\ngeneratedBy: novel-forge\n---\n\n# 世界观\n\n## 规则与漏洞\n\n（待补充）\n\n## 阶层与资源\n\n（待补充）\n\n## 深层危机\n\n（待补充）\n'
    );
    fixture.remove('.novelforge/premise.md');
    const p = projectMod.NovelProject.open(fixture.dir);
    b = await builderMod.buildContext(
      p,
      { action: { stage: 'setting', capability: 'generate' }, target: { kind: 'setting', doc: 'world' }, ask: '' },
      baseConfig
    );
    bIds = ids(b);
  });

  after(() => cleanup(fixture.dir));

  test('只有占位的世界观不带', () => {
    assert.ok(!bIds.has('setting:world'), [...bIds.keys()].join(','));
  });

  test('文件不在的前提不带，也不抛', () => {
    assert.ok(!bIds.has('setting:premise'), [...bIds.keys()].join(','));
  });

  test('填过的配置照带', () => {
    assert.equal(bIds.get('setting:config').status, 'included');
  });

  test('占位文字没有进 prompt', () => {
    assert.ok(!b.messages[b.messages.length - 1].content.includes('（待补充）'));
  });
});

// ---------------------------------------------------------------------------

/**
 * 挑角色卡：**第一优先是本章细纲的 `characters[]`**（D13）。细纲里明写了这一章
 * 有谁，那比在作者那句话里做子串匹配准得多——作者说「接着写」，一个名字都没提，
 * 该出场的人仍然要在。其后才是这一轮的要求、前两章的摘要与主角。
 */
describe('装配：挑角色卡先看本章细纲的计划出场（D13）', () => {
  let plain;
  let pById;
  let named;
  let nById;
  let plotStage;
  const charIds = (b) => b.items.filter((i) => i.kind === 'character').map((i) => i.id);

  before(async () => {
    // 第 2 章细纲计划出场：林昭、沈氏。作者这一句一个名字都没提。
    plain = await builderMod.buildContext(
      project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT2 }, ask: '接着写。' },
      baseConfig
    );
    pById = ids(plain);
    named = await builderMod.buildContext(
      project,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: PLOT2 }, ask: '李叔也要露一面。' },
      baseConfig
    );
    nById = ids(named);
    plotStage = ids(
      await builderMod.buildContext(
        project,
        { action: { stage: 'plot', capability: 'generate' }, target: { kind: 'plot', plotRelPath: PLOT2 }, ask: '重排一下。' },
        baseConfig
      )
    );
  });

  test('计划出场的人都带上了', () => {
    assert.ok(pById.get('character:林昭').status === 'included' && pById.get('character:沈氏').status === 'included');
  });

  test('原因写明是本章细纲计划出场', () => {
    assert.ok(pById.get('character:沈氏').note.includes('本章细纲计划出场'), pById.get('character:沈氏').note);
  });

  // 主角也在计划里时，原因说的是计划——那是更具体的依据。
  test('计划出场优先于「主角始终注入」', () => {
    assert.ok(pById.get('character:林昭').note.includes('本章细纲计划出场'), pById.get('character:林昭').note);
  });

  // 顺序即填充顺序：预算紧的时候，计划出场的人先拿到预算。
  test('计划出场的排在最前面', () => {
    assert.deepEqual(charIds(plain).slice(0, 2), ['character:林昭', 'character:沈氏']);
  });

  test('其余的仍按原有判据补上（前一章出场）', () => {
    assert.ok(pById.get('character:李叔').note.includes('第 1 章出场'), pById.get('character:李叔').note);
  });

  test('要求里点名的人排第二优先', () => {
    assert.ok(nById.get('character:李叔').note.includes('李叔'), nById.get('character:李叔').note);
    assert.deepEqual(charIds(named).slice(0, 3), ['character:林昭', 'character:沈氏', 'character:李叔']);
  });

  test('细纲层同样按计划出场挑', () => {
    assert.ok(plotStage.get('character:沈氏').note.includes('本章细纲计划出场'), plotStage.get('character:沈氏').note);
  });
});

// ---------------------------------------------------------------------------

/**
 * 「落定细纲」的历史封顶。
 *
 * `settle` 要沉淀的**就是那段对话**——按常规的 30% 装，一段聊了十几轮的讨论会
 * 被由远及近截掉开头，而开头往往正是定调子的地方。这是本次唯一的按能力
 * 调整装配策略，所以单独钉一条。
 */
describe('装配：落定细纲时历史保得住', () => {
  const many = [];
  for (let i = 1; i <= 40; i++) {
    many.push({
      id: `s${i}`,
      role: i % 2 === 1 ? 'user' : 'assistant',
      content: `第 ${i} 轮讨论的内容。`.repeat(60),
      at: '2026-08-01T10:00:00Z',
    });
  }
  const cfg = { ...baseConfig, contextWindow: 40000 };
  let settle;
  let generate;
  const historyTokens = (b) =>
    b.items
      .filter((i) => i.kind === 'history' && (i.status === 'included' || i.status === 'degraded'))
      .reduce((s, i) => s + i.tokens, 0);

  before(async () => {
    const base = {
      target: { kind: 'plot', plotRelPath: PLOT3 },
      ask: '按刚才讨论的落定。',
      history: many,
    };
    settle = await builderMod.buildContext(
      project,
      { ...base, action: { stage: 'plot', capability: 'settle' } },
      cfg
    );
    generate = await builderMod.buildContext(
      project,
      { ...base, action: { stage: 'plot', capability: 'generate' } },
      cfg
    );
  });

  test('落定时历史优先级抬到 P0', () => {
    assert.equal(ids(settle).get('history:s40').priority, 0);
  });

  test('写细纲时历史仍是 P1', () => {
    assert.equal(ids(generate).get('history:s40').priority, 1);
  });

  test('落定装进去的历史比写细纲多', () => {
    assert.ok(
      historyTokens(settle) > historyTokens(generate),
      `settle=${historyTokens(settle)} generate=${historyTokens(generate)}`
    );
  });

  test('落定的历史封顶是 60%', () => {
    assert.ok(
      historyTokens(settle) <= Math.floor(settle.budget * 0.6) + 5,
      `${historyTokens(settle)} / ${settle.budget}`
    );
  });

  test('写细纲的历史封顶仍是 30%', () => {
    assert.ok(
      historyTokens(generate) <= Math.floor(generate.budget * 0.3) + 5,
      `${historyTokens(generate)} / ${generate.budget}`
    );
  });

  // 不抬到 100%：大纲与本章细纲仍然要带，不然模型会把讨论里没提到的
  // 既有设定重新发明一遍。
  test('落定仍带上本章细纲', () => {
    assert.notEqual(ids(settle).get(`plot:${PLOT3}`).status, 'dropped');
  });

  // 两条路产出的是同一种产物，所以**输出契约相同**；差别在系统提示里的
  // 「以哪边为准」——一条从作者的描述出发，一条从刚发生过的讨论出发。
  // 说不清这一点，模型会把两者混着编。
  test('两条路的输出契约相同（产物是同一种）', () => {
    const s = settle.messages[settle.messages.length - 1].content;
    const g = generate.messages[generate.messages.length - 1].content;
    assert.equal(s.slice(-400), g.slice(-400));
  });

  test('两条路的系统提示不同', () => {
    assert.notEqual(settle.messages[0].content, generate.messages[0].content);
  });

  test('落定的系统提示说「以讨论里定下的为准」', () => {
    assert.ok(settle.messages[0].content.includes('讨论'), settle.messages[0].content.slice(0, 600));
  });

  test('落定明说不要塞进被否掉的方案', () => {
    assert.ok(settle.messages[0].content.includes('否掉'), settle.messages[0].content.slice(0, 600));
  });

  test('写细纲的系统提示说「按他说的产出」', () => {
    assert.ok(generate.messages[0].content.includes('按他说的产出'), generate.messages[0].content.slice(0, 600));
  });
});

// ---------------------------------------------------------------------------

/**
 * 没写正文的早期章退化成「只带本章目的」。
 *
 * 作者常常先把一批细纲排完再回头写，那些章没有正文也就没有摘要——直接跳过
 * 的话，写第 60 章时模型对前面几章一无所知，却看不出少了什么（AGENTS.md 第 2 条：
 * 不静默截断）。
 */
describe('装配：没写正文的章退化成只带本章目的', () => {
  let fixture;
  let degProject;
  let b;
  let item;

  before(async () => {
    fixture = copyFixture('builder-goalonly');
    degProject = projectMod.NovelProject.open(fixture.dir);
    // 建一章只排了细纲、没写正文的第 4 章，然后从第 5 章的位置装配。
    await wsOf(degProject).writePlot({
      no: 4,
      title: '第三块令牌',
      role: '转折',
      characters: ['林昭', '年轻守卫'],
      upstreamHash: '',
      done: false,
      sections: {
        本章目的: '林昭见到年轻守卫的母亲，第三块令牌现身。',
        关键事件: '天亮后两人上山，母亲拿出令牌，却说不出它的来路。',
        章末钩子: '母亲认出了林昭。',
      },
    });
    degProject.invalidate();
    b = await builderMod.buildContext(
      degProject,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: '.novelforge/plots/005.md' }, ask: '接着写。' },
      baseConfig
    );
    item = ids(b).get('plotSummary:4');
  });

  after(() => cleanup(fixture.dir));

  test('没正文的章仍出现在明细里', () => {
    assert.ok(!!item, [...ids(b).keys()].filter((k) => k.startsWith('plotSummary:')).join(','));
  });

  test('标为 degraded 而不是悄悄跳过', () => {
    assert.equal(item.status, 'degraded', JSON.stringify(item));
  });

  test('注明了退化原因', () => {
    assert.ok(item.note.includes('还没写正文'), item.note);
  });

  test('带的是「本章目的」那一节', () => {
    assert.ok(item.text.includes('第三块令牌现身'), item.text);
  });

  test('不带关键事件（那是给细纲层看的）', () => {
    assert.ok(!item.text.includes('天亮后两人上山'), item.text);
  });

  test('退化后的内容进了 messages', () => {
    assert.ok(b.messages[1].content.includes('第三块令牌现身'));
  });

  // 第 4 章还没写，第 5 章不该「从第 3 章结尾无缝接下去」——那等于让模型跳过第 4 章
  // 的事件。builder.ts 的兜底提示只在「结尾片段被整章正文取代」时才说。
  test('前一章还没写时，不让模型从更早那一章的结尾无缝接下去', () => {
    assert.ok(!b.messages[1].content.includes('「第 3 章《夜访》」的结尾处无缝接下去'), b.messages[1].content.slice(-300));
  });
});

// ---------------------------------------------------------------------------

describe('工程页数据', () => {
  let tree;
  let plots;
  let characters;
  let lore;
  let lin2;
  let linStats;

  before(async () => {
    tree = await projectViewMod.buildProjectTree(project);
    plots = tree.plots;
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

  test('章数与磁盘一致', () => {
    assert.equal(plots.length, 3);
  });

  test('章节组是扁平列表', () => {
    assert.ok(plots.every((p) => typeof p.no === 'number' && !!p.relPath));
  });

  // 工程页正序展示（第 1 章在上），与文件名顺序一致。
  test('章按章号正序', () => {
    assert.equal(plots.map((p) => p.no).join(','), '1,2,3');
  });

  test('每一章都带阶段徽章', () => {
    assert.ok(plots.every((p) => !!p.stage), JSON.stringify(plots.map((p) => p.stage)));
  });

  // 流水线条三格：细纲 · 正文 · 定稿。
  test('每一章都带三段进度', () => {
    assert.ok(
      plots.every(
        (p) => p.progress && ['plot', 'manuscript', 'summary'].every((k) => typeof p.progress[k] === 'number')
      ),
      JSON.stringify(plots.map((p) => p.progress))
    );
  });

  // 示例工程的三章细纲、正文都在，也都定稿过 → 已完成。
  test('写完且摘要新鲜的章 → 已完成', () => {
    assert.ok(plots.every((p) => p.stage === 'done'), JSON.stringify(plots.map((p) => p.stage)));
  });

  test('总字数为各章之和', () => {
    assert.equal(tree.totalWords, plots.reduce((s, p) => s + p.wordCount, 0));
  });

  test('示例工程摘要都是新鲜的', () => {
    assert.ok(tree.staleCount === 0 && plots.every((p) => !p.stale));
  });

  // 前端画进度条要分母：staleCount + summarizedCount 必须等于有正文的章数。
  test('已总结数与过期数互补', () => {
    const withText = plots.filter((p) => p.chapterPath !== '').length;
    assert.equal(
      tree.staleCount + tree.summarizedCount,
      withText,
      `${tree.staleCount} + ${tree.summarizedCount} ≠ ${withText}`
    );
  });

  test('新鲜的章带摘要路径', () => {
    assert.ok(plots[0].summaryPath.endsWith('001-楔子.md'), plots[0].summaryPath);
  });

  test('写过的章带正文路径', () => {
    assert.equal(plots[0].chapterPath, CH1);
  });

  // 细纲号 = 章号：一行同时是细纲与正文的两面。
  test('同一行带着同号的细纲', () => {
    assert.ok(plots[0].plotPath === PLOT1 && plots[0].plotExists, JSON.stringify(plots[0]));
  });

  test('目标字数取细纲的 targetWords', () => {
    assert.equal(plots[1].targetWords, 650);
  });

  // 主路径指正文：点这一行打开的是作者真正在读的那份文字。
  test('主路径指向正文', () => {
    assert.equal(plots[0].relPath, plots[0].chapterPath);
  });

  test('没有上游改动（⟳）', () => {
    assert.ok(plots.every((p) => !p.upstreamStale), JSON.stringify(plots.map((p) => p.upstreamStale)));
  });

  // 架构四件与大纲都齐了、第 1–3 章写完，第 4 章还没有细纲 → 全书下一步是拆细纲。
  test('全书阶段是「拆细纲」', () => {
    assert.equal(tree.bookStage, 'plots', tree.bookStage);
  });

  test('下一个该写的是第 4 章', () => {
    assert.equal(tree.nextChapterNo, 4);
  });

  // 「故事架构」组：四件文档 + 情节大纲，顺序即生成顺序。
  test('故事架构组五行，顺序是 配置 → 前提 → 角色图谱 → 世界观 → 大纲', () => {
    assert.deepEqual(tree.architecture.map((r) => r.key), ['config', 'premise', 'characters', 'world', 'outline']);
  });

  test('示例工程的故事架构 5/5 都填过', () => {
    assert.ok(tree.architecture.every((r) => r.filled), JSON.stringify(tree.architecture));
  });

  test('角色图谱那一行报人数、指向角色目录', () => {
    const row = tree.architecture.find((r) => r.key === 'characters');
    assert.ok(row.detail === '4 人' && row.relPath === '.novelforge/characters', JSON.stringify(row));
  });

  test('情节大纲那一行报覆盖到第几章', () => {
    const row = tree.architecture.find((r) => r.key === 'outline');
    assert.equal(row.detail, '覆盖到第 30 章');
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

  test('给出各区的根目录', () => {
    assert.ok(
      tree.plotsRoot === '.novelforge/plots' && tree.chaptersRoot === 'chapters' &&
        tree.charactersRoot === '.novelforge/characters' && tree.loreRoot === '.novelforge/lore',
      [tree.plotsRoot, tree.chaptersRoot, tree.charactersRoot, tree.loreRoot].join(' ')
    );
  });

  // 出场人物：已建卡的挂 castByCard（按 relPath 索引），未建卡的进 cast。
  test('树上带摘要数', () => {
    assert.equal(tree.summaryCount, 3);
  });

  test('已建卡角色带出场统计', () => {
    assert.ok(!!linStats && linStats.plots.length > 0, JSON.stringify(linStats));
  });

  test('出场统计带人类可读描述', () => {
    assert.ok(
      linStats && linStats.detail.startsWith('第') && linStats.detail.endsWith('章'),
      linStats && linStats.detail
    );
  });

  // 示例工程的角色卡没有 updatedThrough，因此全部出场章都算「待更新」。
  test('从未更新过的卡 updatedThrough 为 0', () => {
    assert.ok(linStats && linStats.updatedThrough === 0);
  });

  test('待更新章数等于出场章数', () => {
    assert.ok(
      linStats && linStats.pending === linStats.plots.length,
      `${linStats && linStats.pending} vs ${linStats && linStats.plots.length}`
    );
  });

  test('未建卡人物单列在 cast 里', () => {
    assert.ok(tree.cast.length > 0, String(tree.cast.length));
  });

  test('cast 条目带名字与描述', () => {
    assert.ok(tree.cast.every((c) => c.name && c.detail && Array.isArray(c.plots)));
  });

  test('cast 里不含已建卡的角色', () => {
    assert.ok(
      !tree.cast.some((c) => characters.some((f) => f.label === c.name)),
      tree.cast.map((c) => c.name).join('、')
    );
  });

  test('全书摘要覆盖章数来自 manifest', () => {
    assert.equal(tree.globalSummaryThrough, 3);
  });

  test('元数据路径都在 .novelforge 下', () => {
    assert.ok(
      [tree.styleGuidePath, tree.outlinePath, tree.globalSummaryPath].every((p) => p.startsWith('.novelforge/')),
      [tree.styleGuidePath, tree.outlinePath, tree.globalSummaryPath].join(' ')
    );
  });

  // 改动正文后，对应那一章必须立刻显示为过期——这正是工程页存在的意义之一。
  describe('改动正文后立刻显示为过期', () => {
    let fixture;
    let dirty;
    let restored;
    const byNo = (list, no) => list.find((p) => p.no === no);

    before(async () => {
      fixture = copyFixture('builder-stale');
      const staleProject = projectMod.NovelProject.open(fixture.dir);
      const base = await projectViewMod.buildProjectTree(staleProject);
      // 摘要的上游是 chapters/ 下那份正文（指纹链的最后一环）。
      const target = path.join(fixture.dir, byNo(base.plots, 3).chapterPath);
      const backup = fs.readFileSync(target, 'utf8');

      fs.writeFileSync(target, `${backup}\n\n临时追加的一句话。\n`);
      staleProject.invalidate();
      dirty = await projectViewMod.buildProjectTree(staleProject);

      fs.writeFileSync(target, backup);
      staleProject.invalidate();
      restored = await projectViewMod.buildProjectTree(staleProject);
    });

    after(() => cleanup(fixture.dir));

    test('改正文后那一章标记为过期', () => {
      assert.equal(byNo(dirty.plots, 3).stale, true);
    });

    test('过期计数为 1', () => {
      assert.equal(dirty.staleCount, 1);
    });

    test('已总结计数跟着减 1', () => {
      assert.equal(dirty.summarizedCount, 2);
    });

    test('过期的章仍带旧摘要路径（可点开对照）', () => {
      assert.ok(byNo(dirty.plots, 3).summaryPath.endsWith('003-夜访.md'));
    });

    // 定稿的判据是「摘要在且不过期」：正文改过，这一章就不再算已完成。
    test('过期的章不再算已完成', () => {
      assert.notEqual(byNo(dirty.plots, 3).stage, 'done', byNo(dirty.plots, 3).stage);
    });

    test('其他章不受影响', () => {
      assert.ok(!byNo(dirty.plots, 1).stale && !byNo(dirty.plots, 2).stale);
    });

    test('还原后不再过期', () => {
      assert.equal(restored.staleCount, 0);
    });
  });
});

// ---------------------------------------------------------------------------

describe('出场人物索引', () => {
  // 示例工程刻意混了两种摘要：第 3 章带 frontmatter.cast（新格式），
  // 第 1、2 章没有（旧格式）。真实工程升级后就是这个样子，索引必须同时
  // 吃下两种，否则老章节的人会在角色页上凭空消失。
  let s3;
  let s1;
  let index;
  let lin;
  let linCard;

  before(async () => {
    s3 = await project.readSummary(CH3);
    s1 = await project.readSummary(CH1);
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

  test('林昭有出场章', () => {
    assert.ok(lin && lin.plots.length > 0, lin && lin.plots.join(','));
  });

  test('出场章升序去重', () => {
    assert.ok(lin && lin.plots.every((o, i, a) => i === 0 || o > a[i - 1]), lin && lin.plots.join(','));
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
    assert.ok(index.unknown.every((m, i, a) => i === 0 || a[i - 1].plots.length >= m.plots.length));
  });

  test('未建卡的人都带出场章', () => {
    assert.ok(index.unknown.every((m) => m.plots.length > 0));
  });

  test('已建卡与未建卡不重叠', () => {
    assert.ok(!index.unknown.some((u) => index.known.some((k) => k.card && k.card.name === u.name)));
  });

  test('示例工程没有名字冲突', () => {
    assert.equal(index.conflicts.length, 0, index.conflicts.map((c) => c.name).join('、'));
  });

  // appearancesOf 是「更新角色卡」取章的入口，必须与索引一致。
  test('appearancesOf 与索引一致', () => {
    assert.equal(castMod.appearancesOf(index, linCard).join(','), lin.plots.join(','));
  });

  test('查不到的角色返回空数组', () => {
    const missing = {
      slug: '不存在', name: '不存在', aliases: [], tags: [], appearsIn: [],
      relPath: 'x', body: '', sections: {},
    };
    assert.equal(castMod.appearancesOf(index, missing).length, 0);
  });

  test('describePlots 短列表全列', () => {
    assert.equal(castMod.describePlots([1, 2, 3]), '第 1、2、3 章');
  });

  test('describePlots 长列表折叠', () => {
    assert.equal(castMod.describePlots([1, 2, 3, 4, 5, 6, 7, 8]), '第 1、2、3、4、5、6 章等 8 章');
  });

  test('describePlots 空列表有说法', () => {
    assert.equal(castMod.describePlots([]), '未在摘要中出现');
  });
});

// ---------------------------------------------------------------------------

/**
 * D13 的另一半：细纲里的 `characters[]` 是**计划**出场，**只给装配器挑角色卡用**。
 * 出场统计只认摘要（第 14 条）——计划与实际混在一起，角色页上会冒出「第 4 章出场」
 * 而那一章其实还没写，或者计划里有、写的时候被删掉的人。
 */
describe('细纲的计划出场：装配时认别名，但不进出场统计（D13）', () => {
  let fixture;
  let p;
  let built4;
  let b4;
  let index;

  before(async () => {
    fixture = copyFixture('builder-planned');
    p = projectMod.NovelProject.open(fixture.dir);
    // 第 4 章只排了细纲：计划出场写的是别名「阿昭」，外加一个还没有卡的人。
    await wsOf(p).writePlot({
      no: 4,
      title: '第三块令牌',
      role: '转折',
      characters: ['阿昭', '陌生人甲'],
      upstreamHash: '',
      done: false,
      sections: {
        本章目的: '第三块令牌现身。',
        关键事件: '天亮后上山，母亲拿出令牌。',
        章末钩子: '母亲认出了他。',
      },
    });
    p.invalidate();
    built4 = await builderMod.buildContext(
      p,
      { action: WRITE, target: { kind: 'manuscript', plotRelPath: '.novelforge/plots/004-第三块令牌.md' }, ask: '写。' },
      baseConfig
    );
    b4 = ids(built4);
    index = await castMod.buildCastIndex(p);
  });

  after(() => cleanup(fixture.dir));

  test('计划出场写别名也认得到那张卡', () => {
    assert.ok(b4.get('character:林昭').note.includes('本章细纲计划出场'), b4.get('character:林昭').note);
  });

  // 没有卡的人不凭空造一条空卡进 prompt。
  test('没有卡的人不产生角色条目', () => {
    assert.ok(![...b4.keys()].some((k) => k.includes('陌生人甲')), [...b4.keys()].join(','));
  });

  test('没有卡的计划出场者不进「未建卡」列表', () => {
    assert.ok(!index.unknown.some((m) => m.name === '陌生人甲'), index.unknown.map((m) => m.name).join('、'));
  });

  test('计划出场不算进已建卡角色的出场章', () => {
    const lin = index.known.find((m) => m.card && m.card.name === '林昭');
    assert.ok(!lin.plots.includes(4), lin.plots.join(','));
  });
});

// ---------------------------------------------------------------------------

/**
 * 二期加的几层与移植过来的契约（AI-Novel-Writer 的配置 / 前提 / 角色图谱 / 世界观 /
 * 情节大纲 / 细纲批次）。示例工程：三幕、30 章 × 400 字，大纲三段区间，第 1–3 章细纲都在。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 结构指导 | 大纲层 P0 force 带按总章数算好的章号区间，并点明本批落在哪几段 |
 * | 角色图谱一览 | 架构后几件、大纲、细纲都知道「书里有谁、彼此什么关系」，不带完整角色卡 |
 * | 大纲续写 | 契约写明本次只写哪几章、前面的不许重写 |
 * | 细纲批次 | 没有「本章」：plotSelf / plotPrev 不出场，前序细纲一览全包，最后几章带钩子 |
 * | 拆半后的后一半 | 看得见前一半刚排好、还没落盘的那几章 |
 * | 链里的后几步 | 角色详情带冻结清单；紧凑重建写明上次哪里不合格 |
 */
describe('装配：二期的新层与移植的契约', () => {
  const build = (request) => builderMod.buildContext(project, request, baseConfig);
  const lastOf = (b) => b.messages[b.messages.length - 1].content;
  const GEN = (stage) => ({ stage, capability: 'generate' });
  let outline21;
  let batch;
  let bIds;
  let split;
  let details;
  let compact;
  let config;
  let world;

  before(async () => {
    outline21 = await build({ action: GEN('outline'), target: { kind: 'outline' }, ask: '', range: { from: 11, to: 25 } });
    batch = await build({
      action: GEN('plot'),
      target: { kind: 'plot', plotRelPath: PLOT4 },
      ask: '',
      range: { from: 4, to: 8 },
    });
    bIds = ids(batch);
    split = await build({
      action: GEN('plot'),
      target: { kind: 'plot', plotRelPath: '.novelforge/plots/006.md' },
      ask: '',
      range: { from: 6, to: 8 },
      draftPlots: [
        { no: 4, title: '第二块令牌', keyEvents: '林昭找到守卫的母亲。', suspenseHook: '她说令牌共有五块。' },
        { no: 5, title: '雨夜', keyEvents: '持牌人坠井。', suspenseHook: '井边有沈氏的簪子。' },
      ],
    });
    details = await build({
      action: GEN('setting'),
      target: { kind: 'setting', doc: 'characters' },
      ask: '',
      step: { kind: 'rosterDetails', manifest: '{"slots":[{"slotId":"1","name":"林昭"}]}', slotIds: ['1'], done: '' },
    });
    compact = await build({
      action: GEN('plot'),
      target: { kind: 'plot', plotRelPath: PLOT4 },
      ask: '',
      range: { from: 4, to: 4 },
      step: { kind: 'blueprintCompact', diagnostic: 'blueprints[0].suspenseHook 是空的' },
    });
    config = await build({
      action: GEN('setting'),
      target: { kind: 'setting', doc: 'config' },
      ask: '一个从火里活下来的人回到起火的地方。',
      setup: { totalChapters: 100, wordsPerChapter: 3000 },
    });
    world = await build({ action: GEN('setting'), target: { kind: 'setting', doc: 'world' }, ask: '' });
  });

  // ------------------------------------------------------------ 结构指导

  test('★ 大纲层带故事结构指导（P0 force），按 30 章算好区间', () => {
    const item = ids(outline21).get('structure');
    assert.ok(item && item.status === 'included' && item.priority === 0, JSON.stringify(item));
    assert.ok(item.text.includes('第一幕 · 建置（第 1–6 章）') && item.text.includes('第三幕 · 高潮与结局（第 24–30 章）'), item.text);
    assert.ok(lastOf(outline21).includes('# 故事结构指导'));
  });

  test('结构指导点明本批落在哪几段', () => {
    assert.ok(ids(outline21).get('structure').text.includes('本次只写第 11–25 章，它们落在：第二幕'), ids(outline21).get('structure').text);
  });

  test('续写大纲：契约写明本次范围，前面的不许重写', () => {
    const user = lastOf(outline21);
    assert.ok(user.includes('本次必须对第 11–25 章输出完整详细的情节大纲（全书共 30 章）'), user.slice(-2000));
    assert.ok(user.includes('第 1–10 章的大纲已在上面的「情节大纲」中给出：不得重复、改写或复述'), user.slice(-2000));
    assert.ok(user.includes('第 26 章以后本次不写'), user.slice(-2000));
  });

  test('没写总章数时不带结构指导，并在明细里说为什么', async () => {
    const fixture = copyFixture('builder-nototal');
    try {
      const cfg = fs.readFileSync(path.join(fixture.dir, '.novelforge/config.md'), 'utf8').replace(/^totalChapters: .*\r?\n/m, '');
      fixture.write('.novelforge/config.md', cfg);
      const p = projectMod.NovelProject.open(fixture.dir);
      const b = await builderMod.buildContext(p, { action: GEN('outline'), target: { kind: 'outline' }, ask: '' }, baseConfig);
      const item = ids(b).get('structure');
      assert.ok(item.status === 'dropped' && /总章数/.test(item.note), JSON.stringify(item));
    } finally {
      cleanup(fixture.dir);
    }
  });

  // ------------------------------------------------------------ 角色图谱一览

  test('世界观那一件带角色图谱一览：一人一段，写明截短', () => {
    const roster = ids(world).get('roster');
    assert.ok(roster && roster.status === 'included' && roster.priority === 0, JSON.stringify(roster));
    assert.ok(roster.text.startsWith('【角色图谱】') && roster.text.includes('- 林昭') && roster.note, roster.text);
    assert.ok(lastOf(world).includes('# 故事架构'));
  });

  test('世界观契约：三节对上 world.md，自带冲突点', () => {
    const user = lastOf(world);
    assert.ok(['## 规则与漏洞', '## 阶层与资源', '## 深层危机', '自带冲突点'].every((k) => user.includes(k)), user.slice(-1400));
  });

  // ------------------------------------------------------------ 细纲批次

  test('★ 批次没有「本章」：不带区间第一章的细纲，也不带上文细纲', () => {
    assert.ok(!bIds.has(`plot:${PLOT4}`) && ![PLOT1, PLOT2, PLOT3].some((p) => bIds.has(`plot:${p}`)), [...bIds.keys()].join(','));
  });

  test('★ 前序细纲一览全包：最后几章带章末钩子', () => {
    const list = bIds.get('plotList');
    assert.ok(list && list.status === 'included', JSON.stringify(list));
    const lines = list.text.split('\n');
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => l.includes('｜章末钩子：')), list.text);
    assert.ok(lastOf(batch).includes('# 前序细纲一览（已生成的目录进度）'));
  });

  test('批次只带大纲里覆盖这几章的那一节', () => {
    assert.ok(bIds.has('outlineSlice:4-8') && bIds.get('outlineSlice:4-8').text.includes('第一幕 · 停舟'), [...bIds.keys()].join(','));
  });

  test('批次契约：覆盖第 4–8 章、容量按每章字数、钩子必填', () => {
    const user = lastOf(batch);
    assert.ok(user.includes('为接下来的第 4–8 章生成极其严密的「保姆级执行目录细纲」'), user.slice(-3000));
    assert.ok(user.includes('chapterNumber 必须覆盖第 4–8 章的每一章'), user.slice(-3000));
    assert.ok(user.includes('每章正文目标约 400 字，可接受范围 320–480 字'), user.slice(-3000));
    // 第 4 章起已经过了黄金三章。
    assert.ok(!user.includes('黄金三章法则') && user.includes('小高潮循环'), user.slice(-3000));
  });

  test('开篇那一批带黄金三章法则', async () => {
    const first = await build({ action: GEN('plot'), target: { kind: 'plot', plotRelPath: PLOT1 }, ask: '', range: { from: 1, to: 5 } });
    assert.ok(lastOf(first).includes('黄金三章法则') && lastOf(first).includes('这是全书开篇'), lastOf(first).slice(-3000));
  });

  test('拆半后的后一半看得见前一半刚排好、还没落盘的那几章', () => {
    const list = ids(split).get('plotList').text;
    assert.ok(list.includes('第4章 第二块令牌（刚排好，还没写入文件）') && list.includes('第5章 雨夜'), list);
    // 最后三章（第 3、4、5 章）带钩子：下一章要紧接着第 5 章往下排。
    assert.ok(list.includes('井边有沈氏的簪子'), list);
  });

  // ------------------------------------------------------------ 链里的后几步

  test('角色详情那一步带冻结清单与这一批的 slotId，禁止写关系', () => {
    const user = lastOf(details);
    assert.ok(user.includes('【冻结身份与关系清单】') && user.includes('"name":"林昭"') && user.includes('{"entries":[...]}'), user.slice(-1500));
    assert.ok(user.includes('禁止输出人物关系'), user.slice(-800));
  });

  test('紧凑重建写明上次哪里不合格，只要这一章', () => {
    const user = lastOf(compact);
    assert.ok(user.includes('blueprints[0].suspenseHook 是空的') && user.includes('必须且只能返回 chapterNumber=4 的一项'), user.slice(-800));
  });

  // ------------------------------------------------------------ 小说配置

  test('一句话发起的配置：规模按弹窗给的算，作者已有配置不许改写', () => {
    const user = lastOf(config);
    assert.ok(user.includes('# 我的脑洞') && user.includes('一个从火里活下来的人'), user.slice(-3500));
    assert.ok(user.includes('计划总章数：100 章') && user.includes('全书总字数约：100 × 3000 = 300000 字'), user.slice(0, 4000));
    assert.ok(user.includes('【作者已有配置】'), user.slice(-3500));
    assert.ok(user.includes('totalChapters 若输出必须严格等于 100'), user.slice(-1500));
    assert.ok(config.messages[0].content.includes('擅长从简短灵感中提炼完整、一致且可执行的小说配置'), config.messages[0].content.slice(0, 200));
  });
});
