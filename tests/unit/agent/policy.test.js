/**
 * 策略与确认闸门：**三种模式 × 五档意图的那张表**。
 *
 * 这个文件从前有两半：判定表，以及每个工具的确认框该写什么话。后一半跟着
 * 工具搬走了（`tests/unit/tools/intent.test.js`）——**这里不认识任何一个工具
 * 的名字**，加一个工具不该回来改这个文件。
 *
 * 两档是产品承诺，不是偏好设置：
 *
 * 1. **`reviewed`**（write 覆盖）在任何模式下都不预先确认——交给下游的覆盖审阅
 *    （diff 本身就同时回答了「要不要动」与「改了什么」）。
 * 2. **`always`**（edit）在任何模式下都要确认，包括「放手」——它改的是已有内容，
 *    而 `ws.edit` 不走 diff，所以那一句确认就是它的审阅。
 *
 * 还有一条：**拒绝之后回给模型的话要有信息量**，否则它会原地重试烧钱。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const policy = loadModule('src/core/agent/policy.ts');
const { gateFor, declinedText, AGENT_POLICIES, DEFAULT_AGENT_POLICY, isAgentPolicy } = policy;

/** 五档意图的最小替身。闸门只看 `gate`，说辞原样转述。 */
const intent = (gate, extra = {}) => ({ gate, title: '做一件事', ...extra });

const confirms = (mode, gate) => gateFor(mode, intent(gate)).confirm;

/** 期望矩阵。改这张表之前先想清楚它对应的是哪一条产品承诺。 */
const MATRIX = {
  //        careful default bold
  auto: [false, false, false],
  costly: [true, false, false],
  mutating: [true, true, false],
  reviewed: [false, false, false],
  always: [true, true, true],
};

describe('三种模式 × 五档', () => {
  for (const [gate, expected] of Object.entries(MATRIX)) {
    AGENT_POLICIES.forEach((mode, i) => {
      test(`${mode} × ${gate} ${expected[i] ? '要确认' : '自动'}`, () => {
        assert.equal(confirms(mode, gate), expected[i]);
      });
    });
  }
});

// ★ 这两组是产品承诺：三种模式给出的闸门必须逐字相同，不可配置。
describe('不可配置的两档', () => {
  for (const gate of ['reviewed', 'always']) {
    test(`${gate} 在三种模式下逐字相同`, () => {
      const gates = AGENT_POLICIES.map((m) => JSON.stringify(gateFor(m, intent(gate))));
      assert.equal(new Set(gates).size, 1, gates.join(' | '));
    });
  }
});

describe('说辞原样来自工具，只补一个主语', () => {
  const g = gateFor('default', {
    gate: 'mutating',
    title: '写入「第 12 章的细纲」',
    detail: '.novelforge/plots/012-入宗.md（新建）',
  });

  // 作者要知道现在是谁要动他的磁盘；工具不知道自己被谁调，所以主语在这里加。
  test('加了主语', () => {
    assert.equal(g.message, 'Agent 要写入「第 12 章的细纲」');
  });

  test('detail 原样透传，不在这里改写', () => {
    assert.equal(g.detail, '.novelforge/plots/012-入宗.md（新建）');
  });

  // 动词已经在按钮上方那句话里了（「Agent 要写入「第 12 章的细纲」」），按钮
  // 再说一遍是重复；每个工具各报一个动词的话，同一颗主按钮每次换一个字。
  test('按钮上一律是「确认」', () => {
    assert.equal(g.proceed, '确认');
    assert.equal(gateFor('default', intent('mutating')).proceed, '确认');
  });
});

describe('没有意图的一步', () => {
  // 认不出的**名字**由循环挡在前面（不弹框，直接让 invoke 回「没有叫 X 的
  // 工具」）。走到这里的是「有这个工具，但它没说自己是什么性质」——
  // 宁可多问，也不要有一条没人想过的路。
  test('按 mutating 判', () => {
    assert.equal(gateFor('careful', undefined).confirm, true);
    assert.equal(gateFor('default', undefined).confirm, true);
    assert.equal(gateFor('bold', undefined).confirm, false);
  });
});

describe('拒绝之后回给模型的话', () => {
  const g = { confirm: true, message: 'Agent 要写入「第 12 章的细纲」' };

  test('跳过时说清了作者跳过了这一步', () => {
    assert.ok(declinedText('skip', g).includes('跳过'), declinedText('skip', g));
  });

  // 不说这句，它会把同一个动作再发一遍，每次都是一整轮上下文的钱。
  test('跳过时明说不要重试同一个动作', () => {
    assert.ok(declinedText('skip', g).includes('不要重试'), declinedText('skip', g));
  });

  test('跳过时说清了磁盘没变', () => {
    assert.ok(declinedText('skip', g).includes('什么都没变'), declinedText('skip', g));
  });

  test('停止时让它去说明做到哪了，而不是接着发动作', () => {
    const text = declinedText('stop', g);
    assert.ok(text.includes('不要再发起新的动作'), text);
    assert.ok(text.includes('做到哪'), text);
  });

  test('两句话里都带上了是哪一步', () => {
    assert.ok(declinedText('skip', g).includes('第 12 章的细纲'), declinedText('skip', g));
    assert.ok(declinedText('stop', g).includes('第 12 章的细纲'), declinedText('stop', g));
  });
});

describe('策略值本身', () => {
  test('三个值', () => {
    assert.deepEqual(AGENT_POLICIES, ['careful', 'default', 'bold']);
  });

  // 第一次用 agent 的人不该发现它已经往磁盘上写了七份东西。
  test('缺省是「默认」而不是「放手」', () => {
    assert.equal(DEFAULT_AGENT_POLICY, 'default');
  });

  test('认不出的值不认', () => {
    assert.equal(isAgentPolicy('放手'), false);
    assert.equal(isAgentPolicy(undefined), false);
    assert.equal(isAgentPolicy('bold'), true);
  });
});
