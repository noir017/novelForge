/**
 * agent 一轮里**想的、说的与做的按发生顺序交替**，`generate` 的产出自成一张卡。
 *
 * 改之前是两块死板的东西：所有工具挤成一串画在正文上方，模型每一回合说的话全
 * 灌进同一个 `.msg-body`，而 `generate` 内部那次调用流出来的几千字也顺着同一条
 * `delta` 拌进去——刷新之后那一半还整份消失（它没进会话）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 说 → 查 → 说 | 三段各自成块，顺序就是发生的顺序 |
 * | 连着几次调用 | 并进同一串（流水账不该散成五块） |
 * | 想 → 查 → 想 | 每个回合的思考各自成块，不攒成一坨 |
 * | 空白 delta | 不开新块（`\n` 在 pre-wrap 里就是一块空高度） |
 * | `toolDelta` | 进 generate 那张卡，**不进**模型说的话里 |
 * | `toolResult` | 换掉卡的头与结论，卡里那份正文不能丢 |
 * | 回放 | `turn.segments` 原样画回来，产出的正文也在 |
 * | 就地编辑 | 有段的那一轮只读；一块正文的那一轮照旧可改 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  mount,
  JSDOM_SKIP,
  turn,
  textSeg,
  reasoningSeg,
  toolSeg,
  emptySession,
} = require('../../helpers/dom');

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
      if (node.classList.contains('reasoning')) {
        return `思考:${node.querySelector('.reasoning-body').textContent}`;
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

/**
 * 思考是段区里的第三种块。**每个回合各想一次**——agent 一轮要调好几次模型，
 * 全灌进气泡顶上那一整块的话，「它读完那三章之后在想什么」就和第一回合的
 * 胡思乱想拌在一起了，而前者才是作者要看的那一段。
 */
describe('思考按发生顺序排进段里（实时）', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = running();
    // 它真实的一轮：先想一下、去查、读完再想一次、然后才说话。
    ui.post({ type: 'reasoning', turnId: 'a1', text: '先看看工程里有什么。' });
    ui.post(call('c1', 'list', 'list .novelforge'));
    ui.post(done('c1', 'list', '2 项'));
    ui.post({ type: 'reasoning', turnId: 'a1', text: '大纲是空的，得从头写。' });
    ui.post({ type: 'delta', turnId: 'a1', text: '我先看看工程现在的结构。' });
  });

  test('两个回合的思考各自成块，顺序就是发生的顺序', () => {
    assert.deepEqual(shape(ui, 'a1'), [
      '思考:先看看工程里有什么。',
      '工具×1',
      '思考:大纲是空的，得从头写。',
      '文字:我先看看工程现在的结构。',
    ]);
  });

  // 从前 appendReasoning 取的是气泡里**第一个** details.reasoning，于是第二个
  // 回合想的东西被追加到第一块上，读起来像是它一口气想完了才动手。
  test('第二段思考不会被塞进第一块', () => {
    const bodies = [...ui.bubble('a1').querySelectorAll('.reasoning-body')].map((b) => b.textContent);
    assert.deepEqual(bodies, ['先看看工程里有什么。', '大纲是空的，得从头写。']);
  });

  test('默认都是折叠的（它是过程，不是结论）', () => {
    for (const det of ui.bubble('a1').querySelectorAll('details.reasoning')) {
      assert.equal(det.open, false);
    }
  });

  test('同一段思考的增量照旧累加', () => {
    ui.post({ type: 'reasoning', turnId: 'a1', text: '' });
    const fresh = running();
    fresh.post({ type: 'reasoning', turnId: 'a1', text: '先确定场景：' });
    fresh.post({ type: 'reasoning', turnId: 'a1', text: '夜里的旧书店。' });
    assert.deepEqual(shape(fresh, 'a1'), ['思考:先确定场景：夜里的旧书店。']);
  });

  // 思考不是正文：采纳写入、字数、复制都不该带上它。
  test('思考不进任何一块正文', () => {
    const texts = [...ui.bubble('a1').querySelectorAll('.msg-body')].map((b) => b.textContent);
    assert.deepEqual(texts, ['我先看看工程现在的结构。']);
  });

  test('思考期间就显示流式光标（正文还没来）', () => {
    const fresh = running();
    fresh.post({ type: 'reasoning', turnId: 'a1', text: '嗯……' });
    assert.ok(fresh.bubble('a1').classList.contains('streaming'));
  });

  // 一轮刚开始那块空正文是给「它在想」留的位；思考真的来了，那个位子就该让出来。
  test('思考接管了那块空正文占位', () => {
    const fresh = running();
    assert.ok(fresh.bodyOf('a1'), '一轮刚开始该有个占位');
    fresh.post({ type: 'reasoning', turnId: 'a1', text: '嗯……' });
    assert.equal(fresh.bubble('a1').querySelector('.msg-body'), null);
  });
});

