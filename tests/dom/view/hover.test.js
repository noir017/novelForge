/**
 * 三个悬停浮窗：章节摘要、行内副标题（别名）、失败标记。
 *
 * 迁自 scripts/smoke-view.js 的这三节：
 *   == 章节摘要的悬停浮窗 ==（1893） == 行内副标题（别名）的悬停浮窗 ==（2170）
 *   == 失败标记与悬停浮窗 ==（2259）
 *
 * 原脚本里这三节**必须**待在文件末尾：浮窗有半秒悬停延迟，只能等真定时器，
 * 于是整块写成 `summaryTipTests().then(detailTipTests).then(failureTipTests)`
 * 的 promise 链，`process.exit` 挂在链尾。那条链**没有 .catch**——任何一步
 * reject 都变成 unhandled rejection 而不是一条失败用例。改成普通 async test
 * 之后，顺序约束与吞异常一并消失。
 *
 * 但等待本身是真的：settle/grace 量的是实现里的防抖与收起宽限，不是抖动，
 * 所以时长原样保留。这个文件大约要跑十几秒。
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { mount, JSDOM_SKIP, sampleTree } = require('../../helpers/dom');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('章节摘要的悬停浮窗', { skip: JSDOM_SKIP }, () => {
  let ui;
  const tip = () => ui.doc.querySelector('.summary-tip');
  // 浮窗只挂在**章节行**上。夹具里同名的行不止一处，
  // 按 .row 取会撞上章节那一行，而章节行根本没有 data-plot。
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row-plot')].find((n) => n.textContent.includes(text));
  const hover = (node) => node.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
  /** 等过悬停延迟（view.js 里是 450ms）。 */
  const settle = () => wait(600);
  /** 等过收起的宽限期（CLOSE_DELAY_MS 是 200ms）。 */
  const grace = () => wait(320);
  /** 鼠标进/出浮窗。这两个事件不冒泡，得直接派到浮窗上。 */
  const enterTip = () => tip().dispatchEvent(new ui.window.MouseEvent('mouseenter'));
  const leaveTip = () => tip().dispatchEvent(new ui.window.MouseEvent('mouseleave'));
  /** 移开鼠标并等过宽限期：悬停到分组标题栏（不是剧情行）即可。 */
  const moveAway = async () => {
    hover(ui.doc.querySelector('#projectBody .group-head'));
    await grace();
  };

  // jsdom 里所有尺寸都是 0，定位逻辑会全程退化成「贴光标」，量不出东西来。
  // 给浮窗与剧情行装上可控的几何，才验得了「不许跑到窗口外面去」。
  const VIEWPORT = { w: 800, h: 600 };
  /** 浮窗的自然高度（不受行内 maxHeight 限制时的高度）。 */
  let tipNaturalHeight = 200;
  /** 目标行在视口里的位置。 */
  let rowRect = { top: 100, bottom: 120, left: 20 };

  /** 浮窗当前占据的矩形（按行内样式算），用来断言它有没有跑出窗口。 */
  const tipBox = () => {
    const box = tip();
    const top = parseFloat(box.style.top);
    const left = parseFloat(box.style.left);
    return { top, left, bottom: top + box.offsetHeight, right: left + box.offsetWidth };
  };
  /** 浮窗完整落在视口内（留 8px 边距，view.js 的 TIP_MARGIN）。 */
  const insideViewport = () => {
    const b = tipBox();
    return b.top >= 0 && b.left >= 0 && b.bottom <= VIEWPORT.h && b.right <= VIEWPORT.w;
  };

  const summaryOf = (extra) =>
    Object.assign(
      {
        no: 1, title: '楔子', exists: true, stale: false,
        relPath: '.novelforge/summaries/001-楔子.md',
        sections: [
          { name: '梗概', text: '雨下了三天，林昭进入青崖镇。' },
          { name: '关键事件', text: '- 以旧牌子代替过所\n- 李叔放行' },
        ],
      },
      extra
    );

  const showTip = async () => {
    hover(rowWith('楔子'));
    await settle();
    ui.post({ type: 'summary', summary: summaryOf() });
  };

  before(() => {
    ui = mount();
    const isTip = (node) => node.classList && node.classList.contains('summary-tip');
    Object.defineProperty(ui.window, 'innerWidth', { get: () => VIEWPORT.w, configurable: true });
    Object.defineProperty(ui.window, 'innerHeight', { get: () => VIEWPORT.h, configurable: true });
    Object.defineProperty(ui.window.HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return isTip(this) ? 340 : 0; },
    });
    Object.defineProperty(ui.window.HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        if (!isTip(this)) return 0;
        // 行内 maxHeight 是 placeSummaryTip 压上去的，这里要如实反映它的效果，
        // 否则「压过高度后再量」那一步测不出来。
        const cap = parseFloat(this.style.maxHeight);
        return Number.isFinite(cap) && cap > 0 ? Math.min(tipNaturalHeight, cap) : tipNaturalHeight;
      },
    });
    ui.window.Element.prototype.getBoundingClientRect = function () {
      if (this.classList && this.classList.contains('row-plot')) {
        return {
          top: rowRect.top, bottom: rowRect.bottom, left: rowRect.left,
          right: rowRect.left + 200, width: 200, height: rowRect.bottom - rowRect.top,
        };
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    };

    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('默认不显示浮窗', () => {
    assert.ok(!tip());
  });

  // 只有剧情行有浮窗，角色行没有。
  test('角色行不弹浮窗', async () => {
    hover([...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes('林昭')));
    await settle();
    assert.ok(!tip());
  });

  // ---- 悬停在剧情行上
  test('悬停后不立刻弹出（有延迟，免得划过时闪）', () => {
    ui.sent.length = 0;
    hover(rowWith('楔子'));
    assert.ok(!tip());
  });

  test('延迟未到时不发请求', () => {
    assert.ok(!ui.last('requestSummary'));
  });

  // 光标在行上微动（mouseover 从子元素冒泡上来）不该重置延迟，
  // 否则手一抖浮窗就永远弹不出来。等一半再抖一下，总时长仍应触发。
  test('行内微动不重置延迟，浮窗照常弹出', async () => {
    await wait(300);
    hover(rowWith('楔子').querySelector('.row-label'));
    await wait(300);
    assert.ok(tip());
  });

  test('数据没到时先显示读取中', () => {
    assert.ok(tip().textContent.includes('读取摘要'), tip().textContent);
  });

  test('向后端要这一章的摘要', () => {
    const req = ui.last('requestSummary');
    assert.ok(req, '没发出 requestSummary');
    // 要的是**路径**，不是序号：摘要文件名跟着标题走，只有路径能唯一
    // 定位到一份摘要。这一章已经发布，主路径因此指成品。
    assert.equal(req.plotRelPath, 'chapters/001-楔子.md', JSON.stringify(req));
  });

  test('浮窗挂在 body 上（工程页有内部滚动，挂在行里会被裁掉）', () => {
    assert.equal(tip().parentElement, ui.doc.body);
  });

  // ---- 摘要到了
  test('摘要到达后换掉内容', () => {
    ui.post({ type: 'summary', summary: summaryOf() });
    assert.ok(!tip().textContent.includes('读取摘要'), tip().textContent);
  });

  test('浮窗带章号与标题', () => {
    assert.ok(tip().textContent.includes('第 1 章 楔子'), tip().textContent);
  });

  test('显示小节名', () => {
    assert.ok(tip().textContent.includes('梗概') && tip().textContent.includes('关键事件'), tip().textContent);
  });

  test('显示小节正文', () => {
    assert.ok(tip().textContent.includes('雨下了三天'), tip().textContent);
  });

  test('新鲜的摘要不打过期标', () => {
    assert.ok(!tip().querySelector('.summary-tip-stale'));
  });

  // ---- 鼠标移到浮窗上：一直留着，能滚、能选中复制
  //
  // 从行挪到浮窗要跨过一道缝，那一两帧鼠标既不在行上也不在浮窗上。
  // 所以收起有宽限期，中途进了浮窗就撤销。
  test('刚移开时浮窗还在（有宽限期，够鼠标挪过去）', () => {
    hover(ui.doc.querySelector('#projectBody .group-head'));
    assert.ok(tip());
  });

  test('鼠标停在浮窗上就一直显示', async () => {
    enterTip();
    await grace();
    assert.ok(tip());
  });

  test('停久了也不会自己消失', async () => {
    await grace();
    assert.ok(tip());
  });

  // 浮窗自己内部的滚动不能把它收掉——摘要有六个小节，滚动条是给人用的。
  test('浮窗内部滚动不收起浮窗', () => {
    tip().dispatchEvent(new ui.window.Event('scroll', { bubbles: true }));
    assert.ok(tip());
  });

  // 移出浮窗才收。
  test('刚离开浮窗时还在（同样有宽限期）', () => {
    leaveTip();
    assert.ok(tip());
  });

  test('离开浮窗后收起', async () => {
    await grace();
    assert.ok(!tip());
  });

  // ---- 移开就收（没进浮窗的情况）
  test('再次悬停弹出浮窗', async () => {
    ui.sent.length = 0;
    hover(rowWith('楔子'));
    await settle();
    assert.ok(tip());
  });

  test('移到非剧情行、且没进浮窗时收起', async () => {
    await moveAway();
    assert.ok(!tip());
  });

  // ---- 缓存：同一段再悬停不再发请求
  test('命中缓存时直接显示，不再请求', async () => {
    ui.sent.length = 0;
    hover(rowWith('楔子'));
    await settle();
    assert.ok(tip() && !ui.last('requestSummary'), JSON.stringify(ui.sent));
  });

  test('缓存命中时不经过「读取中」', () => {
    assert.ok(!tip().textContent.includes('读取摘要'), tip().textContent);
  });

  // ---- 滚动 / Esc / 右键都要收（浮窗是 fixed 的，会和目标行脱节）
  test('滚动收起浮窗', () => {
    ui.doc.getElementById('projectBody').dispatchEvent(new ui.window.Event('scroll', { bubbles: true }));
    assert.ok(!tip());
  });

  test('按 Esc 收起浮窗', async () => {
    hover(rowWith('楔子'));
    await settle();
    ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!tip());
  });

  test('右键弹菜单时浮窗让路', async () => {
    hover(rowWith('楔子'));
    await settle();
    rowWith('楔子').dispatchEvent(
      new ui.window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 })
    );
    assert.ok(!tip());
    ui.closeMenu();
  });

  // ---- 后端重推树 = 磁盘变过，缓存必须作废
  test('重推树后缓存作废、重新请求', async () => {
    ui.post({ type: 'project', tree: sampleTree() });
    ui.sent.length = 0;
    hover(rowWith('楔子'));
    await settle();
    assert.ok(ui.last('requestSummary'), JSON.stringify(ui.sent));
  });

  // ---- 过期的摘要必须标出来（照着旧摘要做判断比没摘要更糟）
  test('过期的摘要打标', () => {
    ui.post({ type: 'summary', summary: summaryOf({ stale: true }) });
    assert.ok(tip().querySelector('.summary-tip-stale'));
  });

  test('过期标写着「已过期」', async () => {
    assert.equal(tip().querySelector('.summary-tip-stale').textContent, '已过期');
    await moveAway();
  });

  // ---- 没生成过摘要的段：说清楚，不给空浮窗
  test('未总结时给出说明而非空白', async () => {
    hover(rowWith('楔子'));
    await settle();
    ui.post({
      type: 'summary',
      summary: { no: 1, title: '楔子', exists: false, stale: true, relPath: '', sections: [] },
    });
    assert.ok(tip().textContent.includes('还没有摘要'), tip().textContent);
  });

  test('未总结时不打「已过期」标（说「还没有」就够了）', async () => {
    assert.ok(!tip().querySelector('.summary-tip-stale'));
    await moveAway();
  });

  // ---- 摘要是模型写的，一律走 textContent，绝不拼 HTML
  test('摘要正文不当 HTML 解析', async () => {
    ui.post({ type: 'project', tree: sampleTree() });
    hover(rowWith('楔子'));
    await settle();
    ui.post({
      type: 'summary',
      summary: summaryOf({ sections: [{ name: '梗概', text: '<img src=x onerror=alert(1)>' }] }),
    });
    assert.ok(!tip().querySelector('img'), tip().innerHTML);
  });

  test('摘要正文原样显示为文字', async () => {
    assert.ok(tip().textContent.includes('<img src=x onerror=alert(1)>'), tip().textContent);
    await moveAway();
  });

  // ---- 定位：浮窗任何时候都不许有一部分落到窗口外面
  //
  // 视口 800×600（上面用 defineProperty 钉住的）。浮窗宽 340，
  // 高度由 tipNaturalHeight 控制，行的位置由 rowRect 控制。

  // ① 常规位置：行在上半屏，浮窗放在行下方
  test('空间够时放在行的下方', async () => {
    rowRect = { top: 100, bottom: 120, left: 20 };
    tipNaturalHeight = 200;
    ui.post({ type: 'project', tree: sampleTree() });
    await showTip();
    assert.ok(tipBox().top >= rowRect.bottom, JSON.stringify(tipBox()));
  });

  test('常规位置整个在视口内', async () => {
    assert.ok(insideViewport(), JSON.stringify(tipBox()));
    await moveAway();
  });

  // ② 行贴近底部：下方放不下 → 翻到上方
  test('行贴底时翻到行的上方', async () => {
    rowRect = { top: 540, bottom: 560, left: 20 };
    tipNaturalHeight = 200;
    ui.post({ type: 'project', tree: sampleTree() });
    await showTip();
    assert.ok(tipBox().bottom <= rowRect.top, JSON.stringify(tipBox()));
  });

  test('翻转后整个在视口内', async () => {
    assert.ok(insideViewport(), JSON.stringify(tipBox()));
    await moveAway();
  });

  // ③ 行贴右边缘：横向往左收，不许右边溢出
  test('贴右边缘时向左收', async () => {
    rowRect = { top: 100, bottom: 120, left: 700 };
    tipNaturalHeight = 200;
    ui.post({ type: 'project', tree: sampleTree() });
    await showTip();
    assert.ok(tipBox().right <= VIEWPORT.w, JSON.stringify(tipBox()));
  });

  test('向左收后仍不越过左边缘', async () => {
    assert.ok(tipBox().left >= 0, JSON.stringify(tipBox()));
    await moveAway();
  });

  // ④ 摘要很长、上下都放不下：压高度进可用空间，靠滚动看剩下的。
  //    只翻转不压高度的话，长摘要在矮窗口里会有一截永远够不到。
  test('超长摘要被压进可用空间', async () => {
    rowRect = { top: 280, bottom: 300, left: 20 };
    tipNaturalHeight = 2000;
    ui.post({ type: 'project', tree: sampleTree() });
    await showTip();
    assert.ok(tipBox().bottom <= VIEWPORT.h, JSON.stringify(tipBox()));
  });

  test('超长摘要不越过顶边', () => {
    assert.ok(tipBox().top >= 0, JSON.stringify(tipBox()));
  });

  test('压高度靠的是 maxHeight（内容仍可滚动，不是被截掉）', async () => {
    assert.ok(parseFloat(tip().style.maxHeight) > 0, tip().style.maxHeight);
    await moveAway();
  });

  // ⑤ 内容后到达导致高度变化时，也要重新收进视口
  test('「读取中」的小浮窗放在下方', async () => {
    rowRect = { top: 500, bottom: 520, left: 20 };
    tipNaturalHeight = 60;
    ui.post({ type: 'project', tree: sampleTree() });
    hover(rowWith('楔子'));
    await settle();
    assert.ok(tipBox().top >= rowRect.bottom, JSON.stringify(tipBox()));
  });

  // 摘要到了，内容一下子撑高——不能就这么支棱到窗口外面去。
  test('内容到达撑高后重新定位，仍在视口内', async () => {
    tipNaturalHeight = 400;
    ui.post({ type: 'summary', summary: summaryOf() });
    assert.ok(insideViewport(), JSON.stringify(tipBox()));
    await moveAway();
  });
});

