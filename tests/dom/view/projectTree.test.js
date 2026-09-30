/**
 * 工程页：目录树的展开/缩进、「故事架构」组、一个章号一行的章节组、
 * 行与分组的右键菜单、菜单引擎的通用行为。
 *
 * 迁自 scripts/smoke-view.js 的这几节：
 *   == 工程页目录树 ==（1014） == 工程页的右键菜单 ==（1059）
 *   == 右键菜单的通用行为 ==（1324）
 *
 * 一章一纲之后（commit 4e0d289）章节组不再分「已发布的章 / 还没交付的剧情段」
 * 两种行，也没有卷那一组：细纲号 = 章号，一行就是一章的细纲与正文两面。
 * 夹具见 helpers/dom.js 的 `sampleTree()`——五行各是单章状态机的一档。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession, sampleTree } = require('../../helpers/dom');

/**
 * 章节组的行。「故事架构」那几行刻意复用了 `.row-plot` 的样式与骨架，
 * 按 `.row-plot` 取时要排掉 `.row-architecture`，否则「章节有几行」会连它们一起数。
 */
const chapterRowsOf = (ui) => [...ui.doc.querySelectorAll('#projectBody .row-plot:not(.row-architecture)')];

describe('工程页目录树', { skip: JSDOM_SKIP }, () => {
  let ui;
  // 目录树只有**角色 / 设定**两个区有——章节列表是扁平的（细纲与正文合成
  // 一行，顺序即章号，折进目录反而看不出来）。
  const charactersGroup = () =>
    [...ui.doc.querySelectorAll('#projectBody .group')]
      .find((g) => g.querySelector('.group-name')?.textContent === '角色');
  const labels = () => [...charactersGroup().querySelectorAll('.row-label')].map((n) => n.textContent);
  const dirLabel = (name) =>
    [...charactersGroup().querySelectorAll('.row-dir-label')].find((n) => n.textContent.includes(name));

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('顶层节点都在', () => {
    assert.ok(
      labels().some((l) => l.includes('配角')) && labels().some((l) => l.includes('林昭')),
      labels().join(' | ')
    );
  });

  test('文件夹默认折叠，不渲染子节点', () => {
    assert.ok(!labels().some((l) => l.includes('李叔')), labels().join(' | '));
  });

  test('折叠时用闭合文件夹图标', () => {
    assert.ok(labels().some((l) => l.startsWith('📁 配角')));
  });

  test('展开后出现子节点', () => {
    ui.clickEl(dirLabel('配角'));
    assert.ok(labels().some((l) => l.includes('李叔')), labels().join(' | '));
  });

  test('展开时用打开文件夹图标', () => {
    assert.ok(labels().some((l) => l.startsWith('📂 配角')));
  });

  // 层级靠 paddingLeft 表达（DOM 是扁平的），每层 14px。
  const padOf = (text) => {
    const row = [...charactersGroup().querySelectorAll('.row')].find((n) => n.textContent.includes(text));
    return row ? parseInt(row.style.paddingLeft, 10) : -1;
  };

  test('第 0 层缩进 16px', () => {
    assert.equal(padOf('林昭'), 16, String(padOf('林昭')));
  });

  test('第 1 层缩进 30px', () => {
    assert.equal(padOf('李叔'), 30, String(padOf('李叔')));
  });

  // 章节列表不折目录：五行（一个章号一行）一律 16px，与正文在 chapters/ 下的层级无关。
  test('章节行一律是第 0 层缩进', () => {
    const rows = chapterRowsOf(ui);
    assert.ok(
      rows.length === 5 && rows.every((r) => parseInt(r.style.paddingLeft, 10) === 16),
      `${rows.length} 行：${rows.map((r) => r.style.paddingLeft).join('|')}`
    );
  });

  // 折叠状态是前端自己的，全量推送不该把它重置掉。
  test('重推数据后保持展开状态', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    assert.ok(labels().some((l) => l.includes('李叔')), labels().join(' | '));
  });
});

/*
 * 「故事架构」组：小说配置 / 故事前提 / 角色图谱 / 世界观 / 情节大纲。
 *
 * 它是后面一切的上游（写正文要读前提、角色与世界观），所以排在章节组之前，
 * 组标题直接报「填了几件」——缺哪件，全书状态机的主按钮就推哪件。
 */
