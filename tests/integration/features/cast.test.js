/**
 * 「谁是谁」这条链路：泛称过滤、同一人聚类、出场索引、维护命令。
 * 迁自 scripts/smoke-cast.js（47 条断言）。
 *
 * 这条链路是一次实战事故的产物——定稿的出场人物里 `方源` 与 `古月方源` 交替出现，
 * 「全部建卡」于是给同一个人建了两张卡；与此同时 aliases 里堆满了 `她`、
 * `姐姐`、`少女`，其中还混进了她孪生弟弟的名字。
 *
 * 最要紧的一条断言是**反向**的：`方源` 与 `方正` 哪怕有一条别名把他们连起来，
 * 也必须仍然是两个人。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempDir } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let naming;
let identity;
let castMod;
let markdown;
let projectMod;
let maintenance;
let wsMod;
let h;
let t;

/**
 * 给 `Workspace` 的某几个方法记一笔再照常执行（同一个 bundle 里的类，维护命令 new 出来的就是它）。
 * 用来证明维护命令的写盘经网关（AGENTS 第 7 条），返回记下的 `[方法名, 路径]`。
 */
async function spyWorkspace(names, fn) {
  const proto = wsMod.Workspace.prototype;
  const calls = [];
  const originals = Object.fromEntries(names.map((n) => [n, proto[n]]));
  for (const n of names) {
    proto[n] = function (rel, ...rest) {
      calls.push([n, rel]);
      return originals[n].call(this, rel, ...rest);
    };
  }
  try {
    await fn();
  } finally {
    Object.assign(proto, originals);
  }
  return calls;
}

/** 这份文件在历史版本里的快照全文（`.novelforge/history/<相对路径>/`），新旧不论。 */
function snapshotTexts(rel) {
  const dir = t.rel('.novelforge/history', rel);
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => fs.readFileSync(`${dir}/${n}`, 'utf8')) : [];
}

/**
 * 造一份定稿过的细纲（带 sourceHash 与 cast）。cast 用 `名(别名、别名)` 的写法。
 *
 * 出场索引扫的是**定稿过的细纲**（`buildCastIndex` 走 `listPlots()`，只认有 sourceHash 的），
 * 不看同号正文在不在、对不对得上——那是最后一次定稿时的实际出场，比没有强。
 */
function makePlot(no, cast, dir = t) {
  const n = String(no).padStart(3, '0');
  dir.write(
    `.novelforge/summaries/${n}-第${no}章.md`,
    `---\nno: ${no}\ntitle: 第${no}章\nsourceHash: x\ncast: [${cast.join(', ')}]\n---\n\n` +
      `# 第${no}章 第${no}章\n\n## 梗概\n\n略。\n\n## 出场人物\n\n${cast.join('、')}\n\n## 关键事件\n\n甲乙丙。\n`
  );
}

function makeCard(name, aliases, extra = {}, dir = t) {
  const fm = [
    `name: ${name}`,
    `aliases: [${aliases.join(', ')}]`,
    'tags: [配角]',
    ...Object.entries(extra).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`),
  ].join('\n');
  dir.write(
    `.novelforge/characters/${name}.md`,
    `---\n${fm}\n---\n\n# ${name}\n\n## 身份\n\n作者手写的这一段一个字都不许动。\n`
  );
}

before(() => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    naming: './src/core/model/naming.ts',
    identity: './src/core/model/identity.ts',
    cast: './src/core/views/cast.ts',
    markdown: './src/core/model/markdown.ts',
    project: './src/core/model/project.ts',
    maintenance: './src/core/features/characterMaintenance.ts',
    ws: './src/core/workspace/index.ts',
  });
  ({ naming, identity, cast: castMod, markdown, project: projectMod, maintenance, ws: wsMod } = bundle);

  // 原脚本的假宿主没有 reviewReplace，摘掉它才与原行为一致。
  h = makeFakeHost({
    settings: () => ({ providers: [], models: [], concurrency: 1 }),
    overrides: { reviewReplace: undefined },
  });
  bundle.host.initHost(h.host);

  // 原脚本从不 initialize()，只手写一份 project.md，再用**构造函数**开工程。
  t = makeTempDir('cast');
});

