/**
 * 完善设定三期（设计稿 §5、§6）：批量展开与写前提醒。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 待完善的 `authored` | 三节全是「（未交代）」却没盖过机器的章、明面空着只写了暗设的，标成作者写过（「全部展开」跳过）；空的、占位的、机器写的不标；`thinLoreFor` 只留要用到那几章的 |
 * | 全部展开 | 先报次数（每条 2 次、最多 4 次——2026-10-25 起写完转写一次，并发不改变这个数）与跳过谁；还没有条目的先按「设定」一节的分类建空条目；只写空的、占位的、机器写的；正文换成展开后的、记作机器写的、水位同整合；关键词只增不减、人名不收；子条目建空条目、不接着展开；还没定的问题不写进任何文件；作者写过的一个字不动 |
 * | 次数上限 | 转写不合格重转一次、整理不出来重写一次，两样不叠加（每条最多 4 次）；坏了语法的 JSON 交给转写理顺；被截断不重来；还不行算失败，挂在那一条上（第 16 条）；完成提示说清写了几条、跳过几条、失败几条 |
 * | 落盘前再认一遍 | 展开的这几十秒里作者写了字的，不写、说出来 |
 * | 没有能写的 | 全是作者写过的：不问、不调，说清去单条展开 |
 * | 拆完展开本批新设定 | 缺省不展开；选了就在拆完后按这一次新建的那几条再问一次次数，答了才展开；取消只是不展开 |
 * | 写前提醒 | 工作台正文目标上一句（零调用、不拦，与 ⟳ 分开）；写过字的、「设定」一节空着的、条目已经写够的不提；批量写章确认框多一行 |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');
const { outlineOf, writeOutline } = require('../../helpers/outline');

let bundle;
let h;
let fake;

const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-第${no}章.md`;
const PLOT = (no) => `.novelforge/summaries/${pad3(no)}-第${no}章.md`;
const LORE = '.novelforge/lore';
const TJG = `${LORE}/宗门/天机阁.md`;
const CJG = `${LORE}/宗门/藏经阁.md`;
const JCL = `${LORE}/地域/九层楼.md`;
const HS = `${LORE}/地域/后山.md`;
const MY = `${LORE}/秘药.md`;
const QYZ = `${LORE}/宗门/青云宗.md`;
const UNTOLD = '## 概要\n（未交代）\n\n## 规则与边界\n（未交代）\n\n## 现状\n（未交代）';

function plotText(no, { hash, synopsis = '往下查。', events = '- 有事发生', lore = '' } = {}) {
  return [
    '---',
    `no: ${no}`,
    `title: 第${no}章`,
    ...(hash ? [`sourceHash: ${hash}`] : []),
    '---',
    '',
    `# 第${no}章 第${no}章`,
    '',
    '## 梗概',
    '',
    synopsis,
    '',
    '## 关键事件',
    '',
    events,
    '',
    '## 设定',
    '',
    lore || '（无）',
    '',
  ].join('\n');
}

function entry(title, { keywords = [title], brief = '', body = '', bodyHash } = {}) {
  return [
    '---',
    `title: ${title}`,
    `keywords: [${keywords.join(', ')}]`,
    ...(brief ? [`brief: ${brief}`] : []),
    ...(bodyHash ? [`bodyHash: ${bodyHash}`] : []),
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

const expansion = (over = {}) =>
  JSON.stringify({
    brief: '一句话',
    keywords: [],
    body: { 概要: '概要。', 规则与边界: '规则。', 现状: '现状。', 暗设: '' },
    children: [],
    questions: [],
    ...over,
  });

/** 这一次在展开哪一条（装配器把它写在「当前这一条设定」那一节的第一行）。修 JSON 那一次没有这一节。 */
function titleOf(messages) {
  const user = messages[messages.length - 1].content;
  return /# 当前这一条设定[^\n]*\n+【([^〔】]+)/.exec(user)?.[1];
}

