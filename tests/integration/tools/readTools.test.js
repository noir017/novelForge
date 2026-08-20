/**
 * 只读三件套：`list` / `read` / `search`。
 *
 * 三个都是 `Workspace` 的薄包装，所以这里验的**不是**底层行为（那有
 * `tests/integration/workspace/` 守着），而是这一层自己的活：
 *
 * 1. **压成模型读得动的形状**——带行号、带路径、带字数；
 * 2. **截断必须说出来**（AGENTS 第 2 条）：list 的「还有 N 项」、read 的
 *    「第 X–Y 行未读」、search 的 ⚠；
 * 3. **出错给 `error` 而不是抛**——模型看得到 error 就能换条路，抛出去会把
 *    整轮循环炸掉，而它本来只是猜错了一个文件名；
 * 4. **一个字都不写盘**：三期的 agent 没有写权限。
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
let ctx;

/** 跑一个工具，返回 ToolResult。 */
const run = (tool, args = {}) => tool.run(ctx, args);

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    ws: './src/core/workspace/index.ts',
    tools: './src/core/tools/novel/index.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'agenttools' });
  project = t.project;

  // 三章正文，只有第 9 章提到「北境」。刻意乱序建，用来验排序不是文件系统顺序。
  t.write('chapters/012-入宗.md', '# 入宗\n\n他站在山门外。\n墙很高。\n');
  t.write('chapters/009-北行.md', '# 北行\n\n「我从没去过北境。」他说。\n那年他十七。\n');
  t.write('chapters/003-楔子.md', '# 楔子\n\n雨下了三天。\n北境的雪他见过三回。\n');
  t.write(
    '.novelforge/plots/012-入宗.md',
    '## 目标\n\n翻墙进宗门\n\n## 剧情脉络\n\n山门外等到天黑\n\n## 冲突与转折\n\n三拍\n\n## 伏笔与回收\n\n令牌\n'
  );
  // 100 行的长文件，用来逼出 read 的行数截断。
  t.write('chapters/020-长章.md', Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
  // 80 个角色卡：逼出 list 的 60 项上限。
  for (let i = 1; i <= 80; i++) {
    t.write(`.novelforge/characters/角色${String(i).padStart(2, '0')}.md`, `# 角色${i}\n`);
  }
  project.invalidate();

  ctx = {
    project,
    workspace: new bundle.ws.Workspace(project),
    drafts: { put() {} },
    sessionId: 's1',
    signal: new AbortController().signal,
    usage: { calls: 0, record(n) { this.calls += n; } },
    report() {},
  };
});

after(() => {
  if (t) cleanup(t.dir);
});

const toolOf = (name) => bundle.tools.NOVEL_TOOLS.find((x) => x.name === name);

describe('list', () => {
  test('列得出章节目录里的文件', async () => {
    const r = await run(toolOf('list'), { path: 'chapters' });
    assert.ok(r.text.includes('009-北行.md'), r.text);
  });

  test('文件带字数', async () => {
    const r = await run(toolOf('list'), { path: 'chapters' });
    assert.ok(/009-北行\.md\s+\d+ 字/.test(r.text), r.text);
  });

  test('目录带斜杠后缀，与文件分得开', async () => {
    const r = await run(toolOf('list'), { path: '.novelforge' });
    assert.ok(r.text.includes('plots/'), r.text);
  });

  test('留空 path 列工程根', async () => {
    const r = await run(toolOf('list'), {});
    assert.ok(r.text.includes('chapters/'), r.text);
  });

  // 不静默截断。
  test('超 60 项时说明「还有 N 项未列出」', async () => {
    const r = await run(toolOf('list'), { path: '.novelforge/characters' });
    assert.ok(/还有 \d+ 项未列出/.test(r.text), r.text.slice(-200));
  });

  test('截断时只列 60 项', async () => {
    const r = await run(toolOf('list'), { path: '.novelforge/characters' });
    const shown = r.text.split('\n').filter((l) => l.includes('.md')).length;
    assert.equal(shown, 60, String(shown));
  });

  test('总数写在开头', async () => {
    const r = await run(toolOf('list'), { path: '.novelforge/characters' });
    assert.ok(r.text.startsWith('.novelforge/characters（80 项）'), r.text.slice(0, 60));
  });

  // 越界不抛：这条路上的输入来自模型，它会猜路径。
  test('越界路径给空结果而不是抛', async () => {
    const r = await run(toolOf('list'), { path: '../../etc' });
    assert.ok(r.text.includes('空目录') || r.text.includes('0 项'), r.text);
  });

  test('不存在的目录给一句人话', async () => {
    const r = await run(toolOf('list'), { path: 'chapters/根本没有这个目录' });
    assert.ok(r.text.includes('不存在') || r.text.includes('空目录'), r.text);
  });
});

