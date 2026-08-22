/**
 * 作者用 `/` 呼出技能：**从选择器到那句话里**。
 *
 * 这条路与 agent 自己读技能（`skill` 工具）是两件事，测的东西也不一样——
 * 那边验「够不着的档取不到」，这边验四件：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 缺省档（仅用户）呼得出来 | 那一档的全部意义：agent 看不见，作者呼得到 |
 * | 「禁用」不在候选里 | 两边都看不到，才叫禁用 |
 * | 正文折进那句话的**前面**，一个字不截 | 半套流程比没有更糟；方法在前、要求在后 |
 * | 发出去就清空，正文不进会话 | 一次性；那几千字已经在 content 里了，存两遍是浪费 |
 *
 * 走的是真的 controller（`dispatch`），因为这条路的活全在拼接与生命周期上：
 * 挑完记在哪、发送时折进哪、发完清不清。打桩就等于把要测的东西替换掉了。
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
let controller;
let h;
let settings;
let someBuiltin;

/** 每一轮 agent 实际收到的第一条 user 消息。呼出的技能就折在这里面。 */
let asks = [];
/** 后端推给前端的 `pendingSkills` 消息，按顺序。 */
let pushed = [];

/**
 * 把 agent 循环那次模型调用换成一个不说话的假 provider：这一组不关心它怎么
 * 回答，只关心**发出去的第一条 user 消息长什么样**。
 */
function installAgentProvider() {
  bundle.registry.registerProviderFactory(() => ({
    id: 'vscode-lm',
    label: '假模型',
    maxInputTokens: async () => undefined,
    stream: async function* (messages) {
      const user = messages.find((m) => m.role === 'user');
      asks.push(user ? user.content : '');
      yield { type: 'text', text: '好' };
    },
  }));
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    controller: './src/core/controller/index.ts',
    skills: './src/core/skills/index.ts',
    db: './src/core/runtime/db.ts',
  });
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 100000 }] }],
    models: ['p/m'],
    concurrency: 1,
    skillModes: {},
  };
  h = makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  installAgentProvider();

  t = await makeTempProject(bundle.project, { prefix: 'skillcall', title: '青云剑录' });
  project = t.project;
  someBuiltin = Object.keys(bundle.skills.BUILTIN_SKILLS).sort()[0];

  t.write(
    '.novelforge/skills/我的审章流程/SKILL.md',
    '---\ndescription: 我自己那套审章法\n---\n\n# 我的审章流程\n\n第一步：先读三遍。\n'
  );
  t.write('.novelforge/skills/不想用的/SKILL.md', '# 不想用的');

  controller = new bundle.controller.ChatController(project);
  controller.attach({
    kind: 'sidebar',
    post: (msg) => {
      if (msg.type === 'pendingSkills') {
        pushed.push(msg.items);
      }
    },
    reveal: () => {},
  });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

/** 挑一份技能（假宿主的 pick 从答案队列里取）。 */
async function pick(name) {
  h.expect(name);
  await controller.dispatch({ type: 'pickSkill' });
}

describe('选择器里有哪些', () => {
  test('缺省档（仅用户）呼得出来——那一档的全部意义就在这儿', async () => {
    settings.skillModes = {};
    h.expect(undefined); // 不选，只看候选列表
    await controller.dispatch({ type: 'pickSkill' });
    const choices = h.picks[h.picks.length - 1].choices.map((c) => c.value);
    assert.ok(choices.includes('project:我的审章流程'), choices.join(' / '));
    assert.ok(choices.includes(`builtin:${someBuiltin}`), choices.join(' / '));
  });

  test('「禁用」的不在候选里', async () => {
    settings.skillModes = { 'project:不想用的': 'off' };
    h.expect(undefined);
    await controller.dispatch({ type: 'pickSkill' });
    const choices = h.picks[h.picks.length - 1].choices.map((c) => c.value);
    assert.equal(choices.includes('project:不想用的'), false, choices.join(' / '));
  });

  // 副标题是作者判断「是不是这一份」的唯一依据。`listSkills` 只在 `full` 档
  // 读描述（那条规矩是为了不让 agent 的每一轮变贵），这条人工挑选的路不受它限。
  test('工程技能的描述也读出来了，哪怕它是缺省档', async () => {
    settings.skillModes = {};
    h.expect(undefined);
    await controller.dispatch({ type: 'pickSkill' });
    const row = h.picks[h.picks.length - 1].choices.find((c) => c.value === 'project:我的审章流程');
    assert.equal(row.description, '我自己那套审章法');
  });
});

