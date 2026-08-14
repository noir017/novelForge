/**
 * 角色的出场统计与更新菜单：已建卡行的出场段数与增量更新、未出场角色的
 * 说明、未建卡出场人物的独立分组、旧后端缺字段时的兼容。
 *
 * 迁自 scripts/smoke-view.js 的 == 角色的出场统计与更新菜单 ==（1216）。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

describe('角色的出场统计与更新菜单', { skip: JSDOM_SKIP }, () => {
  let ui;
  let linRow;
  let linItems;
  let liRow;
  let liItems;
  let castGroup;
  let castRow;
  let castItems;
  let legacyItems;
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const dirLabel = (name) =>
    [...ui.doc.querySelectorAll('#projectBody .row-dir-label')].find((n) => n.textContent.includes(name));

  before(() => {
    ui = mount();
    ui.post({ type: 'project', tree: sampleTree() });
    linRow = rowWith('林昭');
  });

  // ---- 已建卡的角色行：出场段数进副标题，待更新段数单独标记。
  test('角色行显示出场段数', () => {
    assert.ok(linRow.textContent.includes('出场 3 段'), linRow.textContent);
  });

  test('角色行保留原有副标题（标签）', () => {
    assert.ok(linRow.textContent.includes('主角'), linRow.textContent);
  });

  test('待更新段数有标记', () => {
    assert.ok(linRow.textContent.includes('＋2'), linRow.textContent);
  });

  test('标记带解释性 title', () => {
    assert.ok(linRow.querySelector('.cast-pending').title.includes('第 1 段'),
      linRow.querySelector('.cast-pending').title);
  });

  test('菜单含带段数的「更新角色卡」', () => {
    linItems = ui.itemsOf(ui.rightClick(linRow));
    assert.ok(linItems.includes('更新角色卡（新增 2 段）'), JSON.stringify(linItems));
  });

  test('菜单含「重新通读全部」', () => {
    assert.ok(linItems.includes('重新通读全部 3 段'), JSON.stringify(linItems));
  });

  test('菜单里能看到出场段落', () => {
    assert.ok(linItems.includes('出场：第 1、2、3 段'), JSON.stringify(linItems));
  });

  test('角色行仍有类文件操作', () => {
    assert.ok(['重命名', '移动到…', '删除（移到回收站）'].every((l) => linItems.includes(l)),
      JSON.stringify(linItems));
    ui.closeMenu();
  });

  // 增量走 updateCard，全量走 rebuildCard——两个动作不能混。
  test('「更新角色卡」发 updateCard 并带卡路径', () => {
    ui.pick(ui.rightClick(rowWith('林昭')), '更新角色卡（新增 2 段）');
    const inc = ui.last('characterAction');
    assert.ok(inc, '没发出 characterAction');
    assert.equal(inc.action, 'updateCard', JSON.stringify(inc));
    assert.equal(inc.name, '林昭', JSON.stringify(inc));
    assert.equal(inc.relPath, '.novelforge/characters/林昭.md', JSON.stringify(inc));
  });

  test('「重新通读」发 rebuildCard', () => {
    ui.pick(ui.rightClick(rowWith('林昭')), '重新通读全部 3 段');
    const full = ui.last('characterAction');
    assert.ok(full, '没发出 characterAction');
    assert.equal(full.action, 'rebuildCard', JSON.stringify(full));
  });

  // ---- 摘要里没出现过的角色：不给更新入口，说明为什么。
  test('未出场的角色行不显示出场段数', () => {
    ui.clickEl(dirLabel('配角'));
    liRow = rowWith('李叔');
    assert.ok(!liRow.textContent.includes('出场'), liRow.textContent);
  });

  test('未出场的角色行没有待更新标记', () => {
    assert.ok(!liRow.querySelector('.cast-pending'));
  });

  test('未出场的角色没有「更新角色卡」', () => {
    liItems = ui.itemsOf(ui.rightClick(liRow));
    assert.ok(!liItems.some((l) => l.startsWith('更新角色卡')), JSON.stringify(liItems));
  });

  test('未出场的角色说明原因', () => {
    assert.ok(liItems.includes('未在摘要中出现，无法自动更新'), JSON.stringify(liItems));
    ui.closeMenu();
  });

  // ---- 未建卡的出场人物：单独一组，只有「建卡」一个动作。
  test('有「出场人物 · 未建卡」分组', () => {
    castGroup = [...ui.doc.querySelectorAll('#projectBody .group-head')]
      .find((n) => n.querySelector('.group-name').textContent.includes('未建卡'));
    assert.ok(castGroup);
  });

  test('分组副标题给出人数', () => {
    assert.ok(castGroup.textContent.includes('2 人'), castGroup.textContent);
  });

  test('未建卡的人也列出出场段落', () => {
    castRow = rowWith('客栈掌柜');
    assert.ok(castRow.textContent.includes('第 2、3 段'), castRow.textContent);
  });

  test('未建卡的行有独立样式', () => {
    assert.ok(castRow.classList.contains('row-cast'));
  });

  test('别名进 title', () => {
    assert.ok(castRow.querySelector('.row-label').title.includes('掌柜'));
  });

  test('未建卡的菜单只给建卡', () => {
    castItems = ui.itemsOf(ui.rightClick(castRow));
    assert.ok(castItems.includes('创建角色卡（通读出场段落）'), JSON.stringify(castItems));
  });

  // 这些人还没有文件，类文件操作无从谈起。
  test('未建卡的菜单没有类文件操作', () => {
    assert.ok(!castItems.includes('重命名') && !castItems.includes('删除（移到回收站）'),
      JSON.stringify(castItems));
  });

  test('建卡发 createCard 且不带 relPath', () => {
    ui.pick(ui.rightClick(castRow), '创建角色卡（通读出场段落）');
    const create = ui.last('characterAction');
    assert.ok(create, '没发出 characterAction');
    assert.equal(create.action, 'createCard', JSON.stringify(create));
    assert.equal(create.name, '客栈掌柜', JSON.stringify(create));
    assert.ok(!create.relPath, JSON.stringify(create));
  });

  // 点名字也是建卡（最常用的动作放在最省事的位置）。
  test('点未建卡的名字直接建卡', () => {
    ui.clickEl([...ui.doc.querySelectorAll('#projectBody .row-label')].find((n) => n.textContent === '老周'));
    assert.equal(ui.last('characterAction').name, '老周', JSON.stringify(ui.last('characterAction')));
  });

  // 没有未建卡的人时，整组不出现——不该留一个空分组占地方。
  test('没有未建卡的人则不显示该分组', () => {
    ui.post({ type: 'project', tree: { ...sampleTree(), cast: [] } });
    assert.ok(![...ui.doc.querySelectorAll('#projectBody .group-name')]
      .some((n) => n.textContent.includes('未建卡')));
  });

  // 旧后端（还没有 cast 字段）推来的树不能让前端崩。
  test('缺 cast 字段时仍能渲染', () => {
    const legacy = sampleTree();
    delete legacy.cast;
    delete legacy.castByCard;
    ui.post({ type: 'project', tree: legacy });
    assert.ok(rowWith('林昭'));
  });

  test('缺 castByCard 时角色行不显示出场', () => {
    assert.ok(!rowWith('林昭').textContent.includes('出场'));
  });

  test('缺 castByCard 时不给更新入口', () => {
    legacyItems = ui.itemsOf(ui.rightClick(rowWith('林昭')));
    assert.ok(!legacyItems.some((l) => l.startsWith('更新角色卡')), JSON.stringify(legacyItems));
    ui.closeMenu();
  });
});
