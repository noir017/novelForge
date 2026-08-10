/**
 * 「谁是谁」这条链路的离线验证：泛称过滤、同一人聚类、出场索引、维护命令。
 *
 * 这条链路是一次实战事故的产物——摘要里 `方源` 与 `古月方源` 交替出现，
 * 「全部建卡」于是给同一个人建了两张卡；与此同时 aliases 里堆满了 `她`、
 * `姐姐`、`少女`，其中还混进了她孪生弟弟的名字。
 *
 * 最要紧的一条断言是**反向**的：`方源` 与 `方正` 哪怕有一条别名把他们连起来，
 * 也必须仍然是两个人。把两个角色错并成一个，比多一张卡难收拾得多——此后
 * 所有出场统计与角色卡语料都是错的，而界面上看不出任何异常。
 *
 * 用法：node scripts/smoke-cast.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-cast-'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function loadBundle(entries) {
  const source = Object.entries(entries)
    .map(([name, relPath]) => `export * as ${name} from '${relPath}';`)
    .join('\n');
  const result = esbuild.buildSync({
    stdin: { contents: source, resolveDir: ROOT, sourcefile: 'bundle.ts', loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
  });
  const m = new Module('bundle.ts', null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, 'bundle.ts'));
  return m.exports;
}

const bundle = loadBundle({
  host: './src/core/host.ts',
  naming: './src/core/naming.ts',
  identity: './src/core/identity.ts',
  cast: './src/core/cast.ts',
  markdown: './src/core/model/markdown.ts',
  project: './src/core/model/project.ts',
  maintenance: './src/core/features/characterMaintenance.ts',
});
const { host: hostMod, naming, identity, cast: castMod, markdown, project: projectMod, maintenance } = bundle;

// ---------------------------------------------------------------- 假宿主

const answers = [];
const toasts = [];
const confirms = [];

hostMod.initHost({
  name: 'standalone',
  supportsVscodeLm: false,
  config: { read: () => ({ providers: [], models: [], concurrency: 1 }), write: async () => {} },
  input: async () => answers.shift(),
  confirm: async (message, actions, opts) => {
    confirms.push({ message, actions, detail: opts && opts.detail });
    return answers.shift();
  },
  pick: async () => answers.shift(),
  progress: async (_t, fn) => fn(new AbortController().signal, () => {}),
  watch: () => ({ dispose: () => {} }),
  openFile: async () => {},
  toast: (m, level) => toasts.push(`${level ?? 'info'}: ${m}`),
  selectionAttachment: async () => undefined,
});

function expect(...values) {
  answers.length = 0;
  toasts.length = 0;
  confirms.length = 0;
  answers.push(...values);
}

const rel = (...p) => path.join(WORK, ...p);
const write = (relPath, text) => {
  fs.mkdirSync(path.dirname(rel(relPath)), { recursive: true });
  fs.writeFileSync(rel(relPath), text, 'utf8');
};
const read = (relPath) => fs.readFileSync(rel(relPath), 'utf8');

/** 造一章正文 + 一份带 cast 的摘要。cast 用 `名(别名、别名)` 的写法。 */
function makeChapter(order, cast) {
  const n = String(order).padStart(3, '0');
  write(`chapters/${n}-第${order}章.md`, `# 第${order}章\n\n雨下了三天。\n`);
  write(
    `.novelforge/summaries/${n}-第${order}章.md`,
    `---\norder: ${order}\ntitle: 第${order}章\nsourceHash: x\ncast: [${cast.join(', ')}]\n---\n\n` +
      `# 第${order}章 · 摘要\n\n## 梗概\n\n略。\n\n## 出场人物\n\n${cast.join('、')}\n`
  );
}

function makeCard(name, aliases, extra = {}) {
  const fm = [
    `name: ${name}`,
    `aliases: [${aliases.join(', ')}]`,
    'tags: [配角]',
    ...Object.entries(extra).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`),
  ].join('\n');
  write(
    `.novelforge/characters/${name}.md`,
    `---\n${fm}\n---\n\n# ${name}\n\n## 身份\n\n作者手写的这一段一个字都不许动。\n`
  );
}

