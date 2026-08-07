/**
 * 「更新角色卡」的离线验证：在临时工程上跑分批、增量/全量、失败降级。
 *
 * 这条流程是唯一一处「一次动作要调 N 次模型」的地方，N 由上下文预算算出，
 * 且要在动手前告诉作者。这些都不能靠手测——章节一多就要造几十万字语料。
 * 所以这里用假 provider（记录每次收到什么、按脚本返回什么）跑完整流程。
 *
 * 用法：node scripts/smoke-characterCard.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-charcard-'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 要用 Host / registry 模块级状态的模块必须打进同一个 bundle。 */
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
  project: './src/core/model/project.ts',
  cast: './src/core/cast.ts',
  characterCard: './src/core/features/characterCard.ts',
  registry: './src/core/llm/registry.ts',
});

const { host: hostMod, project: projectMod, cast: castMod, characterCard: cardMod, registry } = bundle;

// ---------------------------------------------------------------- 假宿主

const answers = [];
const toasts = [];
const confirms = [];
let reviewVerdict = 'apply';
const reviewed = [];

const fakeHost = {
  name: 'standalone',
  supportsVscodeLm: true,
  config: {
    read: () => ({
      // 用 vscode-lm 这个 kind：它是唯一一条走 registerProviderFactory 的路径，
      // 于是不必碰 SecretStore 就能塞进假模型（其余 kind 会去要 API Key）。
      providers: [{ id: 'fake', kind: 'vscode-lm', models: [{ name: 'm' }] }],
      model: 'fake/m',
      // 窗口刻意开得小，好让几章正文就撑出多批来。
      contextWindow: 4000,
      maxOutputTokens: 500,
    }),
    write: async () => {},
  },
  input: async () => answers.shift(),
  confirm: async (message, actions) => {
    confirms.push({ message, actions });
    return answers.shift();
  },
  pick: async () => answers.shift(),
  progress: async (_t, fn) => fn(new AbortController().signal, () => {}),
  watch: () => ({ dispose: () => {} }),
  openFile: async () => {},
  toast: (m, level) => toasts.push(`${level ?? 'info'}: ${m}`),
  selectionAttachment: async () => undefined,
  reviewReplace: async (name, current, proposed) => {
    reviewed.push({ name, current, proposed });
    return reviewVerdict;
  },
};
hostMod.initHost(fakeHost);

// ---------------------------------------------------------------- 假模型

/** 每次 chatStream 收到的消息，供断言「上下文里到底装了什么」。 */
const calls = [];
/** 下一批要返回什么；用完后循环用最后一个。 */
let replies = [];

function cardJson(overrides) {
  return JSON.stringify({
    aliases: [],
    tags: ['主角'],
    身份: '幸存者',
    外貌: '',
    性格: '沉默寡言',
    语言习惯: '答话极短',
    人物关系: '',
    当前状态: '在客栈',
    未收伏笔: '',
    ...overrides,
  });
}

// 假模型经 registerProviderFactory 注入——这是 core 本来就有的注册点
// （VS Code 壳用它挂 Copilot），不必为测试在 registry 里开后门。
registry.registerProviderFactory(() => ({
  id: 'vscode-lm',
  label: '假模型',
  maxInputTokens: async () => undefined,
  chatStream: async function* (messages) {
    calls.push(messages);
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    yield reply ?? cardJson();
  },
}));

function expect(...values) {
  answers.length = 0;
  toasts.length = 0;
  confirms.length = 0;
  calls.length = 0;
  reviewed.length = 0;
  answers.push(...values);
}

const rel = (...p) => path.join(WORK, ...p);
const write = (relPath, text) => {
  fs.mkdirSync(path.dirname(rel(relPath)), { recursive: true });
  fs.writeFileSync(rel(relPath), text, 'utf8');
};
const read = (relPath) => fs.readFileSync(rel(relPath), 'utf8');

/** 造一章 `words` 字的正文，并写一份带 cast 的摘要。 */
function makeChapter(order, title, cast, words = 400) {
  const pad = '雨下了三天，石板路泡得发白。'.repeat(Math.ceil(words / 14)).slice(0, words);
  write(`chapters/${String(order).padStart(3, '0')}-${title}.md`, `# ${title}\n\n${pad}\n`);
  write(
    `.novelforge/summaries/${String(order).padStart(3, '0')}.md`,
    `---\norder: ${order}\ntitle: ${title}\nsourceHash: x\ncast: [${cast.join(', ')}]\n---\n\n` +
      `# 第${order}章 ${title} · 摘要\n\n## 梗概\n\n略。\n\n## 出场人物\n\n${cast.join('、')}\n`
  );
}