describe('行内副标题（别名）的悬停浮窗', { skip: JSDOM_SKIP }, () => {
  let ui;
  let tree;
  let detail;
  let box;
  let liDetail;
  const tip = () => ui.doc.querySelector('.detail-tip');
  const detailOf = (row) => row.querySelector('.row-detail');
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const hover = (node) => node.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
  /** 等过悬停延迟（detailTip.ts 里是 350ms）。 */
  const settle = () => wait(600);
  /** 等过收起的宽限（CLOSE_DELAY_MS 是 150ms）。 */
  const grace = () => wait(250);

  // 别名多到一行放不下的角色。detail 是「标签 · 别名 …」的完整串，
  // 浮窗要原样端出这一整段。
  const LONG_DETAIL = '反派 · 别名 四娘/老板娘/四姐/沈掌柜/黑心店主/前朝遗孀';

  before(() => {
    ui = mount();
    // jsdom 里 scrollWidth/clientWidth 恒为 0，截断与否只能靠覆写 getter。
    // 带 data-truncated 的副标题按「内容 300px、可见 50px」算，其余不算截断。
    Object.defineProperty(ui.window.HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return this.dataset && this.dataset.truncated ? 50 : 0; },
    });
    Object.defineProperty(ui.window.HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get() { return this.dataset && this.dataset.truncated ? 300 : 0; },
    });

    tree = sampleTree();
    tree.characters.push({
      kind: 'file', label: '沈四娘',
      relPath: '.novelforge/characters/沈四娘.md', detail: LONG_DETAIL,
    });
    ui.post({ type: 'project', tree });
  });

  test('默认不显示浮窗', () => {
    assert.ok(!tip());
  });

  // ---- 截断的副标题：悬停后浮窗显示完整别名
  test('悬停后不立刻弹出（有延迟，免得划过时闪）', () => {
    detail = detailOf(rowWith('沈四娘'));
    detail.dataset.truncated = '1';
    hover(detail);
    assert.ok(!tip());
  });

  test('截断的别名行悬停后弹出浮窗', async () => {
    await settle();
    box = tip();
    assert.ok(box);
  });

  // 下面三条在原脚本里包在 `if (box) { ... }` 里。node:test 的用例是在
  // describe 同步收集阶段声明的，那时 box 还不存在，运行时守卫**无法**用来
  // 决定要不要声明用例——所以这里改成无条件声明。这是一处有意的偏离：
  // 原写法在浮窗弹不出来时会让这三条断言凭空消失，而汇总照打「全部通过」；
  // 现在 box 为 null 就是 TypeError，用例失败，正是我们想要的。
  test('浮窗挂在 body 上（工程页有内部滚动，挂在行里会被裁掉）', () => {
    assert.equal(box.parentElement, ui.doc.body);
  });

  test('浮窗显示完整副标题（含全部别名）', () => {
    assert.equal(box.textContent, LONG_DETAIL, box.textContent);
  });

  test('浮窗带独立样式类（只读展示，不吃鼠标）', () => {
    assert.ok(box.classList.contains('detail-tip'), box.className);
  });

  // 光标在副标题上微动（mouseover 冒泡）不该重置延迟导致弹不出来。
  test('微动后浮窗仍在', async () => {
    hover(detail);
    await grace();
    assert.equal(tip(), box);
  });

  // ---- 移开：宽限后收起
  test('移开后浮窗收起', async () => {
    hover(ui.doc.querySelector('#projectBody .group-head'));
    await grace();
    assert.ok(!tip());
  });

  // ---- 全文可见（未截断）的副标题：不弹浮窗
  test('未截断的副标题不弹浮窗', async () => {
    liDetail = detailOf(rowWith('林昭'));
    delete liDetail.dataset.truncated;
    hover(liDetail);
    await settle();
    assert.ok(!tip());
  });

  // ---- 重渲染把行换掉后，开着的浮窗必须清掉
  test('截断后又能弹出', async () => {
    liDetail.dataset.truncated = '1';
    hover(liDetail);
    await settle();
    assert.ok(tip());
  });

  test('重渲染后浮窗随之收起', () => {
    ui.post({ type: 'project', tree });
    assert.ok(!tip());
  });
});