async function main() {
  console.log(`\n工作目录：${WORK}\n`);

  // ================================================================ 泛称过滤
  console.log('== 别名：什么算专属称呼 ==');
  {
    const generic = ['她', '姐姐', '少女', '丫头', '小姐', '公子', '学妹', '小丫头', '臭丫头',
      '这位小姐', '此女', '本届状元', '满身血迹的少女', '好运的小丫头', '小崽子', '小狼崽子',
      '少女新人', '中年男人', '舅父', '心腹之士'];
    const proper = ['方老魔女', '魔头', '古月方源', '魔道巨擘', '方源妹子', '赤城少爷',
      '贾公子', '甘德·奥塔', '店小二', '家老', '房东', '族长'];
    const keptGeneric = generic.filter((w) => !naming.isGenericAppellation(w));
    const droppedProper = proper.filter((w) => naming.isGenericAppellation(w));
    check('泛称一个不留', keptGeneric.length === 0, keptGeneric.join('、'));
    check('专属称呼一个不丢', droppedProper.length === 0, droppedProper.join('、'));

    // 以泛称当正式名的角色确实存在（店小二、家老、房东），过滤只对别名生效。
    check('sanitizeAliases 去泛称、去本名、去重',
      JSON.stringify(naming.sanitizeAliases(['方老魔女', '姐姐', '方源', '她', '方老魔女', '古月方源'], '方源')) ===
        JSON.stringify(['方老魔女', '古月方源']));
    const dropped = naming.explainDroppedAliases(['姐姐', '她', '满身血迹的少女'], '方源');
    check('说得出为什么丢', dropped.length === 3 && dropped.every((d) => d.reason.length > 0),
      JSON.stringify(dropped));
  }

  // ================================================================ 同一人聚类
  console.log('\n== 聚类：同一人 / 两个人 ==');
  {
    // 同一个人两种写法交替出现——这正是当初一人两卡的成因。
    const res = identity.buildIdentityGroups([
      { order: 1, cast: [{ name: '方源', aliases: ['古月方源', '方老魔女'] }] },
      { order: 2, cast: [{ name: '古月方源', aliases: ['方源'] }] },
      { order: 3, cast: [{ name: '古月方源', aliases: [] }] },
    ]);
    check('两种写法归成一个人', res.groups.length === 1, JSON.stringify(res.groups));
    check('出场章节取并集', res.groups[0].chapters.join(',') === '1,2,3');
    check('展示名取领衔最多的写法', res.groups[0].primary === '古月方源', res.groups[0].primary);
  }
  {
    // ★ 回归：模型幻觉把孪生姐弟连起来，同章共现必须把它拦下。
    const res = identity.buildIdentityGroups([
      { order: 1, cast: [{ name: '方源', aliases: [] }, { name: '方正', aliases: [] }] },
      { order: 2, cast: [{ name: '方源', aliases: [] }, { name: '方正', aliases: [] }] },
      { order: 3, cast: [{ name: '方源', aliases: ['方正'] }] },
    ]);
    check('同章共现的两人绝不合并', res.groups.length === 2, JSON.stringify(res.groups.map((g) => g.names)));
    check('拦下的链接说得出理由',
      res.rejected.some((r) => r.reason.includes('同一章')), JSON.stringify(res.rejected));
    check('areDifferent 认得出这两人', res.areDifferent('方源', '方正') === true);
  }
  {
    // 从没共现过，但两边戏份都重、只有一章说他们是同一人 → 证据不足。
    const chapters = [];
    for (let i = 1; i <= 3; i++) chapters.push({ order: i, cast: [{ name: '甲', aliases: [] }] });
    for (let i = 4; i <= 6; i++) chapters.push({ order: i, cast: [{ name: '乙', aliases: [] }] });
    chapters.push({ order: 7, cast: [{ name: '甲', aliases: ['乙'] }] });
    const res = identity.buildIdentityGroups(chapters);
    check('重要角色之间单票不足以合并', res.groups.length === 2,
      JSON.stringify(res.groups.map((g) => g.names)));
    // 补一票就够了：两章都这么说，那就是同一个人。
    chapters.push({ order: 8, cast: [{ name: '甲', aliases: ['乙'] }] });
    check('两票就合并', identity.buildIdentityGroups(chapters).groups.length === 1);
  }
  {
    // 泛称不能当判据，否则几个女角色会被 `姐姐` 串成一个。
    const res = identity.buildIdentityGroups([
      { order: 1, cast: [{ name: '甲', aliases: ['姐姐'] }] },
      { order: 2, cast: [{ name: '乙', aliases: ['姐姐'] }] },
    ]);
    check('泛称别名不把两个人串起来', res.groups.length === 2,
      JSON.stringify(res.groups.map((g) => g.names)));
  }

  // ================================================================ 出场索引
  console.log('\n== 出场索引 ==');
  {
    fs.rmSync(rel('.novelforge'), { recursive: true, force: true });
    fs.rmSync(rel('chapters'), { recursive: true, force: true });
    write('.novelforge/project.md', '---\ntitle: 测\n---\n\n# 测\n');
    makeChapter(1, ['方源(古月方源、姐姐)', '方正']);
    makeChapter(2, ['古月方源(方源)', '方正']);
    makeChapter(3, ['古月方源']);
    const project = new projectMod.NovelProject(WORK);

    // ---- 一张卡都没有：两种写法只该冒出一个「未建卡」的人。
    let index = await castMod.buildCastIndex(project);
    const fangyuan = index.unknown.filter((m) => m.name.includes('方源'));
    check('未建卡的同一人只出现一次', fangyuan.length === 1,
      index.unknown.map((m) => m.name).join('、'));
    check('出场章节合到一起', fangyuan[0] && fangyuan[0].chapters.join(',') === '1,2,3',
      fangyuan[0] && fangyuan[0].chapters.join(','));
    check('方正仍是独立的一个人', index.unknown.some((m) => m.name === '方正'));

    // ---- 正式名压过别名：方源的卡上错挂了 `方正`，抢不走方正的章节。
    makeCard('方源', ['方老魔女', '古月方源', '方正', '姐姐']);
    makeCard('方正', []);
    project.invalidate();
    index = await castMod.buildCastIndex(project);
    const byName = (n) => index.known.find((m) => m.card.name === n);
    check('方正的章节记在方正名下', byName('方正').chapters.join(',') === '1,2',
      byName('方正').chapters.join(','));
    check('方源不多吃方正的章节', byName('方源').chapters.join(',') === '1,2,3',
      byName('方源').chapters.join(','));
    check('别名撞正式名记进 conflicts',
      index.conflicts.some((c) => c.name === '方正' && c.kind === 'alias'),
      JSON.stringify(index.conflicts));

    // ---- 同一个人两张卡：名字不同、别名互指，两个方向都要报出来。
    makeCard('古月方源', ['方源']);
    project.invalidate();
    index = await castMod.buildCastIndex(project);
    const crossed = index.conflicts.filter(
      (c) => (c.name === '古月方源' || c.name === '方源') && c.slugs.length >= 2
    );
    check('一人两卡的互指冲突被记下', crossed.length === 2, JSON.stringify(index.conflicts));
  }

  // ================================================================ 维护命令
  console.log('\n== 维护：清理别名 ==');
  {
    const project = new projectMod.NovelProject(WORK);
    const before = read('.novelforge/characters/方源.md');
    expect('清理');
    await maintenance.cleanCharacterAliases(project);
    const after = read('.novelforge/characters/方源.md');
    const card = (await project.listCharacters()).find((c) => c.name === '方源');
    check('泛称别名被删', !card.aliases.includes('姐姐'), card.aliases.join('、'));
    check('别人的正式名被删', !card.aliases.includes('方正'), card.aliases.join('、'));
    // 「古月方源」此刻也是另一张卡的正式名，同样会被删——那张卡是重复卡，
    // 该走合并流程解决，而合并的判据来自摘要，不依赖这条别名。
    check('与另一张卡同名的别名也被删', !card.aliases.includes('古月方源'), card.aliases.join('、'));
    check('专属别名留着', card.aliases.includes('方老魔女'), card.aliases.join('、'));
    check('正文一个字节都没动',
      after.slice(after.indexOf('# 方源')) === before.slice(before.indexOf('# 方源')));
    check('动手前先报数', confirms.length === 1 && /个不该当别名的称呼/.test(confirms[0].message),
      JSON.stringify(confirms.map((c) => c.message)));

    // ---- 已经干净了就别再烦作者。
    expect();
    await maintenance.cleanCharacterAliases(project);
    check('没得清理时不弹确认框', confirms.length === 0);
    check('没得清理时明说', toasts.some((t) => t.includes('无需清理')), toasts.join(' | '));
  }

  console.log('\n== 维护：合并重复卡 ==');
  {
    const project = new projectMod.NovelProject(WORK);
    const groups = await maintenance.findDuplicateCards(project);
    const dup = groups.find((g) => g.cards.some((c) => c.name === '方源') && g.cards.some((c) => c.name === '古月方源'));
    check('认出方源 / 古月方源是一组', !!dup, JSON.stringify(groups.map((g) => g.cards.map((c) => c.name))));
    check('这一组有摘要证据', dup && dup.strength === 'summary', dup && dup.strength);
    check('绝不把方源和方正列成一组',
      !groups.some((g) => g.cards.some((c) => c.name === '方源') && g.cards.some((c) => c.name === '方正')),
      JSON.stringify(groups.map((g) => g.cards.map((c) => c.name))));

    expect('逐组处理', '保留「方源」');
    await maintenance.mergeDuplicateCharacterCards(project);
    const cards = await project.listCharacters();
    check('被合并的卡不在角色区了', !cards.some((c) => c.name === '古月方源'),
      cards.map((c) => c.name).join('、'));
    check('搬进了回收站而不是真删',
      fs.existsSync(rel('.novelforge/.trash/.novelforge/characters/古月方源.md')) ||
        fs.existsSync(rel('.novelforge/.trash/characters/古月方源.md')),
      fs.existsSync(rel('.novelforge/.trash')) ? fs.readdirSync(rel('.novelforge/.trash')).join('、') : '（没有回收站）');
    const keeper = cards.find((c) => c.name === '方源');
    check('保留卡吸收了别名', keeper.aliases.includes('古月方源'), keeper.aliases.join('、'));    check('保留卡的正文没被重渲染',
      read('.novelforge/characters/方源.md').includes('作者手写的这一段一个字都不许动'));
    const index = await castMod.buildCastIndex(project);
    check('合并后不再有抢名冲突',
      !index.conflicts.some((c) => c.kind === 'name'), JSON.stringify(index.conflicts));
  }

  console.log('\n== 「已读到」水位线 ==');
  {
    // 合并进来的章节从没被保留卡读过，水位线必须退回它们之前，
    // 否则增量更新会整批跳过，而界面上看不出任何异常。
    // 这一对在摘要里一次都没出现，走的是「名字包含」那条弱提示。
    fs.rmSync(rel('.novelforge/characters'), { recursive: true, force: true });
    makeCard('张三', [], { appearsIn: [10, 11], updatedThrough: 11, firstAppear: 10, lastSeen: 11 });
    makeCard('古月张三', [], { appearsIn: [4, 5], updatedThrough: 5, firstAppear: 4, lastSeen: 5 });
    const project = new projectMod.NovelProject(WORK);
    const groups = await maintenance.findDuplicateCards(project);
    check('名字包含只算弱提示', groups.length === 1 && groups[0].strength === 'naming',
      JSON.stringify(groups.map((g) => [g.strength, g.cards.map((c) => c.name)])));
    expect('逐组处理', '保留「张三」');
    await maintenance.mergeDuplicateCharacterCards(project);
    const keeper = (await project.listCharacters()).find((c) => c.name === '张三');
    check('出场章节取并集', keeper.appearsIn.join(',') === '4,5,10,11', keeper.appearsIn.join(','));
    check('水位线退回第一章没读过的之前', keeper.updatedThrough === 3, String(keeper.updatedThrough));
  }

  console.log('\n== 同一张卡出现在两组候选里 ==');
  {
    // `家老` 同时是 `学堂家老` 与 `暗堂家老` 的后缀，于是它落进两组候选。
    // 第一组把它并掉之后，第二组轮到它时文件已经不在了——不能因此炸掉。
    fs.rmSync(rel('.novelforge/characters'), { recursive: true, force: true });
    makeCard('家老', [], { appearsIn: [1], updatedThrough: 1, firstAppear: 1, lastSeen: 1 });
    makeCard('学堂家老', [], { appearsIn: [2, 3], updatedThrough: 3, firstAppear: 2, lastSeen: 3 });
    makeCard('暗堂家老', [], { appearsIn: [4], updatedThrough: 4, firstAppear: 4, lastSeen: 4 });
    const project = new projectMod.NovelProject(WORK);
    check('两组候选都列出来', (await maintenance.findDuplicateCards(project)).length === 2);
    expect('逐组处理', '保留「学堂家老」');
    await maintenance.mergeDuplicateCharacterCards(project);
    const names = (await project.listCharacters()).map((c) => c.name);
    check('第一组合并成功', !names.includes('家老'), names.join('、'));
    check('第二组因缺卡自动跳过而非报错', names.includes('暗堂家老'), names.join('、'));
    check('只弹了一次逐组确认', confirms.length === 2, JSON.stringify(confirms.map((c) => c.message)));
  }

  console.log('\n== rewriteFrontmatter ==');
  {
    const text = '---\nname: 甲\naliases: [a, b]\n---\n\n# 甲\n\n正文  两个空格结尾  \n';
    const out = markdown.rewriteFrontmatter(text, { aliases: ['a'] });
    check('只改目标字段', out.includes('aliases: [a]') && out.includes('name: 甲'), out);
    check('正文逐字保留', out.endsWith('# 甲\n\n正文  两个空格结尾  \n'), JSON.stringify(out));
    check('没有 frontmatter 时返回 undefined',
      markdown.rewriteFrontmatter('# 甲\n\n正文\n', { aliases: [] }) === undefined);
    const block = markdown.rewriteFrontmatter('---\naliases:\n  - a\n  - b\n---\n\n正文\n', { aliases: ['c'] });
    check('块状数组写法也认', block.includes('aliases: [c]') && !block.includes('- a'), block);
  }

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