/** 按条目名给应答；同一条的第几次调用（含修 JSON 那一次）从 0 数。`route` 给了就全交给它。 */
let replies = {};
let route;
let lastTitle;
const seen = {};
function reply(messages) {
  if (route) {
    return route(messages);
  }
  const title = titleOf(messages) ?? lastTitle;
  lastTitle = title;
  const n = (seen[title] = (seen[title] ?? -1) + 1);
  const r = replies[title];
  const out = typeof r === 'function' ? r(n, messages) : Array.isArray(r) ? r[Math.min(n, r.length - 1)] : r;
  return out ?? { text: '（认不出这一步）', stop: 'end' };
}
function resetReplies(next, routeAll) {
  replies = next;
  route = routeAll;
  lastTitle = undefined;
  for (const k of Object.keys(seen)) delete seen[k];
  fake.calls.length = 0;
}

let settings;
function configure() {
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
  };
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    lore: './src/core/features/lore.ts',
    loreIndex: './src/core/views/lore.ts',
    material: './src/core/views/loreMaterial.ts',
    batch: './src/core/features/pipelineBatch.ts',
    workbench: './src/core/views/workbench.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    fs: './src/core/model/fs.ts',
    db: './src/core/runtime/db.ts',
  });
  configure();
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
});

/**
 * 第 1–2 章写完、定稿；第 3–6 章细纲排好、还没写。
 *
 * - 天机阁：只有一句话（细纲带出来的空条目）→ 批量写
 * - 藏经阁：新建设定的占位 → 批量写
 * - 九层楼：设定清单起步时机器写的三节「（未交代）」（盖了章）→ 批量写
 * - 后山：三节「（未交代）」，没盖章（作者手写的）→ 跳过
 * - 秘药：明面空着、作者写了暗设 → 跳过
 * - 青云宗：写够了，不在待完善里
 * - 断魂香：细纲点名、还没有条目 → 先建空条目
 * - 林昭：人，不算
 */
async function setupBook(prefix) {
  const t = await makeTempProject(bundle.project, { prefix, title: '天机录' });
  const project = t.project;
  t.write('.novelforge/config.md', '---\ngenre: 武侠\ntotalChapters: 30\nwordsPerChapter: 400\n---\n\n# 小说配置\n\n## 核心梗概\n\n林昭查旧案。\n');
  t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n孤儿。\n');
  t.write(TJG, entry('天机阁', { keywords: ['天机阁', '阁里'], brief: '卖消息的楼' }));
  t.write(CJG, entry('藏经阁', { body: '（在这里写这条设定：它是什么、在哪、有什么规矩……）' }));
  t.write(JCL, entry('九层楼', { brief: '藏书楼', body: UNTOLD, bodyHash: bundle.fs.hash(UNTOLD) }));
  t.write(HS, entry('后山', { body: UNTOLD }));
  t.write(MY, entry('秘药', { brief: '只写了暗设', body: '## 暗设\n作者写的：秘药是毒。' }));
  t.write(QYZ, entry('青云宗', { brief: '正道第一宗', body: '剑修。' }));
  fs.mkdirSync(path.join(t.dir, `${LORE}/制度`), { recursive: true });
  for (let no = 1; no <= 2; no++) {
    t.write(CH(no), `# 第${no}章\n\n第${no}章的正文。\n`);
  }
  project.invalidate();
  const chapters = await project.listChapters();
  const hashOf = (no) => chapters.find((c) => c.order === no).contentHash;
  t.write(PLOT(1), plotText(1, { hash: hashOf(1), lore: '- 天机阁〔宗门〕：一问一价' }));
  t.write(PLOT(2), plotText(2, { hash: hashOf(2) }));
  t.write(PLOT(3), plotText(3, { synopsis: '林昭夜入天机阁。', lore: '- 天机阁〔宗门〕：林昭在此买消息\n- 后山〔地域〕\n- 林昭' }));
  t.write(PLOT(4), plotText(4, { lore: '- 藏经阁〔宗门〕\n- 秘药' }));
  t.write(PLOT(5), plotText(5, { lore: '- 九层楼〔地域〕：二当家在楼下等\n- 青云宗' }));
  t.write(PLOT(6), plotText(6, { lore: '- 断魂香〔物品〕：二当家的毒' }));
  project.invalidate();
  return t;
}

