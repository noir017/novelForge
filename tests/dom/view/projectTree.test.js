/**
 * 工程页：目录树的展开/缩进、行与分组的右键菜单、菜单引擎的通用行为。
 *
 * 迁自 scripts/smoke-view.js 的这几节：
 *   == 工程页目录树 ==（1014） == 工程页的右键菜单 ==（1059）
 *   == 右键菜单的通用行为 ==（1324）
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, turn, emptySession, sampleTree } = require('../../helpers/dom');

describe('工程页目录树', { skip: JSDOM_SKIP }, () => {
  let ui;
  // 目录树只有**角色 / 设定**两个区有——章节列表是扁平的（规划与成品合成
  // 一行，顺序即写作顺序，折进目录反而看不出来）。
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

  // 章节列表不折目录：三章一律 16px，与它们在 chapters/ 下的层级无关。
  test('章节行一律是第 0 层缩进', () => {
    const rows = [...ui.doc.querySelectorAll('#projectBody .row-plot')];
    assert.ok(
      rows.length === 3 && rows.every((r) => parseInt(r.style.paddingLeft, 10) === 16),
      rows.map((r) => r.style.paddingLeft).join('|')
    );
  });

  // 折叠状态是前端自己的，全量推送不该把它重置掉。
  test('重推数据后保持展开状态', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    assert.ok(labels().some((l) => l.includes('李叔')), labels().join(' | '));
  });
});

describe('工程页的右键菜单', { skip: JSDOM_SKIP }, () => {
  let ui;
  let doneItems;
  let planningItems;
  let splitItems;
  let folderItems;
  let fileItems;
  let groupHead;
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const plotRow = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row-plot')].find((n) => n.textContent.includes(text));
  const dirLabel = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .row-dir-label')].find((n) => n.textContent.includes(name));

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  // 页面整洁：章节/角色/设定三个区的行不再挂任何行内按钮。
  // （「文风与摘要」不是文件管理区，它的「重建」「从正文提取」链接照旧留在行内。）
  test('树上的行不再有行内操作按钮', () => {
    const treeRows = [...ui.doc.querySelectorAll('#projectBody .group')]
      .slice(0, 3)
      .flatMap((g) => [...g.querySelectorAll('.row')]);
    assert.ok(treeRows.length > 0 && treeRows.every((r) => !r.querySelector('.row-actions')),
      `${treeRows.length} 行`);
  });

  test('分组标题栏不再有「＋」按钮', () => {
    assert.ok(!ui.doc.querySelector('#projectBody .group-head .row-actions'));
  });

  // ---- 已发布的章（第 1 章）：走完整条流水线，菜单最全。
  test('右键章节行弹出菜单', () => {
    doneItems = ui.itemsOf(ui.rightClick(plotRow('楔子')));
    assert.ok(doneItems.length > 0);
  });

  // 「进入这一章」与「打开正文」是两件事：前者把创作页切到这一章当前该做
  // 的那一层，后者只是读文件。行体主点击走前者，所以菜单里两个都要有。
  for (const label of ['进入这一章', '打开正文', '打开细纲', '重新总结', '看摘要',
    '打开草稿', '重命名', '删除（移到回收站）']) {
    test(`已发布的章菜单含「${label}」`, () => {
      assert.ok(doneItems.includes(label), JSON.stringify(doneItems));
    });
  }

  // 顺序由章号决定——把一章挪进子目录只会让它从列表上消失，所以不给这一项。
  test('章节菜单没有「移动到…」', () => {
    assert.ok(!doneItems.includes('移动到…'), JSON.stringify(doneItems));
  });

  // 三层入口：状态机只给「该做的下一步」，而作者常要回头改上一层。
  for (const label of ['剧情（100%）', '场景（100%）', '正文（100%）']) {
    test(`章节菜单含三层入口「${label}」`, () => {
      assert.ok(doneItems.includes(label), JSON.stringify(doneItems));
    });
  }

  // 已经拆分发布了，中转站那份就删了，不该再给「打开待拆分的正文」。
  test('已发布的章没有待拆分的正文项', () => {
    assert.ok(!doneItems.some((l) => l.includes('待拆分')), JSON.stringify(doneItems));
  });

  test('已发布的章没有「拆成章节」', () => {
    assert.ok(!doneItems.includes('拆成章节'), JSON.stringify(doneItems));
  });

  // 点章名 = 打开这一章的文件（这份 body 是插件壳，没有 #wbEditor → openFile）。
  test('点章节名打开成品正文', () => {
    ui.closeMenu();
    ui.clickEl(plotRow('楔子').querySelector('.row-label'));
    const open = ui.last('openFile');
    assert.ok(open, '没发出 openFile');
    assert.equal(open.path, 'chapters/001-楔子.md', JSON.stringify(open));
  });

  // 只有规划的章：没有正文可开，落到细纲。
  test('点只有规划的章名打开细纲', () => {
    ui.closeMenu();
    ui.clickEl(plotRow('入镇').querySelector('.row-label'));
    assert.equal(ui.last('openFile').path, '.novelforge/plots/002-入镇.md');
  });

  // 正文写完还躺在中转站里：打开的是那份正文，而不是主路径指的细纲——
  // 主路径只在成品与细纲之间二选一，会把几千字的正文漏掉。
  test('点待拆分的章名打开中转站正文', () => {
    ui.closeMenu();
    ui.clickEl(plotRow('夜访').querySelector('.row-label'));
    assert.equal(ui.last('openFile').path, '.novelforge/manuscripts/003-夜访.md');
  });

  test('点章节名不再切到对话页', () => {
    ui.closeMenu();
    ui.sent.length = 0;
    ui.clickEl(plotRow('楔子').querySelector('.row-label'));
    assert.ok(!ui.sent.some((m) => m.type === 'selectPlot'), JSON.stringify(ui.sent));
  });

  test('「进入这一章」发 selectPlot', () => {
    ui.pick(ui.rightClick(plotRow('入镇')), '进入这一章');
    const sel = ui.last('selectPlot');
    assert.equal(sel.plotRelPath, '.novelforge/plots/002-入镇.md', JSON.stringify(sel));
  });

  test('三层入口发 setTarget，带的是主路径', () => {
    ui.pick(ui.rightClick(plotRow('入镇')), '场景（50%）');
    const t = ui.last('setTarget');
    assert.ok(t, '没发出 setTarget');
    // 逐字段比：target 是在 jsdom 那个 realm 里造的，原型不是本 realm 的
    // Object.prototype，deepStrictEqual 会因此判不等。
    assert.equal(t.target.kind, 'scene', JSON.stringify(t));
    assert.equal(t.target.plotRelPath, '.novelforge/plots/002-入镇.md', JSON.stringify(t));
    assert.equal(t.target.sceneNo, 1, JSON.stringify(t));
  });

  // 总结读的是成品，所以带的必须是 chapters/ 那条路径。
  test('「重新总结」发 summarizePlot，带的是章节路径', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '重新总结');
    const sum = ui.last('projectAction');
    assert.ok(sum, '没发出 projectAction');
    assert.equal(sum.action, 'summarizePlot', JSON.stringify(sum));
    assert.equal(sum.relPath, 'chapters/001-楔子.md', JSON.stringify(sum));
  });

  test('已有草稿的章行带标记', () => {
    assert.ok(plotRow('楔子').textContent.includes('· 草稿'), plotRow('楔子').textContent);
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

  // ---- 只有规划的章（第 2 章）：还没写正文，也就没有成品那几项。
  test('只有规划的章菜单只给「打开细纲」', () => {
    planningItems = ui.itemsOf(ui.rightClick(plotRow('入镇')));
    assert.ok(planningItems.includes('打开细纲'), JSON.stringify(planningItems));
    assert.ok(!planningItems.includes('打开正文'), JSON.stringify(planningItems));
  });

  for (const label of ['重新总结', '总结这一章', '看摘要', '打开草稿', '新建草稿']) {
    test(`只有规划的章菜单不含「${label}」`, () => {
      assert.ok(!planningItems.includes(label), JSON.stringify(planningItems));
    });
  }

  test('只有规划的章行不带草稿标记', () => {
    assert.ok(!plotRow('入镇').textContent.includes('· 草稿'));
    ui.closeMenu();
  });

  // ---- 待拆分的章（第 3 章）：正文写完躺在中转站里，等作者标断点。
  test('待拆分的章菜单含「拆成章节」', () => {
    splitItems = ui.itemsOf(ui.rightClick(plotRow('夜访')));
    assert.ok(splitItems.includes('拆成章节'), JSON.stringify(splitItems));
  });

  test('待拆分的章能打开中转站里的正文', () => {
    assert.ok(splitItems.includes('打开正文（待拆分）'), JSON.stringify(splitItems));
  });

  // 摘要挂在成品上，还没拆分就无从总结。
  test('待拆分的章没有总结项', () => {
    assert.ok(!splitItems.some((l) => l.includes('总结')), JSON.stringify(splitItems));
    ui.closeMenu();
  });

  test('「拆成章节」发 splitManuscript，带的是细纲路径', () => {
    ui.pick(ui.rightClick(plotRow('夜访')), '拆成章节');
    const msg = ui.last('projectAction');
    assert.ok(msg, '没发出 projectAction');
    assert.equal(msg.action, 'splitManuscript', JSON.stringify(msg));
    assert.equal(msg.relPath, '.novelforge/plots/003-夜访.md', JSON.stringify(msg));
  });

  test('待拆分的章带「待拆分」徽章', () => {
    const badge = plotRow('夜访').querySelector('.row-stage');
    assert.ok(badge && badge.textContent === '待拆分', badge && badge.textContent);
  });

  test('上游变过的章挂 ⟳', () => {
    assert.ok(plotRow('入镇').querySelector('.row-upstream'), plotRow('入镇').outerHTML);
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

  // ---- 「文风与摘要」是工程固定文件，不能重命名/删除。
  let metaItems;
  test('固定元数据行的菜单没有重命名/删除', () => {
    metaItems = ui.itemsOf(ui.rightClick(rowWith('全书大纲')));
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

  // ---- 章节分组：新建一章 + 三个批量动作。
  // 章节组没有 section（`plots/` 不是作者的文件管理区，不给「新建文件夹」），
  // 所以它的菜单全部来自 extraItems，分隔线要自己写。
  let plotHead;
  let plotGroupItems;
  test('章节分组菜单含新建与三个批量动作', () => {
    plotHead = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '章节');
    plotGroupItems = ui.itemsOf(ui.rightClick(plotHead));
    for (const label of ['新建章节', '批量写剧情（只补缺）', '批量拆分场景（只补缺）', '批量写正文（只补缺）']) {
      assert.ok(plotGroupItems.includes(label), JSON.stringify(plotGroupItems));
    }
  });

  test('章节分组菜单没有「在此新建文件夹」', () => {
    assert.ok(!plotGroupItems.includes('在此新建文件夹'), JSON.stringify(plotGroupItems));
  });

  for (const [label, action] of [
    ['新建章节', 'newPlot'],
    ['批量写剧情（只补缺）', 'generatePlots'],
    ['批量拆分场景（只补缺）', 'breakdownScenes'],
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

  // ⋯ 菜单挂在气泡里、跟着一起滚，不该被滚动关掉——否则流式输出时
  // 每来一段都 scrollToBottom()，菜单刚点开就没了。
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
