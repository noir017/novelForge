/**
 * 多服务商 / 多模型：引用解析、配置容错、旧配置兼容，以及 readConfig 把这一切串起来的结果。
 * 迁自 scripts/smoke-providers.js（`== 模型分档的配置容错 ==` 一节除外，那节在 tiers.test.js）。
 *
 * 两件与迁移前不同、但语义等价的事：
 *
 * 1. 原脚本反复整体重赋值 `settings = {...}`，而 helpers/vscodeStub.js 把 config 对象按引用
 *    闭包捕获、换不了对象。这里就地覆写 stub 的 `getConfiguration`，让它每次读本文件当前的
 *    `settings` 变量——同一个变量同时喂给 ConfigStore 与 legacy reader，与原脚本的双重身份一致。
 * 2. 原脚本靠顶层 `return ....then(...)` 把最后两节串在后面；这里改成按 describe 声明顺序 +
 *    各自的 before()。node:test 同文件默认串行，换 ConfigStore 的先后与迁移前一致。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, loadBundle, loadModule } = require('../../helpers/load');
const { installVscodeStub } = require('../../helpers/vscodeStub');

/** 当前这一轮的设置。既是 ConfigStore 的内容，也是 settings.json 的内容。 */
let settings = {};

let p;
let configMod;
let vscode;

before(() => {
  vscode = installVscodeStub({ level: 'workspace', root: ROOT, config: {} });
  vscode.stub.workspace.getConfiguration = () => ({
    get: (key, dflt) => (key in settings ? settings[key] : dflt),
  });

  const bundle = loadBundle({
    p: './src/core/model/providers.ts',
    config: './src/core/config.ts',
  });
  p = bundle.p;
  configMod = bundle.config;

  // readConfig 改由注入的 ConfigStore 供数：这里用内存对象模拟 settings.json。
  configMod.initConfigFromHost({
    config: {
      read: () => settings,
      write: async (s) => { settings = s; },
    },
  });
  // 注册遗留读取器，才能走 0.1.x 兜底分支（与真实 VS Code 壳一致）。
  configMod.setLegacyConfigReader({ read: () => settings });
});

after(() => {
  vscode.restore();
});

describe('模型引用解析', () => {
  test('普通引用', () => {
    assert.deepEqual(p.parseModelRef('glm/glm-4-plus'), { providerId: 'glm', model: 'glm-4-plus' });
  });

  // 这是整个设计的关键：只切第一个斜杠，剩下的都属于模型名。
  test('嵌套斜杠归模型名', () => {
    const nested = p.parseModelRef('openrouter/z-ai/glm-4.6');
    assert.equal(nested.providerId, 'openrouter', JSON.stringify(nested));
    assert.equal(nested.model, 'z-ai/glm-4.6', JSON.stringify(nested));
  });

  test('多层斜杠也只切第一个', () => {
    const deep = p.parseModelRef('or/a/b/c/d');
    assert.equal(deep.providerId, 'or', JSON.stringify(deep));
    assert.equal(deep.model, 'a/b/c/d', JSON.stringify(deep));
  });

  test('冒号型模型名（Ollama）', () => {
    assert.equal(p.parseModelRef('ollama/qwen2.5:14b').model, 'qwen2.5:14b');
  });

  test('两侧空白被裁掉', () => {
    assert.equal(p.parseModelRef('  glm/glm-4-plus  ').providerId, 'glm');
  });

  test('没有斜杠时无效', () => {
    assert.equal(p.parseModelRef('glm-4-plus'), undefined);
  });

  test('以斜杠开头时无效', () => {
    assert.equal(p.parseModelRef('/glm-4-plus'), undefined);
  });

  test('以斜杠结尾时无效', () => {
    assert.equal(p.parseModelRef('glm/'), undefined);
  });

  test('空串无效', () => {
    assert.equal(p.parseModelRef(''), undefined);
  });

  test('只有斜杠无效', () => {
    assert.equal(p.parseModelRef('/'), undefined);
  });

  test('模型名全是空格时无效', () => {
    assert.equal(p.parseModelRef('glm/   '), undefined);
  });

  test('makeModelRef 与 parseModelRef 互逆', () => {
    assert.equal(p.parseModelRef(p.makeModelRef('openrouter', 'z-ai/glm-4.6')).model, 'z-ai/glm-4.6');
  });
});

