/**
 * 「生成」页：手动调 `generate` 的那一整套表单、输出与采纳栏。
 *
 * 这一页与对话页毫无共用状态，所以用例也不碰气泡——推 `genTargets` /
 * `genDelta` / `genDone` 那几条，看它画成什么样、点下去发出什么。
 */
const { describe, test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP } = require('../../helpers/dom');

const STATE = {
  initialized: true,
  plots: [],
  nextNo: 1,
  staleCount: 0,
  model: 'glm/glm-4-plus',
  modelLabel: 'glm-4-plus',
  models: [
    { ref: 'glm/glm-4-plus', label: 'glm-4-plus', group: 'glm' },
    { ref: 'ds/deepseek-v4', label: 'deepseek-v4', group: 'ds' },
  ],
  contextWindow: 128000,
  maxOutputTokens: 8192,
};

const skill = (stem, audience, source = 'project') => ({
  name: `${source}:${stem}`,
  source,
  stem,
  description: `${stem} 的一句说明`,
  mode: 'user',
  audience,
});

const PLOT_TARGETS = {
  type: 'genTargets',
  job: 'plot',
  stage: 'plot',
  items: [
    { relPath: '.novelforge/plots/01-开端/03-下山.md', label: '剧情 3《下山》', hasContent: false },
    { relPath: '.novelforge/plots/01-开端/04-楼道.md', label: '剧情 4《楼道》', hasContent: true },
  ],
  model: {
    ref: 'glm/glm-4-air',
    label: 'glm/glm-4-air',
    contextWindow: 32000,
    maxOutputTokens: 4096,
    tierNote: '剧情层走快速档',
  },
};

