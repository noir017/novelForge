/**
 * 调试转储：开关、落点、内容、补写、随会话进回收站。
 *
 * 守的是三条（见 src/core/runtime/debug.ts 的文件头）：
 *
 * 1. **没开就什么都不做**——一个文件都不能多出来，返回 undefined 让调用点空转。
 * 2. **绝不因转储抛错**——目录写不进去只留一条 warn，调用方照常往下跑。
 * 3. **日志里只有路径，没有 prompt 全文**（第 11 条）。这一条单列一节：它是
 *    这个功能唯一可能踩到既有约束的地方，回归了就是把整本书往日志缓冲里灌。
 *
 * config 与 debug 打进同一个 bundle：`debugEnabled()` 读的是 config 的模块级
 * store，分开 bundle 会让用例设的 settings 落在另一份实例上。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { makeTempProject } = require('../../helpers/tmpProject');

/** 当前这一轮的设置。各 describe 自己改。 */
let settings = {};

let debugMod;
let logger;
let projectMod;
let t;

const SESSION = '20260831-143012-4f2a';

const messages = () => [
  { role: 'system', content: '你是一个写作助手。' },
  { role: 'user', content: '把第 12 章的剧情排出来' },
  {
    role: 'assistant',
    content: '我先看看细纲。',
    toolCalls: [{ id: 'call_1', name: 'read', args: { path: '.novelforge/plots/012.md' }, raw: '{}' }],
  },
  { role: 'tool', toolCallId: 'call_1', name: 'read', content: '# 第 12 章\n夜访。' },
];

before(async () => {
  const bundle = loadBundle({
    host: './src/core/host.ts',
    config: './src/core/config.ts',
    debug: './src/core/runtime/debug.ts',
    logger: './src/core/runtime/logger.ts',
    project: './src/core/model/project.ts',
  });
  debugMod = bundle.debug;
  logger = bundle.logger;
  projectMod = bundle.project;
  bundle.host.initHost(makeFakeHost().host);
  bundle.config.initConfigFromHost({
    config: {
      read: () => settings,
      write: async (s) => {
        settings = s;
      },
    },
  });
  t = await makeTempProject(projectMod, { prefix: 'debug' });
});

after(() => {
  fs.rmSync(t.dir, { recursive: true, force: true });
});

/** 某个会话的调试目录里现在有哪些文件。 */
const dumpedFiles = (sessionId = SESSION) => {
  try {
    return fs.readdirSync(path.join(t.dir, '.novelforge', 'sessions', `${sessionId}.debug`)).sort();
  } catch {
    return [];
  }
};

describe('开关', () => {
  test('没开时 debugEnabled 为假', () => {
    settings = {};
    assert.equal(debugMod.debugEnabled(), false);
  });

  test('只认真正的 true——手改成字符串不算开', () => {
    settings = { debug: 'true' };
    assert.equal(debugMod.debugEnabled(), false);
  });

  test('开了就是真', () => {
    settings = { debug: true };
    assert.equal(debugMod.debugEnabled(), true);
  });

  test('没开时一个文件都不写，返回 undefined', async () => {
    settings = {};
    const at = await debugMod.dumpContext(t.project, {
      sessionId: SESSION,
      slug: 'agent-step1',
      title: 'agent 第 1 步',
      messages: messages(),
    });
    assert.equal(at, undefined);
    assert.deepEqual(dumpedFiles(), []);
  });

  // 工程页的批量任务没有会话：**不造一个落点**，那会在工程里留下没人认领的目录。
  test('开着但没有会话 id 时也不写', async () => {
    settings = { debug: true };
    const at = await debugMod.dumpContext(t.project, {
      slug: 'summary',
      title: '摘要',
      messages: messages(),
    });
    assert.equal(at, undefined);
  });
});

