/**
 * 每个工具自报的**意图**：这一步是什么性质、问的时候怎么说。
 *
 * 从前这些话写在 agent 的 `policy.ts` 里（一个按工具名分支的 switch）。
 * 搬到工具这一侧之后，判定表那边只剩五行（`tests/unit/agent/policy.test.js`），
 * 而**说辞与它描述的那件事在同一个文件里**——改了 `write` 的行为，眼皮底下
 * 就是它要对作者说的话。
 *
 * 两条不可配置的归档是产品承诺（AGENTS 第 25(a) 条），钉在这里：
 *
 * 1. **`write` 覆盖 = `reviewed`**——下游 `ws.write` 带 diff 请人过目，
 *    不该在它之前再问一句「确定吗」。
 * 2. **`edit` = `always`**——`ws.edit` 不走 diff，那一句确认就是它的 diff，
 *    放手模式也不能免。
 *
 * 这里不给 project（纯单测），名字退回路径本身；带工程时的名字由
 * `tests/integration/agent/gate.test.js` 验。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const tools = loadModule('src/core/tools/novel/index.ts');

const byName = (name) => tools.NOVEL_TOOLS.find((t) => t.name === name);
const intentOf = (name, args) => byName(name).intent(args);

const PLOT = '.novelforge/plots/012-入宗.md';

describe('读三件套：不问', () => {
  for (const name of ['list', 'read', 'search']) {
    test(`${name} 没有 intent，也不标 mutating / costly`, () => {
      const tool = byName(name);
      // 注册表据此兜一个 auto——读工具不花钱不改东西，问一句只是让人麻木。
      assert.equal(tool.intent, undefined);
      assert.equal(!!tool.mutating, false);
      assert.equal(!!tool.costly, false);
    });
  }
});

describe('generate：花钱但不写盘', () => {
  const g = () => intentOf('generate', { target: PLOT, ask: '接住第 9 章那处伏笔' });

  test('归 costly', () => {
    assert.equal(g().gate, 'costly');
  });

  test('标了 costly，没标 mutating（它一个字都不落盘）', () => {
    assert.equal(byName('generate').costly, true);
    assert.equal(!!byName('generate').mutating, false);
  });

  // 「Agent 想调用 generate，允许吗」作者答不上来——他不知道会写到哪、花多少。
  test('说清了会花钱', () => {
    assert.ok(g().detail.includes('花钱'), g().detail);
  });

  test('说清了产出仍然要点采纳', () => {
    assert.ok(g().detail.includes('采纳'), g().detail);
  });

  test('说清了动的是哪一份', () => {
    assert.ok(g().title.includes(PLOT), g().title);
  });

  test('title 是动词短语，主语留给调用方加', () => {
    assert.ok(!g().title.startsWith('Agent'), g().title);
  });

  test('按钮上写的是「生成」而不是「确定」', () => {
    assert.equal(g().proceed, '生成');
  });
});

describe('write 新建 / 追加：常规的动手前问一句', () => {
  test('新建归 mutating', () => {
    assert.equal(intentOf('write', { path: PLOT }).gate, 'mutating');
  });

  test('追加与新建同一档', () => {
    assert.equal(intentOf('write', { path: PLOT, mode: 'append' }).gate, 'mutating');
  });

  test('框上写清了写到哪、是新建还是追加', () => {
    const i = intentOf('write', { path: PLOT });
    assert.ok(i.title.includes('写入'), i.title);
    assert.ok(i.detail.includes(PLOT), i.detail);
    assert.ok(i.detail.includes('新建'), i.detail);
    assert.ok(intentOf('write', { path: PLOT, mode: 'append' }).detail.includes('追加'), 'append');
  });

  test('按钮上写的是「写入」', () => {
    assert.equal(intentOf('write', { path: PLOT }).proceed, '写入');
  });
});

// ★ 产品承诺，不是偏好设置。
describe('write 覆盖：交给下游的覆盖审阅', () => {
  test('归 reviewed（三种模式都不预先确认）', () => {
    assert.equal(intentOf('write', { path: PLOT, mode: 'overwrite' }).gate, 'reviewed');
  });
});

// ★ 同上：edit 改的也是已有内容，而 ws.edit 不走 diff。
describe('edit：任何模式都要问', () => {
  const args = { path: PLOT, old: '林昭', new: '林昀' };

  test('归 always', () => {
    assert.equal(intentOf('edit', args).gate, 'always');
  });

  // 不写出 old → new，作者只能凭工具名点确定，那不叫过目。
  test('框里写出了原文与改成什么', () => {
    const i = intentOf('edit', args);
    assert.ok(i.detail.includes('林昭'), i.detail);
    assert.ok(i.detail.includes('林昀'), i.detail);
  });

  test('删掉一段时说「删掉」而不是留空', () => {
    assert.ok(intentOf('edit', { ...args, new: '' }).detail.includes('删掉'));
  });

  test('all=true 时说清全文都改', () => {
    assert.ok(intentOf('edit', { ...args, all: true }).detail.includes('所有出现的地方'));
  });

  test('按钮上写的是「替换」', () => {
    assert.equal(intentOf('edit', args).proceed, '替换');
  });
});

describe('run：工程动作', () => {
  const i = () => intentOf('run', { action: 'batchPlots' });

  test('归 mutating', () => {
    assert.equal(i().gate, 'mutating');
  });

  test('说清了要执行哪个动作', () => {
    assert.ok(i().title.includes('batchPlots'), i().title);
  });

  // 放手模式下这里不问，但 pipelineBatch 自己那个「预计调用 N 次」照弹。
  test('提醒了随后还会告诉他调几次', () => {
    assert.ok(i().detail.includes('预计调用几次'), i().detail);
  });
});

describe('长参数不整段摊进框里', () => {
  test('超长的 old 会截断', () => {
    const long = '青'.repeat(200);
    const detail = intentOf('edit', { path: PLOT, old: long, new: 'x' }).detail;
    assert.ok(detail.includes('…'), detail.slice(0, 80));
    assert.ok(detail.length < 200, String(detail.length));
  });
});
