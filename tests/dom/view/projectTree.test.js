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
  // 目录树只有发布区（章节）那一组有——剧情组是扁平的。剧情段与章节同名
  // （「楔子」两组各一行），所以取行必须先框到章节组里，否则折叠断言会被
  // 剧情组那一行顶掉。
  const chaptersGroup = () =>
    [...ui.doc.querySelectorAll('#projectBody .group')]
      .find((g) => g.querySelector('.group-name')?.textContent === '章节');
  const labels = () => [...chaptersGroup().querySelectorAll('.row-label')].map((n) => n.textContent);
  const dirLabel = (name) =>
    [...chaptersGroup().querySelectorAll('.row-dir-label')].find((n) => n.textContent.includes(name));

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('顶层三个节点都在', () => {
    assert.ok(
      labels().some((l) => l.includes('第一卷')) &&
      labels().some((l) => l.includes('第二卷')) &&
      labels().some((l) => l.includes('楔子')), labels().join(' | '));
  });

  test('文件夹默认折叠，不渲染子节点', () => {
    assert.ok(!labels().some((l) => l.includes('入镇')), labels().join(' | '));
  });

  test('折叠时用闭合文件夹图标', () => {
    assert.ok(labels().some((l) => l.startsWith('📁 第一卷')));
  });

  test('展开后出现子章节', () => {
    ui.clickEl(dirLabel('第一卷'));
    assert.ok(labels().some((l) => l.includes('入镇')), labels().join(' | '));
  });

  test('只展开一层，第三层仍折叠', () => {
    assert.ok(!labels().some((l) => l.includes('夜访')));
  });

  test('展开时用打开文件夹图标', () => {
    assert.ok(labels().some((l) => l.startsWith('📂 第一卷')));
  });

  test('第三层展开后出现最深的章节', () => {
    ui.clickEl(dirLabel('深处'));
    assert.ok(labels().some((l) => l.includes('夜访')));
  });

  // 层级靠 paddingLeft 表达（DOM 是扁平的），每层 14px。
  const padOf = (text) => {
    const row = [...chaptersGroup().querySelectorAll('.row')].find((n) => n.textContent.includes(text));
    return row ? parseInt(row.style.paddingLeft, 10) : -1;
  };

  test('第 0 层缩进 16px', () => {
    assert.equal(padOf('楔子'), 16, String(padOf('楔子')));
  });

  test('第 1 层缩进 30px', () => {
    assert.equal(padOf('入镇'), 30, String(padOf('入镇')));
  });

  test('第 2 层缩进 44px', () => {
    assert.equal(padOf('夜访'), 44, String(padOf('夜访')));
  });

  test('展开空文件夹给出提示', () => {
    ui.clickEl(dirLabel('第二卷'));
    assert.ok([...ui.doc.querySelectorAll('#projectBody .row-empty')].some((n) => n.textContent.includes('空文件夹')));
  });

  // 折叠状态是前端自己的，全量推送不该把它重置掉。
  test('重推数据后保持展开状态', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    assert.ok(labels().some((l) => l.includes('夜访')), labels().join(' | '));
  });
});