after(() => {
  if (t) cleanup(t.dir);
});

// ================================================================ 泛称过滤

describe('别名：什么算专属称呼', () => {
  let keptGeneric;
  let droppedProper;
  let sanitized;
  let dropped;

  before(() => {
    const generic = ['她', '姐姐', '少女', '丫头', '小姐', '公子', '学妹', '小丫头', '臭丫头',
      '这位小姐', '此女', '本届状元', '满身血迹的少女', '好运的小丫头', '小崽子', '小狼崽子',
      '少女新人', '中年男人', '舅父', '心腹之士'];
    const proper = ['方老魔女', '魔头', '古月方源', '魔道巨擘', '方源妹子', '赤城少爷',
      '贾公子', '甘德·奥塔', '店小二', '家老', '房东', '族长'];
    keptGeneric = generic.filter((w) => !naming.isGenericAppellation(w));
    droppedProper = proper.filter((w) => naming.isGenericAppellation(w));
    sanitized = naming.sanitizeAliases(['方老魔女', '姐姐', '方源', '她', '方老魔女', '古月方源'], '方源');
    dropped = naming.explainDroppedAliases(['姐姐', '她', '满身血迹的少女'], '方源');
  });

  test('泛称一个不留', () => {
    assert.equal(keptGeneric.length, 0, keptGeneric.join('、'));
  });

  test('专属称呼一个不丢', () => {
    assert.equal(droppedProper.length, 0, droppedProper.join('、'));
  });

  // 以泛称当正式名的角色确实存在（店小二、家老、房东），过滤只对别名生效。
  test('sanitizeAliases 去泛称、去本名、去重', () => {
    assert.deepEqual(sanitized, ['方老魔女', '古月方源']);
  });

  test('说得出为什么丢', () => {
    assert.equal(dropped.length, 3, JSON.stringify(dropped));
    assert.ok(dropped.every((d) => d.reason.length > 0), JSON.stringify(dropped));
  });
});

// ================================================================ 同一人聚类