describe('待完善的 authored 与 thinLoreFor', () => {
  let t;
  let thin;
  before(async () => {
    t = await setupBook('loreBatchThin');
    ({ thin } = await bundle.loreIndex.buildLoreIndex(t.project, {}, { pending: false, thin: true }));
  });
  after(() => cleanup(t.dir, bundle.db));

  test('作者写过的标 authored：三节未交代没盖章的、只写了暗设的', () => {
    const flags = Object.fromEntries(thin.map((x) => [x.name, x.authored === true]));
    assert.deepEqual(flags, { 天机阁: false, 后山: true, 藏经阁: false, 秘药: true, 九层楼: false, 断魂香: false }, JSON.stringify(thin));
  });

  test('loreBatchExpandable：空的、占位的、机器写的可以；作者写过的、写够了的不行', async () => {
    t.project.invalidate();
    const byTitle = Object.fromEntries((await t.project.listLore()).map((e) => [e.title, e]));
    const ok = (title) => bundle.material.loreBatchExpandable(byTitle[title]);
    assert.deepEqual(
      ['天机阁', '藏经阁', '九层楼', '后山', '秘药', '青云宗'].map(ok),
      [true, true, true, false, false, false]
    );
  });

  test('thinLoreFor 只留要用到那几章的，章号也只留那几章', async () => {
    const list = await bundle.loreIndex.thinLoreFor(t.project, [4, 5]);
    assert.deepEqual(list.map((x) => [x.name, x.chapters, x.first]), [['藏经阁', [4], 4], ['秘药', [4], 4], ['九层楼', [5], 5]]);
    assert.deepEqual(await bundle.loreIndex.thinLoreFor(t.project, []), []);
  });
});

