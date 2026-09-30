/**
 * 四期验收：从排好前 5 章细纲的工程起，工程页「批量写章」第 1–3 章、写完即定稿。
 *
 *   写第 1 章 → 定稿（摘要 + 角色状态）→ 写第 2 章 → 定稿 → 写第 3 章 → 定稿
 *
 * 经 controller 发出去（与工程页弹窗提交的那一条消息一样），假模型按脚本应答。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 三章正文与三份摘要都在，摘要里的连续性事实每条带证据 | D18：证据确定性地找 |
 * | 第 2 章定稿后，角色卡的当前状态换成第 2 章给出的那一版 | D15：机器的那一节由定稿维护 |
 * | **第 3 章写正文那一次的装配里**：角色卡是第 2 章更新过的状态，定稿原文片段里有第 2 章证据所在的那一段 | 这一期存在的理由：后一章读得到前一章定稿留下的东西 |
 * | 作者在第 1 章之后手改过沈氏的当前状态：后两章定稿都没覆盖，卡上挂黄 ❗ | 第 3 条：不静默覆盖 |
 * | 实际调用次数 ≤ 确认框报的上限，完成提示带「打开第 3 章」 | 第 4 条；D24 |
 *
 * 近章全文设成 0：否则第 2 章整章进了上下文，它的片段按去重规则就不单独带了——那条规则
 * 在 context/evidence.test.js 里另有用例。这里要看的是片段本身。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, filler } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;
let controller;
const finished = [];

const TITLES = ['停舟', '令牌', '夜访', '井', '名册'];
const pad3 = (n) => String(n).padStart(3, '0');
const CH = (no) => `chapters/${pad3(no)}-${TITLES[no - 1]}.md`;
const PLOT = (no) => `.novelforge/plots/${pad3(no)}-${TITLES[no - 1]}.md`;
const LIN = '.novelforge/characters/林昭.md';
const SHEN = '.novelforge/characters/沈氏.md';
const AUTHOR_STATE = '作者写的：沈氏其实早就认出了林昭，只是不说。';

/** 第 N 章的正文：一段带证据的原句夹在两段填充之间。 */
function chapterText(no) {
  return [
    filler(260, no * 10 + 1),
    `林昭在第${no}章受了第${no}处伤，血顺着左臂往下淌。`,
    `沈氏在第${no}章把第${no}盏灯吹灭了。`,
    filler(260, no * 10 + 2),
  ].join('\n\n');
}

/** 第 3 章那一次写正文调用发出去的 user 消息，与那一刻角色卡的样子。 */
let ch3Prompt = '';
let linWhenCh3 = '';