describe('聚类：同一人 / 两个人', () => {
  let sameMan;
  let twins;
  let oneVote;
  let twoVotes;
  let genericAlias;

  before(() => {
    // 同一个人两种写法交替出现——这正是当初一人两卡的成因。
    sameMan = identity.buildIdentityGroups([
      { order: 1, cast: [{ name: '方源', aliases: ['古月方源', '方老魔女'] }] },
      { order: 2, cast: [{ name: '古月方源', aliases: ['方源'] }] },
      { order: 3, cast: [{ name: '古月方源', aliases: [] }] },
    ]);

    // ★ 回归：模型幻觉把孪生姐弟连起来，同章共现必须把它拦下。
    twins = identity.buildIdentityGroups([
      { order: 1, cast: [{ name: '方源', aliases: [] }, { name: '方正', aliases: [] }] },
      { order: 2, cast: [{ name: '方源', aliases: [] }, { name: '方正', aliases: [] }] },
      { order: 3, cast: [{ name: '方源', aliases: ['方正'] }] },
    ]);

    // 从没共现过，但两边戏份都重、只有一章说他们是同一人 → 证据不足。
    const chapters = [];
    for (let i = 1; i <= 3; i++) chapters.push({ order: i, cast: [{ name: '甲', aliases: [] }] });
    for (let i = 4; i <= 6; i++) chapters.push({ order: i, cast: [{ name: '乙', aliases: [] }] });
    chapters.push({ order: 7, cast: [{ name: '甲', aliases: ['乙'] }] });
    oneVote = identity.buildIdentityGroups(chapters);
    // 补一票就够了：两章都这么说，那就是同一个人。
    chapters.push({ order: 8, cast: [{ name: '甲', aliases: ['乙'] }] });
    twoVotes = identity.buildIdentityGroups(chapters);

    // 泛称不能当判据，否则几个女角色会被 `姐姐` 串成一个。
    genericAlias = identity.buildIdentityGroups([
      { order: 1, cast: [{ name: '甲', aliases: ['姐姐'] }] },
      { order: 2, cast: [{ name: '乙', aliases: ['姐姐'] }] },
    ]);
  });

  test('两种写法归成一个人', () => {
    assert.equal(sameMan.groups.length, 1, JSON.stringify(sameMan.groups));
  });

  test('出场章节取并集', () => {
    assert.equal(sameMan.groups[0].chapters.join(','), '1,2,3');
  });

  test('展示名取领衔最多的写法', () => {
    assert.equal(sameMan.groups[0].primary, '古月方源', sameMan.groups[0].primary);
  });

  test('同章共现的两人绝不合并', () => {
    assert.equal(twins.groups.length, 2, JSON.stringify(twins.groups.map((g) => g.names)));
  });

  test('拦下的链接说得出理由', () => {
    assert.ok(
      twins.rejected.some((r) => r.reason.includes('同一章')),
      JSON.stringify(twins.rejected)
    );
  });

  test('areDifferent 认得出这两人', () => {
    assert.equal(twins.areDifferent('方源', '方正'), true);
  });

  test('重要角色之间单票不足以合并', () => {
    assert.equal(oneVote.groups.length, 2, JSON.stringify(oneVote.groups.map((g) => g.names)));
  });

  test('两票就合并', () => {
    assert.equal(twoVotes.groups.length, 1);
  });

  test('泛称别名不把两个人串起来', () => {
    assert.equal(
      genericAlias.groups.length,
      2,
      JSON.stringify(genericAlias.groups.map((g) => g.names))
    );
  });
});

// ================================================================ 出场索引

describe('出场索引', () => {
  let fangyuan;
  let unknownNames;
  let byName;
  let conflicts2;
  let crossed;
  let conflicts3;

  before(async () => {
    t.remove('.novelforge');
    t.write('.novelforge/project.md', '---\ntitle: 测\n---\n\n# 测\n');
    makePlot(1, ['方源(古月方源、姐姐)', '方正']);
    makePlot(2, ['古月方源(方源)', '方正']);
    makePlot(3, ['古月方源']);
    const project = new projectMod.NovelProject(t.dir);

    // ---- 一张卡都没有：两种写法只该冒出一个「未建卡」的人。
    let index = await castMod.buildCastIndex(project);
    fangyuan = index.unknown.filter((m) => m.name.includes('方源'));
    unknownNames = index.unknown.map((m) => m.name);

    // ---- 正式名压过别名：方源的卡上错挂了 `方正`，抢不走方正的章节。
    makeCard('方源', ['方老魔女', '古月方源', '方正', '姐姐']);
    makeCard('方正', []);
    project.invalidate();
    index = await castMod.buildCastIndex(project);
    const find = (n) => index.known.find((m) => m.card.name === n);
    byName = { 方正: find('方正'), 方源: find('方源') };
    conflicts2 = index.conflicts;

    // ---- 同一个人两张卡：名字不同、别名互指，两个方向都要报出来。
    makeCard('古月方源', ['方源']);
    project.invalidate();
    index = await castMod.buildCastIndex(project);
    conflicts3 = index.conflicts;
    crossed = index.conflicts.filter(
      (c) => (c.name === '古月方源' || c.name === '方源') && c.slugs.length >= 2
    );
  });

  test('未建卡的同一人只出现一次', () => {
    assert.equal(fangyuan.length, 1, unknownNames.join('、'));
  });

  test('出场段合到一起', () => {
    assert.ok(
      fangyuan[0] && fangyuan[0].plots.join(',') === '1,2,3',
      fangyuan[0] && fangyuan[0].plots.join(',')
    );
  });

  test('方正仍是独立的一个人', () => {
    assert.ok(unknownNames.includes('方正'));
  });

  test('方正的段记在方正名下', () => {
    assert.equal(byName.方正.plots.join(','), '1,2', byName.方正.plots.join(','));
  });

  test('方源不多吃方正的段', () => {
    assert.equal(byName.方源.plots.join(','), '1,2,3', byName.方源.plots.join(','));
  });

  test('别名撞正式名记进 conflicts', () => {
    assert.ok(
      conflicts2.some((c) => c.name === '方正' && c.kind === 'alias'),
      JSON.stringify(conflicts2)
    );
  });

  test('一人两卡的互指冲突被记下', () => {
    assert.equal(crossed.length, 2, JSON.stringify(conflicts3));
  });
});

