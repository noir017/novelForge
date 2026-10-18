/**
 * 工程页的设定名录（设定名录第一期）：设定行的出现章与「＋N」、「出现过 · 未建条目」那一组、
 * 「设定」组标题旁的筛选框。
 *
 * | 用例组 | 钉的是什么 |
 * |---|---|
 * | 设定行 | 右边写出现章（`loreByEntry[relPath].detail`，后端算的）、副标题仍是一句话；待整合的挂「＋N」（样子同角色卡）、tooltip 分水位有没有两种说法；没出现过的两样都不挂；失败标记、右键菜单照旧；旧后端没有 `loreByEntry` 不崩 |
 * | 三件维护（第三期） | 设定组菜单按待办写「补记设定（N 章）」「整合设定（K 条）」，外加「按目录整理…」，没待办只剩整理；有新内容的设定行右键「整合这一条」带路径；未建条目组菜单「给出现 2 章以上的 M 个建条目」 |
 * | 出现过 · 未建条目 | 只在有时出现、紧跟在「设定」组后面、副标题写个数；一行是 名字〔分类〕· 出现章；右键「建条目」发 `buildLore` 带名字，「新建这条设定」发 `newLore` 带 `name` 与分类目录（没分类落在设定根目录）；点名字不新建；一次先画 30 个，「显示全部 N 个」摊开，重推树不缩回 |
 * | 筛选框 | 在标题栏上、折叠开关之外（点它不折叠）；按标题 / 一句话 / 关键词筛（不分大小写），匹配项的祖先文件夹自动展开、没匹配的文件夹不画；也按名字 / 分类筛未建条目；一个都不匹配时说「没有匹配的设定」；重推树筛选还在；打字与推树都不丢焦点和光标；**组字期间不重画**；Esc 与 × 清空；不发任何消息给后端；组折着时开始筛就展开 |
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

const LORE = '.novelforge/lore';

/** 33 个只出现过一次的杂项，凑出一条超过 30 个的长尾。 */
const filler = Array.from({ length: 33 }, (_, i) => ({
  name: `杂项${i + 1}`,
  category: '杂物',
  chapters: [10],
  detail: '1 章 · 第 10 章起',
}));

/**
 * 一棵有设定的工程页快照。设定区按目录（= 分类）分组：
 *
 * | 条目 | 位置 | 一句话 | 出现章 | 水位 / 待整合 | 关键词 |
 * |---|---|---|---|---|---|
 * | 青崖镇 | 地域/ | 偏僻小镇，镇口设卡查过所 | 第 3–57 章 · 12 章 | 40 / ＋3 | 停舟渡、Qingya |
 * | 停舟客栈 | 地域/青崖/ | 镇上唯一的客栈，二层木楼 | 第 5 章 · 1 章 | 0 / ＋1 | — |
 * | 崖字令牌 | 根目录 | 刻着崖字的铜令牌 | 没出现过 | 0 / 0 | 信物 |
 *
 * 外加一个空文件夹「信物」（筛选时没有匹配，不该画出来），以及 35 个未建条目
 * （黑水渡〔地域/青崖〕、断魂香〔无分类〕、33 个杂项〔杂物〕），按出现章数降序。
 */
const loreTree = (extra) => ({
  ...sampleTree(),
  lore: [
    {
      kind: 'dir', label: '地域', relPath: `${LORE}/地域`, fileCount: 2, children: [
        {
          kind: 'dir', label: '青崖', relPath: `${LORE}/地域/青崖`, fileCount: 1, children: [
            { kind: 'file', label: '停舟客栈', relPath: `${LORE}/地域/青崖/停舟客栈.md`, detail: '镇上唯一的客栈，二层木楼' },
          ],
        },
        { kind: 'file', label: '青崖镇', relPath: `${LORE}/地域/青崖镇.md`, detail: '偏僻小镇，镇口设卡查过所' },
      ],
    },
    { kind: 'dir', label: '信物', relPath: `${LORE}/信物`, fileCount: 0, children: [] },
    { kind: 'file', label: '崖字令牌', relPath: `${LORE}/崖字令牌.md`, detail: '刻着崖字的铜令牌' },
  ],
  loreByEntry: {
    [`${LORE}/地域/青崖镇.md`]: {
      chapters: [3, 5, 57], detail: '第 3–57 章 · 12 章', updatedThrough: 40, pending: 3, keywords: ['停舟渡', 'Qingya'],
    },
    [`${LORE}/地域/青崖/停舟客栈.md`]: {
      chapters: [5], detail: '第 5 章 · 1 章', updatedThrough: 0, pending: 1, keywords: [],
    },
    [`${LORE}/崖字令牌.md`]: { chapters: [], detail: '', updatedThrough: 0, pending: 0, keywords: ['信物'] },
  },
  loreUnfiled: [
    { name: '黑水渡', category: '地域/青崖', chapters: [3, 4, 5, 6, 7], detail: '5 章 · 第 3 章起' },
    { name: '断魂香', category: '', chapters: [8, 9], detail: '2 章 · 第 8 章起' },
    ...filler,
  ],
  loreUnrecorded: 0,
  ...extra,
});