describe('挑完之后', () => {
  test('挂成一枚标签推给前端，带字数', async () => {
    settings.skillModes = {};
    pushed = [];
    await pick('project:我的审章流程');
    const last = pushed[pushed.length - 1];
    assert.equal(last.length, 1);
    assert.equal(last[0].name, 'project:我的审章流程');
    assert.equal(last[0].stem, '我的审章流程');
    assert.ok(last[0].chars > 0, JSON.stringify(last[0]));
  });

  test('同一份呼两次不重复', async () => {
    await pick('project:我的审章流程');
    assert.equal(controller.pendingSkills.length, 1);
  });

  test('摘得掉', async () => {
    controller.dispatch({ type: 'dropSkill', name: 'project:我的审章流程' });
    assert.deepEqual(controller.pendingSkills, []);
    assert.deepEqual(pushed[pushed.length - 1], []);
  });

  test('认不出的名字摘了也不炸', () => {
    controller.dispatch({ type: 'dropSkill', name: '并不存在' });
    assert.deepEqual(controller.pendingSkills, []);
  });
});

describe('发出去的那句话', () => {
  before(async () => {
    settings.skillModes = {};
    controller.pendingSkills = [];
    asks = [];
    await pick('project:我的审章流程');
    await controller.dispatch({ type: 'sendAgent', text: '帮我核一下第 9 章' });
  });

  test('技能正文进了第一条 user 消息', () => {
    assert.equal(asks.length, 1, '这一轮该只调一次模型');
    assert.match(asks[0], /第一步：先读三遍。/);
  });

  // 一个字都不截：截掉一半的工作流比没有更糟（它会照着半套流程做完，
  // 还以为自己做全了）。
  test('正文一个字都没少', () => {
    const body = '# 我的审章流程\n\n第一步：先读三遍。';
    assert.ok(asks[0].includes(body), asks[0]);
  });

  // 方法在前、要求在后：模型对最近的内容最敏感，要它做的事该挨着它读到的
  // 最后一句。反过来的话作者那句话会被几千字推到很远的地方。
  test('方法排在作者那句话前面', () => {
    const method = asks[0].indexOf('第一步：先读三遍。');
    const ask = asks[0].indexOf('帮我核一下第 9 章');
    assert.ok(method >= 0 && ask >= 0, asks[0]);
    assert.ok(method < ask, `方法该在前，实际次序：${[method, ask]}`);
  });

  test('说清了这是作者指定的，不必再 skill 一遍', () => {
    assert.match(asks[0], /不必再用 skill 工具读一遍/);
  });

  // 一次性：下一句话不该莫名其妙又带上刚才那几千字（作者会以为它自己记住了）。
  test('发完就清空，前端也收到空表', () => {
    assert.deepEqual(controller.pendingSkills, []);
    assert.deepEqual(pushed[pushed.length - 1], []);
  });

  test('下一句话不再带技能', async () => {
    await controller.dispatch({ type: 'sendAgent', text: '那第 10 章呢' });
    assert.equal(asks.length, 2);
    assert.equal(asks[1].includes('第一步：先读三遍。'), false, asks[1]);
  });
});

describe('会话里留下的记录', () => {
  test('只存名字，不存正文', async () => {
    settings.skillModes = {};
    controller.pendingSkills = [];
    await pick('project:我的审章流程');
    await controller.dispatch({ type: 'sendAgent', text: '再核一次' });

    const userTurn = [...controller.current.turns].reverse().find((x) => x.role === 'user');
    assert.deepEqual(userTurn.skills, ['project:我的审章流程']);
    // 正文已经折进 content 发出去了，会话里再存一份是同一段话躺两遍。
    assert.equal(userTurn.content, '再核一次');
    assert.equal(JSON.stringify(userTurn).includes('第一步：先读三遍。'), false);
  });
});