describe('「故事架构」组', { skip: JSDOM_SKIP }, () => {
  let ui;
  const group = () =>
    [...ui.doc.querySelectorAll('#projectBody .group')]
      .find((g) => g.querySelector('.group-name')?.textContent === '故事架构');
  const rows = () => [...group().querySelectorAll('.row-architecture')];
  const row = (label) => rows().find((r) => r.querySelector('.row-label')?.textContent === label);
  const groupMeta = () => group().querySelector('.group-head .meta').textContent;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('有「故事架构」这一组', () => {
    assert.ok(group(), [...ui.doc.querySelectorAll('#projectBody .group-name')].map((n) => n.textContent).join('|'));
  });

  test('排在章节组之前（它是章节的上游）', () => {
    const names = [...ui.doc.querySelectorAll('#projectBody .group-name')].map((n) => n.textContent);
    assert.ok(names.indexOf('故事架构') < names.indexOf('章节'), names.join('|'));
  });

  // 顺序即生成顺序：每一件都吃前面几件的产出。
  test('五行，顺序即生成顺序', () => {
    assert.deepEqual(
      rows().map((r) => r.querySelector('.row-label').textContent),
      ['小说配置', '故事前提', '角色图谱', '世界观', '情节大纲']
    );
  });

  // 夹具里世界观还没写，其余四件都填过。
  test('组标题报填了几件（x/5）', () => {
    assert.equal(groupMeta(), '4/5', groupMeta());
  });

  test('填过的那一件打实心点', () => {
    const dot = row('小说配置').querySelector('.dot');
    assert.equal(dot.textContent, '●', dot.outerHTML);
    assert.ok(!dot.classList.contains('stale'), dot.className);
  });

  test('没填的那一件打空心点', () => {
    const dot = row('世界观').querySelector('.dot');
    assert.equal(dot.textContent, '○', dot.outerHTML);
    assert.ok(dot.classList.contains('stale'), dot.className);
  });

  // 副标题由后端给（「2 人」「覆盖到第 20 章」「待生成」），前端只渲染。
  test('情节大纲的副标题报覆盖到第几章', () => {
    assert.equal(row('情节大纲').querySelector('.row-detail')?.textContent, '覆盖到第 20 章',
      row('情节大纲').outerHTML);
  });

  test('角色图谱的副标题报人数', () => {
    assert.equal(row('角色图谱').querySelector('.row-detail')?.textContent, '2 人', row('角色图谱').outerHTML);
  });

  test('没填的那一件说「待生成」', () => {
    assert.equal(row('世界观').querySelector('.row-detail')?.textContent, '待生成', row('世界观').outerHTML);
  });

  // 架构行复用章节行的样式，但它们不是一章：不带 data-plot（摘要浮窗认的就是它）。
  test('架构行不带章节行的抓手', () => {
    assert.ok(rows().every((r) => r.dataset.plot === undefined), rows().map((r) => r.outerHTML).join('\n'));
  });

  // 与「去写这一章」同一个道理：第一件还没填的那一行给「去生成」，全组只有这一颗。
  test('只有第一件没填的那一行有「去生成」', () => {
    const go = rows().filter((r) => r.querySelector('.row-go'));
    assert.equal(go.length, 1, String(go.length));
    assert.equal(go[0], row('世界观'));
    assert.equal(go[0].querySelector('.row-go').textContent, '去生成');
  });

  // 它只是「进入这一层」：真正花钱的那一下仍是对话页的主按钮。
  test('点「去生成」进入那一层，不直接开写', () => {
    ui.sent.length = 0;
    ui.clickEl(row('世界观').querySelector('.row-go'));
    assert.equal(JSON.stringify(ui.last('setTarget')?.target), JSON.stringify({ kind: 'setting', doc: 'world' }), JSON.stringify(ui.sent));
    assert.ok(!ui.sent.some((m) => m.type === 'send'), JSON.stringify(ui.sent));
  });

  // 点名字 = 打开那份文件，与章节行同一个习惯。
  test('点文档名打开那份文件', () => {
    ui.sent.length = 0;
    ui.clickEl(row('故事前提').querySelector('.row-label'));
    assert.equal(ui.last('openFile')?.path, '.novelforge/premise.md', JSON.stringify(ui.sent));
  });

  // 角色图谱没有自己的文件（它就是 characters/ 下那一组卡）：点它是进入那一层，
  // 打开一个目录在编辑器里什么都看不到。
  test('点「角色图谱」进入那一层，不打开文件', () => {
    ui.sent.length = 0;
    ui.clickEl(row('角色图谱').querySelector('.row-label'));
    const t = ui.last('setTarget');
    assert.ok(t, JSON.stringify(ui.sent));
    // 逐字段比：target 是在 jsdom 那个 realm 里造的，原型不同，deepStrictEqual 会判不等。
    assert.equal(t.target.kind, 'setting', JSON.stringify(t));
    assert.equal(t.target.doc, 'characters', JSON.stringify(t));
    assert.ok(!ui.last('openFile'), JSON.stringify(ui.sent));
  });

  let worldItems;
  test('没填的那一件右键给「进入这一层（去生成）」', () => {
    worldItems = ui.itemsOf(ui.rightClick(row('世界观')));
    assert.ok(worldItems.includes('进入这一层（去生成）'), JSON.stringify(worldItems));
  });

  test('有文件的那一件右键也给「打开」', () => {
    assert.ok(worldItems.includes('打开'), JSON.stringify(worldItems));
  });

  // 四件文档与大纲是工程的固定文件：改名或删掉，状态机就认不出它们了。
  test('架构行不给重命名 / 删除 / 移动', () => {
    assert.ok(
      !['重命名', '删除（移到回收站）', '移动到…'].some((l) => worldItems.includes(l)),
      JSON.stringify(worldItems)
    );
    ui.closeMenu();
  });

  test('「进入这一层」发 setTarget，带的是那一件文档', () => {
    ui.pick(ui.rightClick(row('世界观')), '进入这一层（去生成）');
    const t = ui.last('setTarget');
    assert.equal(t?.target.kind, 'setting', JSON.stringify(t));
    assert.equal(t?.target.doc, 'world', JSON.stringify(t));
  });

  // 填过的那一件，进去多半是要讨论或重写，菜单上说的是这件事。
  test('情节大纲进入的是大纲层', () => {
    ui.pick(ui.rightClick(row('情节大纲')), '进入这一层（讨论 / 重写）');
    const t = ui.last('setTarget');
    assert.equal(t?.target.kind, 'outline', JSON.stringify(t));
  });

  test('角色图谱的菜单没有「打开」', () => {
    const items = ui.itemsOf(ui.rightClick(row('角色图谱')));
    assert.ok(!items.includes('打开'), JSON.stringify(items));
    assert.ok(items.includes('进入这一层（讨论 / 重写）'), JSON.stringify(items));
    ui.closeMenu();
  });

  test('全部填满后组标题是 5/5', () => {
    const full = sampleTree();
    full.architecture = full.architecture.map((a) => ({ ...a, filled: true }));
    ui.post({ type: 'project', tree: full });
    assert.equal(groupMeta(), '5/5', groupMeta());
  });
});

