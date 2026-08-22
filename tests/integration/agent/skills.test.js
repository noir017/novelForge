/**
 * 技能索引在循环里的落点。
 *
 * 单看 `core/skills/` 那一层测不出这一期真正的赌注——**索引拼在哪、什么时候
 * 重建**。四件事：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 索引在 `AGENT_SYSTEM` 之后、`brief()` 之前 | 稳定的排在前，易变的排在后（接 prompt caching 的前提） |
 * | 一轮之内逐字不变 | 技能是方法论不是状态，中途换掉判据会在一轮内漂移 |
 * | 中途新建的技能本轮不认、下一轮才认 | 同上，这是那条规则看得见的样子 |
 * | 索引只列名字，不读正文 | 正文由 `skill` 工具按需取——这是「不占每一轮 token」的全部 |
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
let someBuiltin;

/**
 * 这一轮配置里的技能档位。**缺省是「仅用户」= 索引里什么都没有**，所以下面
 * 凡是要验索引内容的用例都得先把技能开到「仅标题」/「完整」。
 *
 * 这也是这个文件最容易写出「因为别的原因而通过」的地方：缺省档下索引整段不拼，
 * 于是一串「不该出现」的断言全绿，而一条都没在测它自己说的那件事。
 */
let skillModes = {};

/** 每回合喂一段脚本；`calls` 留下每一轮实际发出去的 messages。 */
function scriptedProvider(script) {
  const calls = [];
  return {
    provider: {
      id: 'vscode-lm',
      label: '假模型',
      maxInputTokens: async () => undefined,
      stream: async function* (messages, options) {
        const i = calls.length;
        calls.push({ messages, options });
        for (const ev of script[i] ?? [{ type: 'text', text: '（没词了）' }]) {
          yield ev;
        }
      },
    },
    calls,
  };
}

const say = (text) => [{ type: 'text', text }];
const useTool = (id, name, args) => [
  { type: 'toolCall', call: { id, name, args, raw: JSON.stringify(args) } },
];

const systemOf = (call) => call.messages.find((m) => m.role === 'system').content;

function run(provider, extra) {
  return bundle.loop.runAgent({
    project,
    tools: bundle.tools.createNovelTools({
      project,
      workspace: new bundle.ws.Workspace(project),
      drafts: new bundle.drafts.DraftStore(),
      sessionId: 's1',
    }),
    provider,
    ask: '帮我看看第 9 章',
    signal: new AbortController().signal,
    ...extra,
  });
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    drafts: './src/core/generation/drafts.ts',
    loop: './src/core/agent/loop.ts',
    tools: './src/core/tools/novel/index.ts',
    skills: './src/core/skills/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(
    makeFakeHost({
      settings: () => ({
        contextWindow: 100000,
        maxOutputTokens: 2000,
        temperature: 0.8,
        requestTimeoutMs: 60000,
        skillModes,
      }),
    }).host
  );
  t = await makeTempProject(bundle.project, { prefix: 'agentskills', title: '青云志' });
  project = t.project;
  someBuiltin = Object.keys(bundle.skills.BUILTIN_SKILLS).sort()[0];
});

after(async () => {
  await cleanup(t);
});

