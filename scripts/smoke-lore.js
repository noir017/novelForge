/**
 * 自动生成设定的离线验证：逐章识别、跨章合并、分类落盘与已有条目审阅。
 * 用法：node scripts/smoke-lore.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-lore-'));
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
  project: './src/core/model/project.ts',
  lore: './src/core/features/lore.ts',
  registry: './src/core/llm/registry.ts',
});
const { host: hostMod, project: projectMod, lore: loreMod, registry } = bundle;

const settings = {
  providers: [{ id: 'fake', kind: 'vscode-lm', models: [{ name: 'm' }] }],
  models: ['fake/m'],
  contextWindow: 12000,
  maxOutputTokens: 500,
  concurrency: 1,
};
const confirms = [];
const reviews = [];
const calls = [];
let reviewVerdict = 'apply';
let answers = ['开始生成'];
let replies = [
  JSON.stringify([{ title: '青崖镇', category: '地理', keywords: ['青崖'], facts: ['青崖镇建在断崖下，镇外是盐道。'] }]),
  JSON.stringify([{ title: '青崖镇', category: '地理', keywords: ['盐道'], facts: ['镇上有一条通往北境的盐道。'] }]),
  JSON.stringify([{ title: '玄门七宗', category: '势力', keywords: ['七宗'], facts: ['玄门由七个宗门组成。'] }]),
  JSON.stringify({ keywords: ['青崖', '盐道'], body: '## 地理\n\n青崖镇建在断崖下，镇外有通往北境的盐道。' }),
  JSON.stringify({ keywords: ['七宗'], body: '## 结构\n\n玄门由七个宗门组成。' }),
];

const fakeHost = {
  name: 'standalone',
  supportsVscodeLm: true,
  config: { read: () => settings, write: async () => {} },
  input: async () => undefined,
  confirm: async (message) => {
    confirms.push(message);
    return answers.shift();
  },
  pick: async () => undefined,
  progress: async (_title, fn) => fn(new AbortController().signal, () => {}),
  watch: () => ({ dispose: () => {} }),
  openFile: async () => {},
  toast: () => {},
  selectionAttachment: async () => undefined,
  reviewReplace: async (name) => {
    reviews.push(name);
    return reviewVerdict;
  },
};
hostMod.initHost(fakeHost);
registry.registerProviderFactory(() => ({
  id: 'vscode-lm',
  label: '假模型',
  maxInputTokens: async () => undefined,
  chatStream: async function* (messages) {
    calls.push(messages);
    yield replies.shift() || '[]';
  },
}));

const rel = (...p) => path.join(WORK, ...p);
const write = (p, text) => {
  fs.mkdirSync(path.dirname(rel(p)), { recursive: true });
  fs.writeFileSync(rel(p), text, 'utf8');
};

async function main() {
  const project = projectMod.NovelProject.open(WORK);
  await project.initialize({ title: '设定测试', author: '测试' });
  fs.rmSync(rel('.novelforge/lore/example-setting.md'), { force: true });
  write('chapters/001-镇.md', '# 镇\n\n青崖镇在断崖下。');
  write('chapters/002-盐道.md', '# 盐道\n\n盐道通往北境。');
  write('chapters/003-宗门.md', '# 宗门\n\n玄门有七宗。');
  project.invalidate();

  console.log('\n== 逐章识别与跨章合并 ==');
  await loreMod.generateLore(project);
  const lore = await project.listLore();
  check('确认框说明逐章调用与后续调用', confirms[0].includes('固定调用模型 3 次') && confirms[0].includes('每发现一条设定再调用 1 次'));
  check('每章各调用一次识别', calls.length === 5, `实际 ${calls.length} 次`);
  check('同一设定跨章合并为一条', lore.filter((x) => x.title === '青崖镇').length === 1);
  check('合并结果保留跨章事实', lore.find((x) => x.title === '青崖镇')?.body.includes('盐道'));
  check('新设定按分类目录落盘', lore.some((x) => x.relPath.includes('地理') && x.title === '青崖镇'));
  check('新设定按分类目录落盘势力', lore.some((x) => x.relPath.includes('势力') && x.title === '玄门七宗'));

  console.log('\n== 已有设定必须审阅 ==');
  answers = ['开始生成'];
  replies = [
    JSON.stringify([{ title: '青崖镇', category: '地理', keywords: ['青崖'], facts: ['青崖镇建在断崖下，镇外是盐道。'] }]),
    JSON.stringify([{ title: '青崖镇', category: '地理', keywords: ['盐道'], facts: ['镇上有一条通往北境的盐道。'] }]),
    JSON.stringify([{ title: '玄门七宗', category: '势力', keywords: ['七宗'], facts: ['玄门由七个宗门组成。'] }]),
    JSON.stringify({ keywords: ['青崖'], body: '## 地理\n\n新版设定。' }),
    JSON.stringify({ keywords: ['七宗'], body: '## 结构\n\n新版结构。' }),
  ];
  await loreMod.generateLore(project);
  check('已有条目走审阅回调', reviews.length >= 2, `审阅 ${reviews.length} 条`);
  check('审阅采纳后写入', (await project.listLore()).some((x) => x.body.includes('新版设定')));

  console.log('\n== 审阅放弃不覆盖 ==');
  const currentLore = await project.listLore();
  const townPath = currentLore.find((x) => x.title === '青崖镇').relPath;
  const beforeDiscard = fs.readFileSync(rel(townPath), 'utf8');
  reviewVerdict = 'discard';
  answers = ['开始生成'];
  replies = [
    JSON.stringify([{ title: '青崖镇', category: '地理', keywords: ['青崖'], facts: ['候选修改。'] }]),
    '[]',
    '[]',
    JSON.stringify({ keywords: ['青崖'], body: '## 地理\n\n不应写入的版本。' }),
  ];
  await loreMod.generateLore(project);
  check('放弃审阅后原文件一字不改', fs.readFileSync(rel(townPath), 'utf8') === beforeDiscard);
  reviewVerdict = 'apply';

  console.log('\n== 长章完整分片 ==');
  settings.contextWindow = 4000;
  const marker = '长章末尾唯一标记';
  write('chapters/004-长章.md', `# 长章\n\n${'这是一段需要完整扫描的正文。'.repeat(1200)}${marker}`);
  project.invalidate();
  answers = ['开始生成'];
  replies = Array(40).fill('[]');
  const callsBefore = calls.length;
  await loreMod.generateLore(project);
  const longRunCalls = calls.slice(callsBefore);
  check('长章会拆成额外调用而非截断', longRunCalls.length > 4, `扫描 ${longRunCalls.length} 个片段`);
  check('最后一段正文也送进模型',
    longRunCalls.some((messages) => messages.some((m) => m.content.includes(marker))));

  if (failures > 0) {
    console.error(`\n${failures} 个测试失败`);
    process.exitCode = 1;
  } else {
    console.log('\n全部设定生成测试通过');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