function reply(messages) {
  const system = messages[0]?.content ?? '';
  const user = messages[messages.length - 1].content;
  if (system.includes('建立可检索的章节档案')) {
    const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
    return JSON.stringify({
      梗概: `第 ${no} 章：林昭又受了伤。`,
      出场人物: [{ name: '林昭', aliases: [] }, { name: '沈氏', aliases: [] }],
      时间地点: '青崖镇。',
      关键事件: [`第 ${no} 章的事`],
      新增伏笔: [],
      状态变更: '',
      连续性事实: [`林昭在第${no}章左臂受伤流血`, `沈氏在第${no}章吹灭了第${no}盏灯`],
    });
  }
  if (system.includes('依据本章正文更新角色的「当前状态」')) {
    const no = Number(/【第(\d+)章/.exec(user)?.[1] ?? 0);
    return JSON.stringify({
      updates: [
        { name: '林昭', 当前状态: `第 ${no} 章之后：左臂有 ${no} 处伤，还在青崖镇。` },
        { name: '沈氏', 当前状态: `第 ${no} 章之后：守着客栈。` },
      ],
    });
  }
  const hook = /- 章节钩子：第 (\d+) 章结尾/.exec(user);
  if (hook) {
    const no = Number(hook[1]);
    if (no === 2) {
      // 第 1 章已经定稿：作者这时候手改了沈氏的当前状态。
      const card = t.read(SHEN);
      t.write(SHEN, card.replace(/## 当前状态\n\n[^\n]*/, `## 当前状态\n\n${AUTHOR_STATE}`));
    }
    if (no === 3) {
      ch3Prompt = user;
      linWhenCh3 = t.read(LIN);
    }
    return { text: chapterText(no), stop: 'end' };
  }
  return '（认不出这一步）';
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    registry: './src/core/llm/registry.ts',
    provider: './src/core/llm/provider.ts',
    controller: './src/core/controller/index.ts',
    pipelineModel: './src/core/model/pipeline.ts',
    progress: './src/core/runtime/progress.ts',
    errorLog: './src/core/runtime/errorLog.ts',
    stateModel: './src/core/model/characterState.ts',
    projectView: './src/core/views/projectView.ts',
    db: './src/core/runtime/db.ts',
  });
  const settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
    recentChaptersFullText: 0,
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    reply,
    errors: { LlmError: bundle.provider.LlmError, CancelledError: bundle.provider.CancelledError },
  });
  bundle.progress.onTaskFinished((x) => finished.push(x));

  t = await makeTempProject(bundle.project, { prefix: 'phase4', title: '青崖记' });
  project = t.project;
  t.write('.novelforge/config.md', '---\ntotalChapters: 30\nwordsPerChapter: 600\n---\n\n# 小说配置\n\n## 核心梗概\n\n回镇查案。\n');
  // 架构四件与大纲都在（二期那一段的产物），主按钮才会落到单章上。
  t.write('.novelforge/premise.md', '# 故事前提\n\n## 一句话前提\n\n林昭回镇，必须找出放火的人。\n\n## 核心冲突链\n\n回镇 → 受伤 → 追查。\n');
  t.write('.novelforge/world.md', '# 世界观\n\n## 规则与漏洞\n\n名册决定谁算镇上的人。\n');
  t.write('.novelforge/outline.md', '# 情节大纲\n\n## 第1–20章：第一幕\n\n林昭进镇，一路受伤一路查。\n');
  const ws = new bundle.ws.Workspace(project);
  for (let no = 1; no <= 5; no++) {
    await ws.writePlot({
      no,
      title: TITLES[no - 1],
      role: '铺垫',
      characters: ['林昭', '沈氏'],
      targetWords: 600,
      upstreamHash: '',
      done: false,
      sections: { 本章目的: `第 ${no} 章的目的`, 关键事件: `第 ${no} 章林昭又往前查了一步。`, 章末钩子: `第 ${no} 章结尾：又一个人不见了。` },
    });
  }
  // 两张卡都是角色图谱建的：开篇状态、归机器（与 acceptRoster 盖的章一样）。
  for (const [rel, name, state] of [[LIN, '林昭', '刚回到青崖镇。'], [SHEN, '沈氏', '客栈老板娘。']]) {
    await ws.writeCharacter(
      bundle.stateModel.stampState(
        {
          slug: name,
          name,
          aliases: [],
          tags: name === '林昭' ? ['主角'] : [],
          sections: { ...bundle.project.emptyCharacterSections(), 身份: `${name}的身份`, 当前状态: state },
        },
        0
      )
    );
    assert.ok(t.has(rel));
  }
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  controller.attach({ kind: 'sidebar', post: () => {}, reveal() {} });
  // 与工程页弹窗提交的那一条一样：弹窗已经报过调用次数，带 confirmed。
  await controller.handle({
    type: 'projectAction',
    action: 'writeManuscripts',
    range: { from: 1, to: 3 },
    mode: 'finalize',
    confirmed: true,
  });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