/**
 * 失败标记（红色感叹号）与它的悬停浮窗。
 *
 * 这是「解析失败只有日志、用户看不到」那个 bug 的界面出口：卡一字未改，
 * 而树上那一行此前与更新成功的一模一样。所以要验的是**看得见**与**说得清**。
 */
describe('失败标记与悬停浮窗', { skip: JSDOM_SKIP }, () => {
  let ui;
  let cardMark;
  let plotMark;
  let box;
  let multiBox;
  const tip = () => ui.doc.querySelector('.failure-tip');
  const rowWith = (text) =>
    [...ui.doc.querySelectorAll('#projectBody .row')].find((n) => n.textContent.includes(text));
  const markIn = (text) => {
    const row = rowWith(text);
    return row ? row.querySelector('.row-failure') : null;
  };
  const hover = (node) => node.dispatchEvent(new ui.window.MouseEvent('mouseover', { bubbles: true }));
  /** 等过悬停延迟（HOVER_DELAY_MS 是 300ms）。 */
  const settle = () => wait(550);
  /** 等过收起的宽限（CLOSE_DELAY_MS 是 200ms）。 */
  const grace = () => wait(320);

  const CARD = '.novelforge/characters/林昭.md';
  // 失败挂在出错那份文件上（recordFailure 的 targetKey 就是它的路径）。
  // 章节是纯文件行，没有失败标记——工具不在那上面跑任何东西。
  const PLOT = '.novelforge/plots/001-楔子.md';

  before(() => {
    ui = mount();
    // ---- 没有失败记录时，树上不该多出任何东西
    ui.post({ type: 'project', tree: sampleTree() });
  });

  test('没有失败记录时不显示感叹号', () => {
    assert.ok(!markIn('林昭'));
  });

  test('没有失败记录时没有浮窗', () => {
    assert.ok(!tip());
  });

  // 旧后端推来的树没有 failures 字段，前端不能因此崩。
  test('缺 failures 字段时不崩', () => {
    const legacy = sampleTree();
    delete legacy.failures;
    let threw = false;
    try {
      ui.post({ type: 'project', tree: legacy });
    } catch {
      threw = true;
    }
    assert.ok(!threw && !!rowWith('林昭'));
  });

  // ---- 有失败记录：对应行挂上感叹号
  test('出错的角色行挂上感叹号', () => {
    const tree = sampleTree();
    tree.failures = {
      [CARD]: [
        {
          at: '2026-08-10T11:31:40.000Z',
          severity: 'error',
          message: '1 批全部解析失败，角色卡未改动',
          detail: '模型没有按要求返回 JSON。换个模型或稍后重试。',
        },
      ],
      [PLOT]: [
        { at: '2026-08-10T11:20:00.000Z', severity: 'warn', message: '3 段解析失败，「已读到」只推进到第 2 段' },
      ],
    };
    ui.post({ type: 'project', tree });
    cardMark = markIn('林昭');
    assert.ok(cardMark);
  });

  test('没出错的角色行没有感叹号', () => {
    assert.ok(!markIn('李叔'));
  });

  // 下面两条在原脚本里包在 `if (cardMark) { ... }` 里——同上，运行时守卫
  // 挡不住声明期，改成无条件；cardMark 为 null 时该失败就失败。
  test('整体失败标红', () => {
    assert.ok(cardMark.classList.contains('is-error'), cardMark.className);
  });

  // 浮窗要等 300ms，原生 title 作兜底，鼠标一停就有提示。
  test('感叹号带 title 兜底', () => {
    assert.ok(cardMark.title.includes('未改动'), cardMark.title);
  });

  test('出错的剧情行也挂上感叹号', () => {
    // 按章节行取：夹具里同名的行不止一处，按 .row 取会撞上别的那一行。
    const row = [...ui.doc.querySelectorAll('#projectBody .row-plot')]
      .find((n) => n.textContent.includes('楔子'));
    plotMark = row ? row.querySelector('.row-failure') : null;
    assert.ok(plotMark);
  });

  test('部分完成标黄而非标红', () => {
    assert.ok(plotMark && plotMark.classList.contains('is-warn'), plotMark && plotMark.className);
  });

  // 失败记录按路径挂：别的章不该跟着挂标记。
  test('别的章不挂感叹号', () => {
    const row = [...ui.doc.querySelectorAll('#projectBody .row-plot')]
      .find((n) => n.textContent.includes('入镇'));
    assert.ok(row && !row.querySelector('.row-failure'), row && row.outerHTML);
  });

  // ---- 悬停：延迟后弹浮窗，说清「改没改」与原因
  test('悬停后不立刻弹出（有延迟，免得划过时闪）', () => {
    hover(cardMark);
    assert.ok(!tip());
  });

  test('悬停感叹号后弹出浮窗', async () => {
    await settle();
    box = tip();
    assert.ok(box);
  });

  // 下面五条在原脚本里包在 `if (box) { ... }` 里——同上，改成无条件。
  test('浮窗挂在 body 上（工程页有内部滚动，挂在行里会被裁掉）', () => {
    assert.equal(box.parentElement, ui.doc.body);
  });

  test('浮窗给出失败原因', () => {
    assert.ok(box.textContent.includes('1 批全部解析失败'), box.textContent);
  });

  test('浮窗给出补充说明', () => {
    assert.ok(box.textContent.includes('换个模型'), box.textContent);
  });

  // 用户最想知道的一件事：磁盘上的东西动没动。
  test('浮窗点明「未改动」', () => {
    assert.ok(box.textContent.includes('未改动'), box.textContent);
  });

  test('浮窗告知标记会自动消失', () => {
    assert.ok(box.textContent.includes('自动消失'), box.textContent);
  });

  // ---- 可进入：详情有好几行、常含模型返回的片段，用户要能选中复制
  test('鼠标停在浮窗上时不收起', async () => {
    box.dispatchEvent(new ui.window.MouseEvent('mouseleave', { bubbles: false }));
    box.dispatchEvent(new ui.window.MouseEvent('mouseenter', { bubbles: false }));
    await grace();
    assert.equal(tip(), box);
  });

  // ---- 移开：宽限后收起
  test('移开后浮窗收起', async () => {
    hover(ui.doc.querySelector('#projectBody .group-head'));
    await grace();
    assert.ok(!tip());
  });

  // ---- 同一目标挂多条：分条画，不是挤成一段
  test('同一目标的多条各占一块', async () => {
    const multi = sampleTree();
    multi.failures = {
      [CARD]: [
        { at: '2026-08-10T11:31:40.000Z', severity: 'error', message: '角色卡失败' },
        { at: '2026-08-10T10:00:00.000Z', severity: 'warn', message: '摘要也失败了' },
      ],
    };
    ui.post({ type: 'project', tree: multi });
    hover(markIn('林昭'));
    await settle();
    multiBox = tip();
    assert.ok(multiBox, '没弹出浮窗');
    assert.equal(multiBox.querySelectorAll('.failure-tip-item').length, 2,
      multiBox && String(multiBox.querySelectorAll('.failure-tip-item').length));
  });

  // 有一条是 error 就按红色算——那比「部分完成」严重，不能被黄色盖过去。
  test('混合严重度时按最严重的标色', () => {
    assert.ok(markIn('林昭').classList.contains('is-error'), markIn('林昭').className);
  });

  // ---- 重渲染把行换掉后，开着的浮窗必须清掉（指向的是已丢弃的节点）
  test('重渲染后浮窗随之收起', () => {
    const multi = sampleTree();
    multi.failures = {
      [CARD]: [
        { at: '2026-08-10T11:31:40.000Z', severity: 'error', message: '角色卡失败' },
        { at: '2026-08-10T10:00:00.000Z', severity: 'warn', message: '摘要也失败了' },
      ],
    };
    ui.post({ type: 'project', tree: multi });
    assert.ok(!tip());
  });

  // ---- 修好之后：后端不再推这条记录，感叹号就该没了
  test('后端不再推记录时感叹号消失', () => {
    ui.post({ type: 'project', tree: sampleTree() });
    assert.ok(!markIn('林昭'));
  });
});