/*
 * 章节组：**一个章号一行**。细纲号 = 章号，所以一行同时报细纲与正文两面：
 * 徽章说这一章该做哪一步，字数写着「写了多少 / 目标多少」，⟳ 说上游变过，
 * 行首圆点说定稿没有。
 */
describe('章节组：一个章号一行', { skip: JSDOM_SKIP }, () => {
  let ui;
  const plotRow = (text) => chapterRowsOf(ui).find((n) => n.textContent.includes(text));
  // 只数章节行上的：故事架构那一组有自己的「去生成」。
  const goBtns = () => [...ui.doc.querySelectorAll('#projectBody .row-plot:not(.row-architecture) .row-go')];
  const metaOf = (text) => plotRow(text).querySelector('.meta').textContent;
  const plotGroupMeta = () =>
    [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '章节')
      .querySelector('.meta').textContent;

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('每个章号一行，按章号升序', () => {
    assert.deepEqual(
      chapterRowsOf(ui).map((r) => r.querySelector('.row-label').textContent),
      ['第 1 章《楔子》', '第 2 章《入镇》', '第 3 章《夜访》', '第 4 章《北行》', '第 5 章《赤星》']
    );
  });

  // data-plot 是这一章在协议上的身份（悬停要摘要、selectPlot 都拿它）：
  // 有正文就是正文，否则是细纲。
  test('有正文的章，行的身份是正文路径', () => {
    assert.equal(plotRow('楔子').dataset.plot, 'chapters/001-楔子.md');
  });

  test('还没写正文的章，行的身份是细纲路径', () => {
    assert.equal(plotRow('北行').dataset.plot, '.novelforge/plots/004-北行.md');
  });

  // 从前这里还带「· 待写 N 段」——剧情段没了，只剩章数与字数。
  test('组标题报章数与字数', () => {
    assert.equal(plotGroupMeta(), '3 章 · 3580 字', plotGroupMeta());
  });

  // ---- 「去写这一章」：树行一律不挂行内按钮，这是唯一的例外（W2）
  test('只有下一个该写的章有「去写这一章」', () => {
    assert.equal(goBtns().length, 1, String(goBtns().length));
    assert.equal(goBtns()[0].closest('.row-plot'), plotRow('北行'), goBtns()[0].closest('.row-plot')?.outerHTML);
  });

  test('那一行带 row-next 标记', () => {
    assert.ok(plotRow('北行').classList.contains('row-next'));
    assert.equal(chapterRowsOf(ui).filter((r) => r.classList.contains('row-next')).length, 1);
  });

  // 它只是「进入这一章」：真正花钱的那一下仍是对话页的主按钮（第 20 条：只推一个）。
  test('点「去写这一章」发 selectPlot，带的是这一章的主路径', () => {
    ui.sent.length = 0;
    ui.clickEl(goBtns()[0]);
    const sel = ui.last('selectPlot');
    assert.ok(sel, JSON.stringify(ui.sent));
    assert.equal(sel.plotRelPath, '.novelforge/plots/004-北行.md', JSON.stringify(sel));
  });

  test('点「去写这一章」不顺手打开文件，也不直接开写', () => {
    assert.ok(!ui.sent.some((m) => m.type === 'openFile' || m.type === 'send' || m.type === 'sendAgent'),
      JSON.stringify(ui.sent));
  });

  // 按钮落在哪一行完全听后端的 nextChapterNo，前端不自己数「第一个没写的」。
  test('按钮跟着 nextChapterNo 走', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), nextChapterNo: 5 } });
    assert.equal(goBtns().length, 1, String(goBtns().length));
    assert.equal(goBtns()[0].closest('.row-plot'), plotRow('赤星'));
  });

  // 下一个该写的章还没有细纲也没有正文时，列表里没有那一行——也就没有按钮，不补空行。
  test('那一章不在列表里时一颗都不挂', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), nextChapterNo: 6 } });
    assert.equal(goBtns().length, 0, String(goBtns().length));
    ui.post({ type: 'project', tree: sampleTree() });
  });

  // ---- 徽章：这一章现在该做哪一步
  test('待写正文的章挂「待写正文」', () => {
    assert.equal(plotRow('北行').querySelector('.row-stage')?.textContent, '待写正文');
  });

  test('细纲只有骨架的章挂「待写细纲」', () => {
    assert.equal(plotRow('赤星').querySelector('.row-stage')?.textContent, '待写细纲');
  });

  test('写够了没定稿的章挂「待定稿」', () => {
    assert.equal(plotRow('入镇').querySelector('.row-stage')?.textContent, '待定稿');
  });

  // 一列「已完成」只是噪声。
  test('已完成的章不挂徽章', () => {
    assert.equal(plotRow('楔子').querySelector('.row-stage'), null, plotRow('楔子').outerHTML);
  });

  test('徽章的 tooltip 报三段完成度', () => {
    const title = plotRow('北行').querySelector('.row-stage').title;
    assert.ok(title.includes('细纲 100%') && title.includes('正文 0%') && title.includes('定稿 0%'), title);
  });

  // ⟳ 不是错误，是「回头看一眼」：大纲里覆盖这一章的那一节改过。
  test('上游变过的章挂 ⟳', () => {
    assert.ok(plotRow('北行').querySelector('.row-upstream'), plotRow('北行').outerHTML);
  });

  test('上游没变的章不挂 ⟳', () => {
    assert.equal(plotRow('楔子').querySelector('.row-upstream'), null);
  });

  // ---- 字数：「2980 / 3000」比单报字数多说一件事——写够没有
  test('有目标字数时报「写了多少 / 目标多少」', () => {
    assert.ok(metaOf('入镇').includes('2980 / 3000'), metaOf('入镇'));
  });

  test('没有目标字数时只报字数', () => {
    assert.ok(metaOf('夜访').startsWith('300 字'), metaOf('夜访'));
  });

  test('还没写正文报「未写」', () => {
    assert.ok(metaOf('北行').startsWith('未写'), metaOf('北行'));
  });

  test('已有草稿的章行带标记', () => {
    assert.ok(metaOf('楔子').includes('· 草稿'), metaOf('楔子'));
  });

  test('没写正文的章不带草稿标记', () => {
    assert.ok(!metaOf('北行').includes('· 草稿'), metaOf('北行'));
  });

  // ---- 行首圆点：定稿（摘要）新鲜度
  test('定稿过的章打实心点', () => {
    assert.equal(plotRow('楔子').querySelector('.dot').textContent, '●');
  });

  test('写了没定稿的章打空心点', () => {
    const dot = plotRow('入镇').querySelector('.dot');
    assert.ok(dot.textContent === '○' && dot.classList.contains('stale'), dot.outerHTML);
  });

  // 还没写正文的章没有摘要可言——那不是「过期」，是还没到那一步。
  test('还没写正文的章不算过期', () => {
    const dot = plotRow('北行').querySelector('.dot');
    assert.ok(dot.textContent === '·' && !dot.classList.contains('stale'), dot.outerHTML);
  });

  test('没有章节时说清先做什么', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), plots: [], plotCount: 0, chapterCount: 0, totalWords: 0 } });
    const hint = [...ui.doc.querySelectorAll('#projectBody .group')]
      .find((g) => g.querySelector('.group-name')?.textContent === '章节')
      .querySelector('.row-empty');
    assert.ok(hint && hint.textContent.includes('故事架构'), hint && hint.textContent);
    ui.post({ type: 'project', tree: sampleTree() });
  });
});