describe('落点与内容', () => {
  let at;

  before(async () => {
    settings = { debug: true };
    logger.clearLogs();
    at = await debugMod.dumpContext(t.project, {
      sessionId: SESSION,
      slug: 'generate-manuscript',
      title: '写正文：第 12 章《夜访》',
      facts: [
        ['模型', 'glm-4-plus @ open.bigmodel.cn'],
        ['目标字数', 3000],
        ['缺席的项', undefined],
      ],
      sections: [{ heading: '装配明细', body: '| 状态 | 条目 |\n| --- | --- |' }],
      messages: messages(),
    });
  });

  test('落在会话文件旁边的 <id>.debug/ 里', () => {
    assert.equal(path.dirname(at), path.join(t.dir, '.novelforge', 'sessions', `${SESSION}.debug`));
  });

  // 文件名以时间打头 = 按文件名排序就是按发生顺序，排查时那一串要一路读下来。
  test('文件名是「时间戳 + slug」', () => {
    assert.match(path.basename(at), /^\d{8}-\d{6}-\d{6}-generate-manuscript\.md$/);
  });

  test('每条消息都在，一条不少', () => {
    const text = fs.readFileSync(at, 'utf8');
    for (const m of messages()) {
      assert.ok(text.includes(m.content), m.content);
    }
  });

  test('工具调用的参数原样留着（「它读的是哪一章」的答案在这里）', () => {
    assert.match(fs.readFileSync(at, 'utf8'), /\.novelforge\/plots\/012\.md/);
  });

  test('事实行照排，值为 undefined 的那一项自动略过', () => {
    const text = fs.readFileSync(at, 'utf8');
    assert.ok(text.includes('- 模型：glm-4-plus @ open.bigmodel.cn'), text.slice(0, 400));
    assert.ok(text.includes('- 目标字数：3000'));
    assert.ok(!text.includes('缺席的项'));
  });

  test('附加段落排在消息之前', () => {
    const text = fs.readFileSync(at, 'utf8');
    assert.ok(text.indexOf('## 装配明细') < text.indexOf('## 发给模型的消息'));
  });

  test('同一毫秒内连开两份也不撞名', async () => {
    const [a, b] = await Promise.all([
      debugMod.dumpContext(t.project, { sessionId: SESSION, slug: 'a', title: 'a', messages: [] }),
      debugMod.dumpContext(t.project, { sessionId: SESSION, slug: 'a', title: 'a', messages: [] }),
    ]);
    assert.notEqual(a, b);
  });
});

// 第 11 条：日志里绝不出现 prompt 全文。调试模式换的是「全文进文件、日志给路径」，
// 这条约束一个字都不松动。
describe('日志里只有路径', () => {
  let entry;

  before(async () => {
    settings = { debug: true };
    logger.clearLogs();
    await debugMod.dumpContext(t.project, {
      sessionId: SESSION,
      slug: 'agent-step1',
      title: 'agent 第 1 步',
      messages: [{ role: 'user', content: '把第 12 章的剧情排出来' }],
    });
    entry = logger.recentLogs().at(-1);
  });

  test('日志里有可复制的绝对路径', () => {
    assert.ok(entry.detail.includes(path.join(t.dir, '.novelforge', 'sessions')), entry.detail);
  });

  test('日志里没有 prompt 正文', () => {
    const whole = `${entry.message}\n${entry.detail}`;
    assert.ok(!whole.includes('把第 12 章的剧情排出来'), whole);
  });
});

describe('补写回答', () => {
  test('接在同一个文件末尾', async () => {
    settings = { debug: true };
    const at = await debugMod.dumpContext(t.project, {
      sessionId: SESSION,
      slug: 'append',
      title: '补写',
      messages: [],
    });
    await debugMod.appendDump(at, '模型的回答', '夜色沉了下来。');
    const text = fs.readFileSync(at, 'utf8');
    assert.ok(text.includes('## 模型的回答'), text);
    assert.ok(text.includes('夜色沉了下来。'), text);
  });

  // 调用点写的是 `appendDump(at, …)`，关着调试时 at 是 undefined——
  // 这一条保证它们不必自己判断开没开。
  test('路径是 undefined 时静默跳过，不抛', async () => {
    await debugMod.appendDump(undefined, '模型的回答', '不该写到任何地方');
  });
});

describe('绝不因转储抛错', () => {
  test('落点写不进去时返回 undefined 并留一条 warn', async () => {
    settings = { debug: true };
    logger.clearLogs();
    // 把调试目录的位置占成一个**文件**：mkdir 必然失败。
    const blocked = 'blocked-session';
    fs.writeFileSync(path.join(t.dir, '.novelforge', 'sessions', `${blocked}.debug`), 'x', 'utf8');
    const at = await debugMod.dumpContext(t.project, {
      sessionId: blocked,
      slug: 'x',
      title: 'x',
      messages: [],
    });
    assert.equal(at, undefined);
    assert.ok(logger.recentLogs().some((e) => e.level === 'warn'), '应当留下一条 warn');
  });
});

// 第 6 条：不真删。会话搬进 .trash/ 时，它那一堆上下文快照（里面是这本书的正文）
// 不能留在 sessions/ 下当孤儿。
describe('随会话进回收站', () => {
  const doomed = 'doomed-session';

  before(async () => {
    settings = { debug: true };
    await debugMod.dumpContext(t.project, {
      sessionId: doomed,
      slug: 'x',
      title: 'x',
      messages: [],
    });
  });

  test('搬之前在 sessions/ 下', () => {
    assert.equal(dumpedFiles(doomed).length, 1);
  });

  test('搬完 sessions/ 下没了', async () => {
    await debugMod.trashDebugDir(t.project, doomed);
    assert.deepEqual(dumpedFiles(doomed), []);
  });

  test('东西在 .trash/ 里，找得回来', () => {
    assert.equal(fs.readdirSync(path.join(t.dir, '.novelforge', '.trash', `${doomed}.debug`)).length, 1);
  });

  test('没有调试目录时静默返回', async () => {
    await debugMod.trashDebugDir(t.project, 'never-existed');
  });
});