/**
 * 出场统计**只认定稿过的细纲**（第 14 条）。没定稿的细纲里「出场人物」写的是计划：排细纲的模型
 * 想让他出场，正文里未必真写到了——混进出场统计会污染角色卡的出场章与语料（D13）。
 * 老工程 `summaries/` 根下的单章摘要（frontmatter `chapter:`、带 sourceHash 与 cast）本来就是
 * 定稿留下的，照样算。
 */
describe('出场索引 · 只认定稿过的细纲', () => {
  let d;
  let index;
  let castPlots;

  before(async () => {
    d = makeTempDir('cast-finalized');
    d.write('.novelforge/project.md', '---\ntitle: 测\n---\n\n# 测\n');
    // 第 1 章：定稿过（新格式细纲）。
    makePlot(1, ['林昭(阿昭)', '沈氏'], d);
    // 第 2 章：还没定稿的计划，出场人物里排了林昭与韩七。
    d.write(
      '.novelforge/summaries/002-第2章.md',
      '---\nno: 2\ntitle: 第2章\n---\n\n# 第2章 第2章\n\n## 梗概\n\n略。\n\n## 出场人物\n\n林昭、韩七\n\n## 关键事件\n\n甲乙丙。\n'
    );
    // 第 3 章：老工程留下的单章摘要，放在 summaries/ 根下。
    d.write(
      '.novelforge/summaries/003-第3章.md',
      '---\nchapter: 3\ntitle: 第3章\nsourceHash: y\ncast: [林昭, 李叔]\n---\n\n# 第3章 · 摘要\n\n## 梗概\n\n略。\n\n## 出场人物\n\n林昭、李叔\n'
    );
    makeCard('林昭', [], {}, d);
    const project = new projectMod.NovelProject(d.dir);
    index = await castMod.buildCastIndex(project);
    castPlots = await castMod.readCastPlots(project);
  });

  after(() => {
    if (d) cleanup(d.dir);
  });

  test('已建卡的角色只记定稿过的章', () => {
    assert.deepEqual(index.known.find((m) => m.name === '林昭')?.plots, [1, 3]);
  });

  test('只在计划里出场的人不进出场统计', () => {
    assert.ok(!index.unknown.some((m) => m.name === '韩七'), index.unknown.map((m) => m.name).join('、'));
  });

  test('定稿过的细纲里没建卡的人照样列出来', () => {
    assert.ok(index.unknown.some((m) => m.name === '沈氏'), index.unknown.map((m) => m.name).join('、'));
  });

  test('summaries/ 根下的老摘要算定稿过的细纲', () => {
    assert.ok(index.unknown.some((m) => m.name === '李叔'), index.unknown.map((m) => m.name).join('、'));
  });

  // 上层据此决定说「没有出场人物」还是「还没定稿过」：计划不算数。
  test('参与统计的细纲数不含计划', () => {
    assert.equal(index.summaryCount, 2);
  });

  // 维护命令的聚类原料与出场索引同一个口径。
  test('readCastPlots 也只给定稿过的章', () => {
    assert.deepEqual(castPlots.map((c) => c.order), [1, 3]);
  });
});