describe('工程页的右键菜单', { skip: JSDOM_SKIP }, () => {
  let ui;
  let doneItems;
  let legacyItems;
  let planningItems;
  let folderItems;
  let fileItems;
  let groupHead;
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const plotRow = (text) => chapterRowsOf(ui).find((n) => n.textContent.includes(text));
  const dirLabel = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .row-dir-label')].find((n) => n.textContent.includes(name));

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  // 页面整洁：故事架构 / 章节 / 角色三个区的行不挂行内操作按钮。例外只有两颗：
  // 下一个该写的章那颗「去写这一章」与第一件没填的架构文档那颗「去生成」（W2）
  // ——各自全组只有一颗，不会变成一排按钮。
  // （「文风与摘要」不是文件管理区，它的「重建」「从正文提取」链接照旧留在行内。）
  test('树上的行没有行内操作区', () => {
    const treeRows = [...ui.doc.querySelectorAll('#projectBody .group')]
      .slice(0, 3)
      .flatMap((g) => [...g.querySelectorAll('.row')]);
    assert.ok(treeRows.length > 0 && treeRows.every((r) => !r.querySelector('.row-actions')),
      `${treeRows.length} 行`);
  });

  test('树上的行里只有「去生成」与「去写这一章」两颗按钮', () => {
    const buttons = [...ui.doc.querySelectorAll('#projectBody .group')]
      .slice(0, 3)
      .flatMap((g) => [...g.querySelectorAll('.row button')]);
    assert.deepEqual(buttons.map((b) => b.textContent), ['去生成', '去写这一章']);
  });

  test('分组标题栏不再有「＋」按钮', () => {
    assert.ok(!ui.doc.querySelector('#projectBody .group-head .row-actions'));
  });

  // ---- 写完且定稿过的章（第 1 章）：细纲、正文、摘要、草稿都在，菜单最全。
  test('右键章节行弹出菜单', () => {
    doneItems = ui.itemsOf(ui.rightClick(plotRow('楔子')));
    assert.ok(doneItems.length > 0);
  });

  // 「进入这一章」与「打开正文」是两件事：前者把创作页切到这一章当前该做
  // 的那一层，后者只是读文件。
  for (const label of ['进入这一章', '打开正文', '打开细纲', '重新定稿', '看摘要',
    '打开草稿', '重命名', '删除（移到回收站）']) {
    test(`定稿过的章菜单含「${label}」`, () => {
      assert.ok(doneItems.includes(label), JSON.stringify(doneItems));
    });
  }

  // 打开哪一份与点名字同序（正文 → 细纲）：点行做的那件事在菜单里排第一。
  test('「打开正文」排在「打开细纲」前面', () => {
    assert.ok(doneItems.indexOf('打开正文') < doneItems.indexOf('打开细纲'), JSON.stringify(doneItems));
  });

  // 顺序由章号决定——把一章挪进子目录只会让它从列表上消失，所以不给这一项。
  test('章节菜单没有「移动到…」', () => {
    assert.ok(!doneItems.includes('移动到…'), JSON.stringify(doneItems));
  });

  // 两层入口：状态机只给「该做的下一步」，而作者常要回头改上一层。
  for (const label of ['细纲（100%）', '正文（100%）']) {
    test(`章节菜单含两层入口「${label}」`, () => {
      assert.ok(doneItems.includes(label), JSON.stringify(doneItems));
    });
  }

  test('章节菜单不再有场景入口', () => {
    assert.ok(!doneItems.some((x) => x.includes('场景')), JSON.stringify(doneItems));
  });

  // 点章名 = 打开这一章（W6 章节工作台）：正文在主区、细纲并排在旁边。开几份、开在哪
  // 由后端按宿主的能力定（有没有「并排打开」），前端只说是哪一章——两个壳发的是同一条。
  test('点章节名发 openChapter，带这一行的主路径', () => {
    ui.closeMenu();
    ui.clickEl(plotRow('楔子').querySelector('.row-label'));
    const open = ui.last('openChapter');
    assert.ok(open, '没发出 openChapter');
    assert.equal(open.plotRelPath, 'chapters/001-楔子.md', JSON.stringify(open));
  });

  test('还没写正文的章也发 openChapter（后端只开细纲）', () => {
    ui.clickEl(plotRow('北行').querySelector('.row-label'));
    assert.equal(ui.last('openChapter').plotRelPath, '.novelforge/plots/004-北行.md');
  });

  test('点章节名不再切到对话页', () => {
    ui.sent.length = 0;
    ui.clickEl(plotRow('楔子').querySelector('.row-label'));
    assert.ok(!ui.sent.some((m) => m.type === 'selectPlot'), JSON.stringify(ui.sent));
  });

  // selectPlot 带的是主路径：后端按章号认，正文路径与细纲路径认到的是同一章。
  test('「进入这一章」发 selectPlot，带的是主路径', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '进入这一章');
    const sel = ui.last('selectPlot');
    assert.equal(sel?.plotRelPath, 'chapters/001-楔子.md', JSON.stringify(sel));
  });

  // 两层入口的 target 一律是**细纲路径**（CreationTarget 按细纲认章），
  // 哪怕这一行的主路径是正文。
  test('两层入口发 setTarget，带的是细纲路径', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '正文（100%）');
    const t = ui.last('setTarget');
    assert.ok(t, '没发出 setTarget');
    // 逐字段比：target 是在 jsdom 那个 realm 里造的，原型不是本 realm 的
    // Object.prototype，deepStrictEqual 会因此判不等。
    assert.equal(t.target.kind, 'manuscript', JSON.stringify(t));
    assert.equal(t.target.plotRelPath, '.novelforge/plots/001-楔子.md', JSON.stringify(t));
  });

  // 定稿（本期只生成摘要）读的是正文，所以带的必须是 chapters/ 那条路径。
  test('「重新定稿」发 finalizeChapter，带的是章节路径', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '重新定稿');
    const msg = ui.last('projectAction');
    assert.ok(msg, '没发出 projectAction');
    assert.equal(msg.action, 'finalizeChapter', JSON.stringify(msg));
    assert.equal(msg.relPath, 'chapters/001-楔子.md', JSON.stringify(msg));
  });

  test('点「打开草稿」发 openDraft，带的是章节路径', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '打开草稿');
    const draftMsg = ui.last('openDraft');
    assert.ok(draftMsg, '没发出 openDraft');
    assert.equal(draftMsg.path, 'chapters/001-楔子.md', JSON.stringify(draftMsg));
  });

  test('点删除发 fileAction，带的是主路径', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '删除（移到回收站）');
    const del = ui.last('fileAction');
    assert.ok(del, '没发出 fileAction');
    assert.equal(del.action, 'delete', JSON.stringify(del));
    assert.equal(del.relPath, 'chapters/001-楔子.md', JSON.stringify(del));
  });

  test('点完菜单关闭', () => {
    assert.ok(!ui.doc.querySelector('.ctx-menu'));
  });

  test('「重命名」发 fileAction', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '重命名');
    assert.equal(ui.last('fileAction').action, 'rename');
  });

  // ---- 老工程里只有正文、没有细纲的章（第 2 章）：写够了，等着定稿。
  test('没有细纲的章不给「打开细纲」', () => {
    legacyItems = ui.itemsOf(ui.rightClick(plotRow('入镇')));
    assert.ok(!legacyItems.includes('打开细纲'), JSON.stringify(legacyItems));
    assert.ok(legacyItems.includes('打开正文'), JSON.stringify(legacyItems));
  });

  test('没定稿的章给「定稿（生成摘要）」', () => {
    assert.ok(legacyItems.includes('定稿（生成摘要）'), JSON.stringify(legacyItems));
    assert.ok(!legacyItems.includes('重新定稿'), JSON.stringify(legacyItems));
  });

  test('没有草稿时给「新建草稿」', () => {
    assert.ok(legacyItems.includes('新建草稿'), JSON.stringify(legacyItems));
    ui.closeMenu();
  });

  test('「定稿（生成摘要）」发 finalizeChapter，带的是章节路径', () => {
    ui.pick(ui.rightClick(plotRow('入镇')), '定稿（生成摘要）');
    const msg = ui.last('projectAction');
    assert.equal(msg?.action, 'finalizeChapter', JSON.stringify(msg));
    assert.equal(msg?.relPath, 'chapters/002-入镇.md', JSON.stringify(msg));
  });

  // 没有细纲时「细纲」那一层仍然进得去：落点是它**应在**的位置，进去就是补细纲。
  test('没有细纲的章点「细纲」切到它应在的位置', () => {
    ui.pick(ui.rightClick(plotRow('入镇')), '细纲（0%）');
    const t = ui.last('setTarget');
    assert.equal(t?.target.kind, 'plot', JSON.stringify(t));
    assert.equal(t?.target.plotRelPath, '.novelforge/plots/002-入镇.md', JSON.stringify(t));
  });

  // ---- 细纲排好、还没写正文的章（第 4 章）：正文那几项都没有。
  test('没写正文的章菜单只给「打开细纲」', () => {
    planningItems = ui.itemsOf(ui.rightClick(plotRow('北行')));
    assert.ok(planningItems.includes('打开细纲'), JSON.stringify(planningItems));
    assert.ok(!planningItems.includes('打开正文'), JSON.stringify(planningItems));
  });

  // 定稿、看摘要、草稿读的都是正文——没有正文就无从谈起。
  for (const label of ['重新定稿', '定稿（生成摘要）', '看摘要', '打开草稿', '新建草稿']) {
    test(`没写正文的章菜单不含「${label}」`, () => {
      assert.ok(!planningItems.includes(label), JSON.stringify(planningItems));
    });
  }

  test('没写正文的章菜单仍有「进入这一章」与两层入口', () => {
    for (const label of ['进入这一章', '细纲（100%）', '正文（0%）']) {
      assert.ok(planningItems.includes(label), JSON.stringify(planningItems));
    }
    ui.closeMenu();
  });

  test('没写正文的章「进入这一章」带的是细纲路径', () => {
    ui.pick(ui.rightClick(plotRow('北行')), '进入这一章');
    assert.equal(ui.last('selectPlot')?.plotRelPath, '.novelforge/plots/004-北行.md');
  });

  test('没写正文的章删除落在细纲上', () => {
    ui.pick(ui.rightClick(plotRow('北行')), '删除（移到回收站）');
    assert.equal(ui.last('fileAction')?.relPath, '.novelforge/plots/004-北行.md');
  });

  // ---- 文件夹行：「在此新建」的落点必须是这个文件夹，不是区根目录。
  test('文件夹菜单含「在此新建角色卡」', () => {
    folderItems = ui.itemsOf(ui.rightClick(rowWith('配角')));
    assert.ok(folderItems.includes('在此新建角色卡'), JSON.stringify(folderItems));
  });

  test('文件夹菜单含折叠项', () => {
    assert.ok(folderItems.includes('展开') || folderItems.includes('折叠'), JSON.stringify(folderItems));
  });

  test('文件夹的「在此新建角色卡」带 dir', () => {
    ui.pick(ui.doc.querySelector('.ctx-menu'), '在此新建角色卡');
    const add = ui.last('projectAction');
    assert.ok(add, '没发出 projectAction');
    assert.equal(add.action, 'newCharacter', JSON.stringify(add));
    assert.equal(add.dir, '.novelforge/characters/配角', JSON.stringify(add));
  });

  test('「在此新建文件夹」带 dir', () => {
    ui.pick(ui.rightClick(rowWith('配角')), '在此新建文件夹');
    const mk = ui.last('projectAction');
    assert.ok(mk, '没发出 projectAction');
    assert.equal(mk.action, 'newFolder', JSON.stringify(mk));
    assert.equal(mk.dir, '.novelforge/characters/配角', JSON.stringify(mk));
  });

  // ---- 角色文件行
  test('角色行菜单含打开与三个类文件操作', () => {
    ui.clickEl(dirLabel('配角'));
    fileItems = ui.itemsOf(ui.rightClick(rowWith('林昭')));
    assert.ok(['打开', '重命名', '移动到…', '删除（移到回收站）'].every((l) => fileItems.includes(l)),
      JSON.stringify(fileItems));
  });

  test('角色行菜单没有「在此新建」', () => {
    assert.ok(!fileItems.some((l) => l.startsWith('在此新建')));
    ui.closeMenu();
  });

  // 点文件名仍走 openPath：插件的 body 没有 #wbEditor，应当发 openFile。
  test('点角色名发 openFile（插件壳无内置编辑器）', () => {
    ui.clickEl([...ui.doc.querySelectorAll('#projectBody .row-label')].find((n) => n.textContent === '林昭'));
    const open = ui.last('openFile');
    assert.ok(open, '没发出 openFile');
    assert.equal(open.path, '.novelforge/characters/林昭.md', JSON.stringify(open));
  });

  // ---- 分组标题栏：落点是该区根目录。
  // 注意用精确匹配取分组名：「出场人物 · 未建卡」也含「角色」二字之外的字样，
  // 而角色区标题就是「角色」，includes 在两组都在时会撞上第一个。
  test('分组标题栏的新建落点为区根目录', () => {
    groupHead = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '角色');
    ui.pick(ui.rightClick(groupHead), '在此新建角色卡');
    const rootAdd = ui.last('projectAction');
    assert.equal(rootAdd.action, 'newCharacter', JSON.stringify(rootAdd));
    assert.equal(rootAdd.dir, '.novelforge/characters', JSON.stringify(rootAdd));
  });

  // ---- 「文风与摘要」是工程固定文件，不能重命名/删除。情节大纲已经挪进「故事架构」
  // 那一组，这里拿文风指南那一行验。
  let metaItems;
  test('固定元数据行的菜单没有重命名/删除', () => {
    metaItems = ui.itemsOf(ui.rightClick(rowWith('文风指南')));
    assert.ok(!metaItems.includes('重命名') && !metaItems.includes('删除（移到回收站）'),
      JSON.stringify(metaItems));
  });

  test('固定元数据行的菜单有打开与刷新', () => {
    assert.ok(metaItems.includes('打开') && metaItems.includes('刷新'), JSON.stringify(metaItems));
  });

  // ---- 角色分组：批量更新/重建。
  let charItems;
  test('角色分组菜单含批量项', () => {
    charItems = ui.itemsOf(ui.rightClick(groupHead));
    assert.ok(charItems.includes('更新所有角色卡') && charItems.includes('从头重建所有角色卡'),
      JSON.stringify(charItems));
  });

  test('角色分组菜单仍含新建项', () => {
    assert.ok(charItems.includes('在此新建角色卡'), JSON.stringify(charItems));
  });

  test('「更新所有角色卡」发 updateAllCards', () => {
    ui.pick(ui.rightClick(groupHead), '更新所有角色卡');
    const upAll = ui.last('characterAction');
    assert.ok(upAll, '没发出 characterAction');
    assert.equal(upAll.action, 'updateAllCards', JSON.stringify(upAll));
  });

  test('「从头重建」发 rebuildAllCards', () => {
    ui.pick(ui.rightClick(groupHead), '从头重建所有角色卡');
    const reAll = ui.last('characterAction');
    assert.ok(reAll, '没发出 characterAction');
    assert.equal(reAll.action, 'rebuildAllCards', JSON.stringify(reAll));
    ui.closeMenu();
  });

  // ---- 设定分组：全书自动生成入口与手动新建并存。
  let loreHead;
  let loreItems;
  test('设定分组菜单含自动生成入口', () => {
    loreHead = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '设定');
    loreItems = ui.itemsOf(ui.rightClick(loreHead));
    assert.ok(loreItems.includes('从已写正文生成/更新设定'), JSON.stringify(loreItems));
  });

  test('设定分组菜单仍含手动新建', () => {
    assert.ok(loreItems.includes('在此新建设定'), JSON.stringify(loreItems));
  });

  test('自动生成设定发 generateLore', () => {
    ui.pick(ui.rightClick(loreHead), '从已写正文生成/更新设定');
    const generateLore = ui.last('projectAction');
    assert.ok(generateLore, '没发出 projectAction');
    assert.equal(generateLore.action, 'generateLore', JSON.stringify(generateLore));
    ui.closeMenu();
  });

  // ---- 章节分组：两个新建项 + 两个批量动作。
  // 章节组没有 section（`plots/` 不是作者的文件管理区，不给「新建文件夹」），
  // 所以它的菜单全部来自 extraItems，分隔线要自己写。
  let plotHead;
  let plotGroupItems;
  test('章节分组菜单含两个新建项与两个批量动作', () => {
    plotHead = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '章节');
    plotGroupItems = ui.itemsOf(ui.rightClick(plotHead));
    for (const label of ['新建细纲（接在最后一章之后）', '新建章节文件（直接粘正文用）',
      '批量拆细纲…', '批量写正文（只补缺）']) {
      assert.ok(plotGroupItems.includes(label), JSON.stringify(plotGroupItems));
    }
  });

  // 批量拆场景随场景层一起删掉了。忘记删的话菜单里会多一条点了会炸的项。
  test('章节分组菜单不再有批量拆场景', () => {
    assert.ok(!plotGroupItems.some((x) => x.includes('拆分场景')), JSON.stringify(plotGroupItems));
  });

  test('章节分组菜单没有「在此新建文件夹」', () => {
    assert.ok(!plotGroupItems.includes('在此新建文件夹'), JSON.stringify(plotGroupItems));
    ui.closeMenu();
  });

  for (const [label, action] of [
    ['新建细纲（接在最后一章之后）', 'newPlot'],
    ['新建章节文件（直接粘正文用）', 'newChapter'],
    ['批量写正文（只补缺）', 'writeManuscripts'],
  ]) {
    test(`「${label}」发 ${action}`, () => {
      ui.pick(ui.rightClick(plotHead), label);
      const msg = ui.last('projectAction');
      assert.ok(msg, '没发出 projectAction');
      assert.equal(msg.action, action, JSON.stringify(msg));
      ui.closeMenu();
    });
  }

  // 工具栏上的「新建」与分组菜单是同一件事：新建的是下一个没有细纲的章的细纲。
  test('工具栏「＋ 新建细纲」发 newPlot', () => {
    const btn = [...ui.doc.querySelectorAll('#projectToolbar [data-action]')]
      .find((b) => b.dataset.action === 'newPlot');
    assert.ok(btn, ui.doc.getElementById('projectToolbar').outerHTML);
    assert.ok(btn.textContent.includes('新建细纲'), btn.textContent);
    ui.clickEl(btn);
    assert.equal(ui.last('projectAction')?.action, 'newPlot');
  });
});