/**
 * 模型几乎总在调工具前后吐一两个换行。`.msg-body` 是 `pre-wrap` 还带 8px 内边距
 * ——为那个 `\n` 留一块，画出来就是**工具条上方一块一行多高、什么都没有的空盒子**
 * （截图里那一片空白就是它）。
 */
describe('空白增量不留空盒子', { skip: JSDOM_SKIP }, () => {
  test('只有换行的 delta 不开新块', () => {
    const ui = running();
    ui.post({ type: 'delta', turnId: 'a1', text: '\n\n' });
    ui.post(call('c1', 'list', 'list .novelforge'));
    ui.post(done('c1', 'list', '2 项'));
    assert.deepEqual(shape(ui, 'a1'), ['工具×1']);
  });

  // 这一条正是截图里那个现象：占位被一片空白喂过之后，dropEmptyText 的
  // `=== ''` 判据就不成立了，空盒子于是留在工具条上方。
  test('占位被空白喂过之后照样撤掉', () => {
    const ui = running();
    ui.post({ type: 'delta', turnId: 'a1', text: '\n' });
    ui.post(call('c1', 'read', 'read outline.md'));
    assert.equal(ui.bubble('a1').querySelector('.msg-body'), null);
  });

  test('工具条之间不会夹出空块', () => {
    const ui = running();
    ui.post(call('c1', 'list', 'list a'));
    ui.post(done('c1', 'list', '2 项'));
    ui.post({ type: 'delta', turnId: 'a1', text: '\n' });
    ui.post(call('c2', 'read', 'read b'));
    ui.post(done('c2', 'read', '19 行'));
    // 中间那个换行既没开新块，也没有把这一串打断成两串。
    assert.deepEqual(shape(ui, 'a1'), ['工具×2']);
  });

  test('真有话说时块首的空白抹掉，字不被往下推', () => {
    const ui = running();
    ui.post({ type: 'delta', turnId: 'a1', text: '\n\n我先看看。' });
    assert.deepEqual(shape(ui, 'a1'), ['文字:我先看看。']);
  });

  test('段内的换行照旧留着（那是它自己分的行）', () => {
    const ui = running();
    ui.post({ type: 'delta', turnId: 'a1', text: '第一行。' });
    ui.post({ type: 'delta', turnId: 'a1', text: '\n\n第二行。' });
    assert.deepEqual(shape(ui, 'a1'), ['文字:第一行。\n\n第二行。']);
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

describe('思考回放', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({
      type: 'session',
      session: emptySession({
        turns: [
          turn('u1', 'user', '帮我完善大纲'),
          turn('a1', 'assistant', '写好了。', {
            segments: [
              reasoningSeg('先看看工程里有什么。'),
              toolSeg({ callId: 'c1', name: 'list', title: 'list', ok: true, summary: '2 项', elapsedMs: 2 }),
              reasoningSeg('大纲是空的，得从头写。'),
              textSeg('写好了。'),
            ],
            agentRun: { steps: 2, calls: 0, tokens: 900, stopReason: 'done' },
          }),
        ],
      }),
    });
  });

  // 第二天翻回来，「它当时在想什么」和顺序一起留着。
  test('两段思考各自在原来的位置上', () => {
    assert.deepEqual(shape(ui, 'a1'), [
      '思考:先看看工程里有什么。',
      '工具×1',
      '思考:大纲是空的，得从头写。',
      '文字:写好了。',
    ]);
  });

  test('回放出来默认也是折叠的', () => {
    for (const det of ui.bubble('a1').querySelectorAll('details.reasoning')) {
      assert.equal(det.open, false);
    }
  });

  // 老会话（单步创作那条路）的形状：思考在 turn.reasoning 上，一轮只有一份。
  test('没有段的那一轮照旧画顶上那一块', () => {
    ui.post({
      type: 'turnDone',
      turn: turn('a2', 'assistant', '灯昏。', { reasoning: '先确定场景。' }),
    });
    const dets = [...ui.bubble('a2').querySelectorAll('details.reasoning')];
    assert.equal(dets.length, 1);
    assert.equal(dets[0].querySelector('.reasoning-body').textContent, '先确定场景。');
  });

  // 两个来源同时在时只画段里那几块：turn.reasoning 是整轮攒在一起的同一批
  // 内容，再画一遍等于把同一段思考摆两处。
  test('有思考段时不再画顶上那一整块', () => {
    ui.post({
      type: 'turnDone',
      turn: turn('a3', 'assistant', '写好了。', {
        reasoning: '先看看工程里有什么。大纲是空的，得从头写。',
        segments: [reasoningSeg('先看看工程里有什么。'), textSeg('写好了。')],
      }),
    });
    const bodies = [...ui.bubble('a3').querySelectorAll('.reasoning-body')].map((b) => b.textContent);
    assert.deepEqual(bodies, ['先看看工程里有什么。']);
  });
});