// ================================================================ 剧作称谓

describe('剧作称谓：不是名字，也不是别名', () => {
  let d;
  let index;

  before(async () => {
    // 正文里夹着作者的笔记时，模型写下的出场人物会是 `主角(林昭)`、光一个 `反派`。
    d = makeTempDir('cast-labels');
    d.write('.novelforge/project.md', '---\ntitle: 测\n---\n\n# 测\n');
    makePlot(1, ['主角(林昭、阿昭)', '反派', '沈氏'], d);
    makePlot(2, ['林昭(主角)', '沈氏'], d);
    index = await castMod.buildCastIndex(new projectMod.NovelProject(d.dir));
  });

  after(() => {
    if (d) cleanup(d.dir);
  });

  test('只认整词：称谓是，故事里真有人这么叫的不是', () => {
    assert.deepEqual(
      ['主角', '反派', '男主角', '路人甲', '韩厉', '掌柜', '头领', '反派韩厉'].map((w) => naming.isRoleLabel(w)),
      [true, true, true, true, false, false, false, false]
    );
  });

  test('别名里的称谓被剔掉（带修饰语的也算），说得出为什么', () => {
    assert.deepEqual(naming.sanitizeAliases(['主角', '阿昭', '小反派'], '林昭'), ['阿昭']);
    assert.match(naming.explainDroppedAliases(['主角'], '林昭')[0].reason, /剧作称谓/);
  });

  test('名字是称谓：别名里第一个真名升上来，称谓交回去', () => {
    assert.deepEqual(naming.resolveRoleLabelName('反派', ['她', '韩厉', '头领']), {
      name: '韩厉',
      aliases: ['头领'],
      label: '反派',
    });
  });

  test('名字是称谓、别名里没有真名：不是一个人', () => {
    assert.equal(naming.resolveRoleLabelName('主角', ['他']), undefined);
  });

  test('名字不是称谓：原样返回（泛称当正式名的也不动）', () => {
    assert.deepEqual(naming.resolveRoleLabelName('掌柜', ['老周']), { name: '掌柜', aliases: ['老周'] });
  });

  test('细纲里的 `主角(林昭)` 记到林昭头上，光一个 `反派` 不列', () => {
    const names = index.unknown.map((m) => m.name);
    assert.ok(!names.includes('主角') && !names.includes('反派'), names.join('、'));
    assert.deepEqual(index.unknown.find((m) => m.name === '林昭')?.plots, [1, 2]);
  });
});

describe('维护：称谓卡并进真名那张', () => {
  let d;
  let groups;
  let confirms;
  let names;
  let keeper;

  before(async () => {
    d = makeTempDir('cast-label-cards');
    d.write('.novelforge/project.md', '---\ntitle: 测\n---\n\n# 测\n');
    // 提取角色时建出来的那一对：`反派.md` 挂着真名，戏份反而记得比真名那张多。
    makeCard('韩厉', [], { appearsIn: [3], updatedThrough: 3, firstAppear: 3, lastSeen: 3 }, d);
    makeCard('反派', ['韩厉', '头领'], { appearsIn: [3, 4, 5], updatedThrough: 5, firstAppear: 3, lastSeen: 5 }, d);
    // 光一个称谓、对不上任何一张真名卡：只能请作者自己改名或删掉。
    makeCard('主角', [], {}, d);
    const project = new projectMod.NovelProject(d.dir);
    groups = await maintenance.findDuplicateCards(project);
    h.confirms.length = 0;
    h.expect('逐组处理', '保留「韩厉」');
    await maintenance.mergeDuplicateCharacterCards(project);
    confirms = [...h.confirms];
    const cards = await project.listCharacters();
    names = cards.map((c) => c.name).sort();
    keeper = cards.find((c) => c.name === '韩厉');
  });

  after(() => {
    if (d) cleanup(d.dir);
  });

  test('认出韩厉 / 反派是一组，算强证据', () => {
    assert.deepEqual(
      groups.map((g) => [g.strength, g.cards.map((c) => c.name)]),
      [['summary', ['韩厉', '反派']]]
    );
  });

  test('保留哪一张的按钮里真名那张排第一，哪怕称谓卡戏份多', () => {
    const ask = confirms.find((c) => c.message.startsWith('合并'));
    assert.deepEqual(ask?.actions, ['保留「韩厉」', '保留「反派」']);
  });

  test('合并后只剩真名卡与光称谓的那张；真名卡收下「头领」，不收「反派」', () => {
    assert.deepEqual(names, ['主角', '韩厉']);
    assert.deepEqual(keeper.aliases, ['头领']);
  });

  test('光称谓的那张写进了确认框，请作者改名或删掉', () => {
    const first = confirms.find((c) => c.message.includes('组疑似重复'));
    assert.match(first?.detail ?? '', /「主角」的名字是剧作称谓/);
  });
});