describe('右键菜单的通用行为', { skip: JSDOM_SKIP }, () => {
  let ui;
  let historyMenu;

  before(() => {
    ui = mount();
  });

  // 其它页面只要基础刷新。
  test('历史页右键弹出菜单', () => {
    historyMenu = ui.rightClick(ui.doc.getElementById('pane-history'));
    assert.ok(historyMenu);
  });

  test('历史页菜单只有「刷新」', () => {
    assert.deepEqual(ui.itemsOf(historyMenu), ['刷新'], JSON.stringify(ui.itemsOf(historyMenu)));
  });

  test('点「刷新」发 projectAction refresh', () => {
    ui.clickEl(historyMenu.querySelector('button'));
    const refresh = ui.last('projectAction');
    assert.ok(refresh, '没发出 projectAction');
    assert.equal(refresh.action, 'refresh', JSON.stringify(refresh));
  });

  test('设置页右键也给刷新', () => {
    assert.ok(ui.itemsOf(ui.rightClick(ui.doc.getElementById('pane-settings'))).includes('刷新'));
  });

  // 同时只允许一个菜单。
  test('同时只存在一个菜单', () => {
    ui.rightClick(ui.doc.getElementById('pane-chat'));
    assert.equal(ui.doc.querySelectorAll('.ctx-menu').length, 1);
  });

  // 用绝对定位挂在 body 上，不会被内部滚动容器裁掉。
  test('菜单挂在 body 上', () => {
    assert.equal(ui.doc.querySelector('.ctx-menu').parentElement, ui.doc.body);
  });

  test('点空白处关闭菜单', () => {
    ui.closeMenu();
    assert.ok(!ui.doc.querySelector('.ctx-menu'));
  });

  test('按 Esc 关闭菜单', () => {
    ui.rightClick(ui.doc.getElementById('pane-history'));
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!ui.doc.querySelector('.ctx-menu'));
  });

  // 气泡的 ⋯ 菜单与右键菜单是两个类名，互不干扰。
  test('⋯ 菜单仍用 .msg-menu 且贴在气泡里', () => {
    ui.post({ type: 'session', session: emptySession() });
    ui.post({ type: 'turnDone', turn: turn('u1', 'user', '写一段') });
    ui.clickEl(ui.bubble('u1').querySelector('.msg-menu-btn'));
    assert.ok(ui.doc.querySelector('.msg-menu'));
    assert.ok(!ui.doc.querySelector('.ctx-menu'));
  });

  // ⋯ 菜单挂在气泡里、跟着一起滚，不该被滚动关掉——否则流式输出贴着底
  // 跟滚时每来一段都 scrollToBottom()，菜单刚点开就没了。
  test('滚动不关闭 ⋯ 菜单', () => {
    ui.doc.getElementById('messages').dispatchEvent(new ui.window.Event('scroll', { bubbles: true }));
    assert.ok(ui.doc.querySelector('.msg-menu'));
  });

  test('右键会顶掉已打开的 ⋯ 菜单', () => {
    ui.rightClick(ui.doc.getElementById('pane-history'));
    assert.ok(!ui.doc.querySelector('.msg-menu'));
    assert.ok(ui.doc.querySelector('.ctx-menu'));
  });

  // 右键菜单是 fixed 的，一滚就和目标行脱节，必须关掉。
  test('滚动关闭右键菜单', () => {
    ui.doc.getElementById('messages').dispatchEvent(new ui.window.Event('scroll', { bubbles: true }));
    assert.ok(!ui.doc.querySelector('.ctx-menu'));
    ui.closeMenu();
  });
});