describe('全部展开', () => {
  let t;
  let project;
  let calls;
  const before3 = {};
  before(async () => {
    t = await setupBook('loreBatchAll');
    project = t.project;
    for (const rel of [HS, MY, QYZ]) before3[rel] = t.read(rel);
    resetReplies({
      // 一次就成：带一条子条目、一条已有的子条目、一个人名关键词、两条问题。
      天机阁: {
        text: expansion({
          brief: '江湖上卖消息的楼阁',
          keywords: ['天机楼', '林昭', '阁规'],
          body: { 概要: '卖消息的七层楼。', 规则与边界: '一问一价。', 现状: '阁主闭关。', 暗设: '阁主是前朝太子。' },
          children: [
            { name: '阁规', category: '制度', brief: '天机阁的十条规矩' },
            { name: '青云宗', category: '宗门', brief: '已有条目' },
          ],
          questions: ['阁规是成文的还是口传的？'],
        }),
        stop: 'end',
      },
      // 解析不了（不是 JSON）→ 这一条重来一次。
      藏经阁: [{ text: '我先想想藏经阁……', stop: 'end' }, { text: expansion({ body: { 概要: '藏书三万卷。' } }), stop: 'end' }],
      // 语法坏了 → 修一次（只改标点），不再重来。
      九层楼: [
        { text: '{"brief":"藏书楼","keywords":[],"body":{"概要":"九层。" "现状":"封楼。"},"children":[],"questions":[]}', stop: 'end' },
        { text: '{"brief":"藏书楼","keywords":[],"body":{"概要":"九层。", "现状":"封楼。"},"children":[],"questions":[]}', stop: 'end' },
      ],
      // 两次都解析不了：失败。
      断魂香: { text: '断魂香是一种毒……', stop: 'end' },
    });
    h.expect('开始展开');
    calls = await bundle.lore.expandLoreEntries(project);
    project.invalidate();
  });
  after(() => cleanup(t.dir, bundle.db));

  test('先报次数：每条 2 次（写、转写各 1）、最多 4 次；说清跳过谁、谁先建空条目、用哪一档', () => {
    const c = h.confirms[0];
    assert.match(c.message, /^展开 4 条设定：预计 8 次调用，最多 16 次（写 1 次、转写 1 次；转写不合格重转 1 次，或者整理不出来时这一条重写、再转写 1 次，两样不叠加）。/, c.message);
    assert.ok(c.detail.includes('要展开的：天机阁、藏经阁、九层楼、断魂香'), c.detail);
    assert.ok(c.detail.includes('其中 1 条还没有条目，先按细纲「设定」一节里的分类建空条目'), c.detail);
    assert.ok(c.detail.includes('跳过你写过的 2 条：后山、秘药'), c.detail);
    // 用哪一档列在模型下拉框下面（「按分档」时）；展开看详细度，那个下拉框也在。
    assert.ok(c.call.tiers.join('\n').includes('故事架构'), c.call.tiers.join('\n'));
    // 转写不跟这一次挑的模型：单列一行。
    assert.ok(c.call.fixed?.some((line) => line.includes('转写')), JSON.stringify(c.call));
    assert.equal(c.call.contextDetail, 3);
    assert.deepEqual(c.actions, ['开始展开']);
  });

  // 九层楼：坏了语法的 JSON 交给转写理顺（2026-10-25 起，从前是修一次），一样是 2 次。
  test('实际调用：1 + 2（重写）+ 2（转写理顺）+ 2（重写仍不行）= 7，返回的就是它', () => {
    assert.equal(fake.callCount(), 7);
    assert.equal(calls, 7);
  });

  test('装配同对话页的单条设定目标：展开合同、这一条在焦点上', () => {
    const user = fake.calls[0][fake.calls[0].length - 1].content;
    assert.ok(user.includes('【展开格式】') && user.includes('不写 JSON'), user.slice(-800));
    assert.ok(user.includes('【天机阁〔宗门〕】'), user.slice(0, 2000));
    assert.ok(user.includes('林昭夜入天机阁'), '已排细纲里用到它的地方');
  });

  test('只有一句话的：正文换成展开后的，暗设成第四节；记作机器写的，水位同整合', async () => {
    const e = (await project.listLore()).find((x) => x.relPath === TJG);
    assert.ok(e.body.includes('卖消息的七层楼。') && e.body.includes('## 暗设\n阁主是前朝太子。'), e.body);
    assert.equal(e.brief, '江湖上卖消息的楼阁');
    assert.ok(bundle.lore.loreOwnedByMachine(e));
    assert.equal(e.bodyHash, bundle.fs.hash(e.body.trim()));
    assert.equal(e.updatedThrough, 2);
  });

  test('关键词只增不减；人名、拆出去的子条目不收', async () => {
    const e = (await project.listLore()).find((x) => x.relPath === TJG);
    assert.deepEqual(e.keywords, ['天机阁', '阁里', '天机楼']);
  });

  test('还没定的问题不写进任何文件', () => {
    const all = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.md')) all.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(path.join(t.dir, '.novelforge'));
    assert.ok(!all.some((x) => x.includes('阁规是成文的还是口传的')));
  });

  test('子条目建空条目（已有的不另建），不在同一批里接着展开', async () => {
    const gz = (await project.listLore()).find((x) => x.title === '阁规');
    assert.equal(gz?.relPath, `${LORE}/制度/阁规.md`);
    assert.equal(gz.body.trim(), '');
    assert.equal(gz.brief, '天机阁的十条规矩');
    assert.equal((await project.listLore()).filter((x) => x.title === '青云宗').length, 1);
    assert.ok(!fake.calls.some((m) => titleOf(m) === '阁规'));
  });

  test('占位的、机器写的薄条目也写；解析不了的重来、语法坏了的修过', () => {
    assert.ok(t.read(CJG).includes('藏书三万卷。'), t.read(CJG));
    assert.ok(!t.read(CJG).includes('在这里写这条设定'));
    assert.ok(t.read(JCL).includes('封楼。'), t.read(JCL));
  });

  test('作者写过的一个字不动', () => {
    for (const rel of [HS, MY, QYZ]) assert.equal(t.read(rel), before3[rel], rel);
  });

  test('还没有条目的先按「设定」一节的分类建空条目；展开失败了空条目留着，失败挂在它身上', async () => {
    const rel = `${LORE}/物品/断魂香.md`;
    assert.ok(t.has(rel));
    const e = (await project.listLore()).find((x) => x.relPath === rel);
    assert.equal(e.body.trim(), '');
    const [f] = (await bundle.errorLog.listActiveFailures(project))[rel] ?? [];
    assert.ok(f && f.op === 'expandLore' && f.message.includes('展开失败'), JSON.stringify(f));
  });

  test('完成提示：写了几条、新建的子条目、跳过你写过的、失败几条', () => {
    const toast = h.toasts[h.toasts.length - 1];
    assert.equal(toast, 'info: 展开 3 条设定，新建子条目 1 条：阁规，跳过你写过的 2 条，失败 1 条（详见日志页）。');
  });

  test('写过之后「待完善」里只剩作者写过的与失败的那一条', async () => {
    const { thin } = await bundle.loreIndex.buildLoreIndex(project, {}, { pending: false, thin: true });
    assert.deepEqual(thin.map((x) => x.name).sort(), ['后山', '断魂香', '秘药'].sort());
  });
});