// ================================================================ 维护命令

describe('维护：清理别名', () => {
  let card;
  let beforeText;
  let afterText;
  let firstConfirms;
  let secondConfirms;
  let secondToasts;
  let calls;
  let snapshots;

  before(async () => {
    const project = new projectMod.NovelProject(t.dir);
    beforeText = t.read('.novelforge/characters/方源.md');
    h.expect('清理');
    calls = await spyWorkspace(['write'], () => maintenance.cleanCharacterAliases(project));
    afterText = t.read('.novelforge/characters/方源.md');
    snapshots = snapshotTexts('.novelforge/characters/方源.md');
    card = (await project.listCharacters()).find((c) => c.name === '方源');
    firstConfirms = [...h.confirms];

    // ---- 已经干净了就别再烦作者。
    h.expect();
    await maintenance.cleanCharacterAliases(project);
    secondConfirms = [...h.confirms];
    secondToasts = [...h.toasts];
  });

  test('泛称别名被删', () => {
    assert.ok(!card.aliases.includes('姐姐'), card.aliases.join('、'));
  });

  test('别人的正式名被删', () => {
    assert.ok(!card.aliases.includes('方正'), card.aliases.join('、'));
  });

  // 「古月方源」此刻也是另一张卡的正式名，同样会被删——那张卡是重复卡，
  // 该走合并流程解决，而合并的判据来自定稿过的细纲，不依赖这条别名。
  test('与另一张卡同名的别名也被删', () => {
    assert.ok(!card.aliases.includes('古月方源'), card.aliases.join('、'));
  });

  test('专属别名留着', () => {
    assert.ok(card.aliases.includes('方老魔女'), card.aliases.join('、'));
  });

  test('正文一个字节都没动', () => {
    assert.equal(
      afterText.slice(afterText.indexOf('# 方源')),
      beforeText.slice(beforeText.indexOf('# 方源'))
    );
  });

  test('动手前先报数', () => {
    assert.equal(firstConfirms.length, 1, JSON.stringify(firstConfirms.map((c) => c.message)));
    assert.ok(
      /个不该当别名的称呼/.test(firstConfirms[0].message),
      JSON.stringify(firstConfirms.map((c) => c.message))
    );
  });

  test('没得清理时不弹确认框', () => {
    assert.equal(secondConfirms.length, 0);
  });

  test('没得清理时明说', () => {
    assert.ok(secondToasts.some((x) => x.includes('无需清理')), secondToasts.join(' | '));
  });

  // 从前直接 writeText（grep 把这份源文件当成二进制跳过了，上一次普查没扫到）：不过守卫、覆盖之前不存历史。
  test('经网关写回（第 7 条）', () => {
    assert.ok(calls.some(([n, rel]) => n === 'write' && rel === '.novelforge/characters/方源.md'), JSON.stringify(calls));
  });

  test('清理之前的旧卡在历史版本里留了一份（删掉的称呼找得回来）', () => {
    assert.ok(snapshots.includes(beforeText), JSON.stringify(snapshots));
  });
});

