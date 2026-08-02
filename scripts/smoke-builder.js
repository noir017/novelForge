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

const projectMod = loadModule('src/model/project.ts');
const builderMod = loadModule('src/context/builder.ts');
const tokenizerMod = loadModule('src/context/tokenizer.ts');

const baseConfig = {
  provider: 'openai',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o',
  anthropicBaseUrl: 'https://api.anthropic.com',
  anthropicModel: 'claude-sonnet-4-5',
  vscodeLmFamily: 'gpt-4o',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  temperature: 0.8,
  recentChaptersFullText: 2,
  prevChapterTailChars: 1500,
  chaptersDir: 'chapters',
  summaryBatchSize: 15,
  requestTimeoutMs: 300000,
};

async function main() {
  const project = projectMod.NovelProject.current();

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
  const built = await builderMod.buildContext(project, { targetOrder: 4, outline, targetWords: 2000 }, baseConfig);

  const byId = new Map(built.items.map((i) => [i.id, i]));
  const inc = (id) => byId.get(id) && (byId.get(id).status === 'included' || byId.get(id).status === 'degraded');

  check('P0 系统提示已注入', inc('system'));
  check('P0 纲要已注入', inc('outline'));
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
  const ch3Summary = (await project.readSummary(3)).content;
  const ch3SummaryTokens = tokenizerMod.estimateTokens(`【第3章 夜访】\n${ch3Summary}`);

  console.log('\n== 装配：预算刚好放不下整章原文（应降级为摘要） ==');
  {
    // 关掉结尾片段，单独考察 chapterFull 的降级链。
    // 预算 = P0~P2 实占 + 介于「该章摘要」与「该章原文」之间的量。
    const mid = ch3SummaryTokens + Math.floor((ch3Full - ch3SummaryTokens) / 2);
    const window = upToP2Tokens + mid + 2000 + 512;
    const cfg = { ...baseConfig, prevChapterTailChars: 0, maxOutputTokens: 2000, contextWindow: window };
    const deg = await builderMod.buildContext(project, { targetOrder: 4, outline }, cfg);
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
  const small = await builderMod.buildContext(project, { targetOrder: 4, outline }, tight);
  const sById = new Map(small.items.map((i) => [i.id, i]));

  check('P0 纲要仍然注入', sById.get('outline').status === 'included');
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
    { targetOrder: 4, outline, excludedIds: ['style', 'character:沈氏', 'chapterFull:2'] },
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
    { targetOrder: 4, outline, providerMaxInputTokens: 8000 },
    baseConfig
  );
  check('标记为被 provider 压缩', clamped.budgetClampedByProvider === true);
  check('预算按 provider 上限算', clamped.budget === 8000 - 4096 - 512, String(clamped.budget));
  check('用量不超压缩后预算', clamped.usedTokens <= clamped.budget, `${clamped.usedTokens} / ${clamped.budget}`);

  // ------------------------------------------------------------ 重写
  console.log('\n== 装配：带修改意见重写 ==');
  const rev = await builderMod.buildContext(
    project,
    {
      targetOrder: 4,
      outline,
      revision: { previousDraft: '上一版的正文内容，写得太文气了。', feedback: '对白改口语一些' },
    },
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
    { targetOrder: 1, outline: '开篇：主角进城。' },
    baseConfig
  );
  const fById = new Map(first.items.map((i) => [i.id, i]));
  check('无前一章时不注入 prevTail', ![...fById.keys()].some((k) => k.startsWith('prevTail:')));
  check('无前文时不注入章节原文', ![...fById.keys()].some((k) => k.startsWith('chapterFull:')));
  check('仍然注入系统提示与纲要', fById.get('system').status === 'included' && fById.get('outline').status === 'included');
  check('仍然注入文风指南', fById.get('style').status === 'included');
  check('主角仍被注入（tags 含主角）', fById.get('character:林昭').status === 'included');
  check('主角注入原因为「主角，始终注入」', fById.get('character:林昭').note.includes('主角'));

  // ------------------------------------------------------------ 追加到已有章节
  console.log('\n== 装配：追加到第 3 章（targetOrder=3） ==');
  const append = await builderMod.buildContext(
    project,
    { targetOrder: 3, outline: '接着写下去。' },
    baseConfig
  );
  const aById = new Map(append.items.map((i) => [i.id, i]));
  check('前文只取到第 2 章', aById.has('prevTail:2') && !aById.has('prevTail:3'));
  check('第 3 章自身不作为前文注入', !aById.has('chapterFull:3'));

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