async function main() {
  const project = projectMod.NovelProject.open(WORK);
  await project.initialize({ title: '角色卡测试', author: '测试' });
  fs.rmSync(rel('.novelforge/characters/example-protagonist.md'), { force: true });
  fs.rmSync(rel('.novelforge/lore/example-setting.md'), { force: true });

  // 林昭出场 1、2、4、5 章；沈氏只在第 3 章；「客栈掌柜」全程没有角色卡。
  makeChapter(1, '楔子', ['林昭', '客栈掌柜']);
  makeChapter(2, '入镇', ['林昭']);
  makeChapter(3, '夜谈', ['沈氏', '客栈掌柜']);
  makeChapter(4, '追兵', ['林昭']);
  makeChapter(5, '渡口', ['林昭']);
  write(
    '.novelforge/characters/林昭.md',
    '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n（待补充）\n'
  );
  project.invalidate();

  console.log('\n== 分批与「预计调用次数」 ==');
  {
    expect('开始');
    replies = [cardJson()];
    await cardMod.updateCharacterCard(project, '.novelforge/characters/林昭.md', 'full');

    // 4000 的窗口装不下 4 章 400 字的正文，必须分批。
    check('分成了多批', calls.length > 1, `只调了 ${calls.length} 次`);
    const ask = confirms.find((c) => c.message.includes('预计调用模型'));
    check('动手前问过用户', !!ask, JSON.stringify(confirms.map((c) => c.message)));
    check('确认框写明预计调用次数',
      ask && ask.message.includes(`预计调用模型 ${calls.length} 次`),
      ask && ask.message);
    check('确认框写明要读几章', ask && ask.message.includes('通读 4 章'), ask && ask.message);

    // 只读该角色出场的那 4 章，第 3 章（沈氏）不该进来。
    const corpus = calls.map((m) => m[1].content).join('\n');
    check('只装该角色的出场章节', !corpus.includes('夜谈'), '第 3 章不该出现');
    check('装进了他出场的章节',
      ['楔子', '入镇', '追兵', '渡口'].every((t) => corpus.includes(t)));

    // 后一批要看得到前一批的产出，否则就成了各写各的。
    check('后续批次带上当前档案',
      calls[1][1].content.includes('当前的角色档案') && calls[1][1].content.includes('沉默寡言'),
      calls[1][1].content.slice(0, 200));
    check('提示词要求控制篇幅',
      calls[0][0].content.includes('精炼') && calls[0][0].content.includes('字以内'));
    check('提示词点名性格与语言习惯优先',
      calls[0][0].content.includes('「性格」和「语言习惯」'));

    check('走了 diff 审阅', reviewed.length === 1, String(reviewed.length));
    const card = read('.novelforge/characters/林昭.md');
    check('写回了模型产出', card.includes('沉默寡言'), card.slice(0, 200));
    check('回写出场章节', card.includes('appearsIn: [1, 2, 4, 5]'), card.split('\n')[5]);
    check('记下读到第几章', card.includes('updatedThrough: 5'), card);
    check('保留作者写的别名', card.includes('阿昭'));
  }

  console.log('\n== 增量更新 ==');
  {
    project.invalidate();
    makeChapter(6, '新章', ['林昭']);
    project.invalidate();

    expect('开始');
    replies = [cardJson({ 当前状态: '已渡河' })];
    await cardMod.updateCharacterCard(project, '.novelforge/characters/林昭.md', 'incremental');

    const corpus = calls.map((m) => m[1].content).join('\n');
    check('增量只读新章节', corpus.includes('新章'), corpus.slice(0, 100));
    check('增量不重读旧章节', !corpus.includes('楔子') && !corpus.includes('渡口'));
    check('增量只调一次模型', calls.length === 1, String(calls.length));
    const card = read('.novelforge/characters/林昭.md');
    check('增量后 updatedThrough 前进', card.includes('updatedThrough: 6'), card);
    check('增量后 appearsIn 含新章', card.includes('6'), card);
    check('增量写入了新内容', card.includes('已渡河'));

    // 没有新章节时不该白跑一次模型。
    expect();
    await cardMod.updateCharacterCard(project, '.novelforge/characters/林昭.md', 'incremental');
    check('没有新章节时不调模型', calls.length === 0, String(calls.length));
    check('没有新章节时明说', toasts.some((t) => t.includes('没有新的出场章节')), toasts.join(' | '));
  }

  console.log('\n== 解析失败与取消 ==');
  {
    // 某一批解析失败：其余批的成果照样写回，但 updatedThrough 不能跳过失败的章。
    // 这里让第一批失败、后面成功——若把 updatedThrough 推到最后一章，
    // 第 1、2 章就再也不会被读到了。
    makeChapter(7, '第七', ['林昭']);
    makeChapter(8, '第八', ['林昭']);
    project.invalidate();
    fs.writeFileSync(
      rel('.novelforge/characters/林昭.md'),
      '---\nname: 林昭\naliases: [阿昭]\ntags: [主角]\nappearsIn: [1, 2, 4, 5, 6]\nupdatedThrough: 0\n---\n\n# 林昭\n\n## 身份\n\n旧的\n',
      'utf8'
    );
    expect('开始');
    replies = ['模型答非所问，完全不是 JSON', cardJson({ 身份: '新的' })];
    await cardMod.updateCharacterCard(project, '.novelforge/characters/林昭.md', 'full');
    const card = read('.novelforge/characters/林昭.md');
    check('部分失败仍写回成功的部分', card.includes('新的'), card.slice(0, 300));
    // 第一批（含第 1、2 章）失败 → 水位线必须停在 0，否则那两章被永久跳过。
    const line = card.split('\n').find((l) => l.startsWith('updatedThrough'));
    check('水位线停在第一个失败章节之前', line === 'updatedThrough: 0', line);

    // 全部失败：不改卡、不推进 updatedThrough、明确报错。
    const before = read('.novelforge/characters/林昭.md');
    expect('开始');
    replies = ['还是不是 JSON'];
    await cardMod.updateCharacterCard(project, '.novelforge/characters/林昭.md', 'full');
    check('全部失败时角色卡一字不改', read('.novelforge/characters/林昭.md') === before);
    check('全部失败时不弹审阅', reviewed.length === 0, String(reviewed.length));
    check('全部失败时报错', toasts.some((t) => t.startsWith('error:')), toasts.join(' | '));

    // 用户在确认框点取消：一次模型都不该调。
    expect(undefined);
    replies = [cardJson()];
    await cardMod.updateCharacterCard(project, '.novelforge/characters/林昭.md', 'full');
    check('用户取消则不调模型', calls.length === 0, String(calls.length));

    // 审阅时放弃：卡不变。
    const kept = read('.novelforge/characters/林昭.md');
    reviewVerdict = 'discard';
    expect('开始');
    replies = [cardJson({ 身份: '不该写进去' })];
    await cardMod.updateCharacterCard(project, '.novelforge/characters/林昭.md', 'full');
    check('审阅放弃则不落盘', read('.novelforge/characters/林昭.md') === kept);
    reviewVerdict = 'apply';
  }

  console.log('\n== 摘要里没有的角色 ==');
  {
    write('.novelforge/characters/幽灵.md', '---\nname: 幽灵\n---\n\n# 幽灵\n');
    project.invalidate();
    expect('开始');
    replies = [cardJson()];
    await cardMod.updateCharacterCard(project, '.novelforge/characters/幽灵.md', 'full');
    check('没出场的角色不调模型', calls.length === 0, String(calls.length));
    check('没出场的角色明确报错',
      toasts.some((t) => t.startsWith('error:') && t.includes('幽灵')), toasts.join(' | '));
  }

  console.log('\n== 给未建卡的人物建卡 ==');
  {
    project.invalidate();
    const before = await project.listCharacters();
    expect('开始');
    replies = [cardJson({ 身份: '停舟客栈的掌柜' })];
    await cardMod.createCardForCast(project, '客栈掌柜');

    const after = await project.listCharacters();
    check('确实建出了一张卡', after.length === before.length + 1, `${before.length} → ${after.length}`);
    const created = after.find((c) => c.name === '客栈掌柜');
    check('新卡带出场章节', created && created.appearsIn.join(',') === '1,3', created && created.appearsIn.join(','));
    check('新卡填上了模型产出', created && created.sections.身份.includes('掌柜'), created && created.sections.身份);
    // 刚建出来的空卡没有作者写的内容，不必走 diff。
    check('新建卡不走 diff 审阅', reviewed.length === 0, String(reviewed.length));
    check('只读该人物的出场章节',
      calls.every((m) => !m[1].content.includes('入镇')),
      '第 2 章没有客栈掌柜');

    // 建完之后他就不该再出现在「未建卡」列表里了。
    project.invalidate();
    const index = await castMod.buildCastIndex(project);
    check('建卡后离开未建卡列表',
      !index.unknown.some((m) => m.name === '客栈掌柜'),
      index.unknown.map((m) => m.name).join('、'));
    check('建卡后进入已建卡列表',
      index.known.some((m) => m.card && m.card.name === '客栈掌柜'));

    // 摘要里已经没有的人不能凭空建卡。
    expect('开始');
    await cardMod.createCardForCast(project, '查无此人');
    check('摘要里没有的人不建卡', toasts.some((t) => t.startsWith('error:')), toasts.join(' | '));
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
