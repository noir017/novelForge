/**
 * 菜单摆在哪（`media/src/view/menuPlace.ts`，纯函数、零 DOM）：右键菜单、标题栏下拉与子菜单整个落在可视区里——
 * 放不下先翻、翻过去还放不下就平移贴边、比可视区还高就压高度在菜单里滚。手机竖屏（360×640）下半屏长按是从前被截掉的那种。
 * 接到菜单上（menu.ts / menubar.ts）的那一半在 tests/dom/standalone/touch.test.js。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const { placeAtPoint, placeNear, visibleArea, MENU_MARGIN } = loadModule('media/src/view/menuPlace.ts');

const phone = { left: 0, top: 0, width: 360, height: 640 };
const m = MENU_MARGIN;

/** 摆出来的菜单整个在可视区里（含留白）。 */
function inside(p, w, h, area = phone) {
  const height = p.maxHeight ?? h;
  assert.ok(p.left >= area.left + m, `left ${p.left}`);
  assert.ok(p.top >= area.top + m, `top ${p.top}`);
  assert.ok(p.left + w <= area.left + area.width - m, `right ${p.left + w}`);
  assert.ok(p.top + height <= area.top + area.height - m, `bottom ${p.top + height}`);
}

describe('placeAtPoint：右键 / 长按的菜单', () => {
  test('放得下就贴着按下去的那一点', () => {
    assert.deepEqual(placeAtPoint(40, 100, 150, 200, phone), { left: 40, top: 100 });
  });

  test('右边放不下往左翻（以那一点为右沿）', () => {
    assert.deepEqual(placeAtPoint(300, 100, 150, 200, phone), { left: 150, top: 100 });
  });

  test('左右都放不下（菜单比半屏宽）：贴着右边缘，不伸出屏幕', () => {
    const p = placeAtPoint(180, 100, 250, 200, phone);
    assert.equal(p.left, 360 - m - 250);
    inside(p, 250, 200);
  });

  test('下半屏：下面放不下往上翻（以那一点为下沿）', () => {
    assert.deepEqual(placeAtPoint(40, 560, 150, 300, phone), { left: 40, top: 260 });
  });

  test('上下都放不下（菜单比半屏高）：平移到贴着底边，整个看得见，不压高度', () => {
    const p = placeAtPoint(40, 300, 150, 476, phone);
    assert.equal(p.top, 640 - m - 476);
    assert.equal(p.maxHeight, undefined);
    inside(p, 150, 476);
  });

  test('比整个可视区还高：从顶上开始，压 max-height 在菜单里滚', () => {
    const p = placeAtPoint(40, 500, 150, 900, phone);
    assert.equal(p.top, m);
    assert.equal(p.maxHeight, 640 - 2 * m);
    inside(p, 150, 900);
  });

  test('可视区被软键盘顶起、或页面缩放过（visualViewport 偏了）：照可视区摆', () => {
    const vv = { left: 0, top: 120, width: 360, height: 300 };
    const p = placeAtPoint(100, 380, 150, 200, vv);
    inside(p, 150, 200, vv);
    assert.equal(p.top, 380 - 200);
  });

  test('量不出尺寸（jsdom 里 offsetWidth 恒为 0）就贴着那一点', () => {
    assert.deepEqual(placeAtPoint(300, 600, 0, 0, phone), { left: 300, top: 600 });
  });

  test('桌面上常见的情形不变：右下角附近右键往左上翻', () => {
    const desk = { left: 0, top: 0, width: 1440, height: 860 };
    assert.deepEqual(placeAtPoint(1400, 840, 150, 120, desk), { left: 1250, top: 720 });
    assert.deepEqual(placeAtPoint(200, 200, 150, 120, desk), { left: 200, top: 200 });
  });
});

describe('placeNear：标题栏的下拉与子菜单', () => {
  const btn = { left: 160, top: 0, right: 200, bottom: 44 };

  test('下拉：按钮下方左对齐；右边伸出去就往左收', () => {
    assert.deepEqual(placeNear({ left: 40, top: 0, right: 80, bottom: 44 }, 220, 300, phone, 'below'), { left: 40, top: 44 });
    const p = placeNear(btn, 220, 300, phone, 'below');
    assert.equal(p.top, 44);
    inside(p, 220, 300);
  });

  test('下拉比剩下的高度还高：压 max-height，不往上翻盖住菜单栏', () => {
    const p = placeNear(btn, 220, 800, phone, 'below');
    assert.equal(p.top, 44);
    assert.equal(p.maxHeight, 640 - m - 44);
  });

  test('子菜单：父菜单项右边、顶对齐', () => {
    const item = { left: 10, top: 200, right: 120, bottom: 240 };
    assert.deepEqual(placeNear(item, 200, 100, phone, 'side'), { left: 120, top: 200 });
  });

  test('子菜单右边放不下翻到左边；左边也放不下就贴边（盖住一点父菜单）', () => {
    const right = { left: 200, top: 200, right: 340, bottom: 240 };
    assert.deepEqual(placeNear(right, 150, 100, phone, 'side'), { left: 50, top: 200 });
    const wide = { left: 30, top: 200, right: 250, bottom: 240 };
    const p = placeNear(wide, 260, 100, phone, 'side');
    inside(p, 260, 100);
  });

  test('子菜单下面放不下往上平移', () => {
    const low = { left: 10, top: 600, right: 120, bottom: 636 };
    const p = placeNear(low, 200, 150, phone, 'side');
    assert.equal(p.top, 640 - m - 150);
  });
});

describe('visibleArea', () => {
  test('有 visualViewport 用它（偏移是相对布局视口的）', () => {
    const win = { visualViewport: { offsetLeft: 0, offsetTop: 80, width: 360, height: 400 }, innerWidth: 446, innerHeight: 792 };
    assert.deepEqual(visibleArea(win), { left: 0, top: 80, width: 360, height: 400 });
  });

  test('没有就是整个窗口', () => {
    assert.deepEqual(visibleArea({ innerWidth: 1440, innerHeight: 860 }), { left: 0, top: 0, width: 1440, height: 860 });
  });
});
