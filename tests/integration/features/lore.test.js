/**
 * 自动生成设定：逐段识别、跨段合并、分类落盘与已有条目审阅。
 * 迁自 scripts/smoke-lore.js（11 条断言）。
 *
 * 与原脚本的一处**有意偏差**：原脚本从不删自己的临时目录，每跑一次泄漏一个
 * `novelforge-lore-*`。这里在 after() 里 cleanup()——那是夹具缺陷，不是断言。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let loreMod;
let h;
let fake;
let t;
let project;
let settings;

/**
 * 原脚本每轮只重赋 `answers`，**不清** `reviews` / `calls`——
 * 「审阅 ≥ 2 条」与「长段新增了几次调用」都是跨轮累计的。
 * 所以这里不能用 h.expect()（它会清掉录制器），只清答案队列。
 */
function queueAnswer(...values) {
  h.answers.length = 0;
  h.answers.push(...values);
}

/** 造一段剧情 + 它的正文。设定扫描按段遍历 `plots/`，读 `manuscripts/`。 */
function makePlot(no, title, text) {
  const stem = `${String(no).padStart(3, '0')}-${title}`;
  t.write(`.novelforge/plots/${stem}.md`, '## 目标\n\n略。\n\n## 剧情脉络\n\n甲乙丙。\n');
  t.write(`.novelforge/manuscripts/${stem}.md`, `# 第${no}段 ${title} · 正文\n\n${text}\n`);
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    lore: './src/core/features/lore.ts',
    registry: './src/core/llm/registry.ts',
  });
  loreMod = bundle.lore;

  settings = makeSettings();
  h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, {
    fallback: '[]',
    replies: [
      JSON.stringify([{ title: '青崖镇', category: '地理', keywords: ['青崖'], facts: ['青崖镇建在断崖下，镇外是盐道。'] }]),
      JSON.stringify([{ title: '青崖镇', category: '地理', keywords: ['盐道'], facts: ['镇上有一条通往北境的盐道。'] }]),
      JSON.stringify([{ title: '玄门七宗', category: '势力', keywords: ['七宗'], facts: ['玄门由七个宗门组成。'] }]),
      JSON.stringify({ keywords: ['青崖', '盐道'], body: '## 地理\n\n青崖镇建在断崖下，镇外有通往北境的盐道。' }),
      JSON.stringify({ keywords: ['七宗'], body: '## 结构\n\n玄门由七个宗门组成。' }),
    ],
  });

  // 原脚本只删了示例设定，示例角色留着。
  t = await makeTempProject(bundle.project, {
    prefix: 'lore',
    title: '设定测试',
    keepExamples: true,
  });
  project = t.project;
  t.remove('.novelforge/lore/example-setting.md');
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('逐段识别与跨段合并', () => {
  let lore;
  let firstConfirm;
  let callCount;

  before(async () => {
    // 设定扫描读的是 `manuscripts/` 里的正文，按 `plots/` 逐段遍历——
    // `chapters/` 已经退出流水线，这条链上一个字都不读它。
    makePlot(1, '镇', '青崖镇在断崖下。');
    makePlot(2, '盐道', '盐道通往北境。');
    makePlot(3, '宗门', '玄门有七宗。');
    project.invalidate();

    queueAnswer('开始生成');
    await loreMod.generateLore(project);
    lore = await project.listLore();
    firstConfirm = h.confirms[0];
    callCount = fake.calls.length;
  });

  test('确认框说明逐段调用与后续调用', () => {
    assert.ok(
      firstConfirm.message.includes('固定调用模型 3 次') &&
        firstConfirm.message.includes('每发现一条设定再调用 1 次'),
      firstConfirm.message
    );
  });

  // 名字说「每段各调用一次」而断言是 5：3 次逐段识别 + 2 次成文。
  // 原样迁移，不改断言。
  test('每段各调用一次识别', () => {
    assert.equal(callCount, 5, `实际 ${callCount} 次`);
  });

  test('同一设定跨段合并为一条', () => {
    assert.equal(lore.filter((x) => x.title === '青崖镇').length, 1);
  });

  test('合并结果保留跨段事实', () => {
    assert.ok(lore.find((x) => x.title === '青崖镇')?.body.includes('盐道'));
  });

  test('新设定按分类目录落盘', () => {
    assert.ok(lore.some((x) => x.relPath.includes('地理') && x.title === '青崖镇'));
  });

  test('新设定按分类目录落盘势力', () => {
    assert.ok(lore.some((x) => x.relPath.includes('势力') && x.title === '玄门七宗'));
  });
});

describe('已有设定必须审阅', () => {
  let reviewCount;
  let lore;

  before(async () => {
    queueAnswer('开始生成');
    fake.push(
      JSON.stringify([{ title: '青崖镇', category: '地理', keywords: ['青崖'], facts: ['青崖镇建在断崖下，镇外是盐道。'] }]),
      JSON.stringify([{ title: '青崖镇', category: '地理', keywords: ['盐道'], facts: ['镇上有一条通往北境的盐道。'] }]),
      JSON.stringify([{ title: '玄门七宗', category: '势力', keywords: ['七宗'], facts: ['玄门由七个宗门组成。'] }]),
      JSON.stringify({ keywords: ['青崖'], body: '## 地理\n\n新版设定。' }),
      JSON.stringify({ keywords: ['七宗'], body: '## 结构\n\n新版结构。' })
    );
    await loreMod.generateLore(project);
    // h.reviewed 从第一轮起就在累计，与原脚本的 `reviews` 一致。
    reviewCount = h.reviewed.length;
    lore = await project.listLore();
  });

  test('已有条目走审阅回调', () => {
    assert.ok(reviewCount >= 2, `审阅 ${reviewCount} 条`);
  });

  test('审阅采纳后写入', () => {
    assert.ok(lore.some((x) => x.body.includes('新版设定')));
  });
});

describe('审阅放弃不覆盖', () => {
  let beforeDiscard;
  let afterDiscard;

  before(async () => {
    const currentLore = await project.listLore();
    const townPath = currentLore.find((x) => x.title === '青崖镇').relPath;
    beforeDiscard = t.read(townPath);
    h.setReviewVerdict('discard');
    queueAnswer('开始生成');
    fake.push(
      JSON.stringify([{ title: '青崖镇', category: '地理', keywords: ['青崖'], facts: ['候选修改。'] }]),
      '[]',
      '[]',
      JSON.stringify({ keywords: ['青崖'], body: '## 地理\n\n不应写入的版本。' })
    );
    await loreMod.generateLore(project);
    afterDiscard = t.read(townPath);
    h.setReviewVerdict('apply');
  });

  test('放弃审阅后原文件一字不改', () => {
    assert.equal(afterDiscard, beforeDiscard);
  });
});

describe('长段完整分片', () => {
  const marker = '长段末尾唯一标记';
  let longRunCalls;

  before(async () => {
    settings.contextWindow = 4000;
    makePlot(4, '长段', `${'这是一段需要完整扫描的正文。'.repeat(1200)}${marker}`);
    project.invalidate();
    queueAnswer('开始生成');
    fake.push(...Array(40).fill('[]'));
    const callsBefore = fake.calls.length;
    await loreMod.generateLore(project);
    longRunCalls = fake.calls.slice(callsBefore);
  });

  test('长段会拆成额外调用而非截断', () => {
    assert.ok(longRunCalls.length > 4, `扫描 ${longRunCalls.length} 个片段`);
  });

  test('最后一段正文也送进模型', () => {
    assert.ok(longRunCalls.some((messages) => messages.some((m) => m.content.includes(marker))));
  });
});