describe('维护：合并重复卡', () => {
  let groups;
  let dup;
  let cards;
  let keeper;
  let inTrash;
  let index;
  let calls;

  before(async () => {
    const project = new projectMod.NovelProject(t.dir);
    groups = await maintenance.findDuplicateCards(project);
    dup = groups.find(
      (g) => g.cards.some((c) => c.name === '方源') && g.cards.some((c) => c.name === '古月方源')
    );

    h.expect('逐组处理', '保留「方源」');
    calls = await spyWorkspace(['write', 'remove'], () => maintenance.mergeDuplicateCharacterCards(project));
    cards = await project.listCharacters();
    keeper = cards.find((c) => c.name === '方源');
    inTrash =
      fs.existsSync(t.rel('.novelforge/.trash/.novelforge/characters/古月方源.md')) ||
      fs.existsSync(t.rel('.novelforge/.trash/characters/古月方源.md'));
    index = await castMod.buildCastIndex(project);
  });

  test('认出方源 / 古月方源是一组', () => {
    assert.ok(!!dup, JSON.stringify(groups.map((g) => g.cards.map((c) => c.name))));
  });

  test('这一组有定稿证据（strength 是 summary）', () => {
    assert.equal(dup && dup.strength, 'summary', dup && dup.strength);
  });

  test('绝不把方源和方正列成一组', () => {
    assert.ok(
      !groups.some((g) => g.cards.some((c) => c.name === '方源') && g.cards.some((c) => c.name === '方正')),
      JSON.stringify(groups.map((g) => g.cards.map((c) => c.name)))
    );
  });

  test('被合并的卡不在角色区了', () => {
    assert.ok(!cards.some((c) => c.name === '古月方源'), cards.map((c) => c.name).join('、'));
  });

  test('搬进了回收站而不是真删', () => {
    assert.ok(
      inTrash,
      fs.existsSync(t.rel('.novelforge/.trash'))
        ? fs.readdirSync(t.rel('.novelforge/.trash')).join('、')
        : '（没有回收站）'
    );
  });

  test('保留卡吸收了别名', () => {
    assert.ok(keeper.aliases.includes('古月方源'), keeper.aliases.join('、'));
  });

  test('保留卡的正文没被重渲染', () => {
    assert.ok(t.read('.novelforge/characters/方源.md').includes('作者手写的这一段一个字都不许动'));
  });

  test('保留卡经网关写回、被合并的卡经网关删（第 7 条）', () => {
    assert.ok(calls.some(([n, rel]) => n === 'write' && rel === '.novelforge/characters/方源.md'), JSON.stringify(calls));
    assert.ok(calls.some(([n, rel]) => n === 'remove' && rel === '.novelforge/characters/古月方源.md'), JSON.stringify(calls));
  });

  test('被合并的卡在回收站里保留原相对路径（第 6 条）', () => {
    assert.ok(fs.existsSync(t.rel('.novelforge/.trash/.novelforge/characters/古月方源.md')));
  });

  test('合并后不再有抢名冲突', () => {
    assert.ok(!index.conflicts.some((c) => c.kind === 'name'), JSON.stringify(index.conflicts));
  });
});

