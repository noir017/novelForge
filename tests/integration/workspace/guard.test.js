/**
 * 统一入口守卫的八条。**一条都不能少**——少一条就是给 agent 开了一个后门。
 *
 * | # | 守卫 | 从前在哪 |
 * |---|---|---|
 * | 1 | 路径规范化（绝对路径 / `..` / 空串） | fileOps.normalizeRel |
 * | 2 | 工程根包含检查 | fileEditing.resolveInRoot |
 * | 3 | 固定目录保护 | fileOps.isProtectedPath |
 * | 4 | `.trash/` 内容不可操作 | projectFiles |
 * | 5 | 读取大小上限 2MB | fileEditing.MAX_EDITABLE_BYTES |
 * | 6 | 同名不覆盖（mode: 'create'） | fileOps / projectFiles 各一份 |
 * | 7 | 覆盖前审阅 | creation.confirmOverwrite |
 * | 8 | 内容 hash 乐观锁 | fileEditing.saveFromEditor |
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadBundle } = require('../../helpers/load');
const { makeTempProject } = require('../../helpers/tmpProject');
const { makeFakeHost } = require('../../helpers/fakeHost');
const { cleanup } = require('../../helpers/teardown');

let bundle;
let h;
let t;
let project;
let G;

/** 跑一段一定会抛 WsError 的代码，把错误交回来断言 code。 */
async function codeOf(fn) {
  try {
    await fn();
  } catch (err) {
    return err?.code ?? `（不是 WsError：${err?.message}）`;
  }
  return '（没抛）';
}

before(async () => {
  bundle = loadBundle({
    host: './src/core/host.ts',
    project: './src/core/model/project.ts',
    fs: './src/core/model/fs.ts',
    guard: './src/core/workspace/guard.ts',
  });
  h = makeFakeHost({ settings: () => ({}), overrides: { reviewReplace: undefined } });
  bundle.host.initHost(h.host);
  t = await makeTempProject(bundle.project, { prefix: 'wsguard' });
  project = t.project;
  G = bundle.guard;

  t.write('chapters/001-楔子.md', '# 楔子\n\n雨下了三天。\n');
  t.write('.novelforge/.trash/chapters/009-删过的.md', '删过的东西');
});

after(() => {
  if (t) cleanup(t.dir);
});

describe('守卫 1 · 路径规范化', () => {
  const bad = ['../etc/passwd', '/abs/path', 'C:\\Windows', '', '  ', '..'];

  for (const input of bad) {
    test(`读 ${JSON.stringify(input)} 报越界`, async () => {
      assert.equal(await codeOf(() => G.guardRead(project, input)), 'outOfRoot');
    });

    test(`写 ${JSON.stringify(input)} 报越界`, async () => {
      assert.equal(
        await codeOf(() => G.guardWrite(project, input, { mode: 'overwrite' })),
        'outOfRoot'
      );
    });
  }

  test('越界的错是 WsError', async () => {
    try {
      await G.guardRead(project, '../x');
      assert.fail('该抛');
    } catch (err) {
      assert.equal(err instanceof G.WsError, true, err?.constructor?.name);
    }
  });
});

describe('守卫 2 · 工程根包含检查', () => {
  // normalizeRel 已经拦掉了 `..`，但 `a/../../b` 这种归一化之后仍会逃出去的
  // 要靠第二道：解析出绝对路径再比一次。
  test('归一化之后仍逃出工程根的路径被拒', async () => {
    assert.equal(await codeOf(() => G.guardRead(project, 'a/../../b')), 'outOfRoot');
  });

  test('工程根自己不是可读对象', async () => {
    assert.equal(await codeOf(() => G.guardRead(project, '.')), 'outOfRoot');
  });

  test('正常路径解析成绝对路径', async () => {
    const abs = await G.guardRead(project, 'chapters/001-楔子.md');
    assert.equal(abs, t.rel('chapters/001-楔子.md'));
  });
});

describe('守卫 3 · 固定目录保护', () => {
  const fixed = [
    'chapters',
    'drafts',
    '.novelforge',
    '.novelforge/plots',
    '.novelforge/scenes',
    '.novelforge/manuscripts',
    '.novelforge/summaries',
    '.novelforge/characters',
    '.novelforge/lore',
    '.novelforge/sessions',
    '.novelforge/.trash',
  ];

  for (const rel of fixed) {
    test(`${rel} 不能改名/删除`, async () => {
      assert.equal(await codeOf(() => G.guardMutate(project, rel)), 'protected');
    });
  }

  // 固定目录只保护它自己，里面的东西照常能操作。
  test('固定目录里的文件能操作', async () => {
    const abs = await G.guardMutate(project, 'chapters/001-楔子.md');
    assert.equal(abs, t.rel('chapters/001-楔子.md'));
  });
});

