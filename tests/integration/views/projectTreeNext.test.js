/**
 * 工程页快照里的「全书下一步」（W12）与对话页主按钮在全书那一档给的，是同一步、同一句话。
 *
 * 两处从前各算各的会怎样：工程页的空状态写「下一步：生成故事前提」，对话页的主按钮却是
 * 「生成情节大纲」——作者不知道该信哪个，而那种分叉没有任何别的测试拦得住（第 20 条）。
 * 所以这里沿着一本书从空工程走到「在写」，每一档都拿 `buildProjectTree` 的 `next` 与
 * `bookNextStep` 逐字比。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    projectView: './src/core/views/projectView.ts',
    chat: './src/core/controller/chat.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'treenext', title: '青云剑录' });
  project = t.project;
});

after(() => {
  if (t) cleanup(t.dir, bundle && bundle.db);
});

/** 两处各算一遍。`bookNextStep` 只用得到 `c.project`。 */
async function both() {
  project.invalidate();
  const tree = await bundle.projectView.buildProjectTree(project);
  const chat = await bundle.chat.bookNextStep({ project });
  return { tree, chat };
}

describe('工程页的全书下一步与对话页主按钮逐字一致', () => {
  test('空工程：生成小说配置，带一句话弹窗的默认值', async () => {
    const { tree, chat } = await both();
    assert.equal(tree.next?.label, '生成小说配置', JSON.stringify(tree.next));
    assert.equal(tree.next.form, 'idea');
    assert.ok(tree.next.formDefaults, JSON.stringify(tree.next));
    assert.deepEqual(tree.next, chat);
  });

  test('配置写好了：生成故事前提', async () => {
    t.write('.novelforge/config.md', '---\ntotalChapters: 40\n---\n\n# 小说配置\n\n## 核心梗概\n\n少年入宗。\n');
    const { tree, chat } = await both();
    assert.equal(tree.next?.label, '生成故事前提', JSON.stringify(tree.next));
    assert.deepEqual(tree.next.target, { kind: 'setting', doc: 'premise' });
    assert.deepEqual(tree.next, chat);
  });

  test('架构四件齐了：生成情节大纲（第 1–20 章）', async () => {
    t.write('.novelforge/premise.md', '# 故事前提\n\n## 核心冲突链\n\n宗门要他死。\n');
    t.write('.novelforge/characters/林昭.md', '---\nname: 林昭\ntags: [主角]\n---\n\n# 林昭\n\n## 身份\n\n少年。\n');
    t.write('.novelforge/world.md', '# 世界观\n\n## 规则与漏洞\n\n灵根定命。\n');
    const { tree, chat } = await both();
    assert.equal(tree.next?.label, '生成情节大纲（第 1–20 章）', JSON.stringify(tree.next));
    assert.deepEqual(tree.next, chat);
  });

  test('有大纲、没细纲：拆细纲（第 1–5 章），落在第 1 章细纲应该在的位置', async () => {
    t.write('.novelforge/outline.md', '# 情节大纲\n\n## 第1–20章：入宗\n\n林昭入宗。\n');
    const { tree, chat } = await both();
    assert.equal(tree.next?.label, '拆细纲（第 1–5 章）', JSON.stringify(tree.next));
    assert.equal(tree.next.no, 1);
    assert.deepEqual(tree.next, chat);
  });

  // 在写那一档：下一步是单章状态机的事（「写第 1 章」），工程页那一行自己带「去写这一章」。
  test('下一章有细纲了：工程页不再给全书下一步', async () => {
    t.write('.novelforge/plots/001-夜入青云.md', '---\nno: 1\ntitle: 夜入青云\n---\n\n## 本章目的\n\n入宗。\n\n## 关键事件\n\n翻墙。\n\n## 章末钩子\n\n墙内有人。\n');
    const { tree, chat } = await both();
    assert.equal(tree.next, undefined, JSON.stringify(tree.next));
    assert.equal(tree.bookStage, 'writing');
    // 对话页那边照旧转去问单章状态机。
    assert.ok(chat && chat.no === 1, JSON.stringify(chat));
  });
});