const groupOf = (ui, name) =>
  [...ui.doc.querySelectorAll('#projectBody .group')].find((g) => g.querySelector('.group-name')?.textContent === name);
const groupNames = (ui) => [...ui.doc.querySelectorAll('#projectBody .group-name')].map((n) => n.textContent);
const loreRow = (ui, label) =>
  [...groupOf(ui, '设定').querySelectorAll('.row-lore')].find((r) => r.querySelector('.row-label')?.textContent === label);
/** 设定组里画出来的条目名（不含文件夹）。 */
const loreLabels = (ui) =>
  [...groupOf(ui, '设定').querySelectorAll('.row-lore .row-label')].map((n) => n.textContent);
/** 设定组里画出来的文件夹（带开合图标）。 */
const folderLabels = (ui) =>
  [...groupOf(ui, '设定').querySelectorAll('.row-dir-label')].map((n) => n.textContent);
const dirLabel = (ui, name) =>
  [...groupOf(ui, '设定').querySelectorAll('.row-dir-label')].find((n) => n.textContent.endsWith(` ${name}`));
const unfiledGroup = (ui) => groupOf(ui, '出现过 · 未建条目');
const unfiledRows = (ui) => [...(unfiledGroup(ui)?.querySelectorAll('.row-lore-unfiled') ?? [])];
const unfiledRow = (ui, name) => unfiledRows(ui).find((r) => r.querySelector('.row-label')?.textContent === name);
const unfiledNames = (ui) => unfiledRows(ui).map((r) => r.querySelector('.row-label').textContent);
const filterInput = (ui) => groupOf(ui, '设定')?.querySelector('.lore-filter-input') ?? null;

/** 往筛选框里打一串字：先聚焦（真实用户就是这样），光标落在末尾，发一条 input。 */
function typeFilter(ui, text) {
  const input = filterInput(ui);
  input.focus();
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
}

