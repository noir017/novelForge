/**
 * agent 一轮里**说的话与做的事按发生顺序交替**，`generate` 的产出自成一张卡。
 *
 * 改之前是两块死板的东西：所有工具挤成一串画在正文上方，模型每一回合说的话全
 * 灌进同一个 `.msg-body`，而 `generate` 内部那次调用流出来的几千字也顺着同一条
 * `delta` 拌进去——刷新之后那一半还整份消失（它没进会话）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 说 → 查 → 说 | 三段各自成块，顺序就是发生的顺序 |
 * | 连着几次调用 | 并进同一串（流水账不该散成五块） |
 * | `toolDelta` | 进 generate 那张卡，**不进**模型说的话里 |
 * | `toolResult` | 换掉卡的头与结论，卡里那份正文不能丢 |
 * | 回放 | `turn.segments` 原样画回来，产出的正文也在 |
 * | 就地编辑 | 有段的那一轮只读；一块正文的那一轮照旧可改 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, textSeg, toolSeg, emptySession } = require('../../helpers/dom');

/** 段区里那一串东西，按气泡里的先后顺序。 */
const shape = (ui, id) =>
  [...ui.bubble(id).children]
    .map((node) => {
      if (node.classList.contains('tools')) {
        return `工具×${node.querySelectorAll('.tool-row').length}`;
      }
      if (node.classList.contains('gen')) {
        return `卡:${node.dataset.call}`;
      }
      return node.dataset.seg === 'text' ? `文字:${node.textContent}` : null;
    })
    .filter(Boolean);

const card = (ui, id, call) => ui.bubble(id).querySelector(`.gen[data-call="${call}"]`);

function running() {
  const ui = mount();
  ui.post({ type: 'session', session: emptySession() });
  ui.post({ type: 'turnDone', turn: turn('u1', 'user', '帮我完善大纲') });
  ui.post({ type: 'busy', value: true });
  ui.post({ type: 'turnDone', turn: turn('a1', 'assistant', '') });
  return ui;
}

const call = (id, name, title) => ({ type: 'toolCall', turnId: 'a1', callId: id, name, title });
const done = (id, name, summary, elapsedMs = 10) => ({
  type: 'toolResult',
  turnId: 'a1',
  callId: id,
  name,
  ok: true,
  summary,
  elapsedMs,
});

describe('交替（实时）', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    // 它真实的一轮：先连着读几份，说一句，生成，再说一句。
    ui.post(call('c1', 'list', 'list .novelforge'));
    ui.post(done('c1', 'list', '2 项'));
    ui.post(call('c2', 'read', 'read outline.md'));
    ui.post(done('c2', 'read', '19 行'));
    ui.post({ type: 'delta', turnId: 'a1', text: '我先看看工程现在的结构。' });
    ui.post(call('c3', 'generate', 'generate 大纲·生成'));
    ui.post({ type: 'toolDelta', turnId: 'a1', callId: 'c3', text: '### 全书结构一览\n' });
    ui.post({ type: 'toolDelta', turnId: 'a1', callId: 'c3', text: '**第一卷 活着**：半世界陷入病灾。' });
    ui.post(done('c3', 'generate', '全书大纲 · 6104 字', 23600));
    ui.post({ type: 'delta', turnId: 'a1', text: '大纲已经生成。' });
  });

  test('顺序就是发生的顺序', () => {
    assert.deepEqual(shape(ui, 'a1'), [
      '工具×2',
      '文字:我先看看工程现在的结构。',
      '卡:c3',
      '文字:大纲已经生成。',
    ]);
  });

  // 连着五次 list/read 仍然是一串流水账，散成五块反而比从前更乱。
  test('相邻的调用并进同一串', () => {
    assert.equal(ui.bubble('a1').querySelectorAll('.tools').length, 1);
  });

  // ★ 这一条就是这次改动本身：产物不许再混进模型说的话里。
  test('产出的正文只在卡里，不在任何一块正文里', () => {
    const texts = [...ui.bubble('a1').querySelectorAll('.msg-body')].map((b) => b.textContent);
    assert.deepEqual(texts, ['我先看看工程现在的结构。', '大纲已经生成。']);
    assert.ok(card(ui, 'a1', 'c3').querySelector('.gen-body').textContent.includes('全书结构一览'));
  });

  test('卡默认展开，正文限在卡里滚（不把对话顶开）', () => {
    assert.equal(card(ui, 'a1', 'c3').open, true);
  });

  // toolResult 里根本没有那份正文——它是顺着 toolDelta 一段段攒在卡里的。
  test('结果到了：头与结论换掉，卡里那份正文还在', () => {
    const c = card(ui, 'a1', 'c3');
    assert.equal(c.querySelector('.gen-elapsed').textContent, '23.6s');
    assert.equal(c.querySelector('.gen-state-text').textContent, '全书大纲 · 6104 字');
    assert.ok(c.querySelector('.gen-body').textContent.includes('半世界陷入病灾'));
  });

  // 落盘答完之后后端会把结论拼在 summary 后面重推一次，那时同样不能抹掉正文。
  test('落盘的结论补上来，正文照旧不丢', () => {
    ui.post(done('c3', 'generate', '全书大纲 · 6104 字 · 已写入 .novelforge/outline.md', 23600));
    const c = card(ui, 'a1', 'c3');
    assert.ok(c.querySelector('.gen-state-text').textContent.includes('已写入'));
    assert.ok(c.querySelector('.gen-body').textContent.includes('全书结构一览'));
  });

  test('生成中那张卡说「生成中…」，不摆一句空话', () => {
    const fresh = running();
    fresh.post(call('c9', 'generate', 'generate 正文·生成'));
    assert.equal(card(fresh, 'a1', 'c9').querySelector('.gen-state-text').textContent, '生成中…');
    assert.equal(card(fresh, 'a1', 'c9').querySelector('.gen-elapsed').textContent, '');
  });

  // 一轮刚开始时留的那块空正文（给「它在想」留的位）不能挡在工具条前面。
  test('第一段是工具调用时，那块空正文占位撤掉了', () => {
    const fresh = running();
    assert.ok(fresh.bodyOf('a1'), '一轮刚开始该有个占位');
    fresh.post(call('c1', 'read', 'read x'));
    assert.equal(fresh.bubble('a1').querySelector('.msg-body'), null);
    assert.deepEqual(shape(fresh, 'a1'), ['工具×1']);
  });

  // 卡上那两行说的是「产出了什么」；「按哪个落点、哪句要求生成的」只在参数里，
  // 而花钱那一下最该查得出这件事。
  test('参数收在再一层折叠里', () => {
    const fresh = running();
    fresh.post({
      type: 'toolCall',
      turnId: 'a1',
      callId: 'c9',
      name: 'generate',
      title: 'generate 正文·生成',
      argsText: '{ "target": ".novelforge/plots/012.md" }',
    });
    const det = card(fresh, 'a1', 'c9').querySelector('details.gen-args');
    assert.ok(det, card(fresh, 'a1', 'c9').innerHTML);
    assert.equal(det.open, false);
    assert.ok(det.querySelector('.tool-detail-text').textContent.includes('012.md'));
  });

  test('认不出的 callId 的 toolDelta 不炸', () => {
    assert.doesNotThrow(() =>
      ui.post({ type: 'toolDelta', turnId: 'a1', callId: '并不存在', text: 'x' })
    );
  });
});

