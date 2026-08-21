/**
 * 设置页：二级分类、上下文参数、模型分档与任务档位、「高级设置」折叠。
 *
 * 迁自 scripts/smoke-view.js 的 == 设置页：模型分档 ==（1741）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

const settings = (extra) =>
  Object.assign(
    {
      providers: [{ id: 'p', kind: 'openai', models: [{ name: 'cheap' }, { name: 'smart' }] }],
      models: ['p/smart'],
      tierModels: { fast: [], balanced: [], quality: [] },
      taskTiers: {},
      temperature: 0.8,
      recentChaptersFullText: 2,
      prevChapterTailChars: 1500,
      summaryBatchSize: 15,
      requestTimeoutMs: 300000,
      concurrency: 3,
      fallbackAttempts: 2,
    },
    extra
  );

describe('设置页：模型分档', { skip: JSDOM_SKIP }, () => {
  let ui;
  let sent;
  let modelTab;
  let contextTab;
  let modelPanel;
  let contextPanel;
  let advToggle;
  let advBox;
  const rows = (id) => [...ui.doc.querySelectorAll(`#${id} .model-entry`)];
  const refsOf = (id) => rows(id).map((n) => n.querySelector('.model-entry-ref').textContent);
  const taskRows = () => [...ui.doc.querySelectorAll('.task-tier-row')];
  const taskNames = () => taskRows().map((r) => r.querySelector('.task-tier-name').textContent);
  const nameOf = (i) => taskRows()[i].querySelector('.task-tier-name').textContent;
  const selOf = (i) => taskRows()[i].querySelector('select');
  const save = () => {
    ui.doc.getElementById('saveSettingsBtn').click();
    return [...ui.sent].reverse().find((m) => m.type === 'saveSettings');
  };

  before(() => {
    ui = mount();
    ui.post({
      type: 'settings',
      settings: settings({ tierModels: { fast: ['p/cheap'], balanced: [], quality: ['p/smart'] } }),
      keys: {},
    });
    modelTab = ui.doc.getElementById('settingsTabModels');
    contextTab = ui.doc.getElementById('settingsTabContext');
    modelPanel = ui.doc.getElementById('settingsPanelModels');
    contextPanel = ui.doc.getElementById('settingsPanelContext');
  });

  test('设置页有两个二级分类', () => {
    assert.ok(modelTab && contextTab);
  });

  test('默认显示模型配置', () => {
    assert.equal(modelTab.getAttribute('aria-selected'), 'true');
    assert.ok(!modelPanel.hidden);
  });

  test('默认隐藏上下文管理', () => {
    assert.equal(contextTab.getAttribute('aria-selected'), 'false');
    assert.ok(contextPanel.hidden);
  });

  test('点击后切到上下文管理', () => {
    contextTab.click();
    assert.equal(contextTab.getAttribute('aria-selected'), 'true');
    assert.ok(!contextPanel.hidden);
    assert.ok(modelPanel.hidden);
  });

  test('二级分类支持方向键切换', () => {
    contextTab.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.equal(modelTab.getAttribute('aria-selected'), 'true');
    assert.ok(!modelPanel.hidden);
  });

  test('页面不再提供全局预算输入', () => {
    assert.ok(!ui.doc.getElementById('setContextWindow') && !ui.doc.getElementById('setMaxOutputTokens'));
  });

  test('上下文参数各自回显', () => {
    assert.equal(ui.doc.getElementById('setRecentChaptersFullText').value, '2');
    assert.equal(ui.doc.getElementById('setPrevChapterTailChars').value, '1500');
    assert.equal(ui.doc.getElementById('setSummaryBatchSize').value, '15');
  });

  test('上下文参数独立提交', () => {
    ui.doc.getElementById('setRecentChaptersFullText').value = '4';
    ui.doc.getElementById('setPrevChapterTailChars').value = '2400';
    ui.doc.getElementById('setSummaryBatchSize').value = '12';
    sent = save();
    assert.equal(sent.settings.recentChaptersFullText, 4, JSON.stringify(sent.settings));
    assert.equal(sent.settings.prevChapterTailChars, 2400, JSON.stringify(sent.settings));
    assert.equal(sent.settings.summaryBatchSize, 12, JSON.stringify(sent.settings));
  });

  test('保存负载不含全局预算', () => {
    assert.ok(!Object.hasOwn(sent.settings, 'contextWindow') && !Object.hasOwn(sent.settings, 'maxOutputTokens'),
      JSON.stringify(sent.settings));
  });

  test('三档各自渲染出自己的清单', () => {
    assert.equal(refsOf('tierModelList-fast').join(','), 'p/cheap', refsOf('tierModelList-fast').join(','));
  });

  test('精标档也渲染得出', () => {
    assert.equal(refsOf('tierModelList-quality').join(','), 'p/smart', refsOf('tierModelList-quality').join(','));
  });

  test('默认模型清单照旧', () => {
    assert.equal(refsOf('defaultModelList').join(','), 'p/smart', refsOf('defaultModelList').join(','));
  });

  // 空档位的说明必须说清「沿用默认模型」——否则用户以为这档的任务跑不了。
  test('空档位说明是「沿用默认模型」', () => {
    const emptyHint = ui.doc.querySelector('#tierModelList-balanced .hint');
    assert.ok(emptyHint && emptyHint.textContent.includes('沿用'), emptyHint && emptyHint.textContent);
  });

  // 行数跟着 LLM_TASKS 走，不写死——加一个任务就改一次测试没有意义。
  // 要紧的是**每个任务都有一行**，漏掉的那个在设置页上就永远调不了档。
  test('任务表每个任务一行', () => {
    assert.ok(taskRows().length >= 10, `${taskRows().length} 行`);
  });

  // 流水线在设置页上是两条：写剧情 / 批量写正文（拆场景那一档随场景层删掉了）。
  test('流水线的三个任务在表里', () => {
    assert.ok(['剧情细纲', '批量写正文'].every((n) => taskNames().includes(n)),
      taskNames().join('|'));
  });

  test('第一行是单章摘要', () => {
    assert.equal(nameOf(0), '单章摘要', nameOf(0));
  });

  test('单章摘要默认落在快速档', () => {
    assert.equal(selOf(0).value, 'fast', selOf(0).value);
  });

  test('内置默认在下拉里标出来', () => {
    assert.ok([...selOf(0).options].some((o) => o.value === 'fast' && o.textContent.includes('默认')),
      [...selOf(0).options].map((o) => o.textContent).join('|'));
  });

  // 改一行档位 → 只有改过的项进负载。
  test('改过的任务写进 taskTiers', () => {
    selOf(0).value = 'quality';
    selOf(0).dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    sent = save();
    assert.equal(sent.settings.taskTiers.plotSummary, 'quality', JSON.stringify(sent.settings.taskTiers));
  });

  test('没改过的任务不写进配置', () => {
    assert.equal(Object.keys(sent.settings.taskTiers).length, 1, JSON.stringify(sent.settings.taskTiers));
  });

  test('档位清单原样带上', () => {
    assert.equal(sent.settings.tierModels.fast.join(','), 'p/cheap', JSON.stringify(sent.settings.tierModels));
  });

  // 选回默认 = 删掉覆盖，而不是把默认值钉死进配置。
  test('选回默认就删掉覆盖', () => {
    selOf(0).value = 'fast';
    selOf(0).dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    sent = save();
    assert.equal(Object.keys(sent.settings.taskTiers).length, 0, JSON.stringify(sent.settings.taskTiers));
  });

  // 档位里指向已删模型的引用：保存时摘掉，但**摘空了就让它空着**
  //（空档位是「沿用默认模型」，不该像默认模型那样兜底塞一个进去）。
  test('已删模型仍留在界面上并标出来', () => {
    ui.post({
      type: 'settings',
      ack: 'saved',
      settings: settings({ tierModels: { fast: ['p/gone'], balanced: [], quality: [] } }),
      keys: {},
    });
    assert.ok(ui.doc.querySelector('#tierModelList-fast .model-tag.danger'));
  });

  test('保存时摘掉已删模型', () => {
    sent = save();
    assert.equal(sent.settings.tierModels.fast.length, 0, JSON.stringify(sent.settings.tierModels));
  });

  test('摘空的档位保持为空（不兜底塞模型）', () => {
    assert.equal(sent.settings.tierModels.fast.length, 0);
  });

  test('默认模型不受影响', () => {
    assert.equal(sent.settings.models.join(','), 'p/smart', sent.settings.models.join(','));
  });

  // 后端没推 tierModels/taskTiers（旧版本）时前端不能崩。
  test('旧后端不推分档字段时不崩', () => {
    const old = settings();
    delete old.tierModels;
    delete old.taskTiers;
    ui.post({ type: 'settings', ack: 'saved', settings: old, keys: {} });
    assert.ok(taskRows().length >= 10, `${taskRows().length} 行`);
  });

  test('缺字段时三档都渲染成空', () => {
    assert.equal(refsOf('tierModelList-fast').length, 0);
  });

  // 「高级设置」折叠开关：模型分档及它后面的三块默认收起。
  test('有高级设置开关', () => {
    advToggle = ui.doc.getElementById('settingsAdvancedToggle');
    advBox = ui.doc.getElementById('settingsAdvanced');
    assert.ok(advToggle && advBox);
  });

  test('开关在模型配置页里', () => {
    assert.ok(modelPanel && modelPanel.contains(advToggle));
  });

  test('高级设置默认折叠', () => {
    assert.ok(advBox && advBox.hidden);
    assert.equal(advToggle.getAttribute('aria-expanded'), 'false');
  });

  test('折叠时箭头朝右', () => {
    assert.equal(advToggle.querySelector('.caret').textContent, '▸');
  });

  test('高级设置收起的是模型分档及其后三块', () => {
    const advancedHeads = [...advBox.querySelectorAll('.pane-head span')].map((s) => s.textContent);
    assert.equal(advancedHeads.join(','), '模型分档,任务档位,请求与调度', advancedHeads.join(','));
  });

  test('模型分档块在高级设置容器里', () => {
    assert.ok(advBox.querySelector('.tier-grid'));
  });

  test('点击后展开', () => {
    advToggle.click();
    assert.ok(!advBox.hidden);
    assert.equal(advToggle.getAttribute('aria-expanded'), 'true');
  });

  test('展开后箭头朝下', () => {
    assert.equal(advToggle.querySelector('.caret').textContent, '▾');
  });

  test('再点收起', () => {
    advToggle.click();
    assert.ok(advBox.hidden);
    assert.equal(advToggle.getAttribute('aria-expanded'), 'false');
  });

  // 折叠不影响保存：值仍在 DOM 里、照常进负载。
  test('折叠时保存照常带档位', () => {
    ui.post({
      type: 'settings',
      ack: 'saved',
      settings: settings({ tierModels: { fast: ['p/cheap'], balanced: [], quality: ['p/smart'] } }),
      keys: {},
    });
    sent = save();
    assert.equal(sent.settings.tierModels.fast.join(','), 'p/cheap', JSON.stringify(sent.settings.tierModels));
  });
});