describe('四期验收：批量写章第 1–3 章、写完即定稿', () => {
  test('三章正文与三份摘要都在', () => {
    for (const no of [1, 2, 3]) {
      assert.ok(t.has(CH(no)), CH(no));
      assert.ok(t.has(`.novelforge/summaries/${pad3(no)}-${TITLES[no - 1]}.md`), `第 ${no} 章摘要`);
    }
    assert.ok(!t.has(CH(4)));
  });

  test('摘要里的连续性事实每条都带一句正文原句', async () => {
    for (const no of [1, 2, 3]) {
      const chapter = await project.getChapter(no);
      const s = await project.readSummary(chapter.relPath);
      const facts = s.sections.连续性事实.split('\n').filter(Boolean);
      assert.equal(facts.length, 2, s.sections.连续性事实);
      for (const f of facts) {
        const quote = /〔证据：「(.+)」〕$/.exec(f)?.[1];
        assert.ok(quote && t.read(CH(no)).includes(quote), f);
      }
    }
  });

  test('第 2 章定稿后，林昭的当前状态换成了第 2 章那一版', () => {
    assert.match(linWhenCh3, /## 当前状态\n\n第 2 章之后：左臂有 2 处伤，还在青崖镇。/);
    assert.match(linWhenCh3, /stateThrough: 2/);
  });

  test('第 3 章写正文时：角色卡是第 2 章更新过的状态', () => {
    assert.ok(ch3Prompt.includes('第 2 章之后：左臂有 2 处伤，还在青崖镇。'), ch3Prompt.slice(0, 2000));
  });

  test('第 3 章写正文时：定稿原文片段里有第 2 章证据所在的那一段', () => {
    const at = ch3Prompt.indexOf('# 定稿原文片段');
    assert.ok(at > 0, '没有定稿原文片段那一节');
    const section = ch3Prompt.slice(at, ch3Prompt.indexOf('\n---\n', at));
    assert.ok(section.includes('林昭在第2章受了第2处伤，血顺着左臂往下淌。'), section.slice(0, 800));
    assert.ok(section.includes('林昭在第1章受了第1处伤'), section.slice(0, 800));
  });

  test('作者手改过的沈氏：后两章定稿都没覆盖，卡上挂黄 ❗', async () => {
    assert.ok(t.read(SHEN).includes(AUTHOR_STATE), t.read(SHEN));
    const [f] = (await bundle.errorLog.listActiveFailures(project))[SHEN] ?? [];
    assert.equal(f?.severity, 'warn');
    assert.equal(f.op, 'cardState');
    assert.match(f.message, /第 3 章定稿给出了新的「当前状态」/);
  });

  test('林昭最后是第 3 章的状态；工程页的角色行写着「状态截至第 3 章」', async () => {
    assert.match(t.read(LIN), /第 3 章之后：左臂有 3 处伤/);
    project.invalidate();
    const tree = await bundle.projectView.buildProjectTree(project);
    const lin = tree.characters.find((n) => n.relPath === LIN);
    assert.match(lin.detail, /状态截至第 3 章/);
  });

  test('一共 9 次：一章写一次、摘要一次、角色状态一次；没超过确认框的上限', () => {
    assert.equal(fake.callCount(), 9);
    const plan = bundle.pipelineModel.planWriteBatch({ from: 1, to: 3, mode: 'finalize', writtenNos: [], plotFilledNos: [1, 2, 3, 4, 5] });
    assert.ok(fake.callCount() <= plan.calls.max);
  });

  test('完成提示：写好 3 章、定稿 3 章，带「打开第 3 章」', () => {
    const f = finished.find((x) => x.title === '批量写章');
    assert.equal(f.message, '第 1–3 章已写好，定稿 3 章（调用 9 次）。');
    assert.deepEqual(f.open, { plotRelPath: PLOT(3), label: '打开第 3 章' });
  });

  test('主按钮转去第 4 章', async () => {
    const out = [];
    controller.attach({ kind: 'sidebar', post: (m) => out.push(m), reveal() {} });
    await controller.handle({ type: 'requestPipeline' });
    const next = out.filter((m) => m.type === 'pipeline').pop()?.next;
    assert.equal(next?.label, '写第 4 章', JSON.stringify(next));
  });
});

