/**
 * 多服务商 / 多模型的离线验证：引用解析、配置容错、旧配置兼容，
 * 以及 readConfig 把这一切串起来的结果。
 *
 * 用法：node scripts/smoke-providers.js
 */
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- vscode 桩

let settings = {};
const vscodeStub = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ROOT, path: ROOT }, name: 'root' }],
    getConfiguration: () => ({
      get: (key, dflt) => (key in settings ? settings[key] : dflt),
    }),
    asRelativePath: (uri) => uri.fsPath,
    fs: {},
  },
  Uri: { file: (p) => ({ fsPath: p, path: p }), joinPath: (b, ...s) => ({ fsPath: [b.fsPath, ...s].join('/'), path: [b.path, ...s].join('/') }) },
  window: {}, commands: {}, FileType: { File: 1, Directory: 2 },
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

const p = loadModule('src/core/model/providers.ts');
const projectMod = loadModule('src/core/model/project.ts');

// ---------------------------------------------------------------- 引用解析

console.log('\n== 模型引用解析 ==');
{
  const parse = p.parseModelRef;
  check('普通引用', JSON.stringify(parse('glm/glm-4-plus')) === JSON.stringify({ providerId: 'glm', model: 'glm-4-plus' }));

  // 这是整个设计的关键：只切第一个斜杠，剩下的都属于模型名。
  const nested = parse('openrouter/z-ai/glm-4.6');
  check('嵌套斜杠归模型名', nested.providerId === 'openrouter' && nested.model === 'z-ai/glm-4.6',
    JSON.stringify(nested));
  const deep = parse('or/a/b/c/d');
  check('多层斜杠也只切第一个', deep.providerId === 'or' && deep.model === 'a/b/c/d', JSON.stringify(deep));

  check('冒号型模型名（Ollama）', parse('ollama/qwen2.5:14b').model === 'qwen2.5:14b');
  check('两侧空白被裁掉', parse('  glm/glm-4-plus  ').providerId === 'glm');

  check('没有斜杠时无效', parse('glm-4-plus') === undefined);
  check('以斜杠开头时无效', parse('/glm-4-plus') === undefined);
  check('以斜杠结尾时无效', parse('glm/') === undefined);
  check('空串无效', parse('') === undefined);
  check('只有斜杠无效', parse('/') === undefined);
  check('模型名全是空格时无效', parse('glm/   ') === undefined);

  check('makeModelRef 与 parseModelRef 互逆',
    parse(p.makeModelRef('openrouter', 'z-ai/glm-4.6')).model === 'z-ai/glm-4.6');
}

// ---------------------------------------------------------------- 配置容错

