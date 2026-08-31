/**
 * 调试模式在**会话文件**这一侧留下了什么。
 *
 * 两件事，一件都不能少：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 关着 | 会话里**一个 debug 字段都没有**；工具返回按界面档（2000 字）截 |
 * | 开着 | 多一块 `debug`：哪个模型、想多深、什么策略、上下文快照在哪几个文件里 |
 * | 开着 | 工具返回按调试档留（那段被截掉的正文才是排查要看的东西） |
 * | 开着 | 快照路径存的是**工程内相对路径**——会话跟着工程走，绝对路径换台机器就废了 |
 *
 * 走真的 `ChatController.dispatch`，因为这条路的活全在「跑完之后往会话里写
 * 什么」上；打桩就等于把要测的东西替换掉了。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;
let controller;
let settings;

/** 一章很长的正文：`read` 回给模型的那一段远超界面档的 2000 字。 */
const LONG = '夜色沉了下来。'.repeat(1200);

/**
 * 两回合的假 agent 模型：先读那一章，再说一句收尾。
 *
 * 只关心它**跑完之后会话里留下什么**，所以回答本身随便。
 */
function installProvider() {
  let round = 0;
  bundle.registry.registerProviderFactory(() => ({
    id: 'vscode-lm',
    label: '假模型',
    maxInputTokens: async () => undefined,
    stream: async function* () {
      if (round++ === 0) {
        yield {
          type: 'toolCall',
          call: {
            id: 'c1',
            name: 'read',
            args: { path: 'chapters/009-北行.md' },
            raw: '{"path":"chapters/009-北行.md"}',
          },
        };
        return;
      }
      yield { type: 'text', text: '读完了。' };
    },
  }));
  return { reset: () => { round = 0; } };
}

let provider;

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    registry: './src/core/llm/registry.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  settings = {
    providers: [{ id: 'p', kind: 'vscode-lm', models: [{ name: 'm', contextWindow: 200000 }] }],
    models: ['p/m'],
    concurrency: 1,
    // 放手档：这一组不测闸门，别让它停下来等人答话。
    agentPolicy: 'bold',
  };
  bundle.host.initHost(makeFakeHost({ name: 'standalone', supportsVscodeLm: true, settings: () => settings }).host);
  provider = installProvider();

  t = await makeTempProject(bundle.project, { prefix: 'debugsession', title: '青云志' });
  project = t.project;
  t.write('chapters/009-北行.md', `# 北行\n\n${LONG}\n`);
  project.invalidate();

  controller = new bundle.controller.ChatController(project);
  controller.attach({ kind: 'sidebar', post: () => {}, reveal: () => {} });
});

after(() => {
  controller?.dispose();
  if (t) cleanup(t.dir, bundle?.db);
});

/** 跑一轮，返回落盘之后的那条 assistant 轮。 */
async function runTurn(text) {
  provider.reset();
  await controller.dispatch({ type: 'newSession' });
  await controller.dispatch({ type: 'sendAgent', text });
  const saved = JSON.parse(
    fs.readFileSync(path.join(t.dir, '.novelforge', 'sessions', `${controller.current.id}.json`), 'utf8')
  );
  return {
    id: controller.current.id,
    turn: [...saved.turns].reverse().find((x) => x.role === 'assistant'),
  };
}

/** 那一轮里 `read` 那条工具段。 */
const readCall = (turn) =>
  (turn.segments ?? []).find((s) => s.kind === 'tool' && s.call.name === 'read')?.call;

describe('关着（缺省）', () => {
  let turn;

  before(async () => {
    settings.debug = false;
    ({ turn } = await runTurn('看看第 9 章'));
  });

  test('会话里没有 debug 字段', () => {
    assert.equal(turn.debug, undefined, JSON.stringify(turn.debug));
  });

  test('工具返回按界面档截断', () => {
    const call = readCall(turn);
    assert.ok(call, JSON.stringify(turn.segments?.map((s) => s.kind)));
    assert.ok(call.resultText.length < 2200, String(call.resultText.length));
  });

  // 第 2 条：截了要自报，不然作者会把半截当全部。
  test('截了会说一声', () => {
    assert.match(readCall(turn).resultText, /已截断/);
  });
});

describe('开着', () => {
  let id;
  let turn;

  before(async () => {
    settings.debug = true;
    ({ id, turn } = await runTurn('再看看第 9 章'));
  });

  after(() => {
    settings.debug = false;
  });

  test('多出一块 debug', () => {
    assert.ok(turn.debug, JSON.stringify(Object.keys(turn)));
  });

  test('记下了哪个模型', () => {
    assert.equal(turn.debug.model, 'p/m', turn.debug.model);
  });

  test('记下了想多深与当时的策略', () => {
    assert.equal(turn.debug.thinking, 'off', turn.debug.thinking);
    assert.equal(turn.debug.policy, 'bold', turn.debug.policy);
  });

  test('记下了起止与耗时', () => {
    assert.ok(!Number.isNaN(Date.parse(turn.debug.startedAt)), turn.debug.startedAt);
    assert.ok(!Number.isNaN(Date.parse(turn.debug.endedAt)), turn.debug.endedAt);
    assert.ok(turn.debug.elapsedMs >= 0, String(turn.debug.elapsedMs));
  });

  test('每回合的上下文快照都记了一条', () => {
    assert.equal(turn.debug.contexts.length, turn.agentRun.steps, JSON.stringify(turn.debug.contexts));
  });

  // 会话文件跟着工程走（可提交、可换机器），一串 /home/… 换台机器就全指不到了。
  test('快照路径是工程内相对路径', () => {
    for (const rel of turn.debug.contexts) {
      assert.ok(!path.isAbsolute(rel), rel);
      assert.ok(rel.startsWith(`.novelforge/sessions/${id}.debug/`), rel);
    }
  });

  test('顺着那个相对路径真的找得到文件', () => {
    for (const rel of turn.debug.contexts) {
      assert.ok(fs.existsSync(path.join(t.dir, rel)), rel);
    }
  });

  // 被截掉的那一段才是排查要看的东西。
  test('工具返回按调试档留，远超界面档', () => {
    assert.ok(readCall(turn).resultText.length > 5000, String(readCall(turn).resultText.length));
  });
});