describe('缺省档：索引整段不拼', () => {
  // **这是最常见的那条路**：什么都不配时技能一个字都不占每轮预算，
  // 「装一份技能不让每一轮变贵」这句话就落在这里。
  test('什么都不配时 system 里没有「可用技能」这一段', async () => {
    skillModes = {};
    const { provider, calls } = scriptedProvider([say('好')]);
    await run(provider);
    const system = systemOf(calls[0]);
    assert.equal(system.includes('# 可用技能'), false, system.slice(0, 400));
    // 身份与现场照旧在——不是整个 system 都空了。
    assert.match(system, /你是 Novel Forge 的助手/);
    assert.match(system, /# 当前工程/);
  });

  test('「禁用」也不在索引里', async () => {
    skillModes = { [`builtin:${someBuiltin}`]: 'off' };
    const { provider, calls } = scriptedProvider([say('好')]);
    await run(provider);
    assert.equal(systemOf(calls[0]).includes('# 可用技能'), false);
  });
});

describe('索引拼在哪', () => {
  test('开到「仅标题」的技能每一轮都在，名字带 builtin: 前缀', async () => {
    skillModes = { [`builtin:${someBuiltin}`]: 'title' };
    const { provider, calls } = scriptedProvider([say('看完了')]);
    await run(provider);
    assert.match(systemOf(calls[0]), new RegExp(`builtin:${someBuiltin}`));
  });

  // 「完整」那一档多付的就是这一行——它让模型更容易判断「这一轮该不该用它」。
  test('开到「完整」时带上那一行描述', async () => {
    skillModes = { [`builtin:${someBuiltin}`]: 'full' };
    const { provider, calls } = scriptedProvider([say('好')]);
    await run(provider);
    const desc = bundle.skills.BUILTIN_SKILLS[someBuiltin].description;
    assert.ok(desc, '这个内置技能得写了 description，否则这条在空跑');
    assert.ok(systemOf(calls[0]).includes(desc), '「完整」档没把描述发出去');
  });

  test('顺序是：身份 → 技能索引 → 当前工程', async () => {
    skillModes = { [`builtin:${someBuiltin}`]: 'title' };
    const { provider, calls } = scriptedProvider([say('好')]);
    await run(provider);
    const system = systemOf(calls[0]);
    const identity = system.indexOf('你是 Novel Forge 的助手');
    const index = system.indexOf('# 可用技能');
    const brief = system.indexOf('# 当前工程');
    assert.ok(identity >= 0 && index >= 0 && brief >= 0, system.slice(0, 200));
    assert.ok(
      identity < index && index < brief,
      `稳定的要排在易变的前面，实际次序：${[identity, index, brief]}`
    );
  });

  // 索引只列名字（与那一行描述）：一次 readdir + 一次 Object.keys()。
  // **正文一个字都不进**——那是「不占每一轮 token」的全部。
  test('只列名字，不带正文', async () => {
    skillModes = { [`builtin:${someBuiltin}`]: 'full' };
    const { provider, calls } = scriptedProvider([say('好')]);
    await run(provider);
    const system = systemOf(calls[0]);
    const body = bundle.skills.BUILTIN_SKILLS[someBuiltin].body;
    // 拿正文里靠后的一段来比——开头那行标题与名字长得像，不足为凭。
    const tail = body.slice(Math.floor(body.length / 2), Math.floor(body.length / 2) + 40);
    assert.equal(system.includes(tail), false, '正文被拼进了每一轮的 system');
  });

  test('作者写的技能带 project: 前缀', async () => {
    t.write('.novelforge/skills/我的审章流程/SKILL.md', '# 我的审章流程');
    skillModes = { 'project:我的审章流程': 'title' };
    const { provider, calls } = scriptedProvider([say('好')]);
    await run(provider);
    assert.match(systemOf(calls[0]), /project:我的审章流程/);
  });

  // 换掉身份的调用方多半也换了工具集，替它硬塞一份 Novel Forge 的技能清单是错的。
  test('调用方自带 system 时不塞索引', async () => {
    skillModes = { [`builtin:${someBuiltin}`]: 'title' };
    const { provider, calls } = scriptedProvider([say('好')]);
    await run(provider, { system: '你是另一个东西。' });
    assert.equal(systemOf(calls[0]).includes('# 可用技能'), false);
  });
});

describe('一轮之内不变', () => {
  test('三个回合的索引逐字一致，而 brief 每回合重建', async () => {
    skillModes = { [`builtin:${someBuiltin}`]: 'title' };
    const { provider, calls } = scriptedProvider([
      useTool('c1', 'list', { path: '.novelforge' }),
      useTool('c2', 'list', { path: '.novelforge/plots' }),
      say('看完了'),
    ]);
    await run(provider);
    assert.equal(calls.length, 3);

    const indexOf = (c) => {
      const s = systemOf(c);
      return s.slice(s.indexOf('# 可用技能'), s.indexOf('# 当前工程'));
    };
    assert.equal(indexOf(calls[0]), indexOf(calls[1]));
    assert.equal(indexOf(calls[1]), indexOf(calls[2]));
    // brief 那一半照旧每回合重建（作者可能正在另一个窗口改文件）。
    assert.match(systemOf(calls[2]), /# 当前工程/);
  });

  // 技能是方法论，不是状态。中途换掉会让 agent 的判据在一轮之内漂移。
  test('中途新建的技能本轮不认', async () => {
    // 那份新技能要**开到 agent 看得见**，否则它本来就不该进索引——那时这条
    // 断言会因为「缺省是仅用户」而通过，一点都没在测「一轮之内不变」。
    skillModes = { [`builtin:${someBuiltin}`]: 'title', 'project:半路杀出的': 'title' };
    const { provider, calls } = scriptedProvider([
      useTool('c1', 'list', { path: '.novelforge' }),
      say('好了'),
    ]);
    const running = run(provider);
    // 第一个回合已经发出去了，这时候落一个新技能到盘上。
    await new Promise((r) => setTimeout(r, 10));
    t.write('.novelforge/skills/半路杀出的/SKILL.md', '# 半路杀出的');
    await running;
    for (const c of calls) {
      assert.equal(systemOf(c).includes('project:半路杀出的'), false, '索引在一轮之内变了');
    }
  });

  test('下一轮就认了', async () => {
    skillModes = { 'project:半路杀出的': 'title' };
    const { provider, calls } = scriptedProvider([say('好')]);
    await run(provider);
    assert.match(systemOf(calls[0]), /project:半路杀出的/);
  });
});