describe('服务商列表容错', () => {
  let ok;
  let messy;
  let strings;
  let kinds;
  let nums;

  before(() => {
    const n = p.normalizeProviders;
    ok = n([
      { id: 'glm', label: '智谱', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', models: [{ name: 'glm-4-plus', contextWindow: 128000 }] },
    ]);

    // 手写 settings.json 什么都可能出现，坏条目跳过而不是整体失败。
    messy = n([
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

    strings = n([{ id: 'a', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4o'] }]);

    kinds = n([
      { id: 'a', kind: 'anthropic', models: ['m'] },
      { id: 'b', kind: 'vscode-lm', models: ['m'] },
      { id: 'c', kind: '胡说', models: ['m'] },
    ]);

    nums = n([{ id: 'a', models: [{ name: 'm', contextWindow: -5, maxOutputTokens: 'x' }] }]);
  });

  test('非数组返回空', () => {
    const n = p.normalizeProviders;
    assert.equal(n(undefined).length, 0);
    assert.equal(n('x').length, 0);
    assert.equal(n(null).length, 0);
  });

  test('正常条目被保留', () => {
    assert.equal(ok.length, 1);
  });

  test('baseUrl 末尾斜杠被裁掉', () => {
    assert.equal(ok[0].baseUrl, 'https://open.bigmodel.cn/api/paas/v4', ok[0].baseUrl);
  });

  test('模型窗口被保留', () => {
    assert.equal(ok[0].models[0].contextWindow, 128000);
  });

  test('坏条目全被跳过，只剩一个', () => {
    assert.equal(messy.length, 1, JSON.stringify(messy.map((x) => x.id)));
  });

  test('保留的是 good', () => {
    assert.equal(messy[0].id, 'good');
  });

  test('含斜杠的 id 被拒绝', () => {
    assert.ok(!messy.some((x) => x.id.includes('/')));
  });

  test('重复 id 只留第一个', () => {
    assert.equal(messy.filter((x) => x.id === 'good').length, 1);
  });

  test('模型可简写为字符串', () => {
    assert.equal(strings[0].models.length, 2, JSON.stringify(strings[0].models));
  });

  test('重复模型名被去掉', () => {
    assert.equal(strings[0].models.map((m) => m.name).join(','), 'gpt-4o,gpt-4o-mini');
  });

  test('kind 原样保留', () => {
    assert.equal(kinds[0].kind, 'anthropic');
    assert.equal(kinds[1].kind, 'vscode-lm');
  });

  test('非法 kind 退回 openai', () => {
    assert.equal(kinds[2].kind, 'openai');
  });

  test('非法数字被忽略', () => {
    assert.equal(nums[0].models[0].contextWindow, undefined);
    assert.equal(nums[0].models[0].maxOutputTokens, undefined);
  });
});

describe('解析与列举', () => {
  let providers;
  let a;
  let b;
  let choices;

  before(() => {
    providers = p.normalizeProviders([
      { id: 'glm', label: '智谱 GLM', kind: 'openai', models: [{ name: 'glm-4-plus', contextWindow: 128000 }, { name: 'glm-4-air' }] },
      { id: 'openrouter', label: 'OpenRouter', kind: 'openai', models: [{ name: 'z-ai/glm-4.6' }] },
      { id: 'copilot', kind: 'vscode-lm', models: [{ name: 'gpt-4o' }] },
    ]);
    a = p.resolveModelRef(providers, 'glm/glm-4-plus');
    b = p.resolveModelRef(providers, 'openrouter/z-ai/glm-4.6');
    choices = p.listModelChoices(providers);
  });

  test('解析出服务商', () => {
    assert.equal(a.profile.id, 'glm');
  });

  test('解析出模型', () => {
    assert.equal(a.model.name, 'glm-4-plus');
  });

  test('带回规范化的 ref', () => {
    assert.equal(a.ref, 'glm/glm-4-plus');
  });

  test('嵌套斜杠模型可解析', () => {
    assert.ok(b && b.model.name === 'z-ai/glm-4.6');
  });

  test('同名模型走不同渠道是两条', () => {
    assert.notEqual(p.resolveModelRef(providers, 'glm/glm-4-plus').profile.id, b.profile.id);
  });

  test('未知前缀返回 undefined', () => {
    assert.equal(p.resolveModelRef(providers, 'nope/x'), undefined);
  });

  test('未知模型返回 undefined', () => {
    assert.equal(p.resolveModelRef(providers, 'glm/不存在'), undefined);
  });

  test('部分匹配不算命中', () => {
    assert.equal(p.resolveModelRef(providers, 'glm/glm-4'), undefined);
  });

  test('firstModelRef 取第一个', () => {
    assert.equal(p.firstModelRef(providers), 'glm/glm-4-plus');
  });

  test('空列表时 firstModelRef 为空串', () => {
    assert.equal(p.firstModelRef([]), '');
  });

  test('列出全部 4 个模型', () => {
    assert.equal(choices.length, 4, `got ${choices.length}`);
  });

  test('列表保持配置顺序', () => {
    assert.equal(
      choices.map((c) => c.ref).join(','),
      'glm/glm-4-plus,glm/glm-4-air,openrouter/z-ai/glm-4.6,copilot/gpt-4o',
      choices.map((c) => c.ref).join(',')
    );
  });

  test('分组用服务商显示名', () => {
    assert.equal(choices[0].group, '智谱 GLM');
  });

  test('无 label 时分组回落到 id', () => {
    assert.equal(choices[3].group, 'copilot');
  });

  test('模型显示名回落到模型名', () => {
    assert.equal(choices[1].label, 'glm-4-air');
  });

  test('带上模型窗口', () => {
    assert.equal(choices[0].contextWindow, 128000);
    assert.equal(choices[1].contextWindow, undefined);
  });
});

describe('引用无效时的说明', () => {
  let providers;

  before(() => {
    providers = p.normalizeProviders([
      { id: 'glm', label: '智谱 GLM', models: [{ name: 'glm-4-plus' }, { name: 'glm-4-air' }] },
    ]);
  });

  test('没有服务商时提示去设置页', () => {
    assert.ok(p.describeModelIssue([], 'x').includes('设置'));
  });

  test('格式不对时说明格式', () => {
    assert.ok(p.describeModelIssue(providers, 'glm-4-plus').includes('服务商前缀/模型名'));
  });

  // 错误信息必须指名道姓，否则用户只能靠猜。
  test('未知前缀时列出已有前缀', () => {
    const unknown = p.describeModelIssue(providers, 'kimi/x');
    assert.ok(unknown.includes('kimi') && unknown.includes('glm'), unknown);
  });

  test('未知模型时列出该商可用模型', () => {
    const noModel = p.describeModelIssue(providers, 'glm/不存在');
    assert.ok(noModel.includes('glm/glm-4-plus') && noModel.includes('glm/glm-4-air'), noModel);
  });

  test('未选模型时给出示例', () => {
    assert.ok(p.describeModelIssue(providers, '').includes('glm/glm-4-plus'));
  });
});

describe('0.1.x 配置兼容', () => {
  let seeded;
  let lm;
  let none;

  before(() => {
    seeded = p.seedFromLegacy({
      provider: 'anthropic',
      openaiBaseUrl: 'https://api.deepseek.com/v1',
      openaiModel: 'deepseek-chat',
      anthropicBaseUrl: 'https://api.anthropic.com',
      anthropicModel: 'claude-sonnet-4-5',
      vscodeLmFamily: 'gpt-4o',
    });

    lm = p.seedFromLegacy({
      provider: 'vscode-lm', openaiBaseUrl: '', openaiModel: 'gpt-4o',
      anthropicBaseUrl: '', anthropicModel: '', vscodeLmFamily: 'claude-3.5-sonnet',
    });

    none = p.seedFromLegacy({
      provider: 'openai', openaiBaseUrl: '', openaiModel: '',
      anthropicBaseUrl: '', anthropicModel: '', vscodeLmFamily: '',
    });
  });

  test('三个服务商都被建出来', () => {
    assert.equal(seeded.providers.length, 3, JSON.stringify(seeded.providers.map((x) => x.id)));
  });

  test('沿用旧的 baseUrl', () => {
    assert.equal(seeded.providers[0].baseUrl, 'https://api.deepseek.com/v1');
  });

  test('沿用旧的模型名', () => {
    assert.equal(seeded.providers[0].models[0].name, 'deepseek-chat');
  });

  test('旧的 provider 选择被保留', () => {
    assert.equal(seeded.activeRef, 'anthropic/claude-sonnet-4-5', seeded.activeRef);
  });

  test('vscode-lm 映射到 copilot 前缀', () => {
    assert.equal(lm.activeRef, 'copilot/claude-3.5-sonnet', lm.activeRef);
  });

  test('anthropic 模型为空时不建该服务商', () => {
    assert.ok(!lm.providers.some((x) => x.id === 'anthropic'));
  });

  test('baseUrl 为空时取默认值', () => {
    assert.equal(lm.providers[0].baseUrl, 'https://api.openai.com/v1');
  });

  test('全空时不产生服务商', () => {
    assert.equal(none.providers.length, 0);
    assert.equal(none.activeRef, '');
  });
});

describe('readConfig 串起来', () => {
  let cfg;
  let cfg2;
  let bad;
  let emptyModel;
  let globals;
  let legacy;
  let both;

  before(() => {
    settings = {
      providers: [
        { id: 'glm', label: '智谱 GLM', kind: 'openai', models: [{ name: 'glm-4-plus', contextWindow: 128000 }] },
        { id: 'openrouter', kind: 'openai', models: [{ name: 'z-ai/glm-4.6', contextWindow: 200000, maxOutputTokens: 8192 }] },
      ],
      model: 'openrouter/z-ai/glm-4.6',
      contextWindow: 64000,
      maxOutputTokens: 4096,
    };
    cfg = configMod.readConfig();

    settings.model = 'glm/glm-4-plus';
    cfg2 = configMod.readConfig();

    settings.model = 'nope/x';
    bad = configMod.readConfig();

    settings.model = '';
    emptyModel = configMod.readConfig();

    globals = configMod.readBudgetFallback();

    // 老用户升级：providers 为空，应从旧设置兜底，而不是「没有模型」。
    settings = {
      provider: 'openai',
      'openai.baseUrl': 'https://api.deepseek.com/v1',
      'openai.model': 'deepseek-chat',
      'anthropic.model': '',
      'vscodeLm.family': '',
    };
    legacy = configMod.readConfig();

    // 新结构一旦存在就以它为准，不再看旧设置。
    settings.providers = [{ id: 'glm', models: [{ name: 'glm-4-plus' }] }];
    settings.model = 'glm/glm-4-plus';
    both = configMod.readConfig();
  });

  test('读出两个服务商', () => {
    assert.equal(cfg.providers.length, 2);
  });

  test('当前模型已解析', () => {
    assert.ok(cfg.active && cfg.active.model.name === 'z-ai/glm-4.6');
  });

  // 同一服务商下 32k 和 200k 的模型常并存，全局值不该盖住模型自带的窗口。
  test('模型窗口覆盖全局值', () => {
    assert.equal(cfg.contextWindow, 200000, String(cfg.contextWindow));
  });

  test('模型输出上限覆盖全局值', () => {
    assert.equal(cfg.maxOutputTokens, 8192, String(cfg.maxOutputTokens));
  });

  test('切换模型后窗口跟着变', () => {
    assert.equal(cfg2.contextWindow, 128000, String(cfg2.contextWindow));
  });

  test('模型没设输出上限时用全局值', () => {
    assert.equal(cfg2.maxOutputTokens, 4096, String(cfg2.maxOutputTokens));
  });

  test('引用无效时 active 为空', () => {
    assert.equal(bad.active, undefined);
  });

  test('引用无效时退回全局窗口', () => {
    assert.equal(bad.contextWindow, 64000, String(bad.contextWindow));
  });

  test('引用无效时不丢服务商列表', () => {
    assert.equal(bad.providers.length, 2);
  });

  test('未指定模型时取第一个', () => {
    assert.equal(emptyModel.model, 'glm/glm-4-plus');
  });

  test('readBudgetFallback 不受模型覆盖影响', () => {
    assert.equal(globals.contextWindow, 64000, String(globals.contextWindow));
  });

  test('providers 为空时从旧设置兜底', () => {
    assert.equal(legacy.providers.length, 1, JSON.stringify(legacy.providers));
  });

  test('兜底后模型可用', () => {
    assert.ok(legacy.active && legacy.active.model.name === 'deepseek-chat');
  });

  test('兜底后引用为 openai/deepseek-chat', () => {
    assert.equal(legacy.model, 'openai/deepseek-chat', legacy.model);
  });

  test('新结构存在时忽略旧设置', () => {
    assert.equal(both.providers.length, 1, JSON.stringify(both.providers.map((x) => x.id)));
    assert.equal(both.providers[0].id, 'glm', JSON.stringify(both.providers.map((x) => x.id)));
  });
});

describe('默认模型列表', () => {
  const providers = [
    { id: 'glm', models: [{ name: 'glm-4-plus', contextWindow: 128000 }] },
    { id: 'ds', models: [{ name: 'deepseek-chat', contextWindow: 64000 }] },
  ];

  let upgraded;
  let seeded;
  let listed;
  let broken;
  let defaults;
  let high;
  let low;
  let odd;

  before(() => {
    // 只有 model 的旧配置：自动升级成单元素列表，用户无感。
    settings = { providers, model: 'ds/deepseek-chat' };
    upgraded = configMod.readConfig();

    // 两者都空：取第一个可用模型，不能是空列表。
    settings = { providers };
    seeded = configMod.readConfig();

    // 列表是唯一真相：model 恒等于首项，哪怕磁盘上的 model 指着别处。
    settings = { providers, models: ['ds/deepseek-chat', 'glm/glm-4-plus'], model: 'glm/glm-4-plus' };
    listed = configMod.readConfig();

    // 解析不出的引用**留在列表里**——设置页要能说清「这个模型没了」，
    // 剔除是模型池构造时的事（那里会打 warn）。
    settings = { providers, models: ['nope/x', 'glm/glm-4-plus'] };
    broken = configMod.readConfig();

    // 并发与 fallback 的默认值与 clamp。
    settings = { providers };
    defaults = configMod.readConfig();

    settings = { providers, concurrency: 99, fallbackAttempts: 99 };
    high = configMod.readConfig();

    settings = { providers, concurrency: 0, fallbackAttempts: -3 };
    low = configMod.readConfig();

    settings = { providers, concurrency: 2.7, fallbackAttempts: '3' };
    odd = configMod.readConfig();
  });

  test('非数组返回空', () => {
    const norm = configMod.normalizeModelList;
    assert.equal(norm(undefined).length, 0);
    assert.equal(norm(null).length, 0);
  });

  test('裸字符串当作单元素列表', () => {
    assert.equal(configMod.normalizeModelList('glm/a').join(','), 'glm/a');
  });

  test('去空白与空项', () => {
    const norm = configMod.normalizeModelList;
    assert.equal(norm(['  a/x  ', '', '   ']).join(','), 'a/x', JSON.stringify(norm(['  a/x  ', '', '   '])));
  });

  test('去重且保序', () => {
    assert.equal(configMod.normalizeModelList(['a/x', 'b/y', 'a/x']).join(','), 'a/x,b/y');
  });

  test('非字符串项被跳过', () => {
    assert.equal(configMod.normalizeModelList(['a/x', 42, null, { a: 1 }]).join(','), 'a/x');
  });

  test('旧配置只有 model 时升级成单元素列表', () => {
    assert.equal(upgraded.models.join(','), 'ds/deepseek-chat', upgraded.models.join(','));
  });

  test('升级后 model 不变', () => {
    assert.equal(upgraded.model, 'ds/deepseek-chat');
  });

  test('都没配时取第一个可用模型', () => {
    assert.equal(seeded.models.join(','), 'glm/glm-4-plus', seeded.models.join(','));
  });

  test('model 恒等于列表首项', () => {
    assert.equal(listed.model, 'ds/deepseek-chat', listed.model);
  });

  test('首项决定窗口', () => {
    assert.equal(listed.contextWindow, 64000, String(listed.contextWindow));
  });

  test('列表原样保留顺序', () => {
    assert.equal(listed.models.join(','), 'ds/deepseek-chat,glm/glm-4-plus');
  });

  test('解析不出的引用不在 readConfig 里被丢掉', () => {
    assert.equal(broken.models.length, 2, broken.models.join(','));
  });

  test('首项解析不出时 active 为空', () => {
    assert.equal(broken.active, undefined);
  });

  test('并发默认 3', () => {
    assert.equal(defaults.concurrency, 3, String(defaults.concurrency));
  });

  test('换模型重试默认 2 次', () => {
    assert.equal(defaults.fallbackAttempts, 2, String(defaults.fallbackAttempts));
  });

  test('并发超上限被收到 16', () => {
    assert.equal(high.concurrency, 16, String(high.concurrency));
  });

  test('重试超上限被收到 5', () => {
    assert.equal(high.fallbackAttempts, 5, String(high.fallbackAttempts));
  });

  test('并发不小于 1', () => {
    assert.equal(low.concurrency, 1, String(low.concurrency));
  });

  test('重试次数不小于 0', () => {
    assert.equal(low.fallbackAttempts, 0, String(low.fallbackAttempts));
  });

  test('小数向下取整', () => {
    assert.equal(odd.concurrency, 2, String(odd.concurrency));
  });

  test('非数字退回默认值', () => {
    assert.equal(odd.fallbackAttempts, 2, String(odd.fallbackAttempts));
  });
});

describe('设置页未保存编辑不被刷新冲掉', () => {
  // 把 view.js 里那段 renderSettings 的逻辑原样复刻一遍。
  // 这是一条真实的丢数据路径：FileSystemWatcher 一刷新就推设置，
  // 用户正在填的 baseUrl 不该被磁盘上的旧值覆盖。
  const snap = {};

  before(() => {
    const draft = { providers: [], keys: {}, dirty: false };
    const render = (s, keys, ack) => {
      const nextKeys = keys || {};
      if (ack === 'saved') draft.dirty = false;
      if (draft.dirty) {
        if (JSON.stringify(nextKeys) !== JSON.stringify(draft.keys)) draft.keys = nextKeys;
        return;
      }
      draft.providers = JSON.parse(JSON.stringify(s.providers || []));
      draft.keys = nextKeys;
    };

    const onDisk = { providers: [{ id: 'glm', models: [{ name: 'glm-4-plus' }] }] };
    render(onDisk, { glm: false });
    snap.firstId = draft.providers[0].id;

    // 用户开始编辑
    draft.providers[0].baseUrl = 'https://正在填一半';
    draft.dirty = true;

    render(onDisk, { glm: false });
    snap.afterRefresh = draft.providers[0].baseUrl;

    // 刚在弹窗里输完 Key，状态要更新
    render(onDisk, { glm: true });
    snap.keysGlm = draft.keys.glm;
    snap.afterKeyUpdate = draft.providers[0].baseUrl;

    // 保存被拒：必须保住编辑
    render(onDisk, { glm: true }, 'rejected');
    snap.afterRejected = draft.providers[0].baseUrl;
    snap.dirtyAfterRejected = draft.dirty;

    // 保存成功：以磁盘为准
    const saved = { providers: [{ id: 'glm', baseUrl: 'https://填完了', models: [{ name: 'glm-4-plus' }] }] };
    render(saved, { glm: true }, 'saved');
    snap.afterSaved = draft.providers[0].baseUrl;
    snap.dirtyAfterSaved = draft.dirty;

    render({ providers: [] }, { glm: true });
    snap.cleanLength = draft.providers.length;
  });

  test('首次渲染读磁盘', () => {
    assert.equal(snap.firstId, 'glm');
  });

  test('刷新不冲掉未保存的编辑', () => {
    assert.equal(snap.afterRefresh, 'https://正在填一半');
  });

  test('脏状态下 Key 状态仍会更新', () => {
    assert.equal(snap.keysGlm, true);
  });

  test('更新 Key 状态时不动编辑内容', () => {
    assert.equal(snap.afterKeyUpdate, 'https://正在填一半');
  });

  test('保存被拒时保住编辑', () => {
    assert.equal(snap.afterRejected, 'https://正在填一半');
  });

  test('保存被拒后仍是脏的', () => {
    assert.equal(snap.dirtyAfterRejected, true);
  });

  test('保存成功后以磁盘为准', () => {
    assert.equal(snap.afterSaved, 'https://填完了');
  });

  test('保存成功后不再是脏的', () => {
    assert.equal(snap.dirtyAfterSaved, false);
  });

  test('干净状态下正常跟随磁盘', () => {
    assert.equal(snap.cleanLength, 0);
  });
});

describe('设置页草稿：新配置的模型不必先保存就能测', () => {
  // 「新加的模型必须先保存才能测」对用户毫无道理——而且保存一份没验过的
  // 配置正是「测试」这个按钮想要避免的事。设置页把屏幕上那份服务商随
  // testConnection 一起发过来，解析时叠加到已保存的列表上。
  let saved;
  let draft;
  let withDraft;
  let fresh;
  let movedResolved;
  let brandNew;

  before(() => {
    saved = p.normalizeProviders([
      { id: 'openai', label: 'my-router', kind: 'openai', baseUrl: 'https://router.example/v1',
        models: [{ name: 'gemini/gemma-4-31b-it' }, { name: 'ms/deepseek-ai/DeepSeek-V4-Flash' }] },
      { id: 'glm', kind: 'openai', models: [{ name: 'glm-4-plus' }] },
    ]);

    // 屏幕上：同一个服务商刚加了第三个模型，还没保存。
    draft = p.normalizeProviders([
      { id: 'openai', label: 'my-router', kind: 'openai', baseUrl: 'https://router.example/v1',
        models: [{ name: 'gemini/gemma-4-31b-it' }, { name: 'ms/deepseek-ai/DeepSeek-V4-Flash' },
          { name: 'ms/deepseek-ai/DeepSeek-V4-Pro' }] },
    ])[0];

    withDraft = p.withDraftProvider(saved, draft);
    fresh = p.resolveModelRef(withDraft, 'openai/ms/deepseek-ai/DeepSeek-V4-Pro');

    // 改了 baseUrl 但没保存，测试要打新地址而不是旧地址。
    const moved = p.normalizeProviders([
      { id: 'openai', kind: 'openai', baseUrl: 'https://新地址.example/v1', models: [{ name: 'gemini/gemma-4-31b-it' }] },
    ])[0];
    movedResolved = p.resolveModelRef(p.withDraftProvider(saved, moved), 'openai/gemini/gemma-4-31b-it');

    // 全新的服务商（还没保存过任何一份）同样要能测。
    brandNew = p.normalizeProviders([
      { id: 'kimi', kind: 'openai', baseUrl: 'https://kimi.example/v1', models: [{ name: 'moonshot-v1-128k' }] },
    ])[0];
  });

  test('未保存的新模型能解析出来', () => {
    assert.ok(!!fresh, p.describeModelIssue(withDraft, 'openai/ms/deepseek-ai/DeepSeek-V4-Pro'));
  });

  test('解析出的模型名是完整的（含两层斜杠）', () => {
    assert.ok(fresh && fresh.model.name === 'ms/deepseek-ai/DeepSeek-V4-Pro', fresh && fresh.model.name);
  });

  // 草稿只顶掉同 id 的那一个，别家不能受牵连——否则 ref 指向 glm 时就废了。
  test('草稿不影响其他服务商', () => {
    assert.ok(!!p.resolveModelRef(withDraft, 'glm/glm-4-plus'));
  });

  test('同 id 只保留草稿那一份', () => {
    assert.equal(withDraft.filter((x) => x.id === 'openai').length, 1);
  });

  test('草稿排在最前（同 id 时命中屏幕上这份）', () => {
    assert.equal(withDraft[0], draft);
  });

  test('未保存的 baseUrl 生效', () => {
    assert.ok(
      movedResolved && movedResolved.profile.baseUrl === 'https://新地址.example/v1',
      movedResolved && movedResolved.profile.baseUrl
    );
  });

  test('没有草稿时原样返回', () => {
    assert.equal(p.withDraftProvider(saved, undefined), saved);
  });

  test('全新服务商的模型也能测', () => {
    assert.ok(!!p.resolveModelRef(p.withDraftProvider(saved, brandNew), 'kimi/moonshot-v1-128k'));
  });

  test('全新服务商不挤掉已保存的', () => {
    assert.equal(p.withDraftProvider(saved, brandNew).length, 3);
  });
});

describe('config.json 缺席时的 settings.json 兜底', () => {
  // 真实 VS Code 壳里这是**两个不同的源**：ConfigStore 读 ~/.novelforge/config.json，
  // legacy reader 读 settings.json。上面的用例让两者共用一个对象，
  // 恰好掩盖了这条路径——这里必须分开。
  //
  // 触发条件：config.json 不存在/损坏（FileConfigStore.read 返回 undefined），
  // 而用户的 novel.providers 就在 settings.json 里。
  let configJson;
  let cfg;
  let back;
  let seeded;
  /** 落盘那一刻的快照：configJson 在本节最后会被置回 undefined。 */
  let diskKeys;
  let diskProviders;

  before(async () => {
    const userProvider = {
      id: 'openai', label: 'my-router', kind: 'openai',
      baseUrl: 'https://router.example/v1',
      models: [{ name: 'gemini/gemma-4-31b-it', contextWindow: 256000, maxOutputTokens: 33000 }],
    };
    // cfg.get() 对声明了默认值的键永远返回值，所以 0.1.x 的键总是"存在"。
    const settingsJson = {
      providers: [userProvider],
      model: 'openai/gemini/gemma-4-31b-it',
      contextWindow: 256000,
      maxOutputTokens: 35840,
      provider: 'openai',
      'openai.baseUrl': 'https://api.openai.com/v1',
      'openai.model': 'gpt-4o',
      'anthropic.baseUrl': 'https://api.anthropic.com',
      'anthropic.model': 'claude-sonnet-4-5',
      'vscodeLm.family': 'gpt-4o',
    };
    configMod.initConfigFromHost({
      config: { read: () => configJson, write: async (s) => { configJson = JSON.parse(JSON.stringify(s)); } },
    });
    // 用**真实**的 legacySettingsReader，而不是手写桩：这条 bug 的一半就出在
    // 那个 reader 只读 0.1.x 的键、把 novel.providers 整份漏掉。
    settings = settingsJson;
    configMod.setLegacyConfigReader(loadModule('src/vscode/migrate.ts').legacySettingsReader);

    cfg = configMod.readConfig();

    // 只改一个字段的写入（下拉框切模型）不能把 providers 弄丢，
    // 否则回读时 model 指向的服务商解析不出来，界面报「下没有模型」。
    await configMod.updateSettings({ model: 'openai/gemini/gemma-4-31b-it' });
    diskKeys = Object.keys(configJson);
    diskProviders = configJson.providers;
    back = configMod.readConfig();

    // providers 被用户清空时，0.1.x 兜底仍要生效（老用户升级路径不能回归）。
    const legacyOnly = { provider: 'openai', 'openai.baseUrl': 'https://api.deepseek.com/v1', 'openai.model': 'deepseek-chat', 'anthropic.model': '', 'vscodeLm.family': '' };
    configJson = undefined;
    settings = legacyOnly;
    seeded = configMod.readConfig();
  });

  test('用 settings.json 里的 providers，而不是 0.1.x 默认值', () => {
    assert.equal(cfg.providers.length, 1, JSON.stringify(cfg.providers.map((x) => x.label)));
    assert.equal(cfg.providers[0].label, 'my-router', JSON.stringify(cfg.providers.map((x) => x.label)));
  });

  test('当前模型解析得出', () => {
    assert.ok(!!cfg.active, cfg.active ? '' : p.describeModelIssue(cfg.providers, cfg.model));
  });

  test('窗口取模型自带值', () => {
    assert.equal(cfg.contextWindow, 256000, String(cfg.contextWindow));
  });

  test('落盘时带上 providers', () => {
    assert.ok(Array.isArray(diskProviders) && diskProviders.length === 1, JSON.stringify(diskKeys));
  });

  test('落盘时丢掉 0.1.x 的带点键', () => {
    assert.ok(!diskKeys.some((k) => k.includes('.') || k === 'provider'), JSON.stringify(diskKeys));
  });

  test('回读后模型仍可解析', () => {
    assert.ok(!!back.active, back.active ? '' : p.describeModelIssue(back.providers, back.model));
  });

  test('回读后仍是用户的服务商', () => {
    assert.ok(back.providers[0] && back.providers[0].label === 'my-router');
  });

  test('纯 0.1.x 设置仍能兜底', () => {
    assert.ok(seeded.model === 'openai/deepseek-chat' && !!seeded.active, seeded.model);
  });
});

/**
 * 切换模型 = 把它提到默认模型列表首位。
 *
 * 单独一节且放在最后，因为它要 await 落盘：前面的用例都是同步读配置，
 * 混进去会打乱它们对 `settings` 的假设。
 */
describe('切换模型 = 提到列表首位', () => {
  const providers = [
    { id: 'glm', models: [{ name: 'glm-4-plus' }] },
    { id: 'ds', models: [{ name: 'deepseek-chat' }] },
    { id: 'kimi', models: [{ name: 'moonshot-v1-128k' }] },
  ];

  let disk;
  let after1;
  let diskAfter1;
  let afterPlainWrite;
  let afterPromoteKimi;
  let afterOutsideList;

  before(async () => {
    // 自带一份存储：上一节把 store 换成了 configJson，这里要能直接看落盘结果。
    disk = { providers, models: ['glm/glm-4-plus', 'ds/deepseek-chat', 'kimi/moonshot-v1-128k'] };
    configMod.initConfigFromHost({
      config: { read: () => disk, write: async (s) => { disk = JSON.parse(JSON.stringify(s)); } },
    });

    await configMod.promoteModel('ds/deepseek-chat');
    after1 = configMod.readConfig();
    diskAfter1 = { models0: disk.models[0], model: disk.model };

    // 只写 model 不写 models 会被首项盖回去——这是「列表是唯一真相」的代价：
    // 所有切换模型的入口都必须走 promoteModel，不能自己写 model。
    await configMod.updateSettings({ model: 'kimi/moonshot-v1-128k' });
    afterPlainWrite = configMod.readConfig();

    await configMod.promoteModel('kimi/moonshot-v1-128k');
    afterPromoteKimi = configMod.readConfig();

    // 列表里原本没有的模型也能切过去（命令面板可以选到任何已配置的模型）。
    disk = { providers, models: ['glm/glm-4-plus'] };
    await configMod.promoteModel('ds/deepseek-chat');
    afterOutsideList = configMod.readConfig();
  });

  test('切换的模型排到了首位', () => {
    assert.equal(after1.models[0], 'ds/deepseek-chat', after1.models.join(','));
  });

  test('其余顺序原样保留', () => {
    assert.equal(
      after1.models.join(','),
      'ds/deepseek-chat,glm/glm-4-plus,kimi/moonshot-v1-128k',
      after1.models.join(',')
    );
  });

  test('model 跟着变', () => {
    assert.equal(after1.model, 'ds/deepseek-chat', after1.model);
  });

  test('落盘的 models 与 model 一致', () => {
    assert.equal(diskAfter1.models0, diskAfter1.model, `${diskAfter1.models0} vs ${diskAfter1.model}`);
  });

  test('只写 model 不生效（切换模型必须走 promoteModel）', () => {
    assert.equal(afterPlainWrite.model, 'ds/deepseek-chat', afterPlainWrite.model);
  });

  test('promoteModel 才切得动', () => {
    assert.equal(afterPromoteKimi.model, 'kimi/moonshot-v1-128k');
  });

  test('切换不丢别的模型', () => {
    assert.equal(afterPromoteKimi.models.length, 3, afterPromoteKimi.models.join(','));
  });

  test('切到列表外的模型会把它加进列表', () => {
    assert.equal(
      afterOutsideList.models.join(','),
      'ds/deepseek-chat,glm/glm-4-plus',
      afterOutsideList.models.join(',')
    );
  });
});