describe('守卫 4 · 回收站里的内容不可操作', () => {
  test('.trash 里的文件改不动', async () => {
    assert.equal(
      await codeOf(() => G.guardMutate(project, '.novelforge/.trash/chapters/009-删过的.md')),
      'inTrash'
    );
  });

  test('.trash 里的文件写不进去', async () => {
    assert.equal(
      await codeOf(() =>
        G.guardWrite(project, '.novelforge/.trash/新的.md', { mode: 'overwrite' })
      ),
      'inTrash'
    );
  });

  // 但**读**得到：作者要能翻回收站找回东西。
  test('.trash 里的文件读得到', async () => {
    const abs = await G.guardRead(project, '.novelforge/.trash/chapters/009-删过的.md');
    assert.ok(abs.includes('.trash'));
  });
});

describe('守卫 5 · 大小上限', () => {
  before(() => {
    t.write('chapters/002-巨物.md', 'x'.repeat(G.MAX_EDITABLE_BYTES + 10));
  });

  test('读超限文件报 tooLarge', async () => {
    assert.equal(await codeOf(() => G.guardRead(project, 'chapters/002-巨物.md')), 'tooLarge');
  });

  test('写超限内容报 tooLarge', async () => {
    assert.equal(
      await codeOf(() =>
        G.guardWrite(project, 'chapters/003-新的.md', {
          mode: 'overwrite',
          text: 'y'.repeat(G.MAX_EDITABLE_BYTES + 10),
        })
      ),
      'tooLarge'
    );
  });

  test('上限就是 2MB', () => {
    assert.equal(G.MAX_EDITABLE_BYTES, 2 * 1024 * 1024);
  });
});

describe('守卫 6 · 同名不覆盖', () => {
  test('mode: create 撞上已有文件报 exists', async () => {
    assert.equal(
      await codeOf(() => G.guardWrite(project, 'chapters/001-楔子.md', { mode: 'create' })),
      'exists'
    );
  });

  test('mode: create 写新文件放行', async () => {
    const r = await G.guardWrite(project, 'chapters/010-新的.md', { mode: 'create' });
    assert.equal(r.existed, false);
  });

  test('mode: overwrite 撞上已有文件放行，但说出来它存在', async () => {
    const r = await G.guardWrite(project, 'chapters/001-楔子.md', { mode: 'overwrite' });
    assert.equal(r.existed, true);
  });

  test('目标已存在时把当前内容一并交回（供审阅比对）', async () => {
    const r = await G.guardWrite(project, 'chapters/001-楔子.md', { mode: 'overwrite' });
    assert.ok(r.current?.includes('雨下了三天'), r.current);
  });

  test('目标是目录时报 notFile', async () => {
    assert.equal(
      await codeOf(() => G.guardWrite(project, 'chapters', { mode: 'overwrite' })),
      'notFile'
    );
  });

  test('读不存在的文件报 notFound', async () => {
    assert.equal(await codeOf(() => G.guardRead(project, 'chapters/查无此章.md')), 'notFound');
  });
});