describe('read', () => {
  test('内容带行号', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/009-北行.md' });
    assert.ok(r.text.includes('1\t# 北行'), JSON.stringify(r.text.slice(0, 80)));
  });

  test('开头是路径', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/009-北行.md' });
    assert.ok(r.text.startsWith('chapters/009-北行.md\n'), r.text.slice(0, 40));
  });

  test('短文件不加截断说明', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/009-北行.md' });
    assert.ok(!r.text.includes('未读'), r.text);
  });

  test('offset 从指定行开始，行号跟着对', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/020-长章.md', offset: 50, limit: 3 });
    assert.ok(r.text.includes('50\t第 50 行'), r.text);
    assert.ok(!r.text.includes('49\t'), r.text);
  });

  // 不静默截断：模型不知道自己只看了一半，会拿半份正文下结论。
  test('超行数上限时说明「第 X–Y 行未读」', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/020-长章.md', limit: 10 });
    assert.ok(/第 11–100 行未读，共 100 行/.test(r.text), r.text.slice(-120));
  });

  test('截断说明里给出接着读的 offset', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/020-长章.md', limit: 10 });
    assert.ok(r.text.includes('offset=11'), r.text.slice(-120));
  });

  // 抛出去会把整轮循环炸掉，而它本来只是猜错了一个文件名。
  test('不存在的文件给 error，不抛', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/根本没有.md' });
    assert.ok(r.error, JSON.stringify(r));
  });

  test('error 说清楚了，模型能据此换路', async () => {
    const r = await run(toolOf('read'), { path: 'chapters/根本没有.md' });
    assert.ok(r.error.includes('不存在'), r.error);
    assert.ok(r.error.includes('list') || r.error.includes('search'), r.error);
  });

  test('越界路径给 error，不抛', async () => {
    const r = await run(toolOf('read'), { path: '../../../etc/passwd' });
    assert.ok(r.error && r.error.includes('超出工程目录'), JSON.stringify(r));
  });

  test('path 空着给 error', async () => {
    const r = await run(toolOf('read'), {});
    assert.ok(r.error && r.error.includes('必填'), JSON.stringify(r));
  });

  test('目录不是文件，给 error', async () => {
    const r = await run(toolOf('read'), { path: 'chapters' });
    assert.ok(r.error, JSON.stringify(r));
  });
});

describe('search', () => {
  test('命中带路径与行号', async () => {
    const r = await run(toolOf('search'), { pattern: '北境' });
    assert.ok(/chapters\/003-楔子\.md:\d+/.test(r.text), r.text);
  });

  test('命中带整行原文', async () => {
    const r = await run(toolOf('search'), { pattern: '从没去过北境' });
    assert.ok(r.text.includes('「我从没去过北境。」他说。'), r.text);
  });

  // 作者问的是「他**前面**说过吗」，时间线顺序才有意义。
  test('跨章命中按章号升序', async () => {
    const r = await run(toolOf('search'), { pattern: '北境' });
    const order = r.text
      .split('\n')
      .map((l) => /chapters\/(\d+)-/.exec(l))
      .filter(Boolean)
      .map((m) => Number(m[1]));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), JSON.stringify(order));
  });

  test('报出扫了几个文件', async () => {
    const r = await run(toolOf('search'), { pattern: '北境' });
    assert.ok(/扫了 \d+ 个文件/.test(r.text), r.text);
  });

  test('kinds 限定生效', async () => {
    const r = await run(toolOf('search'), { pattern: '山门', kinds: ['plot'] });
    assert.ok(!r.text.includes('chapters/'), r.text);
    assert.ok(r.text.includes('.novelforge/plots/'), r.text);
  });

  test('认不出的 kinds 当没限定，不是搜出空结果', async () => {
    const r = await run(toolOf('search'), { pattern: '北境', kinds: ['写错的种类名'] });
    assert.ok(r.text.includes('chapters/009-北行.md'), r.text);
  });

  test('path 限定生效', async () => {
    const r = await run(toolOf('search'), { pattern: '山门', path: '.novelforge/plots' });
    assert.ok(!r.text.includes('chapters/'), r.text);
  });

  // 模型看到「命中 2 处」会当成「全书只有 2 处」，然后据此断言主角从没提过北境。
  test('有丢弃时返回文本里有 ⚠', async () => {
    const r = await run(toolOf('search'), { pattern: '行', limit: 1 });
    assert.ok(r.text.includes('⚠'), r.text);
  });

  test('⚠ 那句说清了丢了几条', async () => {
    const r = await run(toolOf('search'), { pattern: '行', limit: 1 });
    assert.ok(/丢弃 \d+ 条/.test(r.text), r.text);
  });

  test('搜不到时明说没命中', async () => {
    const r = await run(toolOf('search'), { pattern: '压根不存在的一串字' });
    assert.ok(r.text.includes('没有命中'), r.text);
  });

  test('pattern 空着给 error', async () => {
    const r = await run(toolOf('search'), { pattern: '  ' });
    assert.ok(r.error && r.error.includes('必填'), JSON.stringify(r));
  });

  test('坏正则降级成字面量并说明', async () => {
    const r = await run(toolOf('search'), { pattern: '北境(', regex: true });
    assert.ok(r.text.includes('⚠'), r.text);
  });
});

describe('三个工具都不写盘', () => {
  let baseline;

  const snapshot = (dir) => {
    const out = {};
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      const p = path.join(entry.parentPath ?? entry.path, entry.name);
      if (entry.isFile()) {
        out[path.relative(dir, p)] = fs.statSync(p).mtimeMs;
      }
    }
    return out;
  };

  before(async () => {
    baseline = snapshot(t.dir);
    await run(toolOf('list'), { path: 'chapters' });
    await run(toolOf('read'), { path: 'chapters/009-北行.md' });
    await run(toolOf('search'), { pattern: '北境' });
  });

  test('磁盘上一个文件都没变', () => {
    assert.deepEqual(snapshot(t.dir), baseline);
  });
});
