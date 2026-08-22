/**
 * 四档注入方式的取值与判定。**纯数据 + 纯函数**，所以这一份也是前端与后端
 * 共用那张表的契约（`media/src/protocol.ts` 直接 import 值，不另抄一份）。
 *
 * 真正要钉住的只有两件事：
 *
 * 1. **缺省是「仅用户」**——「装一份技能不让每一轮变贵」这句话就落在这个常量上。
 *    改掉它意味着所有既有工程的每轮预算都会变，那该是一次明确的决定。
 * 2. **`user` 与 `off` 在 agent 那一侧一样，在作者那一侧不一样**。它们不是
 *    「关」的两种程度，合成一档的话作者就没法把某份技能收进抽屉而仍能呼出。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const mode = loadModule('src/core/model/skillMode.ts');

describe('四档与缺省', () => {
  test('恰好四档，顺序是「越省钱的在前」', () => {
    assert.deepEqual(mode.SKILL_MODES, ['user', 'title', 'full', 'off']);
  });

  // 改这个常量 = 改所有既有工程的每轮预算。
  test('缺省是「仅用户」', () => {
    assert.equal(mode.DEFAULT_SKILL_MODE, 'user');
  });

  test('每一档都有界面说法与一句解释', () => {
    for (const m of mode.SKILL_MODES) {
      assert.ok(mode.SKILL_MODE_LABEL[m], m);
      assert.ok(mode.SKILL_MODE_HINT[m], m);
    }
  });

  test('认不出的值不是合法档位', () => {
    for (const bad of ['User', 'all', '', null, undefined, 1, {}]) {
      assert.equal(mode.isSkillMode(bad), false, JSON.stringify(bad));
    }
    for (const good of mode.SKILL_MODES) {
      assert.equal(mode.isSkillMode(good), true, good);
    }
  });
});

describe('isAgentVisible：agent 每轮看得到哪几档', () => {
  test('只有「仅标题」与「完整」', () => {
    assert.deepEqual(
      mode.SKILL_MODES.filter((m) => mode.isAgentVisible(m)),
      ['title', 'full']
    );
  });

  // 两者在 agent 这一侧一样、在作者那一侧不一样——所以是两件事，不是两种程度。
  test('「仅用户」与「禁用」在这一侧一样', () => {
    assert.equal(mode.isAgentVisible('user'), false);
    assert.equal(mode.isAgentVisible('off'), false);
  });
});

describe('normalizeSkillModes：手改配置写坏了也不炸', () => {
  test('认得出的原样留下', () => {
    const got = mode.normalizeSkillModes({ 'builtin:a': 'title', 'project:b': 'off' });
    assert.deepEqual(got, { 'builtin:a': 'title', 'project:b': 'off' });
  });

  // 一个认不出的档位名不该让整份配置作废——那一项回落缺省就行。
  test('认不出的档位名丢掉，其余照旧', () => {
    const got = mode.normalizeSkillModes({ 'builtin:a': 'TITLE', 'project:b': 'full', 'x': 3 });
    assert.deepEqual(got, { 'project:b': 'full' });
  });

  test('空名字丢掉（那种键在配置里没有意义）', () => {
    assert.deepEqual(mode.normalizeSkillModes({ '': 'full', '  ': 'title' }), {});
  });

  test('不是对象时回空表，不抛', () => {
    for (const bad of [null, undefined, 'full', 3, []]) {
      assert.deepEqual(mode.normalizeSkillModes(bad), {}, JSON.stringify(bad));
    }
  });

  // **不剔除指向已删技能的键**：作者可能只是把 .novelforge/skills/ 临时挪走了，
  // 清掉的话他挪回来时那几份技能的档位已经没了。
  test('指向不存在技能的键留着', () => {
    const got = mode.normalizeSkillModes({ 'project:早就删了的': 'full' });
    assert.deepEqual(got, { 'project:早就删了的': 'full' });
  });
});