describe('次数上限与失败', () => {
  let t;
  before(async () => {
    t = await setupBook('loreBatchCap');
  });
  after(() => cleanup(t.dir, bundle.db));

  test('被输出上限截断：不重来，算失败', async () => {
    resetReplies({ 天机阁: { text: '{"brief":"卖消息的","body":{"概要":"七层', stop: 'maxTokens' } });
    h.expect('开始展开');
    const n = await bundle.lore.expandLoreEntries(t.project, [TJG]);
    assert.equal(n, 1);
    assert.equal(fake.callCount(), 1);
    assert.ok(!t.read(TJG).includes('七层'));
    const [f] = (await bundle.errorLog.listActiveFailures(t.project))[TJG] ?? [];
    assert.ok(f?.message.includes('截断'), JSON.stringify(f));
  });

  // 写 1 + 转写 1 + 重转 1 = 3：已经重转过就不再重写（两样不叠加），转写的调用也算进返回的次数。
  test('重转过一次仍解析不了：不再重写（每条最多 4 次）', async () => {
    resetReplies({
      天机阁: [
        { text: '{"brief":"卖消息的" "body":{}}', stop: 'end' },
        { text: '{"brief":"卖消息的", "body":{}}', stop: 'end' },
      ],
    });
    h.expect('开始展开');
    const n = await bundle.lore.expandLoreEntries(t.project, [TJG]);
    assert.equal(n, 3);
    assert.equal(fake.callCount(), 3);
    assert.ok(fake.calls[1][0].content.includes('格式转写员') && fake.calls[2][0].content.includes('格式转写员'));
  });

  // 按格式写的原文（2026-10-25 起）：写 1 + 转写 1，照抄的落盘；返回的次数含转写那一次。
  test('按格式写、转写成 JSON：2 次，照抄的落盘', async () => {
    const prose = ['## 一句话', '卖消息的楼', '## 关键词', '天机楼', '## 概要', '九层的楼。', '## 规则与边界', '一问一价。', '## 现状', '（未交代）', '## 暗设', '无', '## 子条目', '无', '## 还没定的问题', '无'].join('\n');
    const copied = expansion({ brief: '卖消息的楼', keywords: ['天机楼'], body: { 概要: '九层的楼。', 规则与边界: '一问一价。', 现状: '（未交代）', 暗设: '无' } });
    const original = t.read(TJG);
    resetReplies({ 天机阁: [{ text: prose, stop: 'end' }, { text: copied, stop: 'end' }] });
    h.expect('开始展开');
    const n = await bundle.lore.expandLoreEntries(t.project, [TJG]);
    assert.equal(n, 2);
    const user = fake.calls[1][fake.calls[1].length - 1].content;
    assert.ok(fake.calls[1][0].content.includes('格式转写员') && user.includes('【原文】') && user.includes('九层的楼。'), user.slice(0, 600));
    assert.ok(t.read(TJG).includes('九层的楼。'), t.read(TJG));
    // 放回去：后面几条还要拿它当只有一句话的条目展开。
    t.write(TJG, original);
    t.project.invalidate();
  });

  test('重来那一次就成了：失败记录收掉', async () => {
    resetReplies({ 天机阁: [{ text: '好的，我来想想。', stop: 'end' }, { text: expansion({ body: { 概要: '七层楼。' } }), stop: 'end' }] });
    h.expect('开始展开');
    assert.equal(await bundle.lore.expandLoreEntries(t.project, [TJG]), 2);
    assert.ok(t.read(TJG).includes('七层楼。'));
    assert.equal(((await bundle.errorLog.listActiveFailures(t.project))[TJG] ?? []).length, 0);
  });

  test('取消就一次都不调', async () => {
    resetReplies({});
    h.expect(undefined);
    assert.equal(await bundle.lore.expandLoreEntries(t.project, [CJG]), 0);
    assert.equal(fake.callCount(), 0);
  });

  test('给的几条全是作者写过的：不问、不调，说清去单条展开', async () => {
    resetReplies({});
    h.expect();
    assert.equal(await bundle.lore.expandLoreEntries(t.project, [HS, MY]), 0);
    assert.equal(h.confirms.length, 0);
    assert.equal(fake.callCount(), 0);
    assert.ok(h.toasts.some((x) => x.includes('没有能直接展开的设定') && x.includes('跳过你写过的 2 条：后山、秘药')), h.toasts.join('|'));
  });
});

