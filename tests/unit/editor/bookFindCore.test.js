/**
 * 全书查找替换面板的纯函数（`media/src/editor/bookFindCore.ts`）。面板本身（按键、停顿再搜、点一处跳过去、预览、两段式、
 * 汇总）在 tests/dom/standalone/bookFind.test.js。
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | 分组 | 按范围（面板上的顺序）分组，组内顺序原样，每组几处 |
 * | 勾选 | 文件的三态；勾着几个文件几处（未保存的不算）；重推的结果里没有了的从「勾掉的」里拿掉 |
 * | 替换请求 | 只带勾着的那几处与每份的 hash；未保存的整份带上并列进 `dirty`（后端跳过、汇总里说） |
 * | 状态与说明 | 「N 个文件，M 处」、预览时勾着几处、到了上限说停在哪、没搜的说为什么、正则写错 |
 * | 汇总 | 替换了几个文件几处、历史版本是退路、跨文件没有一步撤销、指纹链、角色卡改名、跳过了哪些 |
 * | 行列 → 下标 | 按「行 + 列」认回编辑区里的位置（磁盘上的 \r\n 在编辑区里是 \n）；越界夹住 |
 * | 条件比较 | 预览之后改了输入框、勾选范围，就不是同一次 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const core = loadModule('media/src/editor/bookFindCore.ts');

const hit = (start, end, extra = {}) => ({ start, end, line: 1, col: start, before: '', text: '林晚', after: '', ...extra });
const file = (path, scope, hits, extra = {}) => ({ path, scope, label: path, hash: `h-${path}`, count: hits.length, hits, ...extra });

const files = [
  file('chapters/001.md', 'chapter', [hit(0, 2), hit(10, 12)]),
  file('.novelforge/characters/林晚.md', 'character', [hit(5, 7)]),
  file('chapters/002.md', 'chapter', [hit(3, 5)]),
  file('.novelforge/summaries/001.md', 'plot', [hit(1, 3)]),
];
const result = { files, listed: 5, scanned: 9, skipped: [] };

describe('分组', () => {
  test('按范围分组（面板上的顺序），组内顺序原样', () => {
    const groups = core.groupByScope(files);
    assert.deepEqual(groups.map((g) => [g.scope, g.label, g.files.map((f) => f.path), g.hits]), [
      ['chapter', '正文', ['chapters/001.md', 'chapters/002.md'], 3],
      ['plot', '细纲', ['.novelforge/summaries/001.md'], 1],
      ['character', '角色卡', ['.novelforge/characters/林晚.md'], 1],
    ]);
  });
});

describe('勾选', () => {
  const k = (f, i) => core.hitKey(f.path, f.hits[i]);

  test('文件的三态', () => {
    assert.equal(core.fileCheck(files[0], new Set()), 'all');
    assert.equal(core.fileCheck(files[0], new Set([k(files[0], 0)])), 'some');
    assert.equal(core.fileCheck(files[0], new Set([k(files[0], 0), k(files[0], 1)])), 'none');
  });

  test('勾着几个文件几处；未保存的那几份不算', () => {
    assert.deepEqual(core.pickedCount(files, new Set()), { files: 4, hits: 5 });
    assert.deepEqual(core.pickedCount(files, new Set([k(files[0], 0), k(files[0], 1)])), { files: 3, hits: 3 });
    assert.deepEqual(core.pickedCount(files, new Set(), new Set(['chapters/002.md'])), { files: 3, hits: 4 });
  });

  test('同一个位置、不同文件的两处不混', () => {
    assert.notEqual(core.hitKey('a.md', { start: 1, end: 2 }), core.hitKey('b.md', { start: 1, end: 2 }));
  });

  test('重推的结果里已经没有的那几处，从「勾掉的」里拿掉', () => {
    const stale = new Set([k(files[0], 0), core.hitKey('chapters/009.md', { start: 0, end: 2 })]);
    assert.deepEqual([...core.pruneExcluded(stale, files)], [k(files[0], 0)]);
  });
});

describe('替换请求', () => {
  const query = { query: '林晚', caseSensitive: false, regex: false, scopes: ['chapter', 'plot', 'character'], replacement: '林婉' };

  test('只带勾着的那几处与每份预览时的 hash；一处都没勾的文件不带', () => {
    const excluded = new Set([core.hitKey(files[0].path, files[0].hits[1]), core.hitKey(files[3].path, files[3].hits[0])]);
    const req = core.buildReplaceRequest(query, result, excluded, []);
    assert.deepEqual(req, {
      query: '林晚',
      caseSensitive: false,
      regex: false,
      replacement: '林婉',
      scopes: ['chapter', 'plot', 'character'],
      files: [
        { path: 'chapters/001.md', hash: 'h-chapters/001.md', hits: [{ start: 0, end: 2 }] },
        { path: '.novelforge/characters/林晚.md', hash: 'h-.novelforge/characters/林晚.md', hits: [{ start: 5, end: 7 }] },
        { path: 'chapters/002.md', hash: 'h-chapters/002.md', hits: [{ start: 3, end: 5 }] },
      ],
      dirty: [],
    });
  });

  test('未保存的整份带上、列进 dirty（后端跳过、汇总里说）；没在结果里的未保存文件不列', () => {
    const excluded = new Set([core.hitKey(files[2].path, files[2].hits[0])]);
    const req = core.buildReplaceRequest(query, result, excluded, ['chapters/002.md', 'chapters/099.md']);
    assert.deepEqual(req.dirty, ['chapters/002.md']);
    assert.deepEqual(req.files.find((f) => f.path === 'chapters/002.md').hits, [{ start: 3, end: 5 }]);
  });

  test('替换框空着：换成空串（删掉）', () => {
    assert.equal(core.buildReplaceRequest({ ...query, replacement: undefined }, result, new Set(), []).replacement, '');
  });
});

describe('状态行与说明', () => {
  test('几个文件几处；预览时补上勾着几处与未保存的', () => {
    assert.equal(core.resultStatus(result), '4 个文件，5 处');
    assert.equal(core.resultStatus(result, { files: 3, hits: 4 }, 1), '4 个文件，5 处 · 勾着 3 个文件 4 处；1 个文件有未保存的修改，会跳过');
  });

  test('没找到、没有可搜的、正则写错', () => {
    assert.equal(core.resultStatus({ files: [], listed: 0, scanned: 3, skipped: [] }), '全书没有找到');
    assert.equal(core.resultStatus({ files: [], listed: 0, scanned: 0, skipped: [] }), '没有可搜的文件');
    assert.equal(core.resultStatus({ files: [], listed: 0, scanned: 0, skipped: [], error: 'x' }), '正则写错了');
  });

  test('到了上限：只列了前 N 处、停在哪一份上、替换只作用于列出来的；没搜的说为什么', () => {
    const notes = core.resultNotes({
      ...result,
      truncated: { limit: 1000, at: '第 12 章 夜访' },
      skipped: [{ path: 'chapters/020.md', label: '第 20 章', reason: '超过 2 MB，没有搜' }],
    });
    assert.match(notes[0], /只列了前 1000 处：搜到「第 12 章 夜访」就停了/);
    assert.match(notes[0], /替换也只作用于列出来的这些/);
    assert.equal(notes[1], '1 个文件没有搜：第 20 章（超过 2 MB，没有搜）');
  });
});

describe('汇总', () => {
  const summary = {
    files: 3,
    hits: 7,
    replaced: [],
    skipped: [
      { path: 'chapters/002.md', label: '第 2 章 下山', reason: 'dirty', message: '编辑器里有未保存的修改：先保存（或放弃修改），再替换一次。' },
    ],
    chainKept: ['第 1 章 入宗'],
    plotOnly: ['第 2 章 下山'],
    bodyOnly: ['第 3 章 夜访'],
    outlineOnly: ['细纲 · 第 4 章 北行'],
    renamedCards: [
      { path: '.novelforge/characters/林晚.md', label: '角色 · 林晚', name: '林婉', nameChanged: true },
      { path: '.novelforge/characters/老周.md', label: '角色 · 老周', name: '老周', nameChanged: false },
    ],
  };

  test('替换了几个文件几处；历史版本是退路；跨文件没有一步撤销', () => {
    const lines = core.summaryLines(summary).map((l) => l.text);
    assert.equal(lines[0], '替换了 3 个文件、共 7 处。');
    assert.match(lines[1], /每个改过的文件都可以在「历史」里找回替换前那一版/);
    assert.match(lines[1], /跨文件的替换没有一步撤销/);
  });

  test('指纹链、角色卡改名、跳过的说明都在，警告的那几句标出来', () => {
    const lines = core.summaryLines(summary);
    const text = lines.map((l) => l.text).join('\n');
    assert.match(text, /第 1 章 入宗：细纲与正文这次一起改了，指纹跟着刷新/);
    assert.match(text, /第 2 章 下山：只改了细纲、正文没跟着改，正文会挂 ⟳/);
    assert.match(text, /第 3 章 夜访：只改了正文、细纲没跟着改，回到「待定稿」/);
    assert.match(text, /细纲 · 第 4 章 北行：情节大纲里覆盖它的那一节改了/);
    assert.match(text, /角色 · 林晚：卡里的名字改成了「林婉」，文件名没跟着改/);
    assert.match(text, /角色 · 老周：别名改了/);
    assert.match(text, /跳过了 1 个文件：/);
    assert.match(text, /第 2 章 下山——编辑器里有未保存的修改/);
    assert.equal(lines.find((l) => l.text.includes('只改了细纲')).tone, 'warn');
  });

  test('一处都没换、整个没做', () => {
    const none = core.summaryLines({ ...summary, files: 0, hits: 0, chainKept: [], plotOnly: [], bodyOnly: [], outlineOnly: [], renamedCards: [], skipped: [] });
    assert.deepEqual(none.map((l) => l.text), ['一处都没有替换。']);
    assert.deepEqual(core.summaryLines({ ...summary, error: '正则写错了' }), [{ text: '正则写错了', tone: 'error' }]);
  });

  test('章多了只点五个名', () => {
    assert.equal(core.listLabels(['1', '2', '3', '4', '5', '6', '7']), '1、2、3、4、5 等 7 个');
  });
});

describe('行列 → 编辑区里的下标', () => {
  test('按行列认（磁盘上的 \\r\\n 到了编辑区里是 \\n，按下标会差）', () => {
    const text = '第一行\n第二行林晚\n第三行';
    assert.equal(core.offsetAt(text, 2, 3), text.indexOf('林晚'));
    assert.equal(core.offsetAt(text, 1, 0), 0);
  });

  test('越界夹住', () => {
    const text = '甲\n乙';
    assert.equal(core.offsetAt(text, 1, 99), 1);
    assert.equal(core.offsetAt(text, 9, 0), text.length);
  });
});

describe('条件比较', () => {
  const q = { query: '林晚', caseSensitive: false, regex: false, scopes: ['chapter'], replacement: '林婉' };
  test('一样的才算一样', () => {
    assert.equal(core.sameQuery(q, { ...q }), true);
    assert.equal(core.sameQuery(q, { ...q, replacement: '林苑' }), false);
    assert.equal(core.sameQuery(q, { ...q, scopes: ['chapter', 'plot'] }), false);
    assert.equal(core.sameQuery(q, { ...q, regex: true }), false);
    assert.equal(core.sameQuery(null, q), false);
  });
});