describe('设定行：出现章与「＋N」', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: loreTree() });
    // 文件夹默认折叠：把两层都打开，三条都画出来。
    ui.clickEl(dirLabel(ui, '地域'));
    ui.clickEl(dirLabel(ui, '青崖'));
  });

  test('三条都画成设定行', () => {
    assert.deepEqual(loreLabels(ui).sort(), ['停舟客栈', '崖字令牌', '青崖镇'].sort());
  });

  // 出现章由后端从定稿过的细纲第九节算好，前端照抄。
  test('右边写出现章', () => {
    const span = loreRow(ui, '青崖镇').querySelector('.lore-span');
    assert.equal(span?.textContent, '第 3–57 章 · 12 章', loreRow(ui, '青崖镇').outerHTML);
  });

  test('副标题仍是那一句话', () => {
    assert.equal(loreRow(ui, '青崖镇').querySelector('.row-detail')?.textContent, '偏僻小镇，镇口设卡查过所');
  });

  // 出现章另起一格放在一句话后面，不并进副标题（并进去会被省略号吃掉）。
  test('出现章另起一格，排在一句话后面', () => {
    const kids = [...loreRow(ui, '青崖镇').children];
    const detail = kids.findIndex((n) => n.classList.contains('row-detail'));
    const span = kids.findIndex((n) => n.classList.contains('lore-span'));
    assert.ok(detail >= 0 && span > detail, kids.map((n) => n.className).join('|'));
    assert.ok(!loreRow(ui, '青崖镇').querySelector('.row-detail').textContent.includes('章'));
  });

  test('待整合的挂「＋N」，用角色卡那个样子', () => {
    const flag = loreRow(ui, '青崖镇').querySelector('.cast-pending');
    assert.equal(flag?.textContent, '＋3', loreRow(ui, '青崖镇').outerHTML);
  });

  test('「＋N」的 tooltip 写水位之后几章', () => {
    assert.equal(
      loreRow(ui, '青崖镇').querySelector('.cast-pending').title,
      '第 40 章之后又有 3 章的新内容没整合进这一条'
    );
  });

  // 水位是 0（从没整合过）时说「第 0 章之后」是句怪话。
  test('没整合过的换一种说法', () => {
    assert.equal(loreRow(ui, '停舟客栈').querySelector('.cast-pending').title, '有 1 章的新内容还没整合进这一条');
  });

  test('定稿里没出现过的：不挂出现章，也不挂「＋N」', () => {
    const row = loreRow(ui, '崖字令牌');
    assert.equal(row.querySelector('.lore-span'), null, row.outerHTML);
    assert.equal(row.querySelector('.cast-pending'), null, row.outerHTML);
  });

  test('右键菜单照旧：打开与三个类文件操作', () => {
    const items = ui.itemsOf(ui.rightClick(loreRow(ui, '青崖镇')));
    for (const label of ['打开', '重命名', '移动到…', '删除（移到回收站）']) {
      assert.ok(items.includes(label), JSON.stringify(items));
    }
    ui.pick(ui.doc.querySelector('.ctx-menu'), '打开');
    assert.equal(ui.last('openFile')?.path, `${LORE}/地域/青崖镇.md`, JSON.stringify(ui.sent));
  });

  test('点名字打开那一条', () => {
    ui.sent.length = 0;
    ui.clickEl(loreRow(ui, '崖字令牌').querySelector('.row-label'));
    assert.equal(ui.last('openFile')?.path, `${LORE}/崖字令牌.md`, JSON.stringify(ui.sent));
  });

  test('失败标记照挂，排在名字前面', () => {
    const tree = loreTree({
      failures: { [`${LORE}/崖字令牌.md`]: [{ at: '', severity: 'warn', message: '整合了一半' }] },
    });
    ui.post({ type: 'project', tree });
    const row = loreRow(ui, '崖字令牌');
    const kids = [...row.children];
    const mark = kids.findIndex((n) => n.classList.contains('row-failure'));
    const label = kids.findIndex((n) => n.classList.contains('row-label'));
    assert.ok(mark >= 0 && mark < label, row.outerHTML);
    assert.ok(row.querySelector('.row-failure').classList.contains('is-warn'));
  });

  // 旧后端推来的树没有 loreByEntry：就是一行普通的文件行，不崩。
  test('缺 loreByEntry 时照样画，只是没有出现章', () => {
    const legacy = loreTree();
    delete legacy.loreByEntry;
    delete legacy.loreUnfiled;
    ui.post({ type: 'project', tree: legacy });
    const row = loreRow(ui, '青崖镇');
    assert.ok(row, groupOf(ui, '设定').outerHTML);
    assert.equal(row.querySelector('.lore-span'), null);
    assert.equal(row.querySelector('.cast-pending'), null);
    assert.equal(unfiledGroup(ui), undefined);
  });
});