describe('落盘前再认一遍', () => {
  let t;
  before(async () => {
    t = await setupBook('loreBatchRace');
    resetReplies({
      藏经阁: () => {
        // 模型想的这几十秒里，作者在编辑器里写了字。
        t.write(CJG, entry('藏经阁', { body: '## 概要\n作者刚写的：藏书三万卷。' }));
        return { text: expansion({ body: { 概要: '模型写的。' } }), stop: 'end' };
      },
    });
    h.expect('开始展开');
    await bundle.lore.expandLoreEntries(t.project, [CJG]);
  });
  after(() => cleanup(t.dir, bundle.db));

  test('作者写了字的不写，完成提示里说出来', () => {
    assert.ok(t.read(CJG).includes('作者刚写的'), t.read(CJG));
    assert.ok(!t.read(CJG).includes('模型写的'));
    assert.ok(h.toasts.some((x) => x.includes('展开 0 条设定') && x.includes('「藏经阁」展开期间有人写了内容')), h.toasts.join('|'));
  });
});

describe('拆完展开本批新设定', () => {
  let t;
  let project;
  const OUTLINE = outlineOf(20, { title: '大纲', text: { 1: '林昭进天机阁。' } });
  const blueprints = (messages) => {
    const user = messages[messages.length - 1].content;
    const m = /写第 (\d+)(?:–(\d+))? 章的细纲：/.exec(user);
    const from = Number(m?.[1] ?? 1);
    const to = Number(m?.[2] ?? from);
    const items = [];
    for (let no = from; no <= to; no++) {
      items.push({
        chapterNumber: no,
        title: `第${no}章`,
        synopsis: '林昭下暗河。',
        characters: ['林昭'],
        timePlace: '夜',
        keyEvents: ['林昭摸进鬼市。'],
        highlights: ['鬼市开张'],
        foreshadowing: [],
        stateChange: '',
        settings: no === from ? [{ name: '鬼市', category: '地域', note: '暗河下的集市', isNew: true }] : [],
      });
    }
    return { text: JSON.stringify({ blueprints: items }), stop: 'end' };
  };
  /** 拆细纲、排叙事线、展开：按消息认是哪一步。 */
  const steps = (messages) => {
    const user = messages[messages.length - 1].content;
    if (/写第 \d+(?:–\d+)? 章的细纲：/.test(user)) return blueprints(messages);
    if (titleOf(messages)) return { text: expansion({ body: { 概要: '暗河下的集市。' } }), stop: 'end' };
    return { text: '{"threads":[]}', stop: 'end' };
  };
  /** 重拆第 2 章：删掉它的细纲与它带出来的新设定。 */
  const resetChapter2 = () => {
    t.remove(PLOT(2));
    t.remove(`${LORE}/地域/鬼市.md`);
    project.invalidate();
  };

  before(async () => {
    t = await makeTempProject(bundle.project, { prefix: 'loreBatchPlots', title: '鬼市' });
    project = t.project;
    t.write('.novelforge/config.md', '---\ntotalChapters: 2\nwordsPerChapter: 400\n---\n\n# 小说配置\n\n## 核心梗概\n\n林昭查旧案。\n');
    writeOutline(t, OUTLINE);
    project.invalidate();
  });
  after(() => cleanup(t.dir, bundle.db));

  test('缺省不展开：新设定照建空条目，拆完不再问', async () => {
    resetReplies({}, steps);
    h.expect();
    await bundle.batch.generatePlots(project, { range: { from: 1, to: 1 }, call: {} });
    project.invalidate();
    assert.equal(h.confirms.length, 0);
    const e = (await project.listLore()).find((x) => x.title === '鬼市');
    assert.equal(e?.body.trim(), '');
    assert.ok(!fake.calls.some((m) => titleOf(m)), '没调展开');
  });

  test('选了展开、但这一次没有新建设定（名字已经有条目）：不问', async () => {
    resetReplies({}, steps);
    h.expect('开始展开');
    const n = await bundle.batch.generatePlots(project, { range: { from: 2, to: 2 }, call: {}, expandLore: true });
    assert.equal(h.confirms.length, 0, JSON.stringify(h.confirms));
    assert.equal(n, fake.callCount());
  });

  test('选了展开：拆完按这一次新建的那几条再问一次次数，答了才展开', async () => {
    resetChapter2();
    resetReplies({}, steps);
    h.expect('开始展开');
    const n = await bundle.batch.generatePlots(project, { range: { from: 2, to: 2 }, call: {}, expandLore: true });
    project.invalidate();
    assert.equal(h.confirms.length, 1, JSON.stringify(h.confirms));
    assert.match(h.confirms[0].message, /^第 2 章拆出了 1 条新设定。展开 1 条设定：预计 2 次调用，最多 4 次/);
    assert.ok(h.confirms[0].detail.includes('要展开的：鬼市'), h.confirms[0].detail);
    const e = (await project.listLore()).find((x) => x.title === '鬼市');
    assert.ok(e.body.includes('暗河下的集市。'), e.body);
    assert.equal(n, fake.callCount(), '返回值含展开那一次');
  });

  test('第二问取消：只是不展开，细纲照样在', async () => {
    resetChapter2();
    resetReplies({}, steps);
    h.expect(undefined);
    await bundle.batch.generatePlots(project, { range: { from: 2, to: 2 }, call: {}, expandLore: true });
    project.invalidate();
    assert.equal(h.confirms.length, 1);
    assert.ok(t.has(PLOT(2)));
    assert.equal((await project.listLore()).find((x) => x.title === '鬼市')?.body.trim(), '');
    assert.ok(!fake.calls.some((m) => titleOf(m)), '没调展开');
  });
});

