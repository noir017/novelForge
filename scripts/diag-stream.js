/**
 * 排查「界面不是流式」的现场脚本：直接打真实服务商，看它到底是
 * 逐块吐还是一次性吐完。界面只能显示服务器给的东西——如果上游把
 * 整段憋到最后一次响应，前端再怎么改也变不出流式。
 *
 * 用法：node scripts/diag-stream.js [模型引用]
 * 读 ~/.novelforge/config.json 里已配的服务商与 Key。
 */
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') return { window: {}, workspace: {}, commands: {}, Uri: {} };
  return originalLoad.call(this, request, ...args);
};

function loadModule(relPath) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true, format: 'cjs', platform: 'node', write: false, external: ['vscode'],
  });
  const m = new Module(relPath, null);
  m._compile(result.outputFiles[0].text, path.join(ROOT, relPath));
  return m.exports;
}

const { OpenAiProvider } = loadModule('src/core/llm/openaiProvider.ts');
const { AnthropicProvider } = loadModule('src/core/llm/anthropicProvider.ts');
const P = loadModule('src/core/model/providers.ts');

const HOME = path.join(os.homedir(), '.novelforge');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

(async () => {
  const cfg = readJson(path.join(HOME, 'config.json'));
  if (!cfg) {
    console.log(`读不到 ${path.join(HOME, 'config.json')}。先在设置页保存一次配置。`);
    process.exit(1);
  }
  const providers = P.normalizeProviders(cfg.providers ?? []);
  const ref = process.argv[2] || cfg.model || P.firstModelRef(providers);
  const active = P.resolveModelRef(providers, ref);
  if (!active) {
    console.log(P.describeModelIssue(providers, ref));
    process.exit(1);
  }

  const secrets = readJson(path.join(HOME, 'secrets.json')) ?? {};
  const key = secrets[`novel-forge.apiKey.provider.${active.profile.id}`]
    ?? secrets[`novel-forge.apiKey.${active.profile.id}`];
  if (!key && active.profile.kind !== 'vscode-lm') {
    console.log(`没找到「${active.profile.id}」的 API Key（~/.novelforge/secrets.json）。`);
    process.exit(1);
  }

  const baseUrl = active.profile.baseUrl || P.defaultBaseUrl(active.profile.kind);
  const provider = active.profile.kind === 'anthropic'
    ? new AnthropicProvider(baseUrl, active.model.name, key)
    : new OpenAiProvider(baseUrl, active.model.name, key);

  console.log(`模型 ${ref}`);
  console.log(`地址 ${baseUrl}`);
  console.log('请求「从 1 数到 30，用中文，每个数字之间加顿号」…\n');

  const t0 = Date.now();
  const marks = [];
  let full = '';
  try {
    for await (const delta of provider.chatStream(
      [{ role: 'user', content: '从 1 数到 30，用中文，每个数字之间加顿号。只输出数字。' }],
      { maxOutputTokens: 400, temperature: 0, timeoutMs: 120000 }
    )) {
      marks.push({ at: Date.now() - t0, len: delta.length });
      full += delta;
      // 实时打印，直观看到是不是一段段来的
      process.stdout.write(delta);
    }
  } catch (err) {
    console.log(`\n\n请求失败：${err && err.message ? err.message : err}`);
    process.exit(1);
  }

  console.log('\n');
  console.log('─'.repeat(60));
  if (marks.length === 0) {
    console.log('一个增量都没收到——服务器没有返回内容。');
    process.exit(1);
  }
  const first = marks[0].at;
  const last = marks[marks.length - 1].at;
  console.log(`增量块数   ${marks.length}`);
  console.log(`首块到达   +${first}ms`);
  console.log(`末块到达   +${last}ms`);
  console.log(`跨度       ${last - first}ms`);
  console.log(`总字数     ${full.length}`);
  console.log('─'.repeat(60));

  if (marks.length === 1) {
    console.log('结论：上游一次性返回了全部内容（只有 1 个增量块）。');
    console.log('      这不是插件的问题——界面拿到的就是一整段，无法再拆成流式。');
    console.log('      多半是中间的反代/网关缓冲了 SSE，或该服务不支持 stream。');
    console.log('      若走 Nginx，检查 proxy_buffering off; 与 X-Accel-Buffering: no。');
  } else if (last - first < 200) {
    console.log('结论：分块了，但几乎同时到达（跨度 < 200ms）。');
    console.log('      通常也是被反代整体缓冲后一次性放行。');
  } else {
    console.log('结论：上游确实在逐块流式返回，链路正常。');
    console.log('      若界面仍是「等全部生成完才显示」，问题在前端渲染。');
  }
})();
