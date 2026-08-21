/**
 * 一轮 assistant 排下来的段：攒段那几个纯函数（`model/session.ts`）与
 * `serializeTurn` 的那一半。
 *
 * 界面**只认 `segments`**：思考块、文字块、工具条、generate 卡按数组顺序画。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 有 segments | 原样带过去，不动它 |
 * | 没调工具 | **没有段**：一块正文就是全部，那一轮照旧可就地编辑 |
 * | 攒文字 | 相邻的接上，隔着别的段就另开一段 |
 * | 纯空白 | **开不了新段**（那是工具条上方那块空盒子的来源） |
 * | 攒思考 | 与文字互不相接（想的不能拼进说的里） |
 * | `textOfSegments` | 只取文字：思考与产物都不算「这一轮说的话」 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { serializeTurn } = loadModule('src/core/controller/serialize.ts');
const {
  pruneSegments,
  pushReasoningSegment,
  pushTextSegment,
  textOfSegments,
} = loadModule('src/core/model/session.ts');

const call = (callId, name, extra) =>
  Object.assign({ callId, name, title: name, ok: true, summary: '摘要', elapsedMs: 1 }, extra);

const assistant = (extra) =>
  serializeTurn(Object.assign({ id: 'a1', role: 'assistant', content: '', at: 'x' }, extra));

/** 一串段的形状，读起来就是气泡里那个顺序。 */
const shape = (segments) =>
  segments.map((seg) =>
    seg.kind === 'tool' ? `工具:${seg.call.callId}` : `${seg.kind === 'text' ? '文字' : '思考'}:${seg.text}`
  );

const toolSeg = (callId) => ({ kind: 'tool', call: call(callId, 'read') });

describe('段：新会话原样带过去', () => {
  const segments = [
    { kind: 'tool', call: call('c1', 'read') },
    { kind: 'text', text: '我先看看。' },
    { kind: 'tool', call: call('c2', 'generate', { output: '### 全书结构' }) },
    { kind: 'text', text: '写好了。' },
  ];

  test('顺序与内容一个字都不动', () => {
    assert.deepEqual(assistant({ content: '我先看看。\n\n写好了。', segments }).segments, segments);
  });

  // 那几千字是产物本身，回放时要画在卡里；从前它根本没进会话，刷新就没了。
  test('generate 产出的正文跟着段走', () => {
    const out = assistant({ segments }).segments[2];
    assert.equal(out.call.output, '### 全书结构');
  });
});

describe('段：没调工具时没有段', () => {
  test('assistant 一块正文', () => {
    assert.equal(assistant({ content: '好的。' }).segments, undefined);
  });

  test('user 那一支也没有', () => {
    const turn = serializeTurn({ id: 'u1', role: 'user', content: '写一段', at: 'x' });
    assert.equal(turn.segments, undefined);
  });
});

describe('攒文字段', () => {
  test('相邻的两片接成一段', () => {
    const segs = [];
    pushTextSegment(segs, '我先');
    pushTextSegment(segs, '看看。');
    assert.deepEqual(shape(segs), ['文字:我先看看。']);
  });

  // 中间插过一次工具调用之后，接着说的话是新的一段——那正是「交替」。
  test('隔着工具段就另开一段', () => {
    const segs = [];
    pushTextSegment(segs, '我先看看。');
    segs.push(toolSeg('c1'));
    pushTextSegment(segs, '看完了。');
    assert.deepEqual(shape(segs), ['文字:我先看看。', '工具:c1', '文字:看完了。']);
  });

  /**
   * ★ 工具条上方那块空盒子的来源。
   *
   * 模型几乎总在调工具前后吐一两个换行，有时一整回合只有一个 `\n` 就转头调
   * 工具。为它开一段，界面上就是一块一行多高、什么都没有的盒子（`.msg-body`
   * 是 `pre-wrap` 还带 8px 内边距），而且刷新之后还随会话回来。
   */
  test('纯空白开不了新段', () => {
    const segs = [];
    pushTextSegment(segs, '\n\n');
    assert.deepEqual(segs, []);
  });

  test('一串空白喂下来也还是空的', () => {
    const segs = [];
    pushTextSegment(segs, '\n');
    pushTextSegment(segs, '  ');
    pushTextSegment(segs, '\n');
    assert.deepEqual(segs, []);
  });

  test('空白之后真有话说：那一段从第一个字开始', () => {
    const segs = [];
    pushTextSegment(segs, '\n\n');
    pushTextSegment(segs, '我先看看。');
    assert.deepEqual(shape(segs), ['文字:我先看看。']);
  });

  test('段首的空白抹掉，字不被往下推', () => {
    const segs = [];
    pushTextSegment(segs, '\n\n我先看看。');
    assert.deepEqual(shape(segs), ['文字:我先看看。']);
  });

  // 段**内**的换行是它自己分的行，一个都不能少——只有开头那几个该走。
  test('段内的换行照旧留着', () => {
    const segs = [];
    pushTextSegment(segs, '第一行。');
    pushTextSegment(segs, '\n\n第二行。');
    assert.deepEqual(shape(segs), ['文字:第一行。\n\n第二行。']);
  });
});