describe('写前提醒', () => {
  let t;
  let project;
  const wb = (no) => bundle.workbench.buildWorkbench(project, { kind: 'manuscript', plotRelPath: PLOT(no) });
  before(async () => {
    t = await setupBook('loreBatchHint');
    project = t.project;
    resetReplies({});
  });
  after(() => cleanup(t.dir, bundle.db));

  // 同一章的按名字排（后山在天机阁前面），与「待完善」同一个顺序。
  test('还没写的章：本章要用的还只有一句话，提一句（与 ⟳ 分开）', async () => {
    const card = await wb(3);
    assert.equal(card.notice, '本章要用的 后山、天机阁 还只有一句话，写之前可以先展开（在工程页「待完善」里右键「展开…」）。');
    assert.equal(card.warning, undefined);
  });

  test('还没有条目的也算；写够了的不算', async () => {
    assert.ok((await wb(6)).notice?.includes('断魂香'));
    assert.ok(!(await wb(5)).notice?.includes('青云宗'));
    assert.ok((await wb(5)).notice?.includes('九层楼'));
  });

  test('已经写了字的章、「设定」一节空着的章不提', async () => {
    assert.equal((await wb(1)).notice, undefined);
    assert.equal((await wb(2)).notice, undefined);
  });

  test('零调用', () => {
    assert.equal(fake.callCount(), 0);
  });

  test('批量写章确认框多一行（不拦）', async () => {
    resetReplies({});
    h.expect(undefined);
    const n = await bundle.batch.writeManuscripts(project, { range: { from: 3, to: 5 } });
    assert.equal(n, 0);
    const c = h.confirms.find((x) => x.message.includes('要写'));
    assert.ok(c, JSON.stringify(h.confirms));
    assert.ok(
      c.detail.includes('区间里 5 条要用到的设定还只有一句话（后山、天机阁、藏经阁、秘药、九层楼），写之前可以先在工程页「待完善」里展开；不展开也照写。'),
      c.detail
    );
    assert.deepEqual(c.actions, ['开始写章']);
  });
});
