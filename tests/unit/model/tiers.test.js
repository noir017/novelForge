/**
 * 模型分档的配置容错：tierModels / taskTiers 读坏了不崩、空档位继承 models、
 * 认不出的任务名与档位名一律回落内置默认。
 * 迁自 scripts/smoke-providers.js 的 `== 模型分档的配置容错 ==` 一节。
 *
 * config.ts 与 tiers.ts 打进同一个 bundle：这样 config 内部那份 tiers 与用例里断言用的
 * DEFAULT_TASK_TIERS 是同一个实例（tiers.ts 零 import、全是常量，分开也对，但同 bundle 更稳）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');

/** 当前这一轮的设置。每个 describe 的 before() 自己改。 */
let settings = {};

const providers = [
  { id: 'glm', models: [{ name: 'glm-4-plus' }, { name: 'glm-4-air' }] },
  { id: 'ds', models: [{ name: 'deepseek-chat' }] },
];

let configMod;
let tiersMod;

before(() => {
  const bundle = loadBundle({
    config: './src/core/config.ts',
    tiers: './src/core/model/tiers.ts',
  });
  configMod = bundle.config;
  tiersMod = bundle.tiers;
  // readConfig 由注入的 ConfigStore 供数：这里用内存对象模拟 settings.json。
  configMod.initConfigFromHost({
    config: {
      read: () => settings,
      write: async (s) => { settings = s; },
    },
  });
  configMod.setLegacyConfigReader({ read: () => settings });
});

describe('模型分档的配置容错', () => {
  describe('缺席 / 类型不对', () => {
    let none;
    let junk;

    before(() => {
      // 缺席 / 类型不对：三档都退化为空数组 = 全部沿用 models，与分档前一致。
      settings = { providers, models: ['glm/glm-4-plus'] };
      none = configMod.readConfig();

      settings = { providers, models: ['glm/glm-4-plus'], tierModels: 'nonsense', taskTiers: 42 };
      junk = configMod.readConfig();
    });

    test('没配 tierModels 时三档都是空数组', () => {
      assert.ok(
        ['fast', 'balanced', 'quality'].every(
          (t) => Array.isArray(none.tierModels[t]) && none.tierModels[t].length === 0
        ),
        JSON.stringify(none.tierModels)
      );
    });

    test('没配 taskTiers 时是空对象', () => {
      assert.equal(Object.keys(none.taskTiers).length, 0, JSON.stringify(none.taskTiers));
    });

    test('空档位的任务沿用 models', () => {
      assert.equal(tiersMod.refsForTask(none, 'plotSummary').refs.join(','), 'glm/glm-4-plus');
    });

    test('沿用时标出 inherited', () => {
      assert.equal(tiersMod.refsForTask(none, 'plotSummary').inherited, true);
    });

    test('tierModels 不是对象时不崩', () => {
      assert.equal(junk.tierModels.fast.length, 0, JSON.stringify(junk.tierModels));
      assert.equal(junk.tierModels.quality.length, 0, JSON.stringify(junk.tierModels));
    });

    test('taskTiers 不是对象时不崩', () => {
      assert.equal(Object.keys(junk.taskTiers).length, 0);
    });
  });

  describe('档内归一', () => {
    let normed;

    before(() => {
      // 每档各自走 normalizeModelList：去空、去重、保序。
      settings = {
        providers,
        models: ['glm/glm-4-plus'],
        tierModels: { fast: ['  glm/glm-4-air ', '', 'glm/glm-4-air', 42], quality: 'ds/deepseek-chat' },
      };
      normed = configMod.readConfig();
    });

    test('档内去空白、去重、保序', () => {
      assert.equal(normed.tierModels.fast.join(','), 'glm/glm-4-air', JSON.stringify(normed.tierModels.fast));
    });

    test('档位给成裸字符串时收成单元素', () => {
      assert.equal(
        normed.tierModels.quality.join(','),
        'ds/deepseek-chat',
        JSON.stringify(normed.tierModels.quality)
      );
    });

    test('没提到的档仍是空数组', () => {
      assert.equal(normed.tierModels.balanced.length, 0);
    });
  });

  describe('解析不出的引用留在档里', () => {
    let stale;

    before(() => {
      // 与 models 一致：解析不出的引用留在档里，剔除是模型池的事（那里会 warn）。
      settings = { providers, models: ['glm/glm-4-plus'], tierModels: { fast: ['nope/x', 'glm/glm-4-air'] } };
      stale = configMod.readConfig();
    });

    test('档里解析不出的引用不在 readConfig 里被丢掉', () => {
      assert.equal(stale.tierModels.fast.length, 2, stale.tierModels.fast.join(','));
    });
  });

  describe('taskTiers 的覆盖与回落', () => {
    let tiers;

    before(() => {
      // taskTiers：认不出的任务名与非法档位名一律丢弃，那一项回落内置默认。
      settings = {
        providers,
        models: ['glm/glm-4-plus'],
        taskTiers: { plotSummary: 'quality', extractStyle: '超级档', nosuchTask: 'fast', loreScan: 7 },
      };
      tiers = configMod.readConfig();
    });

    test('合法的覆盖被保留', () => {
      assert.equal(tiers.taskTiers.plotSummary, 'quality', JSON.stringify(tiers.taskTiers));
    });

    test('非法档位名被丢弃', () => {
      assert.equal(tiers.taskTiers.extractStyle, undefined, JSON.stringify(tiers.taskTiers));
    });

    test('认不出的任务名被丢弃', () => {
      assert.equal(tiers.taskTiers.nosuchTask, undefined, JSON.stringify(tiers.taskTiers));
    });

    test('非字符串档位被丢弃', () => {
      assert.equal(tiers.taskTiers.loreScan, undefined, JSON.stringify(tiers.taskTiers));
    });

    test('覆盖优先于内置默认', () => {
      assert.equal(tiersMod.tierOf(tiers, 'plotSummary'), 'quality');
    });

    test('丢弃后回落内置默认', () => {
      assert.equal(tiersMod.tierOf(tiers, 'extractStyle'), tiersMod.DEFAULT_TASK_TIERS.extractStyle);
    });
  });

  describe('内置默认表自身的完备性', () => {
    // 内置默认必须给每个任务都指定一档，否则 refsForTask 会取到 undefined。
    test('每个任务都有内置默认档位', () => {
      assert.ok(
        tiersMod.LLM_TASKS.every((t) => tiersMod.MODEL_TIERS.includes(tiersMod.DEFAULT_TASK_TIERS[t])),
        JSON.stringify(tiersMod.DEFAULT_TASK_TIERS)
      );
    });

    test('每个任务与档位都有中文名（设置页要显示）', () => {
      assert.ok(tiersMod.LLM_TASKS.every((t) => !!tiersMod.TASK_LABEL[t]));
      assert.ok(tiersMod.MODEL_TIERS.every((t) => !!tiersMod.TIER_LABEL[t]));
    });
  });
});