describe('守卫 7 · 覆盖前审阅', () => {
  // 逐字搬自 features/creation.ts 的 confirmOverwrite——那段文案是产品承诺的一部分。
  test('宿主有 reviewReplace 时开 diff', async () => {
    const withReview = makeFakeHost({ settings: () => ({}) });
    bundle.host.initHost(withReview.host);
    withReview.expect();
    const ok = await G.reviewOverwrite('第 12 章的细纲', '.novelforge/plots/012.md', '旧', '新');
    assert.equal(ok, true);
    assert.equal(withReview.reviewed.length, 1, JSON.stringify(withReview.reviewed));
    bundle.host.initHost(h.host);
  });

  test('reviewReplace 说 discard 就不写', async () => {
    const withReview = makeFakeHost({ settings: () => ({}) });
    withReview.setReviewVerdict('discard');
    bundle.host.initHost(withReview.host);
    const ok = await G.reviewOverwrite('第 12 章的细纲', '.novelforge/plots/012.md', '旧', '新');
    assert.equal(ok, false);
    bundle.host.initHost(h.host);
  });

  test('没有 reviewReplace 的宿主退化成确认框', async () => {
    h.expect('覆盖');
    const ok = await G.reviewOverwrite('全书大纲', '.novelforge/outline.md', '旧的一段', '新的一段');
    assert.equal(ok, true);
    assert.equal(h.confirms.length, 1);
  });

  test('确认框的文案一字不改', async () => {
    h.expect('覆盖');
    await G.reviewOverwrite('全书大纲', '.novelforge/outline.md', '旧的一段', '新的一段');
    assert.equal(h.confirms[0].message, '「全书大纲」已经有内容了，用新版本覆盖？');
  });

  test('确认框的 detail 给字数对比与路径', async () => {
    h.expect('覆盖');
    await G.reviewOverwrite('全书大纲', '.novelforge/outline.md', '旧的一段', '新的一段甲');
    assert.equal(h.confirms[0].detail, '现有 4 字，新版 5 字。\n.novelforge/outline.md');
  });

  test('用户选「保留原样」就不写', async () => {
    h.expect('保留原样');
    assert.equal(await G.reviewOverwrite('全书大纲', '.novelforge/outline.md', '旧', '新'), false);
  });

  test('用户直接取消也不写', async () => {
    h.expect();
    assert.equal(await G.reviewOverwrite('全书大纲', '.novelforge/outline.md', '旧', '新'), false);
  });

  // 一字未变还弹个框，只会让人以为自己点错了。
  test('内容一模一样时不弹框，直接算通过', async () => {
    h.expect();
    assert.equal(await G.reviewOverwrite('全书大纲', '.novelforge/outline.md', ' 甲 ', '甲'), true);
    assert.equal(h.confirms.length, 0);
  });
});

describe('守卫 8 · 内容 hash 乐观锁', () => {
  test('baseHash 与磁盘一致时放行', async () => {
    const disk = t.read('chapters/001-楔子.md');
    const r = await G.guardWrite(project, 'chapters/001-楔子.md', {
      mode: 'overwrite',
      baseHash: bundle.fs.hash(disk),
    });
    assert.equal(r.existed, true);
  });

  test('baseHash 对不上抛 conflict', async () => {
    assert.equal(
      await codeOf(() =>
        G.guardWrite(project, 'chapters/001-楔子.md', { mode: 'overwrite', baseHash: '过期的hash' })
      ),
      'conflict'
    );
  });

  test('冲突时把磁盘版本一并交回', async () => {
    try {
      await G.guardWrite(project, 'chapters/001-楔子.md', {
        mode: 'overwrite',
        baseHash: '过期的hash',
      });
      assert.fail('该抛');
    } catch (err) {
      assert.ok(err.diskText?.includes('雨下了三天'), err.diskText);
      assert.equal(err.diskHash, bundle.fs.hash(t.read('chapters/001-楔子.md')));
    }
  });

  test('冲突错是 WsConflictError，也是 WsError', async () => {
    try {
      await G.guardWrite(project, 'chapters/001-楔子.md', {
        mode: 'overwrite',
        baseHash: '过期的hash',
      });
      assert.fail('该抛');
    } catch (err) {
      assert.equal(err instanceof G.WsConflictError, true);
      assert.equal(err instanceof G.WsError, true);
    }
  });

  // 文件被删了：当作新建处理，不拦（逐字沿用 fileEditing 的行为）。
  test('文件不存在时 baseHash 不拦', async () => {
    const r = await G.guardWrite(project, 'chapters/011-刚删的.md', {
      mode: 'overwrite',
      baseHash: '任意',
    });
    assert.equal(r.existed, false);
  });

  test('不传 baseHash 就没有乐观锁', async () => {
    const r = await G.guardWrite(project, 'chapters/001-楔子.md', { mode: 'overwrite' });
    assert.equal(r.existed, true);
  });
});

describe('guardMutate · 存在性', () => {
  test('改不存在的东西报 notFound', async () => {
    assert.equal(await codeOf(() => G.guardMutate(project, 'chapters/查无此章.md')), 'notFound');
  });

  test('目录能改名（不是 notFile）', async () => {
    t.write('chapters/第一卷/005-甲.md', 'x');
    const abs = await G.guardMutate(project, 'chapters/第一卷');
    assert.equal(abs, t.rel('chapters/第一卷'));
  });
});
