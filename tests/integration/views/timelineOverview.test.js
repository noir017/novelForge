/**
 * 编辑区「时间线总览」的数据（`views/threads.ts` 的 `buildTimelineOverview`，2026-10-24），真临时工程：读时间线与叙事线、章节与细纲
 * 两份列表，交给纯函数 `buildTimelineMatrix`（那一半的细节在 tests/unit/views/timeline.test.js）。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 卡片 | 章名（细纲优先）、正文 / 细纲路径（细纲按路径配对）、细纲的梗概与时间地点、这一章在线上的实际事件 |
 * | 补推 | 「同步过」与工程页同一个口径（细纲有 `sourceHash`、正文还在）：写了没同步的章不算还没推 |
 * | 还不是小说工程 | `initialized: false`，其余都是空的 |
 * | 不写盘 | 读完之后工程目录一个字节没变 |
 * | controller | `requestTimelineOverview` 回 `timelineOverview`，带同一个 `requestId` |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let t;
let project;

const plot = (no, title, { hash = '', synopsis = '梗概', timePlace = '' } = {}) =>
  `---\nno: ${no}\ntitle: ${title}\n${hash ? `sourceHash: ${hash}\n` : ''}---\n\n# ${title}\n\n## 梗概\n${synopsis}\n\n## 时间地点\n${timePlace}\n\n## 关键事件\n事件\n`;

/** 工程目录下全部文件的「路径 → 内容」（看读完之后有没有写盘）。 */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
      } else if (!/\.(db|sqlite)(-\w+)?$/.test(ent.name)) {
        out[path.relative(dir, abs)] = fs.readFileSync(abs, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    threads: './src/core/views/threads.ts',
    controller: './src/core/controller/index.ts',
    db: './src/core/runtime/db.ts',
  });
  bundle.host.initHost(makeFakeHost({ settings: () => ({}) }).host);
  t = await makeTempProject(bundle.project, { prefix: 'timeline-overview', title: '青云剑录' });
  project = t.project;

  // 第 1、2 章同步过（第 2 章在第一卷里，细纲的标题优先）；第 3 章同步过、时间线里还没有；第 4 章写了没同步。
  t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。');
  t.write('.novelforge/summaries/001-楔子.md', plot(1, '楔子', { hash: 'abc', synopsis: '林昭在雨夜进了青崖镇。', timePlace: '傍晚，青崖镇' }));
  t.write('chapters/第一卷/002-入镇.md', '# 入镇\n\n次日他走进镇子。');
  t.write('.novelforge/summaries/第一卷/002-入镇.md', plot(2, '入镇（改）', { hash: 'def' }));
  t.write('chapters/第一卷/003-夜访.md', '# 夜访\n\n夜里有人敲门。');
  t.write('.novelforge/summaries/第一卷/003-夜访.md', plot(3, '夜访', { hash: 'ghi' }));
  t.write('chapters/第一卷/004-北行.txt', '他往北走。');

  t.write('.novelforge/threads/青崖旧案.md', '---\nkind: 主线\n---\n\n# 青崖旧案\n\n## 进展\n- 第 2 章 · 推进：找到令牌 〔证据：「令牌」〕\n- 第 3 章 · 计划 · 推进：夜探\n');
  t.write(
    '.novelforge/threads/时间线.md',
    ['---', 'calendar: 简单历', 'start: 大衍三年三月初七', '---', '', '# 时间线', '', '- 第 1 章：+0 天，傍晚〔依据：「雨下了三天」〕', '- 第 2 章：+1 天〔依据：「次日」〕', ''].join('\n')
  );
  project.invalidate();
});

after(() => {
  if (t) cleanup(t.dir, bundle.db);
});

describe('views/threads › buildTimelineOverview', () => {
  test('卡片：章名、正文与细纲路径、梗概（没有事件时）与时间地点、实际事件；轴按日子', async () => {
    const o = await bundle.threads.buildTimelineOverview(project);
    assert.equal(o.initialized, true);
    assert.equal(o.exists, true);
    assert.equal(o.relPath, '.novelforge/threads/时间线.md');
    assert.deepEqual(o.days.map((d) => [d.day, d.label, d.month, d.cards.map((c) => c.no)]), [
      [1, '三月初七', '大衍三年三月', [1]],
      [2, '三月初八', '大衍三年三月', [2]],
    ]);
    const [c1, c2] = o.days.map((d) => d.cards[0]);
    assert.deepEqual([c1.title, c1.chapterPath, c1.plotPath, c1.synopsis], ['楔子', 'chapters/001-楔子.md', '.novelforge/summaries/001-楔子.md', '林昭在雨夜进了青崖镇。']);
    assert.ok(c1.detail.includes('细纲写的时间地点：傍晚，青崖镇'), c1.detail.join('\n'));
    assert.equal(c2.title, '入镇（改）');
    assert.equal(c2.plotPath, '.novelforge/summaries/第一卷/002-入镇.md');
    assert.deepEqual(c2.events, [{ thread: '青崖旧案', color: 0, type: '推进', what: '找到令牌', evidence: '令牌' }]);
    assert.equal(c2.synopsis, undefined);
    assert.deepEqual(o.threads, [{ name: '青崖旧案', color: 0 }]);
  });

  test('补推：同步过的才算（第 3 章），写了没同步的（第 4 章）不算', async () => {
    const o = await bundle.threads.buildTimelineOverview(project);
    assert.deepEqual(o.missing, { count: 1, text: '第 3 章还没推出来' });
    assert.equal(o.meta, '简单历 · 起点 大衍三年三月初七 · 推到第 2 章 · 故事第 2 天（大衍三年三月初八）');
  });

  test('不写盘：读完之后工程目录一个字节没变', async () => {
    const before = snapshot(t.dir);
    await bundle.threads.buildTimelineOverview(project);
    assert.deepEqual(snapshot(t.dir), before);
  });

  test('还不是小说工程：initialized 为 false，其余都是空的', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelforge-timeline-overview-bare-'));
    try {
      const o = await bundle.threads.buildTimelineOverview(bundle.project.NovelProject.open(dir));
      assert.deepEqual([o.initialized, o.exists, o.days, o.issues, o.threads], [false, false, [], [], []]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('controller › requestTimelineOverview', () => {
  test('回 timelineOverview，带同一个 requestId', async () => {
    const posted = [];
    const controller = new bundle.controller.ChatController(project);
    controller.attach({ kind: 'sidebar', post: (m) => posted.push(m), reveal() {} });
    try {
      await controller.handle({ type: 'requestTimelineOverview', requestId: 'tlo-1' });
      const reply = posted.find((m) => m.type === 'timelineOverview');
      assert.ok(reply, JSON.stringify(posted.map((m) => m.type)));
      assert.equal(reply.requestId, 'tlo-1');
      assert.equal(reply.overview.initialized, true);
      assert.equal(reply.overview.days.length, 2);
    } finally {
      controller.dispose();
    }
  });
});