describe('生成页', { skip: JSDOM_SKIP }, () => {
  let ui;
  const id = (name) => ui.doc.getElementById(name);
  const setSelect = (name, value) => {
    id(name).value = value;
    id(name).dispatchEvent(new ui.window.Event('change'));
  };

  before(() => {
    ui = mount();
    ui.post({ type: 'init', state: STATE });
  });

  test('页签栏里有「生成」', () => {
    const tabs = [...ui.doc.querySelectorAll('#tabbar .tab')].map((t) => t.textContent);
    assert.ok(tabs.includes('生成'), tabs.join('/'));
  });

  test('切过去时那一页是激活的', () => {
    ui.post({ type: 'tab', tab: 'generate' });
    assert.ok(id('pane-generate').classList.contains('active'));
  });

  test('切过去时要一遍落点候选', () => {
    assert.ok(ui.last('genTargets'), '没发 genTargets');
  });

  // ---------------------------------------------------------------- ① job

  test('六个 job 都在下拉框里', () => {
    const opts = [...id('genJob').options].map((o) => o.value);
    assert.deepEqual(opts, ['outline', 'volumeList', 'volume', 'plotSegment', 'plot', 'manuscript']);
  });

  test('job 的说法与提示语来自后端那份常量', () => {
    assert.equal(id('genJob').options[4].textContent, '剧情细纲');
    setSelect('genJob', 'plot');
    assert.ok(id('genJobHint').textContent.includes('因果'), id('genJobHint').textContent);
  });

  test('换 job 会重新要落点候选', () => {
    setSelect('genJob', 'volume');
    assert.equal(ui.last('genTargets').job, 'volume');
  });

  // ---------------------------------------------------------------- ④ 字数

  test('目标字数只在正文那一档渲染', () => {
    setSelect('genJob', 'plot');
    assert.ok(id('genWordsStep').classList.contains('hidden'), '剧情层不该有目标字数');
    setSelect('genJob', 'manuscript');
    assert.ok(!id('genWordsStep').classList.contains('hidden'), '正文层该有目标字数');
  });

  // ---------------------------------------------------------------- ② 落点

  describe('落点', () => {
    beforeEach(() => {
      setSelect('genJob', 'plot');
      ui.post(PLOT_TARGETS);
    });

    test('候选按后端给的说法画', () => {
      const opts = [...id('genTarget').options].map((o) => o.textContent);
      assert.deepEqual(opts, ['剧情 3《下山》', '剧情 4《楼道》']);
    });

    test('选项的值是工程内相对路径', () => {
      assert.equal(id('genTarget').options[0].value, '.novelforge/plots/01-开端/03-下山.md');
    });

    test('说清要哪一层的落点', () => {
      assert.ok(id('genStageBadge').textContent.includes('剧情层'), id('genStageBadge').textContent);
    });

    test('空落点报「新写」', () => {
      setSelect('genTarget', '.novelforge/plots/01-开端/03-下山.md');
      assert.ok(id('genCheck').classList.contains('ok'), id('genCheck').className);
      assert.ok(id('genCheck').textContent.includes('新写'), id('genCheck').textContent);
    });

    test('已有内容的落点报「会先比对」', () => {
      setSelect('genTarget', '.novelforge/plots/01-开端/04-楼道.md');
      assert.ok(id('genCheck').classList.contains('warn'), id('genCheck').className);
      assert.ok(id('genCheck').textContent.includes('比对'), id('genCheck').textContent);
    });

    // 作者连着拨两下下拉框时，先发那一条的回话会后到。按它画会让界面短暂地
    // 按上一层显示，而落点校验也跟着按错的层判。
    test('迟到的回话（上一个 job 的）被丢掉', () => {
      setSelect('genJob', 'volume');
      ui.post({
        type: 'genTargets',
        job: 'volume',
        stage: 'volume',
        items: [{ relPath: '.novelforge/volumes/01-开端.md', label: '第 1 卷《开端》', hasContent: false }],
        model: PLOT_TARGETS.model,
      });
      ui.post(PLOT_TARGETS); // 迟到的剧情层回话
      assert.ok(id('genStageBadge').textContent.includes('卷纲层'), id('genStageBadge').textContent);
      assert.equal(id('genTarget').options[0].textContent, '第 1 卷《开端》');
    });

    test('手填路径展开后禁掉下拉框', () => {
      ui.clickEl(id('genManualBtn'));
      assert.ok(!id('genManualPath').classList.contains('hidden'));
      assert.ok(id('genTarget').disabled);
      ui.clickEl(id('genManualBtn')); // 收回去
    });
  });

  // ---------------------------------------------------------------- ⑥ 模型

  describe('模型', () => {
    before(() => {
      setSelect('genJob', 'plot');
      ui.post(PLOT_TARGETS);
    });

    test('下拉框里有「按层自动」与全部可用模型', () => {
      const opts = [...id('genModel').options].map((o) => o.textContent);
      assert.deepEqual(opts, ['按层自动', 'glm-4-plus', 'deepseek-v4']);
    });

    test('回显实际会用哪个模型与它的窗口', () => {
      const text = id('genResolved').textContent;
      assert.ok(text.includes('剧情层走快速档'), text);
      assert.ok(text.includes('glm/glm-4-air'), text);
      assert.ok(text.includes('32.0k'), text);
    });

    // 那一行回显的是**这个模型**的窗口，前端算不出来，只能回后端要。
    test('换模型会重新要一遍回显', () => {
      setSelect('genModel', 'ds/deepseek-v4');
      assert.equal(ui.last('genTargets').model, 'ds/deepseek-v4');
      setSelect('genModel', '');
      assert.equal(ui.last('genTargets').model, undefined, '按层自动时不带 model');
    });

    test('解析不出模型时禁掉「生成」', () => {
      ui.post({
        ...PLOT_TARGETS,
        model: { ref: '', label: '', contextWindow: 0, maxOutputTokens: 0, issue: '还没有可用的模型。' },
      });
      assert.ok(id('genResolved').classList.contains('err'));
      assert.ok(id('genRunBtn').disabled, '模型不可用时不该让人点生成');
      ui.post(PLOT_TARGETS);
      assert.ok(!id('genRunBtn').disabled);
    });
  });

  // ---------------------------------------------------------------- ⑤ skills

  describe('skills', () => {
    test('只列能交给创作模型的那些', () => {
      ui.post({
        type: 'skillList',
        items: [skill('情绪弧线', 'generate'), skill('正文体检', 'agent'), skill('章节钩子', 'generate')],
      });
      const names = [...ui.doc.querySelectorAll('#genSkills .gen-skill-name')].map((n) => n.textContent);
      assert.ok(names.some((n) => n.includes('情绪弧线')), names.join('/'));
      assert.ok(names.some((n) => n.includes('章节钩子')), names.join('/'));
      assert.ok(!names.some((n) => n.includes('正文体检')), 'agent 类不该出现在这里');
    });

    test('行里显示不带前缀的那一半，全名挂在 tooltip 上', () => {
      const row = ui.doc.querySelector('#genSkills .gen-skill');
      assert.equal(row.title, 'project:情绪弧线');
      assert.ok(row.querySelector('.gen-skill-name').textContent.startsWith('情绪弧线'));
    });

    test('带来源角标', () => {
      assert.equal(ui.doc.querySelector('#genSkills .gen-skill-src').textContent, '工程');
    });

    test('勾选计数', () => {
      const box = ui.doc.querySelector('#genSkills input[type=checkbox]');
      box.checked = true;
      box.dispatchEvent(new ui.window.Event('change'));
      assert.equal(ui.doc.getElementById('genSkillCount').textContent, '已选 1 份');
    });

    test('名单里没了的那一份，勾选也跟着掉', () => {
      ui.post({ type: 'skillList', items: [skill('章节钩子', 'generate')] });
      assert.equal(ui.doc.getElementById('genSkillCount').textContent, '未选');
    });

    test('空名单给出指路而不是一个空框', () => {
      ui.post({ type: 'skillList', items: [skill('正文体检', 'agent')] });
      const box = ui.doc.querySelector('#genSkills .gen-skills-empty');
      assert.ok(box, '空名单该有一块指路');
      assert.ok(box.textContent.includes('audience: generate'), box.textContent);
    });
  });

  // ---------------------------------------------------------------- ⑦⑧ 跑

  describe('跑一次', () => {
    before(() => {
      setSelect('genJob', 'plot');
      ui.post(PLOT_TARGETS);
      ui.post({ type: 'skillList', items: [skill('情绪弧线', 'generate')] });
      const box = ui.doc.querySelector('#genSkills input[type=checkbox]');
      box.checked = true;
      box.dispatchEvent(new ui.window.Event('change'));
      setSelect('genTarget', '.novelforge/plots/01-开端/03-下山.md');
      id('genAsk').value = '把师门的态度推到明确反对';
      setSelect('genModel', 'ds/deepseek-v4');
      setSelect('genThinking', 'high');
      ui.clickEl(id('genRunBtn'));
    });

    test('发出去的参数与工具的一一对应', () => {
      const msg = ui.last('genRun');
      assert.equal(msg.job, 'plot');
      assert.equal(msg.target, '.novelforge/plots/01-开端/03-下山.md');
      assert.equal(msg.ask, '把师门的态度推到明确反对');
      assert.deepEqual([...msg.skills], ['project:情绪弧线']);
      assert.equal(msg.model, 'ds/deepseek-v4');
      assert.equal(msg.thinking, 'high');
    });

    test('剧情层不带目标字数', () => {
      assert.equal(ui.last('genRun').targetWords, undefined);
    });

    test('跑起来之后换成「停止」', () => {
      ui.post({ type: 'genPhase', phase: 'writing' });
      assert.ok(id('genRunBtn').classList.contains('hidden'));
      assert.ok(!id('genStopBtn').classList.contains('hidden'));
    });

    test('正文增量追加进输出框', () => {
      ui.post({ type: 'genDelta', text: '## 一、消息走漏\n' });
      ui.post({ type: 'genDelta', text: '清早的雾还没散。' });
      assert.ok(id('genText').value.includes('消息走漏'));
      assert.ok(id('genText').value.includes('清早的雾'));
    });

    test('思考增量长出一块折叠', () => {
      ui.post({ type: 'genReasoning', text: '先看卷纲说这里要推到哪一步。' });
      assert.ok(!id('genReasonFold').classList.contains('hidden'));
      assert.ok(id('genReasonBody').textContent.includes('卷纲'));
    });

    test('停止按钮发 genStop', () => {
      ui.clickEl(id('genStopBtn'));
      assert.ok(ui.last('genStop'));
    });
  });

  // ---------------------------------------------------------------- ⑨ 采纳

  describe('采纳栏', () => {
    const done = (over, withArtifact = true) => ({
      type: 'genDone',
      draft: {
        draftId: 'd1',
        words: 1240,
        artifact: withArtifact
          ? { where: '剧情 3《下山》', summary: '剧情 · 4/4 节', overwrites: over }
          : undefined,
        relPath: '.novelforge/plots/01-开端/03-下山.md',
        reasoningChars: 0,
        layers: [
          { label: '本卷卷纲', tokens: 1880, status: '完整' },
          { label: '更早 6 章', tokens: 3200, status: '已降级', note: '预算不足' },
        ],
        usedTokens: 34210,
        budget: 120000,
      },
    });

    test('写入时说清落在哪', () => {
      ui.post({ type: 'genPhase', phase: 'done' });
      ui.post(done(false));
      assert.ok(!id('genAdopt').classList.contains('hidden'));
      assert.equal(id('genAdoptBtn').textContent, '采纳并写入');
      assert.ok(id('genAdoptWhere').textContent.includes('03-下山.md'), id('genAdoptWhere').textContent);
    });

    test('形状与字数写在输出区底部', () => {
      assert.ok(id('genShape').textContent.includes('剧情 · 4/4 节'), id('genShape').textContent);
      assert.ok(id('genShape').textContent.includes('1240 字'), id('genShape').textContent);
    });

    test('装配明细列出每一层与降级原因', () => {
      const rows = [...ui.doc.querySelectorAll('#genLayers .gen-layer')].map((r) => r.textContent);
      assert.equal(rows.length, 2);
      assert.ok(rows[1].includes('已降级'), rows[1]);
      assert.ok(rows[1].includes('预算不足'), rows[1]);
    });

    test('会覆盖时整条变黄、按钮改口', () => {
      ui.post(done(true));
      assert.ok(id('genAdopt').classList.contains('overwrite'));
      assert.equal(id('genAdoptBtn').textContent, '覆盖并写入');
      assert.ok(id('genAdoptWhere').textContent.includes('覆盖'), id('genAdoptWhere').textContent);
    });

    test('解析不出形状时不给采纳按钮', () => {
      ui.post(done(false, false));
      assert.ok(id('genAdoptBtn').classList.contains('hidden'), '解析不出还给采纳按钮就会写一个空产物');
      assert.ok(id('genAdoptWhere').textContent.includes('解析不出'), id('genAdoptWhere').textContent);
    });

    test('采纳时带的是输出框里当下的文本（作者可能改过）', () => {
      ui.post(done(false));
      id('genText').value = '作者改过的正文';
      ui.clickEl(id('genAdoptBtn'));
      const msg = ui.last('genAdopt');
      assert.equal(msg.draftId, 'd1');
      assert.equal(msg.text, '作者改过的正文');
    });

    test('写成了就把采纳栏收掉', () => {
      ui.post({ type: 'genAdopted', relPath: '.novelforge/plots/01-开端/03-下山.md', message: '已写入。' });
      assert.ok(id('genAdopt').classList.contains('hidden'));
    });

    test('不采纳发 genDiscard', () => {
      ui.post(done(false));
      ui.clickEl(id('genDiscardBtn'));
      assert.equal(ui.last('genDiscard').draftId, 'd1');
    });

    test('没有产出时不出现采纳栏', () => {
      ui.post({ type: 'genDone' });
      assert.ok(id('genAdopt').classList.contains('hidden'));
    });
  });
});