describe('交替（重开面板时回放）', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        turns: [
          turn('u1', 'user', '帮我完善大纲'),
          turn('a1', 'assistant', '我先看看。\n\n大纲已经生成。', {
            segments: [
              toolSeg({ callId: 'c1', name: 'list', title: 'list', ok: true, summary: '2 项', elapsedMs: 2 }),
              toolSeg({ callId: 'c2', name: 'read', title: 'read', ok: true, summary: '19 行', elapsedMs: 2 }),
              textSeg('我先看看。'),
              toolSeg({
                callId: 'c3',
                name: 'generate',
                title: 'generate 大纲·生成',
                ok: true,
                summary: '全书大纲 · 6104 字 · 已写入 .novelforge/outline.md',
                elapsedMs: 23600,
                output: '### 全书结构一览\n**第一卷 活着**',
              }),
              textSeg('大纲已经生成。'),
            ],
            agentRun: { steps: 4, calls: 1, tokens: 12000, stopReason: 'done' },
          }),
        ],
      }),
    });
  });

  test('画回来的还是那个顺序', () => {
    assert.deepEqual(shape(ui, 'a1'), ['工具×2', '文字:我先看看。', '卡:c3', '文字:大纲已经生成。']);
  });

  // 从前它整份消失（那几千字没进会话）：刷新一下，作者刚生成的东西就没了。
  test('产出的正文留住了', () => {
    assert.ok(card(ui, 'a1', 'c3').querySelector('.gen-body').textContent.includes('第一卷 活着'));
  });

  test('花销那一行排在段区之后', () => {
    const kids = [...ui.bubble('a1').children].map((c) => c.className);
    assert.ok(kids.indexOf('agent-run') > kids.lastIndexOf('msg-body'), JSON.stringify(kids));
  });

  // editTurn 换的是**整轮内容**，而这一轮的正文分成好几块，改哪一块都映射不回去。
  test('有段的那一轮不可就地编辑', () => {
    for (const block of ui.bubble('a1').querySelectorAll('.msg-body')) {
      assert.equal(block.getAttribute('contenteditable'), null, block.textContent);
    }
  });

  test('一块正文的那一轮照旧可改（单步创作那条路没动）', () => {
    ui.post({ type: 'turnDone', turn: turn('a2', 'assistant', '普通回答') });
    assert.equal(ui.bubble('a2').querySelector('.msg-body').getAttribute('contenteditable'), 'true');
  });
});