console.log('\n== 服务商列表容错 ==');
{
  const n = p.normalizeProviders;
  check('非数组返回空', n(undefined).length === 0 && n('x').length === 0 && n(null).length === 0);

  const ok = n([
    { id: 'glm', label: '智谱', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', models: [{ name: 'glm-4-plus', contextWindow: 128000 }] },
  ]);
  check('正常条目被保留', ok.length === 1);
  check('baseUrl 末尾斜杠被裁掉', ok[0].baseUrl === 'https://open.bigmodel.cn/api/paas/v4', ok[0].baseUrl);
  check('模型窗口被保留', ok[0].models[0].contextWindow === 128000);

  // 手写 settings.json 什么都可能出现，坏条目跳过而不是整体失败。
  const messy = n([
    null,
    'not an object',
    { id: '', models: [{ name: 'x' }] },
    { id: 'has/slash', models: [{ name: 'x' }] },
    { id: 'has space', models: [{ name: 'x' }] },
    { id: 'nomodels', models: [] },
    { id: 'nomodels2' },
    { id: 'good', models: [{ name: 'm1' }] },
    { id: 'good', models: [{ name: 'dup' }] },
  ]);
  check('坏条目全被跳过，只剩一个', messy.length === 1, JSON.stringify(messy.map((x) => x.id)));
  check('保留的是 good', messy[0].id === 'good');
  check('含斜杠的 id 被拒绝', !messy.some((x) => x.id.includes('/')));
  check('重复 id 只留第一个', messy.filter((x) => x.id === 'good').length === 1);

  const strings = n([{ id: 'a', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4o'] }]);
  check('模型可简写为字符串', strings[0].models.length === 2, JSON.stringify(strings[0].models));
  check('重复模型名被去掉', strings[0].models.map((m) => m.name).join(',') === 'gpt-4o,gpt-4o-mini');

  const kinds = n([
    { id: 'a', kind: 'anthropic', models: ['m'] },
    { id: 'b', kind: 'vscode-lm', models: ['m'] },
    { id: 'c', kind: '胡说', models: ['m'] },
  ]);
  check('kind 原样保留', kinds[0].kind === 'anthropic' && kinds[1].kind === 'vscode-lm');
  check('非法 kind 退回 openai', kinds[2].kind === 'openai');

  const nums = n([{ id: 'a', models: [{ name: 'm', contextWindow: -5, maxOutputTokens: 'x' }] }]);
  check('非法数字被忽略', nums[0].models[0].contextWindow === undefined && nums[0].models[0].maxOutputTokens === undefined);
}

// ---------------------------------------------------------------- 解析与列举

console.log('\n== 解析与列举 ==');
{
  const providers = p.normalizeProviders([
    { id: 'glm', label: '智谱 GLM', kind: 'openai', models: [{ name: 'glm-4-plus', contextWindow: 128000 }, { name: 'glm-4-air' }] },
    { id: 'openrouter', label: 'OpenRouter', kind: 'openai', models: [{ name: 'z-ai/glm-4.6' }] },
    { id: 'copilot', kind: 'vscode-lm', models: [{ name: 'gpt-4o' }] },
  ]);

  const a = p.resolveModelRef(providers, 'glm/glm-4-plus');
  check('解析出服务商', a.profile.id === 'glm');
  check('解析出模型', a.model.name === 'glm-4-plus');
  check('带回规范化的 ref', a.ref === 'glm/glm-4-plus');

  const b = p.resolveModelRef(providers, 'openrouter/z-ai/glm-4.6');
  check('嵌套斜杠模型可解析', b && b.model.name === 'z-ai/glm-4.6');
  check('同名模型走不同渠道是两条',
    p.resolveModelRef(providers, 'glm/glm-4-plus').profile.id !== b.profile.id);

  check('未知前缀返回 undefined', p.resolveModelRef(providers, 'nope/x') === undefined);
  check('未知模型返回 undefined', p.resolveModelRef(providers, 'glm/不存在') === undefined);
  check('部分匹配不算命中', p.resolveModelRef(providers, 'glm/glm-4') === undefined);

  check('firstModelRef 取第一个', p.firstModelRef(providers) === 'glm/glm-4-plus');
  check('空列表时 firstModelRef 为空串', p.firstModelRef([]) === '');

  const choices = p.listModelChoices(providers);
  check('列出全部 4 个模型', choices.length === 4, `got ${choices.length}`);
  check('列表保持配置顺序',
    choices.map((c) => c.ref).join(',') === 'glm/glm-4-plus,glm/glm-4-air,openrouter/z-ai/glm-4.6,copilot/gpt-4o',
    choices.map((c) => c.ref).join(','));
  check('分组用服务商显示名', choices[0].group === '智谱 GLM');
  check('无 label 时分组回落到 id', choices[3].group === 'copilot');
  check('模型显示名回落到模型名', choices[1].label === 'glm-4-air');
  check('带上模型窗口', choices[0].contextWindow === 128000 && choices[1].contextWindow === undefined);
}

// ---------------------------------------------------------------- 错误信息

console.log('\n== 引用无效时的说明 ==');
{
  const providers = p.normalizeProviders([
    { id: 'glm', label: '智谱 GLM', models: [{ name: 'glm-4-plus' }, { name: 'glm-4-air' }] },
  ]);
  check('没有服务商时提示去设置页', p.describeModelIssue([], 'x').includes('设置'));
  check('格式不对时说明格式', p.describeModelIssue(providers, 'glm-4-plus').includes('服务商前缀/模型名'));
  // 错误信息必须指名道姓，否则用户只能靠猜。
  const unknown = p.describeModelIssue(providers, 'kimi/x');
  check('未知前缀时列出已有前缀', unknown.includes('kimi') && unknown.includes('glm'), unknown);
  const noModel = p.describeModelIssue(providers, 'glm/不存在');
  check('未知模型时列出该商可用模型',
    noModel.includes('glm/glm-4-plus') && noModel.includes('glm/glm-4-air'), noModel);
  check('未选模型时给出示例', p.describeModelIssue(providers, '').includes('glm/glm-4-plus'));
}

// ---------------------------------------------------------------- 旧配置兼容

console.log('\n== 0.1.x 配置兼容 ==');
{
  const seeded = p.seedFromLegacy({
    provider: 'anthropic',
    openaiBaseUrl: 'https://api.deepseek.com/v1',
    openaiModel: 'deepseek-chat',
    anthropicBaseUrl: 'https://api.anthropic.com',
    anthropicModel: 'claude-sonnet-4-5',
    vscodeLmFamily: 'gpt-4o',
  });
  check('三个服务商都被建出来', seeded.providers.length === 3, JSON.stringify(seeded.providers.map((x) => x.id)));
  check('沿用旧的 baseUrl', seeded.providers[0].baseUrl === 'https://api.deepseek.com/v1');
  check('沿用旧的模型名', seeded.providers[0].models[0].name === 'deepseek-chat');
  check('旧的 provider 选择被保留', seeded.activeRef === 'anthropic/claude-sonnet-4-5', seeded.activeRef);

  const lm = p.seedFromLegacy({
    provider: 'vscode-lm', openaiBaseUrl: '', openaiModel: 'gpt-4o',
    anthropicBaseUrl: '', anthropicModel: '', vscodeLmFamily: 'claude-3.5-sonnet',
  });
  check('vscode-lm 映射到 copilot 前缀', lm.activeRef === 'copilot/claude-3.5-sonnet', lm.activeRef);
  check('anthropic 模型为空时不建该服务商', !lm.providers.some((x) => x.id === 'anthropic'));
  check('baseUrl 为空时取默认值', lm.providers[0].baseUrl === 'https://api.openai.com/v1');

  const none = p.seedFromLegacy({
    provider: 'openai', openaiBaseUrl: '', openaiModel: '',
    anthropicBaseUrl: '', anthropicModel: '', vscodeLmFamily: '',
  });
  check('全空时不产生服务商', none.providers.length === 0 && none.activeRef === '');
}

// ---------------------------------------------------------------- readConfig

console.log('\n== readConfig 串起来 ==');
{
  settings = {
    providers: [
      { id: 'glm', label: '智谱 GLM', kind: 'openai', models: [{ name: 'glm-4-plus', contextWindow: 128000 }] },
      { id: 'openrouter', kind: 'openai', models: [{ name: 'z-ai/glm-4.6', contextWindow: 200000, maxOutputTokens: 8192 }] },
    ],
    model: 'openrouter/z-ai/glm-4.6',
    contextWindow: 64000,
    maxOutputTokens: 4096,
  };
  const cfg = projectMod.readConfig();
  check('读出两个服务商', cfg.providers.length === 2);
  check('当前模型已解析', cfg.active && cfg.active.model.name === 'z-ai/glm-4.6');
  // 同一服务商下 32k 和 200k 的模型常并存，全局值不该盖住模型自带的窗口。
  check('模型窗口覆盖全局值', cfg.contextWindow === 200000, String(cfg.contextWindow));
  check('模型输出上限覆盖全局值', cfg.maxOutputTokens === 8192, String(cfg.maxOutputTokens));

  settings.model = 'glm/glm-4-plus';
  const cfg2 = projectMod.readConfig();
  check('切换模型后窗口跟着变', cfg2.contextWindow === 128000, String(cfg2.contextWindow));
  check('模型没设输出上限时用全局值', cfg2.maxOutputTokens === 4096, String(cfg2.maxOutputTokens));

  settings.model = 'nope/x';
  const bad = projectMod.readConfig();
  check('引用无效时 active 为空', bad.active === undefined);
  check('引用无效时退回全局窗口', bad.contextWindow === 64000, String(bad.contextWindow));
  check('引用无效时不丢服务商列表', bad.providers.length === 2);

  settings.model = '';
  check('未指定模型时取第一个', projectMod.readConfig().model === 'glm/glm-4-plus');

  const globals = projectMod.readGlobalBudget();
  check('readGlobalBudget 不受模型覆盖影响', globals.contextWindow === 64000, String(globals.contextWindow));

  // 老用户升级：providers 为空，应从旧设置兜底，而不是「没有模型」。
  settings = {
    provider: 'openai',
    'openai.baseUrl': 'https://api.deepseek.com/v1',
    'openai.model': 'deepseek-chat',
    'anthropic.model': '',
    'vscodeLm.family': '',
  };
  const legacy = projectMod.readConfig();
  check('providers 为空时从旧设置兜底', legacy.providers.length === 1, JSON.stringify(legacy.providers));
  check('兜底后模型可用', legacy.active && legacy.active.model.name === 'deepseek-chat');
  check('兜底后引用为 openai/deepseek-chat', legacy.model === 'openai/deepseek-chat', legacy.model);

  // 新结构一旦存在就以它为准，不再看旧设置。
  settings.providers = [{ id: 'glm', models: [{ name: 'glm-4-plus' }] }];
  settings.model = 'glm/glm-4-plus';
  const both = projectMod.readConfig();
  check('新结构存在时忽略旧设置', both.providers.length === 1 && both.providers[0].id === 'glm',
    JSON.stringify(both.providers.map((x) => x.id)));
}

// ---------------------------------------------------------------- 设置页脏状态

console.log('\n== 设置页未保存编辑不被刷新冲掉 ==');
{
  // 把 view.js 里那段 renderSettings 的逻辑原样复刻一遍。
  // 这是一条真实的丢数据路径：FileSystemWatcher 一刷新就推设置，
  // 用户正在填的 baseUrl 不该被磁盘上的旧值覆盖。
  const draft = { providers: [], keys: {}, dirty: false };
  const render = (settings, keys, ack) => {
    const nextKeys = keys || {};
    if (ack === 'saved') draft.dirty = false;
    if (draft.dirty) {
      if (JSON.stringify(nextKeys) !== JSON.stringify(draft.keys)) draft.keys = nextKeys;
      return;
    }
    draft.providers = JSON.parse(JSON.stringify(settings.providers || []));
    draft.keys = nextKeys;
  };

  const onDisk = { providers: [{ id: 'glm', models: [{ name: 'glm-4-plus' }] }] };
  render(onDisk, { glm: false });
  check('首次渲染读磁盘', draft.providers[0].id === 'glm');

  // 用户开始编辑
  draft.providers[0].baseUrl = 'https://正在填一半';
  draft.dirty = true;

  render(onDisk, { glm: false });
  check('刷新不冲掉未保存的编辑', draft.providers[0].baseUrl === 'https://正在填一半');

  // 刚在弹窗里输完 Key，状态要更新
  render(onDisk, { glm: true });
  check('脏状态下 Key 状态仍会更新', draft.keys.glm === true);
  check('更新 Key 状态时不动编辑内容', draft.providers[0].baseUrl === 'https://正在填一半');

  // 保存被拒：必须保住编辑
  render(onDisk, { glm: true }, 'rejected');
  check('保存被拒时保住编辑', draft.providers[0].baseUrl === 'https://正在填一半');
  check('保存被拒后仍是脏的', draft.dirty === true);

  // 保存成功：以磁盘为准
  const saved = { providers: [{ id: 'glm', baseUrl: 'https://填完了', models: [{ name: 'glm-4-plus' }] }] };
  render(saved, { glm: true }, 'saved');
  check('保存成功后以磁盘为准', draft.providers[0].baseUrl === 'https://填完了');
  check('保存成功后不再是脏的', draft.dirty === false);

  render({ providers: [] }, { glm: true });
  check('干净状态下正常跟随磁盘', draft.providers.length === 0);
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);