describe('名录的三件维护：补记、整合、按目录整理、建条目（第三期）', { skip: JSDOM_SKIP }, () => {
  let ui;
  const loreHead = () => groupOf(ui, '设定').querySelector('.group-head');
  const unfiledHead = () => unfiledGroup(ui).querySelector('.group-head');

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: loreTree({ loreUnrecorded: 4 }) });
    ui.clickEl(dirLabel(ui, '地域'));
  });

  test('设定组菜单：有几件待办就写几件，外加按目录整理', () => {
    const items = ui.itemsOf(ui.rightClick(loreHead()));
    ui.closeMenu();
    for (const label of ['补记设定（4 章定稿过、还没记）', '整合设定（2 条有新内容）', '按目录整理…']) {
      assert.ok(items.includes(label), JSON.stringify(items));
    }
  });

  test('三项各发各的动作，都不带对象（次数在后端的确认框里报）', () => {
    for (const [label, action] of [
      ['补记设定（4 章定稿过、还没记）', 'recordLore'],
      ['整合设定（2 条有新内容）', 'integrateLore'],
      ['按目录整理…', 'organizeLore'],
    ]) {
      ui.sent.length = 0;
      ui.pick(ui.rightClick(loreHead()), label);
      const msg = ui.last('projectAction');
      assert.equal(msg?.action, action, JSON.stringify(ui.sent));
      assert.equal(msg.relPath, undefined, JSON.stringify(msg));
    }
  });

  test('没有待办时只剩按目录整理', () => {
    const quiet = loreTree({ loreUnrecorded: 0 });
    for (const s of Object.values(quiet.loreByEntry)) {
      s.pending = 0;
    }
    ui.post({ type: 'project', tree: quiet });
    const items = ui.itemsOf(ui.rightClick(loreHead()));
    ui.closeMenu();
    assert.ok(items.includes('按目录整理…'), JSON.stringify(items));
    assert.ok(!items.some((i) => i.startsWith('补记设定') || i.startsWith('整合设定')), JSON.stringify(items));
    ui.post({ type: 'project', tree: loreTree({ loreUnrecorded: 4 }) });
  });

  test('有新内容的设定行：右键「整合这一条」发 integrateLore，带这一条的路径', () => {
    const items = ui.itemsOf(ui.rightClick(loreRow(ui, '青崖镇')));
    assert.ok(items.includes('整合这一条（新增 3 章，调用模型 1 次）'), JSON.stringify(items));
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), '整合这一条（新增 3 章，调用模型 1 次）');
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'integrateLore', JSON.stringify(ui.sent));
    assert.equal(msg.relPath, `${LORE}/地域/青崖镇.md`);
  });

  test('没有新内容的设定行：没有「整合这一条」', () => {
    const items = ui.itemsOf(ui.rightClick(loreRow(ui, '崖字令牌')));
    ui.closeMenu();
    assert.ok(!items.some((i) => i.startsWith('整合这一条')), JSON.stringify(items));
  });

  test('未建条目组菜单：给出现 2 章以上的建条目，发 buildLore 不带名字', () => {
    const items = ui.itemsOf(ui.rightClick(unfiledHead()));
    assert.ok(items.includes('给出现 2 章以上的 2 个建条目'), JSON.stringify(items));
    ui.sent.length = 0;
    ui.pick(ui.doc.querySelector('.ctx-menu'), '给出现 2 章以上的 2 个建条目');
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'buildLore', JSON.stringify(ui.sent));
    assert.equal(msg.name, undefined, JSON.stringify(msg));
  });
});

