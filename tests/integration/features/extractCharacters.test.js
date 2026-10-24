/**
 * 「从正文提取角色卡」把「主角」「反派」建成卡（外部 issue，2026-10-24）。
 *
 * 那一次是三件事叠在一起：卷目录里的 `047 细纲.txt`、`048 作话.txt` 被当成正文读进语料；
 * 模型读到作者视角的文字，返回了「韩厉」与「反派（别名：韩厉、头领）」两条；
 * 同一批的两条各建了一张卡，`反派.md` 与 `韩厉.md` 抢同一个称呼。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { installFakeProvider, makeSettings } = require('../../helpers/fakeProvider');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let fake;
let t;
let project;

const settings = makeSettings();

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    characters: './src/core/features/characters.ts',
    registry: './src/core/llm/registry.ts',
    logger: './src/core/runtime/logger.ts',
    db: './src/core/runtime/db.ts',
  });
  h = makeFakeHost({ supportsVscodeLm: true, settings: () => settings });
  bundle.host.initHost(h.host);
  fake = installFakeProvider(bundle.registry, { repeatLast: true, fallback: '[]' });
  t = await makeTempProject(bundle.project, { prefix: 'extract-labels', title: '剧作称谓' });
  project = t.project;
  t.write('chapters/046-夜袭.txt', `${'韩厉带人摸进镇口，火把一路烧到客栈门前。'.repeat(10)}\n`);
  t.write('chapters/047 细纲.txt', '反派在此处需要透露哪些信息……描述反派的心理压力……\n');
  t.write('chapters/048 作话.txt', '大家放心，主角是……下一章会升级……\n');
  project.invalidate();
});

after(() => {
  cleanup(t.dir, bundle.db);
});

describe('提取角色：笔记不进语料，称谓不建卡', () => {
  let chapters;
  let corpus;
  let files;
  let card;
  let confirms;

  before(async () => {
    chapters = (await project.listChapters()).map((c) => c.relPath);
    // 输入框（章号）→ 确认框（开始提取）。并完只剩一张新卡，不该再问「逐个对比」。
    h.expect('46', '开始提取');
    fake.reset([
      JSON.stringify([
        { name: '韩厉', aliases: [], tags: ['反派'], 身份: '黑风寨寨主' },
        { name: '反派', aliases: ['韩厉', '头领'], tags: ['反派'], 身份: '黑风寨头领', 性格: '多疑' },
      ]),
    ]);
    await bundle.characters.extractCharacters(project);
    corpus = fake.calls[0]?.at(-1)?.content ?? '';
    files = fs.readdirSync(t.rel('.novelforge/characters')).sort();
    card = (await project.listCharacters()).find((c) => c.name === '韩厉');
    confirms = h.confirms.map((c) => c.message);
  });

  test('卷目录里的细纲、作话不算章节', () => {
    assert.deepEqual(chapters, ['chapters/046-夜袭.txt']);
  });

  test('喂给模型的只有正文', () => {
    assert.match(corpus, /韩厉带人摸进镇口/);
    assert.doesNotMatch(corpus, /心理压力|大家放心/);
  });

  test('只建了真名那一张卡', () => {
    assert.deepEqual(files, ['韩厉.md']);
  });

  test('「反派」那一条并进来了：头领进别名、空着的小节补上', () => {
    assert.deepEqual(card.aliases, ['头领']);
    assert.deepEqual(card.tags, ['反派']);
    assert.equal(card.sections.身份, '黑风寨寨主');
    assert.equal(card.sections.性格, '多疑');
  });

  test('没有对一张刚建的卡再问「逐个对比」', () => {
    assert.ok(!confirms.some((m) => m.includes('要逐个对比确认吗')), confirms.join(' | '));
  });
});
