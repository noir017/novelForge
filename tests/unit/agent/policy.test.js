/**
 * 策略与确认闸门。
 *
 * 三种模式 × 五类工具的矩阵，外加两条**不可配置**的：
 *
 * 1. **`write` 覆盖**在任何模式下都不预先确认——交给网关的覆盖审阅（diff）。
 * 2. **`edit`** 在任何模式下都要确认，包括「放手」——它改的是已有内容，
 *    而 `ws.edit` 不走 diff，所以那一句确认就是它的审阅。
 *
 * 还有一条：**拒绝之后回给模型的话要有信息量**，否则它会原地重试烧钱。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const policy = loadModule('src/core/agent/policy.ts');
const { gateFor, declinedText, AGENT_POLICIES, DEFAULT_AGENT_POLICY, isAgentPolicy } = policy;

/** 工具定义的最小替身：闸门只看 name / mutating / costly。 */
const T = {
  list: { name: 'list' },
  read: { name: 'read' },
  search: { name: 'search' },
  generate: { name: 'generate', costly: true },
  write: { name: 'write', mutating: true },
  edit: { name: 'edit', mutating: true },
  run: { name: 'run', mutating: true, costly: true },
};

const gate = (mode, tool, args = {}) => gateFor(mode, tool, args);
const confirms = (mode, tool, args) => gate(mode, tool, args).confirm;

describe('读工具在任何模式下都自动', () => {
  for (const mode of AGENT_POLICIES) {
    for (const name of ['list', 'read', 'search']) {
      test(`${mode} × ${name} 不问`, () => {
        assert.equal(confirms(mode, T[name], { path: 'x' }), false);
      });
    }
  }
});

describe('generate：只有谨慎模式每次确认', () => {
  test('谨慎要确认', () => {
    assert.equal(confirms('careful', T.generate, { target: '.novelforge/plots/012.md' }), true);
  });

  test('默认不问（预算内自动）', () => {
    assert.equal(confirms('default', T.generate, { target: '.novelforge/plots/012.md' }), false);
  });

  test('放手不问', () => {
    assert.equal(confirms('bold', T.generate, { target: '.novelforge/plots/012.md' }), false);
  });

  // 「Agent 想调用 generate，允许吗」作者答不上来——他不知道会写到哪、花多少。
  test('问的时候说清了会花钱', () => {
    const g = gate('careful', T.generate, { target: '.novelforge/plots/012.md' });
    assert.ok(g.detail.includes('花钱'), g.detail);
  });

  test('问的时候说清了产出仍然要点采纳', () => {
    const g = gate('careful', T.generate, { target: '.novelforge/plots/012.md' });
    assert.ok(g.detail.includes('采纳'), g.detail);
  });
});

describe('write 新建 / 追加：谨慎与默认确认，放手自动', () => {
  const args = { path: '.novelforge/plots/012-入宗.md' };

  test('谨慎要确认', () => {
    assert.equal(confirms('careful', T.write, args), true);
  });

  test('默认要确认', () => {
    assert.equal(confirms('default', T.write, args), true);
  });

  test('放手自动', () => {
    assert.equal(confirms('bold', T.write, args), false);
  });

  test('追加与新建同一档', () => {
    assert.equal(confirms('default', T.write, { ...args, mode: 'append' }), true);
    assert.equal(confirms('bold', T.write, { ...args, mode: 'append' }), false);
  });

  test('确认框上写清了写到哪、是新建还是追加', () => {
    const g = gate('default', T.write, args);
    assert.ok(g.message.includes('写入'), g.message);
    assert.ok(g.detail.includes('.novelforge/plots/012-入宗.md'), g.detail);
    assert.ok(g.detail.includes('新建'), g.detail);
  });

  test('同意那颗按钮上写的是「写入」而不是「确定」', () => {
    assert.equal(gate('default', T.write, args).proceed, '写入');
  });
});

// ★ 这一组是产品承诺，不是偏好设置。
describe('write 覆盖：三种模式完全一样', () => {
  const args = { path: '.novelforge/plots/012-入宗.md', mode: 'overwrite' };

  for (const mode of AGENT_POLICIES) {
    test(`${mode} 下都不预先确认（交给网关的覆盖审阅）`, () => {
      assert.equal(confirms(mode, T.write, args), false);
    });
  }

  test('三种模式给出的闸门逐字相同', () => {
    const gates = AGENT_POLICIES.map((m) => JSON.stringify(gate(m, T.write, args)));
    assert.equal(new Set(gates).size, 1, gates.join(' | '));
  });
});

// ★ 同上：edit 改的也是已有内容，而 ws.edit 不走 diff。
describe('edit：三种模式都要确认', () => {
  const args = { path: '.novelforge/plots/012-入宗.md', old: '林昭', new: '林昀' };

  for (const mode of AGENT_POLICIES) {
    test(`${mode} 下都要确认`, () => {
      assert.equal(confirms(mode, T.edit, args), true);
    });
  }

  test('三种模式给出的闸门逐字相同', () => {
    const gates = AGENT_POLICIES.map((m) => JSON.stringify(gate(m, T.edit, args)));
    assert.equal(new Set(gates).size, 1, gates.join(' | '));
  });

  // 不写出 old → new，作者只能凭工具名点确定，那不叫过目。
  test('框里写出了原文与改成什么', () => {
    const g = gate('bold', T.edit, args);
    assert.ok(g.detail.includes('林昭'), g.detail);
    assert.ok(g.detail.includes('林昀'), g.detail);
  });

  test('删掉一段时说「删掉」而不是留空', () => {
    const g = gate('default', T.edit, { ...args, new: '' });
    assert.ok(g.detail.includes('删掉'), g.detail);
  });

  test('all=true 时说清全文都改', () => {
    const g = gate('default', T.edit, { ...args, all: true });
    assert.ok(g.detail.includes('所有出现的地方'), g.detail);
  });
});

describe('run：谨慎与默认确认，放手自动', () => {
  const args = { action: 'batchPlots' };

  test('谨慎要确认', () => {
    assert.equal(confirms('careful', T.run, args), true);
  });

  test('默认要确认', () => {
    assert.equal(confirms('default', T.run, args), true);
  });

  test('放手自动', () => {
    assert.equal(confirms('bold', T.run, args), false);
  });

  // 放手模式下这里不问，但 pipelineBatch 自己那个「预计调用 N 次」照弹。
  test('确认框里提醒了随后还会告诉他调几次', () => {
    const g = gate('default', T.run, args);
    assert.ok(g.detail.includes('预计调用几次'), g.detail);
  });
});

describe('认不出的工具', () => {
  const unknown = { name: '未来的某个工具', mutating: true };

  test('默认模式下宁可多问一句', () => {
    assert.equal(confirms('default', unknown, {}), true);
  });

  test('读类的没登记也不问（不花钱不写盘）', () => {
    assert.equal(confirms('default', { name: '某个只读工具' }, {}), false);
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
