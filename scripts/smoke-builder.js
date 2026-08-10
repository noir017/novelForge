/**
 * builder.ts 的离线验证：用一个基于真实文件系统的 vscode API 桩，
 * 在 sample-novel 上跑完整的上下文装配，重点验证预算与降级链。
 *
 * 用法：node scripts/smoke-builder.js
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'sample-novel');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- vscode 桩

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

function makeUri(fsPath) {
  const normalized = fsPath.replace(/\\/g, '/');
  return {
    fsPath,
    path: normalized,
    scheme: 'file',
    toString: () => `file:///${normalized}`,
  };
}

let currentConfig = {};

const vscodeStub = {
  FileType,
  Uri: {
    file: (p) => makeUri(p),
    joinPath: (base, ...segs) => makeUri(path.join(base.fsPath, ...segs)),
  },
  workspace: {
    workspaceFolders: [{ uri: makeUri(SAMPLE), name: 'sample-novel' }],
    getConfiguration: () => ({
      get: (key, dflt) => (key in currentConfig ? currentConfig[key] : dflt),
    }),
    asRelativePath: (uri) => path.relative(SAMPLE, uri.fsPath).replace(/\\/g, '/'),
    fs: {
      readFile: async (uri) => new Uint8Array(fs.readFileSync(uri.fsPath)),
      writeFile: async (uri, bytes) => fs.writeFileSync(uri.fsPath, Buffer.from(bytes)),
      stat: async (uri) => {
        const s = fs.statSync(uri.fsPath);
        return { type: s.isDirectory() ? FileType.Directory : FileType.File, size: s.size };
      },
      readDirectory: async (uri) =>
        fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? FileType.Directory : FileType.File]),
      createDirectory: async (uri) => fs.mkdirSync(uri.fsPath, { recursive: true }),
      delete: async (uri) => fs.rmSync(uri.fsPath, { force: true }),
    },
  },
  window: { showErrorMessage: async () => undefined, showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
  commands: { executeCommand: async () => undefined },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  TreeItem: class {},
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ThemeColor: class {},
  MarkdownString: class { constructor(v) { this.value = v; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }; } cancel() {} dispose() {} },
  ProgressLocation: { Notification: 15 },
  ViewColumn: { One: 1, Beside: -2 },
};

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, ...args);
};

function loadModule(relPath) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
  });
  const m = new Module(relPath, null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, relPath));
  return m.exports;
}

const projectMod = loadModule('src/core/model/project.ts');
const builderMod = loadModule('src/core/context/builder.ts');
const tokenizerMod = loadModule('src/core/context/tokenizer.ts');
const projectViewMod = loadModule('src/core/projectView.ts');
const castMod = loadModule('src/core/cast.ts');

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

// ---------------------------------------------------------------- 请求构造
// 装配请求现在带 action（阶段 × 能力）与 target（在改哪个产物），
// 旧的 mode: 'write' | 'discuss' 对应正文阶段的 generate / discuss。
const WRITE = { stage: 'manuscript', capability: 'generate' };
const DISCUSS = { stage: 'manuscript', capability: 'discuss' };

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

async function main() {
  const project = projectMod.NovelProject.open(SAMPLE);

  console.log('\n== NovelProject 读取示例工程 ==');
  const chapters = await project.listChapters();
  check('扫描到 3 章', chapters.length === 3, `got ${chapters.length}`);
  check('章节按序号排序', chapters.map((c) => c.order).join(',') === '1,2,3');
  check('标题取自正文 H1', chapters[1].title === '客栈里的女人', chapters[1].title);
  check('字数统计合理', chapters[0].wordCount > 200 && chapters[0].wordCount < 600, String(chapters[0].wordCount));

  const stale = await project.staleChapters();
  check('示例工程无过期摘要', stale.length === 0, `stale: ${stale.map((c) => c.order).join(',')}`);

  const cards = await project.listCharacters();
  check('读到 4 张角色卡', cards.length === 4, `got ${cards.length}`);
  const lin = cards.find((c) => c.name === '林昭');
  check('林昭卡有别名', lin && lin.aliases.includes('阿昭'));
  check('林昭卡标记为主角', lin && lin.tags.includes('主角'));
  check('林昭卡「当前状态」非空', lin && lin.sections.当前状态.includes('停舟'));

  const lore = await project.listLore();
  check('读到 2 条设定', lore.length === 2, `got ${lore.length}`);
  check('设定有 keywords', lore.some((l) => l.keywords.includes('令牌')));

  const style = await project.readStyleGuide();
  check('读到文风指南', style.includes('禁用清单'));
  const global = await project.readGlobalSummary();
  check('读到全书摘要', global.includes('未收伏笔'));
  check('下一章序号为 4', (await project.nextChapterOrder()) === 4);

  // ------------------------------------------------------------ 充裕预算
  console.log('\n== 装配：预算充裕（128k） ==');
  const outline = '林昭答应给年轻守卫看令牌，两人约定天亮后去见他母亲。沈氏在楼下听见了动静。';
  const built = await builderMod.buildContext(project, req(outline, { targetWords: 2000 }), baseConfig);

  const byId = new Map(built.items.map((i) => [i.id, i]));
  const inc = (id) => byId.get(id) && (byId.get(id).status === 'included' || byId.get(id).status === 'degraded');

  check('P0 系统提示已注入', inc('system'));
  check('P0 纲要已注入', inc('ask'));
  check('P1 文风指南已注入', inc('style'));
  check('P1 全书摘要已注入', inc('globalSummary'));
  check('P3 第 3 章原文已注入', inc('chapterFull:3'));
  check('P3 第 2 章原文已注入', inc('chapterFull:2'));
  check('P4 第 1 章降级为摘要注入', inc('chapterSummary:1'));

  // 预算充裕时整章原文已含结尾，P0 的结尾片段应被撤掉以免重复。
  check('整章原文注入后结尾片段被撤销', byId.get('prevTail:3').status === 'dropped',
    byId.get('prevTail:3').status);
  check('撤销原因写明了重复', byId.get('prevTail:3').note.includes('无需重复'));
  check('第 3 章原文标注为接续点', byId.get('chapterFull:3').note.includes('续写将从此处接续'));
  const tailText = '雨已经停了。窗外月亮出来';
  const occurrences = built.messages[1].content.split(tailText).length - 1;
  check('上一章结尾在 prompt 中只出现一次', occurrences === 1, `got ${occurrences}`);
  check('user 含接续指示', built.messages[1].content.includes('无缝接下去'));

  check('纲要命中角色 林昭', inc('character:林昭'));
  check('纲要命中角色 沈氏', inc('character:沈氏'));
  check('纲要命中角色 年轻守卫', inc('character:年轻守卫'));
  check(
    '未命中的李叔以「第 N 章出场」或不注入',
    !byId.has('character:李叔') || byId.get('character:李叔').status !== undefined
  );
  check('命中角色带命中原因', byId.get('character:沈氏').note.includes('沈氏'));

  check('设定「崖字令牌」被关键词命中', inc('lore:崖字令牌'), '纲要含「令牌」');
  check('设定「青崖镇」未被误命中', !inc('lore:青崖镇'), '纲要不含青崖/停舟');

  check('用量不超预算', built.usedTokens <= built.budget, `${built.usedTokens} / ${built.budget}`);
  check('预算 = 窗口 - 输出 - 余量', built.budget === 128000 - 4096 - 512, String(built.budget));
  check('未被 provider 压缩', built.budgetClampedByProvider === false);

  // 消息结构
  check('消息为 system + user 两条', built.messages.length === 2, String(built.messages.length));
  check('首条为 system', built.messages[0].role === 'system');
  const user = built.messages[1].content;
  check('user 含文风指南段', user.includes('# 文风指南'));
  check('user 含前情提要段', user.includes('# 全书前情提要'));
  check('user 含角色设定段', user.includes('# 相关角色设定'));
  check('user 含纲要段', user.includes(outline));
  check('user 含目标字数', user.includes('2000 字'));
  check('user 末尾是写作指令', user.trimEnd().endsWith('保持一致。'));
  check('正文原文确实在 user 里', user.includes('三更，林昭醒了'), '第 3 章原文');
  check('章节按由远及近排列', user.indexOf('【第2章') < user.indexOf('【第3章'));

  // ------------------------------------------------------------ 降级链
  // 预算阈值由上一轮实测的条目大小反推，避免示例文本长度变化后测试失效。
  // 注意要把 P0~P2 已占用的量都算进去，否则轮到 P3 时剩余预算不是预期值。
  const sumTokens = (pred) => built.items.filter(pred).reduce((s, i) => s + i.tokens, 0);
  const p0Tokens = sumTokens((i) => i.priority === 0);
  const upToP2Tokens = sumTokens((i) => i.priority <= 2);
  const ch3Full = built.items.find((i) => i.id === 'chapterFull:3').tokens;
  const ch3Summary = (await project.readSummary((await project.listChapters()).find((c) => c.order === 3))).content;
  const ch3SummaryTokens = tokenizerMod.estimateTokens(`【第3章 夜访】\n${ch3Summary}`);

  console.log('\n== 装配：预算刚好放不下整章原文（应降级为摘要） ==');
  {
    // 关掉结尾片段，单独考察 chapterFull 的降级链。
    // 预算 = P0~P2 实占 + 介于「该章摘要」与「该章原文」之间的量。
    const mid = ch3SummaryTokens + Math.floor((ch3Full - ch3SummaryTokens) / 2);
    const window = upToP2Tokens + mid + 2000 + 512;
    const cfg = { ...baseConfig, prevChapterTailChars: 0, maxOutputTokens: 2000, contextWindow: window };
    const deg = await builderMod.buildContext(project, req(outline), cfg);
    const dById = new Map(deg.items.map((i) => [i.id, i]));

    check('结尾片段已关闭时不注入 prevTail', !dById.has('prevTail:3'));
    const item = dById.get('chapterFull:3');
    check('第 3 章原文降级为摘要', item.status === 'degraded',
      `status=${item.status}, full=${ch3Full}, summary=${ch3SummaryTokens}, budget=${deg.budget}, note=${item.note}`);
    check('降级后内容确实是摘要', item.text.includes('· 摘要】'), item.text.slice(0, 40));
    check('降级后不含原文句子', !item.text.includes('三更，林昭醒了'));
    check('降级说明写明了原因', item.note.includes('降级为摘要'), item.note);
    check('降级后 tokens 小于原文', item.tokens < ch3Full, `${item.tokens} vs ${ch3Full}`);
    check('降级项进入了 messages', deg.messages[1].content.includes(item.text.slice(0, 30)));
    check('用量不超预算', deg.usedTokens <= deg.budget, `${deg.usedTokens} / ${deg.budget}`);
  }

  console.log('\n== 装配：预算极小（P0 之外几乎全丢） ==');
  const tight = { ...baseConfig, contextWindow: 3000, maxOutputTokens: 2000, prevChapterTailChars: 300 };
  const small = await builderMod.buildContext(project, req(outline), tight);
  const sById = new Map(small.items.map((i) => [i.id, i]));

  check('P0 纲要仍然注入', sById.get('ask').status === 'included');
  check('P0 上一章结尾仍然注入', sById.get('prevTail:3').status === 'included',
    `status=${sById.get('prevTail:3').status}`);
  check('结尾片段确实带正文', sById.get('prevTail:3').text.includes('月亮出来'));
  check('user 含上一章结尾段', small.messages[1].content.includes('上一章结尾原文'));
  check('预算不足时整章原文不与结尾片段合并',
    sById.get('chapterFull:3').status === 'dropped', sById.get('chapterFull:3').status);
  const degradedOrDropped = small.items.filter((i) => i.status === 'degraded' || i.status === 'dropped');
  check('存在被降级/丢弃的条目', degradedOrDropped.length > 0, `got ${degradedOrDropped.length}`);
  check('每个降级/丢弃条目都带原因', degradedOrDropped.every((i) => !!i.note),
    JSON.stringify(degradedOrDropped.filter((i) => !i.note).map((i) => i.id)));
  check(
    '被丢弃的条目 tokens 归零',
    small.items.filter((i) => i.status === 'dropped').every((i) => i.tokens === 0)
  );
  check('被丢弃的条目 text 为空', small.items.filter((i) => i.status === 'dropped').every((i) => i.text === ''));
  check('丢弃项不进 messages', !small.messages[1].content.includes('三更，林昭醒了'));
  // 逐条核对：进 messages 的文本必须全部来自 included/degraded 条目
  const liveTexts = small.items
    .filter((i) => (i.status === 'included' || i.status === 'degraded') && i.text.trim())
    .map((i) => i.text);
  const droppedWithText = small.items.filter(
    (i) => (i.status === 'dropped' || i.status === 'excluded') && i.text.trim()
  );
  check('丢弃/排除项一律不带 text', droppedWithText.length === 0,
    JSON.stringify(droppedWithText.map((i) => i.id)));
  check('所有存活条目的文本都进了 messages',
    liveTexts.every((t) => small.messages.some((m) => m.content.includes(t.slice(0, 30)))));

  // ------------------------------------------------------------ 手动排除
  console.log('\n== 装配：手动排除条目 ==');
  const excluded = await builderMod.buildContext(
    project,
    req(outline, { excludedIds: ['style', 'character:沈氏', 'chapterFull:2'] }),
    baseConfig
  );
  const eById = new Map(excluded.items.map((i) => [i.id, i]));
  check('style 被标记 excluded', eById.get('style').status === 'excluded');
  check('沈氏被标记 excluded', eById.get('character:沈氏').status === 'excluded');
  check('第 2 章原文被标记 excluded', eById.get('chapterFull:2').status === 'excluded');
  check('excluded 项 tokens 为 0', eById.get('style').tokens === 0);
  check('excluded 项不进 messages', !excluded.messages[1].content.includes('# 文风指南'));
  check('排除后总用量下降', excluded.usedTokens < built.usedTokens, `${excluded.usedTokens} vs ${built.usedTokens}`);
  check('未被排除的项仍在', eById.get('character:林昭').status === 'included');

  // ------------------------------------------------------------ provider 配额
  console.log('\n== 装配：provider 配额压缩 ==');
  const clamped = await builderMod.buildContext(
    project,
    req(outline, { providerMaxInputTokens: 8000 }),
    baseConfig
  );
  check('标记为被 provider 压缩', clamped.budgetClampedByProvider === true);
  check('预算按 provider 上限算', clamped.budget === 8000 - 4096 - 512, String(clamped.budget));
  check('用量不超压缩后预算', clamped.usedTokens <= clamped.budget, `${clamped.usedTokens} / ${clamped.budget}`);

  // ------------------------------------------------------------ 重写
  console.log('\n== 装配：带修改意见重写 ==');
  const rev = await builderMod.buildContext(
    project,
    req(outline, {
      revision: { previousDraft: '上一版的正文内容，写得太文气了。', feedback: '对白改口语一些' },
    }),
    baseConfig
  );
  const rById = new Map(rev.items.map((i) => [i.id, i]));
  check('revision 条目已注入', rById.get('revision').status === 'included');
  check('user 含修订要求段', rev.messages[1].content.includes('# 修订要求'));
  check('user 含上一版草稿', rev.messages[1].content.includes('写得太文气了'));
  check('user 含修改意见', rev.messages[1].content.includes('对白改口语一些'));

  // ------------------------------------------------------------ 第一章场景
  console.log('\n== 装配：从第 1 章开始写（无前文） ==');
  const first = await builderMod.buildContext(
    project,
    req('开篇：主角进城。', { targetOrder: 1 }),
    baseConfig
  );
  const fById = new Map(first.items.map((i) => [i.id, i]));
  check('无前一章时不注入 prevTail', ![...fById.keys()].some((k) => k.startsWith('prevTail:')));
  check('无前文时不注入章节原文', ![...fById.keys()].some((k) => k.startsWith('chapterFull:')));
  check('仍然注入系统提示与纲要', fById.get('system').status === 'included' && fById.get('ask').status === 'included');
  check('仍然注入文风指南', fById.get('style').status === 'included');
  check('主角仍被注入（tags 含主角）', fById.get('character:林昭').status === 'included');
  check('主角注入原因为「主角，始终注入」', fById.get('character:林昭').note.includes('主角'));

  // ------------------------------------------------------------ 追加到已有章节
  console.log('\n== 装配：追加到第 3 章（targetOrder=3） ==');
  const append = await builderMod.buildContext(
    project,
    // 追加到已经落盘的第 3 章：target 指向它自己，序号由磁盘决定。
    req('接着写下去。', { target: { kind: 'manuscript', chapterRelPath: 'chapters/003-夜访.md' } }),
    baseConfig
  );
  const aById = new Map(append.items.map((i) => [i.id, i]));
  check('前文只取到第 2 章', aById.has('prevTail:2') && !aById.has('prevTail:3'));
  check('第 3 章自身不作为前文注入', !aById.has('chapterFull:3'));

  // ------------------------------------------------------------ 附件
  console.log('\n== 装配：用户 @ 的引用 ==');
  {
    const att = await builderMod.buildContext(
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
    const m = new Map(att.items.map((i) => [i.id, i]));
    check('选区附件已注入', m.get('attachment:sel1').status === 'included');
    check('选区用的是快照文本', m.get('attachment:sel1').text.includes('这是我选中的一段话'));
    check('文件附件读盘注入', m.get('attachment:file1').text.includes('林昭'));
    check('文件附件为 P0', m.get('attachment:file1').priority === 0);
    check('文件不存在时判 dropped', m.get('attachment:gone').status === 'dropped');
    check('缺失附件带原因', m.get('attachment:gone').note.includes('不存在'));
    check('user 含引用段', att.messages[att.messages.length - 1].content.includes('# 我引用的内容'));
    check('附件可被手动排除', (await builderMod.buildContext(project,
      req('x', { attachments: [{ id: 'sel1', kind: 'selection', label: 'a', text: '内容' }],
        excludedIds: ['attachment:sel1'] }), baseConfig))
      .items.find((i) => i.id === 'attachment:sel1').status === 'excluded');
  }

  console.log('\n== 装配：超大附件应截断而非丢弃 ==');
  {
    const huge = '很长的引用内容。'.repeat(4000);
    const att = await builderMod.buildContext(
      project,
      req('继续写。', { attachments: [{ id: 'big', kind: 'file', label: '大文件.md', text: huge }] }),
      { ...baseConfig, contextWindow: 20000, maxOutputTokens: 2000 }
    );
    const item = att.items.find((i) => i.id === 'attachment:big');
    check('超大附件降级而非丢弃', item.status === 'degraded', item.status);
    check('降级说明写明截断', item.note.includes('截断'), item.note);
    check('截断后不超过预算 35%', item.tokens <= Math.floor(att.budget * 0.35) + 5,
      `${item.tokens} vs ${Math.floor(att.budget * 0.35)}`);
    check('用量不超预算', att.usedTokens <= att.budget, `${att.usedTokens} / ${att.budget}`);
    check('前文仍有空间注入', att.items.some((i) => i.kind === 'chapterFull' && i.status !== 'dropped'));
  }

  // ------------------------------------------------------------ 多轮历史
  console.log('\n== 装配：多轮对话历史 ==');
  {
    const history = [
      { id: 'h1', role: 'user', content: '先写林昭进城。', at: '2026-08-01T10:00:00Z' },
      { id: 'h2', role: 'assistant', content: '林昭在辰时进了城门。', at: '2026-08-01T10:01:00Z' },
      { id: 'h3', role: 'user', content: '语气再冷一点。', at: '2026-08-01T10:02:00Z' },
    ];
    const conv = await builderMod.buildContext(
      project,
      req('接着写夜里的部分。', { history }),
      baseConfig
    );
    const m = new Map(conv.items.map((i) => [i.id, i]));
    check('三轮历史都已注入', ['h1', 'h2', 'h3'].every((h) => m.get(`history:${h}`).status === 'included'));
    check('历史为 P1', m.get('history:h1').priority === 1);
    check('历史明细按时间正序', conv.items.filter((i) => i.kind === 'history').map((i) => i.id).join(',')
      === 'history:h1,history:h2,history:h3');

    // 历史必须作为真正的多轮消息发出，而不是塞进一段文本
    check('消息数为 system + 3 轮历史 + 本轮', conv.messages.length === 5, String(conv.messages.length));
    check('历史保持 role 交替',
      conv.messages.slice(1, 4).map((m) => m.role).join(',') === 'user,assistant,user',
      conv.messages.slice(1, 4).map((m) => m.role).join(','));
    check('历史内容原样', conv.messages[2].content === '林昭在辰时进了城门。');
    check('本轮在最后一条', conv.messages[4].content.includes('接着写夜里的部分'));
    check('历史不重复出现在本轮文本里', !conv.messages[4].content.includes('语气再冷一点'));

    const someExcluded = await builderMod.buildContext(
      project,
      req('x', { history, excludedIds: ['history:h2'] }),
      baseConfig
    );
    check('历史可被手动排除',
      someExcluded.items.find((i) => i.id === 'history:h2').status === 'excluded');
    check('排除后该轮不进 messages',
      !someExcluded.messages.some((m) => m.content === '林昭在辰时进了城门。'));
  }

  console.log('\n== 装配：历史预算封顶（由近及远保留） ==');
  {
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
    const cfg = { ...baseConfig, contextWindow: 40000 };
    const conv = await builderMod.buildContext(
      project,
      req('继续。', { history: many }),
      cfg
    );
    const hist = conv.items.filter((i) => i.kind === 'history');
    const kept = hist.filter((i) => i.status === 'included' || i.status === 'degraded');
    const droppedH = hist.filter((i) => i.status === 'dropped');
    check('历史总量被封顶', droppedH.length > 0, `kept=${kept.length}, dropped=${droppedH.length}`);
    check('确有部分历史保留', kept.length > 0, `kept=${kept.length}`);
    check('保留的是最近几轮',
      kept.every((k) => Number(k.id.slice(9)) > Math.max(...droppedH.map((d) => Number(d.id.slice(9))))),
      `kept=${kept.map((k) => k.id).join(',')}`);
    check('历史占用不超过预算 30%',
      kept.reduce((s, i) => s + i.tokens, 0) <= Math.floor(conv.budget * 0.3) + 5);
    check('被丢弃的历史带原因', droppedH.every((d) => d.note.includes('历史对话预算已满')));
    check('用量不超预算', conv.usedTokens <= conv.budget, `${conv.usedTokens} / ${conv.budget}`);
    check('封顶后前文仍能注入', conv.items.some((i) => i.kind === 'chapterFull' && i.status !== 'dropped'));
  }

  console.log('\n== 装配：单轮过长时取结尾 ==');
  {
    const long = {
      id: 'big',
      role: 'assistant',
      content: `开头的部分。${'中间的废话。'.repeat(3000)}这是结尾的部分。`,
      at: '2026-08-01T10:00:00Z',
    };
    const conv = await builderMod.buildContext(
      project,
      req('继续。', { history: [long] }),
      { ...baseConfig, contextWindow: 40000 }
    );
    const item = conv.items.find((i) => i.id === 'history:big');
    check('过长的一轮降级而非丢弃', item.status === 'degraded', item.status);
    check('降级说明写明只取结尾', item.note.includes('仅注入结尾部分'), item.note);
    check('保留了结尾', item.text.includes('这是结尾的部分'));
    check('丢掉了开头', !item.text.includes('开头的部分'));
    check('用量不超预算', conv.usedTokens <= conv.budget, `${conv.usedTokens} / ${conv.budget}`);
  }

  console.log('\n== 装配：discuss 模式 ==');
  {
    const d = await builderMod.buildContext(
      project,
      req('林昭这个人物到目前为止立住了吗？', { action: DISCUSS, targetWords: 2000 }),
      baseConfig
    );
    // 正文阶段的讨论对象仍是「作者」这个身份——找编辑聊要切到大纲阶段去，
    // 那是身份换人的地方（见下面的四阶段配方）。
    check('系统提示保持正文阶段的身份', d.messages[0].content.includes('作者'), d.messages[0].content.slice(0, 30));
    check('系统提示写明本层职责', d.messages[0].content.includes('剧情不由你决定'));
    check('discuss 不强制只输出正文', !d.messages[0].content.includes('只输出正文'));
    check('discuss 禁止顺手改写产物', d.messages[0].content.includes('不要输出改写后的完整产物'));
    const last = d.messages[d.messages.length - 1].content;
    check('末尾指令为「直接回答」', last.includes('请直接回答上面的问题'));
    check('discuss 忽略目标字数', !last.includes('2000 字'));
    check('discuss 的用户输入不叫「剧情纲要」', !last.includes('本章剧情纲要'), last.slice(-400));
    check('discuss 仍注入文风与角色', last.includes('# 文风指南') && last.includes('# 相关角色设定'));
    check('write 模式仍要求只输出正文',
      (await builderMod.buildContext(project, req('x'), baseConfig))
        .messages[0].content.includes('只输出正文'));
  }

  console.log('\n== 装配：四阶段配方 ==');
  {
    // 示例工程本身没有细纲与场景（它是 0.2.x 的样子），这里临时造一套，
    // 跑完就删干净——不能把测试产物留在示例工程里。
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

    try {
      await project.writePlan(CH2, {
        chapterRelPath: CH2, order: 2, title: '客栈里的女人', arc: '第一卷 · 停舟',
        upstreamHash: '', done: false, sections: planSections('林昭第一次见到沈氏。'),
      });
      await project.writePlan(CH3, {
        chapterRelPath: CH3, order: 3, title: '夜访', arc: '第一卷 · 停舟',
        targetWords: 3000, upstreamHash: '', done: false,
        sections: planSections('沈氏摊牌，令牌的另一半现身。'),
      });
      for (const [no, title, who, must] of [
        [1, '楼下的脚步', ['林昭'], '- 林昭听见脚步停在门外'],
        [2, '摊牌', ['林昭', '沈氏'], '- 沈氏拿出半枚令牌\n- 林昭承认自己是谁'],
        [3, '被打断', ['林昭', '沈氏', '客栈掌柜'], '- 掌柜敲门，谈话中断'],
      ]) {
        await project.writeScene(CH3, {
          chapterRelPath: CH3, no, title, place: '青崖客栈', time: '寅时',
          characters: who, targetWords: 1000, upstreamHash: '', status: 'ready',
          sections: sceneSections(`把「${title}」这一拍演完`, must),
        });
      }
      project.invalidate();

      const ids = (built) => new Map(built.items.map((i) => [i.id, i]));
      const alive = (m, id) => m.has(id) && m.get(id).status !== 'dropped' && m.get(id).status !== 'excluded';

      // ---------------------------------------------------------- 大纲阶段
      const oc = await builderMod.buildContext(
        project,
        { action: { stage: 'outline', capability: 'discuss' }, target: { kind: 'outline' },
          ask: '第一卷的冲突升级够不够？' },
        baseConfig
      );
      const oIds = ids(oc);
      check('大纲阶段身份是策划编辑', oc.messages[0].content.includes('策划编辑'),
        oc.messages[0].content.slice(0, 24));
      check('大纲阶段注入大纲全文', alive(oIds, 'outlineDoc'));
      check('大纲全文进了 user 段', oc.messages[1].content.includes('一句话立意'));
      // 这是分阶段装配最直接的成本收益：讨论故事结构时不该读三章原文。
      check('大纲阶段不带任何正文原文',
        ![...oIds.keys()].some((k) => k.startsWith('chapterFull:')),
        [...oIds.keys()].filter((k) => k.startsWith('chapterFull:')).join(','));
      check('大纲阶段全书摘要都在',
        [1, 2, 3].every((n) => alive(oIds, `chapterSummary:${n}`)),
        [...oIds.keys()].filter((k) => k.startsWith('chapterSummary:')).join(','));
      check('大纲阶段不写「只输出正文」', !oc.messages[0].content.includes('只输出正文'));

      // ---------------------------------------------------------- 细纲阶段
      const pc = await builderMod.buildContext(
        project,
        { action: { stage: 'plan', capability: 'discuss' },
          target: { kind: 'plan', chapterRelPath: CH3 }, ask: '这一章的节奏是不是太平？' },
        baseConfig
      );
      const pIds = ids(pc);
      check('细纲阶段身份是剧情导演', pc.messages[0].content.includes('剧情导演'),
        pc.messages[0].content.slice(0, 24));
      check('细纲阶段注入本章细纲', alive(pIds, `plan:${CH3}`));
      check('细纲阶段注入上一章细纲', alive(pIds, `plan:${CH2}`));
      check('两份细纲都进了 user 段',
        pc.messages[1].content.includes('沈氏摊牌') && pc.messages[1].content.includes('第一次见到沈氏'));
      check('细纲阶段带上全书大纲', alive(pIds, 'outlineDoc'));
      check('细纲阶段不带正文原文',
        ![...pIds.keys()].some((k) => k.startsWith('chapterFull:')),
        [...pIds.keys()].filter((k) => k.startsWith('chapterFull:')).join(','));
      check('细纲阶段前文只到第 2 章', alive(pIds, 'chapterSummary:2') && !pIds.has('chapterSummary:3'));
      // 同一个问题，正文阶段要为整章原文付钱，细纲阶段一个字都不付。
      // 这里不比总量：示例工程一章才三四百字，省下的绝对值看不出来；
      // 真实工程一章三千字 × 近三章，差的就是一个数量级。
      const mcSame = await builderMod.buildContext(
        project,
        { action: WRITE, target: { kind: 'manuscript', chapterRelPath: CH3 },
          ask: '这一章的节奏是不是太平？' },
        baseConfig
      );
      const fullTokens = (b) => b.items.filter((i) => i.kind === 'chapterFull').reduce((s, i) => s + i.tokens, 0);
      check('正文阶段确实为整章原文花了 token', fullTokens(mcSame) > 0, String(fullTokens(mcSame)));
      check('细纲阶段一个字的原文都不花', fullTokens(pc) === 0, String(fullTokens(pc)));

      // ---------------------------------------------------------- 细节阶段
      const sc = await builderMod.buildContext(
        project,
        { action: { stage: 'scene', capability: 'generate' },
          target: { kind: 'scene', chapterRelPath: CH3, sceneNo: 2 },
          ask: '把这一场写扎实一点。' },
        baseConfig
      );
      const sIds = ids(sc);
      const sceneRel = (no) => [...sIds.keys()].find((k) => k.startsWith('scene:') && k.includes(`/0${no}-`));
      check('细节阶段身份是编剧', sc.messages[0].content.includes('编剧'), sc.messages[0].content.slice(0, 24));
      check('细节阶段注入本场', alive(sIds, sceneRel(2)), sceneRel(2));
      check('细节阶段注入前后两场', alive(sIds, sceneRel(1)) && alive(sIds, sceneRel(3)));
      check('邻居场景标注了前后关系', sIds.get(sceneRel(1)).label.includes('上一场')
        && sIds.get(sceneRel(3)).label.includes('下一场'));
      check('邻居只给约束不给整张卡', !sIds.get(sceneRel(1)).text.includes('情绪曲线'),
        sIds.get(sceneRel(1)).text.slice(0, 60));
      check('细节阶段带本章细纲', alive(sIds, `plan:${CH3}`));
      // ★ 这一条是分阶段装配最直接的质量收益：出场人物来自场景 frontmatter，
      //   而不是在用户那一句话里做子串匹配——用户这句话里一个人名都没有。
      check('角色按场景在场人物精确取', alive(sIds, 'character:沈氏'));
      check('取卡原因写明是本场出场', sIds.get('character:沈氏').note === '本场出场人物',
        sIds.get('character:沈氏').note);
      check('细节阶段角色卡升到 P1', sIds.get('character:沈氏').priority === 1,
        String(sIds.get('character:沈氏').priority));
      check('细节阶段不带正文原文',
        ![...sIds.keys()].some((k) => k.startsWith('chapterFull:')));
      check('细节阶段的输出契约是场景 JSON',
        sc.messages[1].content.includes('"不能发生"') && sc.messages[1].content.includes('只输出 JSON'));

      // ---------------------------------------------------------- 正文阶段
      const mc = await builderMod.buildContext(
        project,
        { action: WRITE, target: { kind: 'manuscript', chapterRelPath: CH3, sceneNo: 2 },
          ask: '按这一场写。', targetWords: 1200 },
        baseConfig
      );
      const mIds = ids(mc);
      check('正文阶段仍带整章原文', [...mIds.keys()].some((k) => k.startsWith('chapterFull:')));
      check('正文阶段带本场场景卡', alive(mIds, sceneRel(2)) || alive(mIds, `scene:.novelforge/scenes/003-夜访/02-摊牌.md`));
      check('正文阶段文风指南升到 P0', mIds.get('style').priority === 0, String(mIds.get('style').priority));
      // ★ 另一条质量收益：文风指南不再与一段长对话抢预算。预算紧到只剩强制项时，
      //   它必须仍然在——「读者感觉不到换人执笔」全靠它。
      const squeezed = await builderMod.buildContext(
        project,
        { action: WRITE, target: { kind: 'manuscript', chapterRelPath: CH3 }, ask: '继续。' },
        { ...baseConfig, contextWindow: 3000, maxOutputTokens: 2000 }
      );
      const qIds = ids(squeezed);
      check('预算极小时文风指南仍强制注入', qIds.get('style').status === 'included',
        qIds.get('style').status);
      check('预算极小时确实挤掉了别的东西',
        squeezed.items.some((i) => i.status === 'dropped'));
      check('文风指南进了 user 段', squeezed.messages[1].content.includes('# 文风指南'));
    } finally {
      fs.rmSync(path.join(SAMPLE, '.novelforge', 'plans'), { recursive: true, force: true });
      fs.rmSync(path.join(SAMPLE, '.novelforge', 'scenes'), { recursive: true, force: true });
      project.invalidate();
    }
    check('测试产物已清理',
      !fs.existsSync(path.join(SAMPLE, '.novelforge', 'plans')) &&
      !fs.existsSync(path.join(SAMPLE, '.novelforge', 'scenes')));
  }

  console.log('\n== 工程页数据 ==');
  {
    const tree = await projectViewMod.buildProjectTree(project);
    // 示例工程是全平铺的，因此顶层节点就是全部文件——这条不变量保证
    // 层级改造没有把「没有子目录时」的行为搞复杂。
    const flat = (nodes) => nodes.flatMap((n) => (n.kind === 'dir' ? flat(n.children) : [n]));
    const chapters = flat(tree.chapters);
    const characters = flat(tree.characters);
    const lore = flat(tree.lore);

    check('已初始化', tree.initialized === true);
    check('带上作品名', tree.title.length > 0, tree.title);
    check('章节数与磁盘一致', chapters.length === 3, String(chapters.length));
    check('平铺工程顶层没有目录节点', tree.chapters.every((n) => n.kind === 'chapter'));
    check('章节节点带 kind', chapters.every((c) => c.kind === 'chapter'));
    // 工程页正序展示（第 1 章在上），与文件名顺序一致。
    check('章节按序号正序', chapters.map((c) => c.order).join(',') === '1,2,3',
      chapters.map((c) => c.order).join(','));
    check('总字数为各章之和',
      tree.totalWords === chapters.reduce((s, c) => s + c.wordCount, 0), String(tree.totalWords));
    check('示例工程摘要都是新鲜的', tree.staleCount === 0 && chapters.every((c) => !c.stale));
    // 前端画进度条要分母：staleCount + summarizedCount 必须等于章节总数。
    check('已总结数与过期数互补',
      tree.staleCount + tree.summarizedCount === tree.chapterCount,
      `${tree.staleCount} + ${tree.summarizedCount} ≠ ${tree.chapterCount}`);
    check('新鲜的章节带摘要路径', chapters[0].summaryPath.endsWith('001.md'), chapters[0].summaryPath);
    check('章节带正文相对路径', chapters[0].relPath.startsWith('chapters/'), chapters[0].relPath);

    check('角色数与磁盘一致', characters.length === 4, String(characters.length));
    const lin2 = characters.find((c) => c.label === '林昭');
    check('角色副标题含标签与别名', lin2 && lin2.detail.includes('主角') && lin2.detail.includes('阿昭'), lin2 && lin2.detail);
    check('设定数与磁盘一致', lore.length === 2, String(lore.length));
    check('设定副标题为 keywords', lore.some((l) => l.detail.includes('令牌')));

    check('给出三个区的根目录',
      tree.chaptersRoot === 'chapters' && tree.charactersRoot === '.novelforge/characters' &&
      tree.loreRoot === '.novelforge/lore', [tree.chaptersRoot, tree.charactersRoot, tree.loreRoot].join(' '));

    // 出场人物：已建卡的挂 castByCard（按 relPath 索引），未建卡的进 cast。
    check('树上带摘要数', tree.summaryCount === 3, String(tree.summaryCount));
    const linStats = tree.castByCard[lin2.relPath];
    check('已建卡角色带出场统计', !!linStats && linStats.chapters.length > 0,
      JSON.stringify(linStats));
    check('出场统计带人类可读描述',
      linStats && linStats.detail.startsWith('第') && linStats.detail.endsWith('章'), linStats && linStats.detail);
    // 示例工程的角色卡没有 updatedThrough，因此全部出场章节都算「待更新」。
    check('从未更新过的卡 updatedThrough 为 0', linStats && linStats.updatedThrough === 0);
    check('待更新章数等于出场章数',
      linStats && linStats.pending === linStats.chapters.length,
      `${linStats && linStats.pending} vs ${linStats && linStats.chapters.length}`);
    check('未建卡人物单列在 cast 里', tree.cast.length > 0, String(tree.cast.length));
    check('cast 条目带名字与描述',
      tree.cast.every((c) => c.name && c.detail && Array.isArray(c.chapters)));
    check('cast 里不含已建卡的角色',
      !tree.cast.some((c) => characters.some((f) => f.label === c.name)),
      tree.cast.map((c) => c.name).join('、'));
    check('全书摘要覆盖章数来自 manifest', typeof tree.globalSummaryThrough === 'number');
    check('元数据路径都在 .novelforge 下',
      [tree.styleGuidePath, tree.outlinePath, tree.globalSummaryPath].every((p) => p.startsWith('.novelforge/')),
      [tree.styleGuidePath, tree.outlinePath, tree.globalSummaryPath].join(' '));

    // 改动正文后，对应章节必须立刻显示为过期——这正是工程页存在的意义之一。
    const byOrder = (nodes, order) => flat(nodes).find((c) => c.order === order);
    const target = path.join(SAMPLE, byOrder(tree.chapters, 3).relPath);
    const backup = fs.readFileSync(target, 'utf8');
    try {
      fs.writeFileSync(target, `${backup}\n\n临时追加的一句话。\n`);
      project.invalidate();
      const dirty = await projectViewMod.buildProjectTree(project);
      check('改正文后该章标记为过期', byOrder(dirty.chapters, 3).stale === true);
      check('过期计数为 1', dirty.staleCount === 1, String(dirty.staleCount));
      check('已总结计数跟着减 1', dirty.summarizedCount === 2, String(dirty.summarizedCount));
      check('过期章节仍带旧摘要路径（可点开对照）',
        byOrder(dirty.chapters, 3).summaryPath.endsWith('003.md'));
      check('其他章节不受影响',
        !byOrder(dirty.chapters, 1).stale && !byOrder(dirty.chapters, 2).stale);
    } finally {
      fs.writeFileSync(target, backup);
      project.invalidate();
    }
    check('还原后不再过期', (await projectViewMod.buildProjectTree(project)).staleCount === 0);
  }

  console.log('\n== 出场人物索引 ==');
  {
    // 示例工程刻意混了两种摘要：第 3 章带 frontmatter.cast（新格式），
    // 第 1、2 章没有（0.2.x 之前的格式）。真实工程升级后就是这个样子，
    // 索引必须同时吃下两种，否则老章节的人会在角色页上凭空消失。
    const byOrder = async (order) => (await project.listChapters()).find((c) => c.order === order);
    const s3 = await project.readSummary(await byOrder(3));
    check('新格式摘要读到结构化 cast', s3.cast.length === 2, JSON.stringify(s3.cast));
    check('新格式 cast 带别名',
      s3.cast.find((c) => c.name === '年轻守卫').aliases.includes('那个年轻人'),
      JSON.stringify(s3.cast));
    const s1 = await project.readSummary(await byOrder(1));
    check('旧格式摘要从小节文本反解 cast', s1.cast.length === 3, JSON.stringify(s1.cast));
    check('旧格式反解出的名字正确',
      s1.cast.map((c) => c.name).join('、') === '林昭、李叔、年轻守卫',
      s1.cast.map((c) => c.name).join('、'));

    const index = await castMod.buildCastIndex(project);
    check('统计到 3 份摘要', index.summaryCount === 3, String(index.summaryCount));

    const lin = index.known.find((m) => m.card && m.card.name === '林昭');
    check('林昭被识别为已建卡', !!lin);
    check('林昭有出场章节', lin && lin.chapters.length > 0, lin && lin.chapters.join(','));
    check('出场章节升序去重',
      lin && lin.chapters.every((o, i, a) => i === 0 || o > a[i - 1]), lin && lin.chapters.join(','));

    // 别名匹配：某一章摘要里写「阿昭」也该记到林昭头上，不该多出一个人。
    check('未建卡列表里没有已知别名',
      !index.unknown.some((m) => m.name === '阿昭'),
      index.unknown.map((m) => m.name).join('、'));

    // 摘要里出现、没有角色卡的人（示例工程里是「客栈掌柜」）。
    check('未建卡人物被单列',
      index.unknown.some((m) => m.name.includes('掌柜')),
      index.unknown.map((m) => m.name).join('、'));
    check('未建卡按出场章数降序',
      index.unknown.every((m, i, a) => i === 0 || a[i - 1].chapters.length >= m.chapters.length));
    check('未建卡的人都带出场章节',
      index.unknown.every((m) => m.chapters.length > 0));
    check('已建卡与未建卡不重叠',
      !index.unknown.some((u) => index.known.some((k) => k.card && k.card.name === u.name)));
    check('示例工程没有名字冲突', index.conflicts.length === 0,
      index.conflicts.map((c) => c.name).join('、'));

    // appearancesOf 是「更新角色卡」取章节的入口，必须与索引一致。
    const linCard = (await project.listCharacters()).find((c) => c.name === '林昭');
    check('appearancesOf 与索引一致',
      castMod.appearancesOf(index, linCard).join(',') === lin.chapters.join(','));
    const missing = { slug: '不存在', name: '不存在', aliases: [], tags: [], appearsIn: [], relPath: 'x', body: '', sections: {} };
    check('查不到的角色返回空数组', castMod.appearancesOf(index, missing).length === 0);

    check('describeChapters 短列表全列', castMod.describeChapters([1, 2, 3]) === '第 1、2、3 章');
    check('describeChapters 长列表折叠',
      castMod.describeChapters([1, 2, 3, 4, 5, 6, 7, 8]) === '第 1、2、3、4、5、6 章等 8 章',
      castMod.describeChapters([1, 2, 3, 4, 5, 6, 7, 8]));
    check('describeChapters 空列表有说法', castMod.describeChapters([]) === '未在摘要中出现');
  }

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