describe('「出现过 · 未建条目」', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: loreTree() });
  });

  test('紧跟在「设定」组后面', () => {
    const names = groupNames(ui);
    assert.equal(names.indexOf('出现过 · 未建条目'), names.indexOf('设定') + 1, names.join('|'));
  });

  test('副标题写个数', () => {
    assert.equal(unfiledGroup(ui).querySelector('.group-head .meta').textContent, '35 个');
  });

  test('一行：名字〔分类〕· 出现章', () => {
    const row = unfiledRow(ui, '黑水渡');
    assert.equal(row.querySelector('.lore-category')?.textContent, '〔地域/青崖〕', row.outerHTML);
    assert.equal(row.querySelector('.row-detail')?.textContent, '5 章 · 第 3 章起');
    const kids = [...row.children].map((n) => n.className);
    assert.ok(
      kids.findIndex((c) => c.includes('row-label')) < kids.findIndex((c) => c.includes('lore-category')) &&
        kids.findIndex((c) => c.includes('lore-category')) < kids.findIndex((c) => c.includes('row-detail')),
      kids.join('|')
    );
  });

  test('没有分类的不画空的〔〕', () => {
    assert.equal(unfiledRow(ui, '断魂香').querySelector('.lore-category'), null);
  });

  test('按后端给的顺序排（出现章数降序）', () => {
    assert.deepEqual(unfiledNames(ui).slice(0, 3), ['黑水渡', '断魂香', '杂项1']);
  });

  // 这些名字还没有文件：没有类文件操作，只有建条目（调模型）与新建空条目（不调）。
  test('右键给「建条目」「新建这条设定」与刷新', () => {
    const items = ui.itemsOf(ui.rightClick(unfiledRow(ui, '黑水渡')));
    assert.deepEqual(items, ['建条目（调用模型 1 次）', '新建这条设定（空的，不调模型）', '刷新'], JSON.stringify(items));
    ui.closeMenu();
  });

  test('「建条目」发 buildLore，带名字', () => {
    ui.sent.length = 0;
    ui.pick(ui.rightClick(unfiledRow(ui, '黑水渡')), '建条目（调用模型 1 次）');
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'buildLore', JSON.stringify(ui.sent));
    assert.equal(msg.name, '黑水渡', JSON.stringify(msg));
  });

  test('「新建这条设定」发 newLore，带名字，落在建议的分类目录里', () => {
    ui.sent.length = 0;
    ui.pick(ui.rightClick(unfiledRow(ui, '黑水渡')), '新建这条设定（空的，不调模型）');
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'newLore', JSON.stringify(ui.sent));
    assert.equal(msg.name, '黑水渡', JSON.stringify(msg));
    assert.equal(msg.dir, `${LORE}/地域/青崖`, JSON.stringify(msg));
  });

  test('没有分类的落在设定根目录', () => {
    ui.pick(ui.rightClick(unfiledRow(ui, '断魂香')), '新建这条设定（空的，不调模型）');
    const msg = ui.last('projectAction');
    assert.equal(msg.name, '断魂香', JSON.stringify(msg));
    assert.equal(msg.dir, LORE, JSON.stringify(msg));
  });

  // 新建出来的是一份空条目：扫列表时手一滑就多一个文件，不放在点名字上。
  test('点名字不新建', () => {
    ui.sent.length = 0;
    ui.clickEl(unfiledRow(ui, '黑水渡').querySelector('.row-label'));
    assert.ok(!ui.last('projectAction'), JSON.stringify(ui.sent));
  });

  test('一次先画 30 个，后面收在「显示全部 35 个」', () => {
    assert.equal(unfiledRows(ui).length, 30);
    const more = unfiledGroup(ui).querySelector('.row-more');
    assert.equal(more?.textContent, '显示全部 35 个', unfiledGroup(ui).outerHTML.slice(-400));
  });

  test('「显示全部」那一行不是名录里的一项（没有右键菜单）', () => {
    const more = unfiledGroup(ui).querySelector('.row-more');
    assert.ok(!more.classList.contains('row'), more.className);
  });

  test('点「显示全部」摊开全部，不发消息', () => {
    ui.sent.length = 0;
    ui.clickEl(unfiledGroup(ui).querySelector('.row-more button'));
    assert.equal(unfiledRows(ui).length, 35);
    assert.equal(unfiledGroup(ui).querySelector('.row-more'), null);
    assert.deepEqual(ui.sent, []);
  });

  // 文件一变后端就整棵重推：点开之后每次都缩回 30 个，等于那颗按钮白点。
  test('重推树之后仍是全部', () => {
    ui.post({ type: 'project', tree: loreTree() });
    assert.equal(unfiledRows(ui).length, 35);
  });

  test('没有未建条目时整组不出现', () => {
    ui.post({ type: 'project', tree: loreTree({ loreUnfiled: [] }) });
    assert.ok(!groupNames(ui).includes('出现过 · 未建条目'), groupNames(ui).join('|'));
  });
});