describe('工程页的右键菜单', { skip: JSDOM_SKIP }, () => {
  let ui;
  // 原脚本把第一次弹出的菜单节点存在 chapterMenu 里，后面「点删除」那一步
  // 复用的是这个**已经脱离文档**的旧引用（见下方注释），所以它得是块级变量。
  let chapterMenu;
  let chapterItems;
  let plotItems;
  let staleItems;
  let folderItems;
  let fileItems;
  let groupHead;
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  // 剧情段与章节同名（「楔子」在两组里各有一行），按组取才不会撞上。
  const plotRow = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row-plot')].find((n) => n.textContent.includes(text));
  const chapterRow = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row-chapter')].find((n) => n.textContent.includes(text));
  const dirLabel = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .row-dir-label')].find((n) => n.textContent.includes(name));

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
  });

  // 页面整洁：剧情/章节/角色三个区的行不再挂任何行内按钮。
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

  // ---- 剧情行：流水线的落点，全部创作动作都在这里。
  test('右键剧情行弹出菜单', () => {
    plotItems = ui.itemsOf(ui.rightClick(plotRow('楔子')));
    assert.ok(plotItems.length > 0);
  });

  // 「进入这一段」与「打开剧情」是两件事：前者把创作页切到这一段当前该做
  // 的那一层，后者只是读文件。行体主点击走前者，所以菜单里两个都要有。
  for (const label of ['进入这一段', '打开剧情', '打开正文', '重新总结', '看摘要',
    '重命名', '删除（移到回收站）']) {
    test(`剧情菜单含「${label}」`, () => {
      assert.ok(plotItems.includes(label), JSON.stringify(plotItems));
    });
  }

  // `plots/` 是扁平的，顺序由序号决定——把一段挪进子目录只会让它
  // 从流水线上消失，所以不给这一项。
  test('剧情菜单没有「移动到…」', () => {
    assert.ok(!plotItems.includes('移动到…'), JSON.stringify(plotItems));
  });

  // 三层入口：状态机只给「该做的下一步」，而作者常要回头改上一层。
  for (const label of ['剧情（100%）', '场景（100%）', '正文（100%）']) {
    test(`剧情菜单含三层入口「${label}」`, () => {
      assert.ok(plotItems.includes(label), JSON.stringify(plotItems));
    });
  }

  test('剧情菜单没有草稿项', () => {
    // 草稿是发布区章节的东西（作者手改那一份），剧情段没有。
    assert.ok(!plotItems.some((l) => l.includes('草稿')), JSON.stringify(plotItems));
  });

  test('点剧情名发 selectPlot', () => {
    ui.closeMenu();
    ui.clickEl(plotRow('楔子').querySelector('.row-label'));
    const sel = ui.last('selectPlot');
    assert.ok(sel, '没发出 selectPlot');
    assert.equal(sel.plotRelPath, '.novelforge/plots/001-楔子.md', JSON.stringify(sel));
  });

  test('「进入这一段」发 selectPlot', () => {
    ui.pick(ui.rightClick(plotRow('入镇')), '进入这一段');
    const sel = ui.last('selectPlot');
    assert.equal(sel.plotRelPath, '.novelforge/plots/002-入镇.md', JSON.stringify(sel));
  });

  test('三层入口发 setTarget，带的是段路径', () => {
    ui.pick(ui.rightClick(plotRow('入镇')), '场景（50%）');
    const t = ui.last('setTarget');
    assert.ok(t, '没发出 setTarget');
    // 逐字段比：target 是在 jsdom 那个 realm 里造的，原型不是本 realm 的
    // Object.prototype，deepStrictEqual 会因此判不等。
    assert.equal(t.target.kind, 'scene', JSON.stringify(t));
    assert.equal(t.target.plotRelPath, '.novelforge/plots/002-入镇.md', JSON.stringify(t));
    assert.equal(t.target.sceneNo, 1, JSON.stringify(t));
  });

  test('「重新总结」发 summarizePlot，带的是段路径', () => {
    ui.pick(ui.rightClick(plotRow('楔子')), '重新总结');
    const sum = ui.last('projectAction');
    assert.ok(sum, '没发出 projectAction');
    assert.equal(sum.action, 'summarizePlot', JSON.stringify(sum));
    assert.equal(sum.relPath, '.novelforge/plots/001-楔子.md', JSON.stringify(sum));
  });

  // 摘要过期的段：文案换成「总结这一段」，且没有摘要文件就不给「看摘要」。
  test('摘要过期的段显示「总结这一段」', () => {
    staleItems = ui.itemsOf(ui.rightClick(plotRow('夜访')));
    assert.ok(staleItems.includes('总结这一段'), JSON.stringify(staleItems));
  });

  test('未生成摘要的段没有「看摘要」', () => {
    assert.ok(!staleItems.includes('看摘要'), JSON.stringify(staleItems));
    ui.closeMenu();
  });

  // ---- 章节行：**纯文件**。没有徽章、没有进度，菜单也只有文件操作。
  test('右键章节行弹出菜单', () => {
    ui.clickEl(dirLabel('第一卷'));
    chapterMenu = ui.rightClick(chapterRow('楔子'));
    chapterItems = ui.itemsOf(chapterMenu);
    assert.ok(chapterMenu);
  });

  for (const label of ['打开', '重命名', '移动到…', '删除（移到回收站）']) {
    test(`章节菜单含「${label}」`, () => {
      assert.ok(chapterItems.includes(label), JSON.stringify(chapterItems));
    });
  }

  // 章节是作者从 manuscripts/ 切出来的成品，工具不分析它的内容，
  // 所以没有任何「该做什么」可说——这几项都搬到剧情行去了。
  for (const label of ['进入这一段', '打开剧情', '重新总结', '看摘要']) {
    test(`章节菜单不含「${label}」`, () => {
      assert.ok(!chapterItems.includes(label), JSON.stringify(chapterItems));
    });
  }

  test('章节菜单不含三层入口', () => {
    assert.ok(!chapterItems.some((l) => l.startsWith('场景（')), JSON.stringify(chapterItems));
  });

  test('已有草稿的章节显示「打开草稿」', () => {
    assert.ok(chapterItems.includes('打开草稿'), JSON.stringify(chapterItems));
  });

  test('已有草稿的章节不显示「新建草稿」', () => {
    assert.ok(!chapterItems.includes('新建草稿'), JSON.stringify(chapterItems));
  });

  test('菜单有分隔线', () => {
    assert.ok(chapterMenu.querySelectorAll('.menu-sep').length >= 1);
  });

  test('有草稿的章节行带标记', () => {
    assert.ok(chapterRow('楔子').textContent.includes('· 草稿'), chapterRow('楔子').textContent);
  });

  test('章节行不带流水线徽章', () => {
    assert.ok(!chapterRow('楔子').querySelector('.row-stage'), chapterRow('楔子').outerHTML);
    assert.ok(!chapterRow('楔子').querySelector('.row-upstream'));
  });

  test('点「打开草稿」发 openDraft，带的是章节路径', () => {
    ui.pick(ui.rightClick(chapterRow('楔子')), '打开草稿');
    const draftMsg = ui.last('openDraft');
    assert.ok(draftMsg, '没发出 openDraft');
    assert.equal(draftMsg.path, 'chapters/001-楔子.md', JSON.stringify(draftMsg));
  });

  // 原样保留：这里点的是**第一次**弹出的那个菜单（chapterMenu），此时它已被
  // 上一步的重新右键换掉、脱离了文档。脱离的节点上按钮处理器仍在，所以照样
  // 发得出消息——它证明的是「删除项发 fileAction」，不证明当前屏幕上那个菜单。
  test('点删除发 fileAction', () => {
    ui.pick(chapterMenu, '删除（移到回收站）');
    const del = ui.last('fileAction');
    assert.ok(del, '没发出 fileAction');
    assert.equal(del.action, 'delete', JSON.stringify(del));
    assert.equal(del.relPath, 'chapters/001-楔子.md', JSON.stringify(del));
  });

  test('点完菜单关闭', () => {
    assert.ok(!ui.doc.querySelector('.ctx-menu'));
  });

  test('「重命名」发 fileAction', () => {
    ui.pick(ui.rightClick(chapterRow('楔子')), '重命名');
    assert.equal(ui.last('fileAction').action, 'rename');
  });

  test('「移动到…」发 fileAction', () => {
    ui.pick(ui.rightClick(chapterRow('楔子')), '移动到…');
    assert.equal(ui.last('fileAction').action, 'move');
  });

  // 夜访在第三层，先展开两级。
  test('没有草稿的章节显示「新建草稿」', () => {
    ui.clickEl(dirLabel('深处'));
    const deepItems = ui.itemsOf(ui.rightClick(chapterRow('夜访')));
    assert.ok(deepItems.includes('新建草稿'), JSON.stringify(deepItems));
  });

  test('没有草稿的章节行不带标记', () => {
    assert.ok(!chapterRow('夜访').textContent.includes('· 草稿'));
    ui.closeMenu();
  });

  // ---- 文件夹行：「在此新建」的落点必须是这个文件夹，不是区根目录。
  test('文件夹菜单含「在此新建章节」', () => {
    folderItems = ui.itemsOf(ui.rightClick(rowWith('第一卷')));
    assert.ok(folderItems.includes('在此新建章节'), JSON.stringify(folderItems));
  });

  test('文件夹菜单含折叠项', () => {
    assert.ok(folderItems.includes('折叠'), JSON.stringify(folderItems));
  });

  test('文件夹的「在此新建章节」带 dir', () => {
    // 原脚本这里 pick 的也是上面存下来的 folderMenu（同一个仍在文档里的菜单）。
    ui.pick(ui.doc.querySelector('.ctx-menu'), '在此新建章节');
    const add = ui.last('projectAction');
    assert.ok(add, '没发出 projectAction');
    assert.equal(add.action, 'newChapter', JSON.stringify(add));
    assert.equal(add.dir, 'chapters/第一卷', JSON.stringify(add));
  });

  test('「在此新建文件夹」带 dir', () => {
    ui.pick(ui.rightClick(rowWith('第一卷')), '在此新建文件夹');
    const mk = ui.last('projectAction');
    assert.ok(mk, '没发出 projectAction');
    assert.equal(mk.action, 'newFolder', JSON.stringify(mk));
    assert.equal(mk.dir, 'chapters/第一卷', JSON.stringify(mk));
  });

  // ---- 角色文件行
  test('角色行菜单含打开与三个类文件操作', () => {
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

  // ---- 剧情分组：新建一段 + 三个批量动作。
  // 剧情组没有 section（`plots/` 不是作者的文件管理区，不给「新建文件夹」），
  // 所以它的菜单全部来自 extraItems，分隔线要自己写。
  let plotHead;
  let plotGroupItems;
  test('剧情分组菜单含新建与三个批量动作', () => {
    plotHead = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent === '剧情');
    plotGroupItems = ui.itemsOf(ui.rightClick(plotHead));
    for (const label of ['新建剧情段', '批量写剧情（只补缺）', '批量拆分场景（只补缺）', '批量写正文（只补缺）']) {
      assert.ok(plotGroupItems.includes(label), JSON.stringify(plotGroupItems));
    }
  });

  test('剧情分组菜单没有「在此新建文件夹」', () => {
    assert.ok(!plotGroupItems.includes('在此新建文件夹'), JSON.stringify(plotGroupItems));
  });

  for (const [label, action] of [
    ['新建剧情段', 'newPlot'],
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