describe('「已读到」水位线', () => {
  let groups;
  let keeper;

  before(async () => {
    // 合并进来的章节从没被保留卡读过，水位线必须退回它们之前，
    // 否则增量更新会整批跳过，而界面上看不出任何异常。
    // 这一对在定稿里一次都没出现，走的是「名字包含」那条弱提示。
    t.remove('.novelforge/characters');
    makeCard('张三', [], { appearsIn: [10, 11], updatedThrough: 11, firstAppear: 10, lastSeen: 11 });
    makeCard('古月张三', [], { appearsIn: [4, 5], updatedThrough: 5, firstAppear: 4, lastSeen: 5 });
    const project = new projectMod.NovelProject(t.dir);
    groups = await maintenance.findDuplicateCards(project);
    h.expect('逐组处理', '保留「张三」');
    await maintenance.mergeDuplicateCharacterCards(project);
    keeper = (await project.listCharacters()).find((c) => c.name === '张三');
  });

  test('名字包含只算弱提示', () => {
    assert.ok(
      groups.length === 1 && groups[0].strength === 'naming',
      JSON.stringify(groups.map((g) => [g.strength, g.cards.map((c) => c.name)]))
    );
  });

  test('出场章节取并集', () => {
    assert.equal(keeper.appearsIn.join(','), '4,5,10,11', keeper.appearsIn.join(','));
  });

  test('水位线退回第一章没读过的之前', () => {
    assert.equal(keeper.updatedThrough, 3, String(keeper.updatedThrough));
  });
});

describe('同一张卡出现在两组候选里', () => {
  let groupCount;
  let names;
  let confirms;

  before(async () => {
    // `家老` 同时是 `学堂家老` 与 `暗堂家老` 的后缀，于是它落进两组候选。
    // 第一组把它并掉之后，第二组轮到它时文件已经不在了——不能因此炸掉。
    t.remove('.novelforge/characters');
    makeCard('家老', [], { appearsIn: [1], updatedThrough: 1, firstAppear: 1, lastSeen: 1 });
    makeCard('学堂家老', [], { appearsIn: [2, 3], updatedThrough: 3, firstAppear: 2, lastSeen: 3 });
    makeCard('暗堂家老', [], { appearsIn: [4], updatedThrough: 4, firstAppear: 4, lastSeen: 4 });
    const project = new projectMod.NovelProject(t.dir);
    groupCount = (await maintenance.findDuplicateCards(project)).length;
    h.expect('逐组处理', '保留「学堂家老」');
    await maintenance.mergeDuplicateCharacterCards(project);
    names = (await project.listCharacters()).map((c) => c.name);
    confirms = [...h.confirms];
  });

  test('两组候选都列出来', () => {
    assert.equal(groupCount, 2);
  });

  test('第一组合并成功', () => {
    assert.ok(!names.includes('家老'), names.join('、'));
  });

  test('第二组因缺卡自动跳过而非报错', () => {
    assert.ok(names.includes('暗堂家老'), names.join('、'));
  });

  // 名字说「一次」而断言是 2：第一次是「怎么处理这批候选」的总确认，
  // 第二次才是逐组确认；第二组因为卡没了根本没弹。原样迁移，不改断言。
  test('只弹了一次逐组确认', () => {
    assert.equal(confirms.length, 2, JSON.stringify(confirms.map((c) => c.message)));
  });
});

describe('rewriteFrontmatter', () => {
  let out;
  let block;

  before(() => {
    const text = '---\nname: 甲\naliases: [a, b]\n---\n\n# 甲\n\n正文  两个空格结尾  \n';
    out = markdown.rewriteFrontmatter(text, { aliases: ['a'] });
    block = markdown.rewriteFrontmatter('---\naliases:\n  - a\n  - b\n---\n\n正文\n', { aliases: ['c'] });
  });

  test('只改目标字段', () => {
    assert.ok(out.includes('aliases: [a]') && out.includes('name: 甲'), out);
  });

  test('正文逐字保留', () => {
    assert.ok(out.endsWith('# 甲\n\n正文  两个空格结尾  \n'), JSON.stringify(out));
  });

  test('没有 frontmatter 时返回 undefined', () => {
    assert.equal(markdown.rewriteFrontmatter('# 甲\n\n正文\n', { aliases: [] }), undefined);
  });

  test('块状数组写法也认', () => {
    assert.ok(block.includes('aliases: [c]') && !block.includes('- a'), block);
  });
});