describe('「设定」组的筛选框', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: loreTree() });
  });

  test('在「设定」组的标题栏上，折叠开关之外', () => {
    const input = filterInput(ui);
    assert.ok(input, groupOf(ui, '设定').querySelector('.group-head').outerHTML);
    assert.ok(input.closest('.group-head'));
    assert.equal(input.closest('.group-toggle'), null);
  });

  test('别的组没有筛选框', () => {
    assert.equal(ui.doc.querySelectorAll('#projectBody .lore-filter-input').length, 1);
  });

  test('没筛的时候 × 藏着', () => {
    assert.ok(groupOf(ui, '设定').querySelector('.lore-filter-clear').classList.contains('hidden'));
  });

  test('点筛选框不把组折起来', () => {
    ui.clickEl(filterInput(ui));
    assert.ok(groupOf(ui, '设定').querySelector('.group-body').children.length > 0);
    assert.equal(groupOf(ui, '设定').querySelector('.group-head .caret').textContent, '▾');
  });

  test('没筛的时候文件夹照旧折着', () => {
    assert.deepEqual(loreLabels(ui), ['崖字令牌']);
  });

  test('按标题筛', () => {
    typeFilter(ui, '令牌');
    assert.deepEqual(loreLabels(ui), ['崖字令牌']);
    assert.deepEqual(folderLabels(ui), []);
  });

  // 匹配的那一条在两层折叠着的目录里：不自动展开就等于没筛出来。
  test('按一句话筛，匹配项的祖先文件夹自动展开', () => {
    typeFilter(ui, '二层木楼');
    assert.deepEqual(loreLabels(ui), ['停舟客栈']);
    assert.deepEqual(folderLabels(ui), ['📂 地域', '📂 青崖']);
  });

  test('没有匹配的文件夹不画（空文件夹「信物」也不画）', () => {
    assert.ok(!folderLabels(ui).some((l) => l.includes('信物')), folderLabels(ui).join('|'));
    assert.equal(groupOf(ui, '设定').querySelector('.row-empty'), null);
  });

  // 筛选不清它就一直开着：点了、右键「折叠」都没有看得见的效果，干脆不挂，免得悄悄改掉
  // 清筛选之后的开合（下面「Esc 清空」那条验文件夹仍是原来折着的样子）。
  test('筛选中强制展开的文件夹点了不折叠，右键也没有「折叠 / 展开」', () => {
    ui.clickEl(dirLabel(ui, '地域'));
    assert.deepEqual(loreLabels(ui), ['停舟客栈']);
    const items = ui.itemsOf(ui.rightClick(dirLabel(ui, '地域').closest('.row')));
    assert.ok(!items.includes('折叠') && !items.includes('展开'), JSON.stringify(items));
    assert.ok(items.includes('在此新建设定'), JSON.stringify(items));
    ui.closeMenu();
  });

  test('按关键词筛，不分大小写', () => {
    typeFilter(ui, 'QINGYA');
    assert.deepEqual(loreLabels(ui), ['青崖镇']);
    assert.deepEqual(folderLabels(ui), ['📂 地域']);
  });

  // 关键词「信物」恰好与空文件夹同名：匹配的是崖字令牌这一条，空文件夹照样不画。
  test('关键词命中根目录下的条目', () => {
    typeFilter(ui, '信物');
    assert.deepEqual(loreLabels(ui), ['崖字令牌']);
    assert.deepEqual(folderLabels(ui), []);
  });

  test('有字时 × 出现', () => {
    assert.ok(!groupOf(ui, '设定').querySelector('.lore-filter-clear').classList.contains('hidden'));
  });

  test('也按名字筛未建条目；设定组没有匹配时说「没有匹配的设定」', () => {
    typeFilter(ui, '黑水');
    assert.deepEqual(unfiledNames(ui), ['黑水渡']);
    assert.equal(groupOf(ui, '设定').querySelector('.row-no-match')?.textContent, '没有匹配的设定');
    assert.deepEqual(loreLabels(ui), []);
  });

  test('按分类筛未建条目', () => {
    typeFilter(ui, '地域/青');
    assert.deepEqual(unfiledNames(ui), ['黑水渡']);
  });

  test('筛出来的未建条目超过 30 个照样收起来，「显示全部」报的是筛出来的个数', () => {
    typeFilter(ui, '杂物');
    assert.equal(unfiledRows(ui).length, 30);
    assert.equal(unfiledGroup(ui).querySelector('.row-more')?.textContent, '显示全部 33 个');
  });

  test('一个都不匹配：设定组说「没有匹配的设定」，未建条目整组不画', () => {
    typeFilter(ui, '查无此物');
    const none = groupOf(ui, '设定').querySelector('.row-no-match');
    assert.equal(none?.textContent, '没有匹配的设定');
    assert.ok(none.classList.contains('hint'), none.className);
    assert.equal(unfiledGroup(ui), undefined);
  });

  test('重推树之后筛选还在，框里的字也还在', () => {
    typeFilter(ui, '二层木楼');
    ui.post({ type: 'project', tree: loreTree() });
    assert.equal(filterInput(ui).value, '二层木楼');
    assert.deepEqual(loreLabels(ui), ['停舟客栈']);
  });

  test('打一个字重画一次，焦点与光标留在新的框里', () => {
    const input = filterInput(ui);
    input.focus();
    input.value = '二层木';
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    const now = filterInput(ui);
    assert.notEqual(now, input, '没有重画（换了输入框才测得到焦点放回去）');
    assert.equal(ui.doc.activeElement, now);
    assert.equal(now.value, '二层木');
    assert.equal(now.selectionStart, 1);
    assert.equal(now.selectionEnd, 1);
  });

  // 文件监视推来的树：正在打字的人不该被踢出筛选框。
  test('打字时推来一棵树，焦点与光标不丢', () => {
    const input = filterInput(ui);
    input.setSelectionRange(2, 2);
    ui.post({ type: 'project', tree: loreTree() });
    const now = filterInput(ui);
    assert.equal(ui.doc.activeElement, now);
    assert.equal(now.selectionStart, 2);
  });

  test('焦点不在框里时，推树不把焦点拽进去', () => {
    filterInput(ui).blur();
    ui.post({ type: 'project', tree: loreTree() });
    assert.notEqual(ui.doc.activeElement, filterInput(ui));
  });

  // 组字中途换掉输入框，打了一半的拼音就没了：中途的 input 不筛，推来的树也先不画。
  test('输入法组字期间不重画，组字结束再筛', () => {
    typeFilter(ui, '');
    const input = filterInput(ui);
    input.focus();
    input.dispatchEvent(new ui.window.Event('compositionstart', { bubbles: true }));
    input.value = '黑';
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    assert.equal(filterInput(ui), input, '组字中途重画了');
    assert.ok(unfiledNames(ui).length > 1, '组字中途就筛了');

    ui.post({ type: 'project', tree: loreTree() });
    assert.equal(filterInput(ui), input, '组字中途推来的树把输入框换掉了');

    input.value = '黑水';
    input.dispatchEvent(new ui.window.Event('compositionend', { bubbles: true }));
    assert.deepEqual(unfiledNames(ui), ['黑水渡']);
    assert.equal(ui.doc.activeElement, filterInput(ui));
  });

  test('Esc 清空筛选，全部回来', () => {
    filterInput(ui).dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(filterInput(ui).value, '');
    assert.equal(unfiledRows(ui).length, 30);
    // 文件夹回到原来的开合（默认折着）。
    assert.deepEqual(loreLabels(ui), ['崖字令牌']);
    assert.deepEqual(folderLabels(ui), ['📁 地域', '📁 信物']);
  });

  test('× 清空筛选，焦点回到框里', () => {
    typeFilter(ui, '令牌');
    ui.clickEl(groupOf(ui, '设定').querySelector('.lore-filter-clear'));
    assert.equal(filterInput(ui).value, '');
    assert.equal(groupOf(ui, '设定').querySelector('.row-no-match'), null);
    assert.equal(ui.doc.activeElement, filterInput(ui));
    assert.ok(groupOf(ui, '设定').querySelector('.lore-filter-clear').classList.contains('hidden'));
  });

  test('筛选是纯前端的：一条消息都不发', () => {
    ui.sent.length = 0;
    typeFilter(ui, '青崖');
    filterInput(ui).dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.deepEqual(ui.sent, []);
  });

  test('组折着时开始筛就展开', () => {
    ui.clickEl(groupOf(ui, '设定').querySelector('.group-toggle'));
    assert.equal(groupOf(ui, '设定').querySelector('.group-body').children.length, 0, '先折起来');
    typeFilter(ui, '令牌');
    assert.deepEqual(loreLabels(ui), ['崖字令牌']);
  });

  test('没有条目也没有未建条目时不摆筛选框', () => {
    typeFilter(ui, '');
    ui.post({ type: 'project', tree: loreTree({ lore: [], loreByEntry: {}, loreUnfiled: [] }) });
    assert.equal(filterInput(ui), null);
  });
});