/*
 * 原生右键菜单一律不许出现。
 *
 * 触控板双指点击走的事件序列与按实体右键不一样：有的环境发 contextmenu，
 * 有的只发 auxclick；页面里任何一处 stopPropagation() 又能让冒泡阶段的监听
 * 根本轮不到。三样都得挡住，漏一样就是「弹出原生右键菜单」。
 */
describe('接管原生右键菜单', { skip: JSDOM_SKIP }, () => {
  let ui;

  before(() => {
    ui = mount();
  });

  test('contextmenu 的默认行为被挡掉', () => {
    const ev = new ui.window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 40, clientY: 60,
    });
    ui.doc.getElementById('pane-history').dispatchEvent(ev);
    assert.ok(ev.defaultPrevented, '没有 preventDefault，原生菜单会弹出来');
    ui.closeMenu();
  });

  // 监听挂在 window 的捕获阶段，所以中途 stopPropagation 也拦不住它。
  test('半路 stopPropagation 仍挡得住', () => {
    const pane = ui.doc.getElementById('pane-history');
    const swallow = (e) => e.stopPropagation();
    pane.addEventListener('contextmenu', swallow);
    const ev = new ui.window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 40, clientY: 60,
    });
    pane.dispatchEvent(ev);
    pane.removeEventListener('contextmenu', swallow);
    assert.ok(ev.defaultPrevented, '被 stopPropagation 挡掉了，原生菜单会弹出来');
    assert.ok(ui.doc.querySelector('.ctx-menu'), '菜单也没弹出来');
    ui.closeMenu();
  });

  // 只发 auxclick 的环境（部分浏览器/驱动下的双指点击）。落点与上一发不同，
  // 所以不会被「同一次点击的尾巴」那条规则吃掉。
  test('只发 auxclick 也弹自己的菜单', () => {
    const ev = ui.auxClick(ui.doc.getElementById('pane-history'), 100, 120);
    assert.ok(ev.defaultPrevented, 'auxclick 的默认行为没挡');
    assert.ok(ui.doc.querySelector('.ctx-menu'), '没弹出菜单');
  });

  // 同一次点击的尾巴：contextmenu 之后紧跟的那发 auxclick 不该再弹一遍。
  test('contextmenu 之后的 auxclick 不重复弹', () => {
    ui.closeMenu();
    const menu = ui.rightClick(ui.doc.getElementById('pane-history'));
    ui.auxClick(ui.doc.getElementById('pane-history'));
    const now = ui.doc.querySelectorAll('.ctx-menu');
    assert.equal(now.length, 1, `弹了 ${now.length} 个`);
    assert.equal(now[0], menu, '菜单被重建了一遍');
    ui.closeMenu();
  });

  // 中键（button 1）不接管：那是「新标签页打开」之类的默认行为，不是右键。
  test('中键的 auxclick 不弹菜单', () => {
    const ev = new ui.window.MouseEvent('auxclick', {
      bubbles: true, cancelable: true, button: 1, clientX: 40, clientY: 60,
    });
    ui.doc.getElementById('pane-history').dispatchEvent(ev);
    assert.ok(!ev.defaultPrevented);
    assert.ok(!ui.doc.querySelector('.ctx-menu'));
  });
});