describe('攒思考段', () => {
  test('相邻的两片接成一段', () => {
    const segs = [];
    pushReasoningSegment(segs, '先看看');
    pushReasoningSegment(segs, '有什么。');
    assert.deepEqual(shape(segs), ['思考:先看看有什么。']);
  });

  // 一个回合的顺序通常是「想 → 说 → 调工具」：两者拼成一块就等于把思考
  // 写进正文，而正文是会被采纳写入章节的那一份。
  test('思考不接到文字段上', () => {
    const segs = [];
    pushTextSegment(segs, '我先看看。');
    pushReasoningSegment(segs, '嗯……');
    assert.deepEqual(shape(segs), ['文字:我先看看。', '思考:嗯……']);
  });

  test('文字也不接到思考段上', () => {
    const segs = [];
    pushReasoningSegment(segs, '嗯……');
    pushTextSegment(segs, '我先看看。');
    assert.deepEqual(shape(segs), ['思考:嗯……', '文字:我先看看。']);
  });

  // agent 一轮要调好几次模型，每个回合各想一次：攒成一块的话，
  // 「它读完这三章之后在想什么」就和第一回合的胡思乱想拌在一起了。
  test('隔着工具段的两次思考各自成段', () => {
    const segs = [];
    pushReasoningSegment(segs, '先查一下。');
    segs.push(toolSeg('c1'));
    pushReasoningSegment(segs, '读完了。');
    assert.deepEqual(shape(segs), ['思考:先查一下。', '工具:c1', '思考:读完了。']);
  });

  test('纯空白同样开不了新段', () => {
    const segs = [];
    pushReasoningSegment(segs, '\n');
    assert.deepEqual(segs, []);
  });
});

describe('收尾清理（pruneSegments）', () => {
  test('只剩空白的段清出去', () => {
    const kept = pruneSegments([
      { kind: 'text', text: '我先看看。' },
      { kind: 'text', text: '\n\n' },
      toolSeg('c1'),
    ]);
    assert.deepEqual(shape(kept), ['文字:我先看看。', '工具:c1']);
  });

  // pushTextSegment 只管得住段首；段尾那几个换行是流到最后才有的。
  test('段尾的空白剪掉', () => {
    const kept = pruneSegments([{ kind: 'text', text: '写好了。\n\n' }]);
    assert.deepEqual(shape(kept), ['文字:写好了。']);
  });

  test('思考段一样清', () => {
    const kept = pruneSegments([
      { kind: 'reasoning', text: '  ' },
      { kind: 'reasoning', text: '嗯……\n' },
    ]);
    assert.deepEqual(shape(kept), ['思考:嗯……']);
  });

  test('工具段一个字都不动（产出的正文在里面）', () => {
    const gen = { kind: 'tool', call: call('c2', 'generate', { output: '### 全书结构\n\n' }) };
    assert.equal(pruneSegments([gen])[0].call.output, '### 全书结构\n\n');
  });
});

describe('这一轮说的话（textOfSegments）', () => {
  test('几段文字用空行连起来', () => {
    const text = textOfSegments([
      { kind: 'text', text: '我先看看。' },
      toolSeg('c1'),
      { kind: 'text', text: '看完了。' },
    ]);
    assert.equal(text, '我先看看。\n\n看完了。');
  });

  // 思考不是正文：采纳写入、字数、复制都不该带上它。
  test('不含思考', () => {
    const text = textOfSegments([
      { kind: 'reasoning', text: '这段不该出现在正文里。' },
      { kind: 'text', text: '写好了。' },
    ]);
    assert.equal(text, '写好了。');
  });

  // 产物有自己的落点（那张卡片 + 落盘那一问），不是「这一轮说的话」。
  test('不含 generate 产出的正文', () => {
    const text = textOfSegments([
      { kind: 'tool', call: call('c2', 'generate', { output: '三更，林昭醒了。' }) },
      { kind: 'text', text: '写好了。' },
    ]);
    assert.equal(text, '写好了。');
  });

  test('一句话都没说时是空串', () => {
    assert.equal(textOfSegments([{ kind: 'reasoning', text: '嗯……' }, toolSeg('c1')]), '');
  });
});
