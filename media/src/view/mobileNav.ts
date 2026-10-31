/**
 * 窄屏（`../narrow.ts`）的导航：底栏的两颗导航键与返回键。
 *
 * ## 底栏
 *
 * 活动栏在窄屏上是底栏，只露「对话 · 工程 · 正文 · 版本 · 更多」五颗（样式在 narrow.css）：
 * - 「正文」：把编辑区那层翻上来（`body.editor-open`）。编辑区开着时它亮、侧栏那一页的页签不亮（样式按这个类认）。
 * - 「更多」：弹一个菜单列文件 / 历史 / 日志 / 设置；正开着这几页之一时它亮，日志有没看过的错误时它也带红点。
 * 这两颗没有 `data-tab`（`data-nav`），页签切换（`tabs.ts`）不认它们，宽屏上不显示。
 * 软键盘弹着、正在打字时底栏让出来（body 挂 `kb-open`）：键盘上面本来就只剩半屏。
 *
 * ## 返回键
 *
 * 手机上按返回，先一层层收：最上面的菜单 / 弹窗 / 浮窗 → 编辑区那层 → 都收完了才离开页面（浏览器）或弹壳的菜单（Android）。
 * - 浏览器：开着几层就在历史里压几条（`history.state.nfLayer` 记第几层），按返回退一条、页面收一层；
 *   不是按返回收掉的（点了外面、点了底栏）就自己退掉多出来的那几条。只在窄屏上压。
 *   Chromium 会跳过页面在作者碰它之前压的条目（返回键一下就离开了页面），所以作者没碰过页面时不压，碰过之后补上。
 * - Android 壳：返回键不经网页历史，壳先问 `window.nfBack()`——收掉了一层返回 true，没什么可收的返回 false、壳再弹自己的菜单。
 */
import { closestFrom } from '../dom';
import type { MenuItem } from '../globals';
import type { Tab } from '../protocol';
import { narrowScreen as narrow } from '../narrow';
import { el } from './refs';
import { isTabActive, revealTab } from './tabs';

/** 「更多」里的几页（窄屏底栏上不单独露）。 */
const MORE_TABS: { tab: Tab; label: string }[] = [
  { tab: 'files', label: '文件' },
  { tab: 'history', label: '历史' },
  { tab: 'logs', label: '日志' },
  { tab: 'settings', label: '设置' },
];

/**
 * 按返回能收的那几样，都是挂在 body 上或页面里常驻、靠 `.hidden` / `.open` 开关的。收的办法是在它上面按一下 Esc
 * （各自都认 Esc，多半挂在 document 上），不认的再点一下外面。
 * - `LAYERS`：作者点开的弹窗、菜单、面板——开着就在历史里算一层。
 * - `TIPS`：浮窗与补全框——一碰就出、一动就收（窄窗口的桌面上鼠标划过名字就出一个），不另压历史；按返回时开着就顺手收掉。
 */
const LAYERS = [
  '.modal-overlay',
  '.ctx-menu',
  '.wb-menu-drop',
  '.msg-menu',
  '.qo-panel',
  '.ed-look-overlay',
  '.ed-check-panel',
  '.ed-stats-panel',
  '.nf-picker.open',
  '.nf-about.open',
].join(', ');

const TIPS = ['.summary-tip', '.failure-tip', '.detail-tip', '.workbench-tip', '.nm-tip', '.tov-tip', '.nc-box'].join(', ');

const ANY = `${LAYERS}, ${TIPS}`;

function editorOpen(): boolean {
  return document.body.classList.contains('editor-open');
}

/** 最上面那一层（DOM 里靠后的盖在靠前的上面）。藏着的不算。 */
function topOverlay(selector: string): HTMLElement | null {
  const shown = [...document.querySelectorAll<HTMLElement>(selector)].filter((n) => !n.closest('.hidden, [hidden]'));
  return shown[shown.length - 1] ?? null;
}

function isShown(node: HTMLElement): boolean {
  return node.isConnected && node.matches(ANY) && !node.closest('.hidden, [hidden]');
}

/** 收掉最上面一层；没什么可收的返回 false。 */
function closeTopLayer(): boolean {
  const overlay = topOverlay(ANY);
  if (overlay) {
    // 焦点在它里面（弹窗里的输入框）就从焦点那儿按：有的只在自己的输入框上认 Esc。不在就按在它身上，冒泡到 document。
    const focused = document.activeElement;
    const at = focused instanceof HTMLElement && overlay.contains(focused) ? focused : overlay;
    at.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    if (isShown(overlay)) {
      // 浮窗之类不认 Esc 的：点一下外面就收。
      document.body.click();
    }
    return true;
  }
  if (narrow() && editorOpen()) {
    document.body.classList.remove('editor-open');
    return true;
  }
  return false;
}

/** 这一刻该在历史里压着几层。宽屏上一层都不压（编辑区常驻，返回键照浏览器原来的意思）。 */
function wantedDepth(): number {
  if (!narrow()) {
    return 0;
  }
  return (editorOpen() ? 1 : 0) + (topOverlay(LAYERS) ? 1 : 0);
}

function currentDepth(): number {
  const state = history.state as { nfLayer?: unknown } | null;
  return typeof state?.nfLayer === 'number' ? state.nfLayer : 0;
}

/** 作者碰过页面没有。没有这个接口的环境当碰过。 */
function userActivated(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return activation ? activation.hasBeenActive : true;
}

/** 自己退掉多出来的条目时，那一下 popstate 不是作者按的返回。 */
let traversing = false;

/** 让历史里压着的层数跟上页面上开着的层数。 */
function reconcile(): void {
  if (traversing) {
    return;
  }
  const have = currentDepth();
  const want = wantedDepth();
  if (want > have) {
    if (!userActivated()) {
      return;
    }
    for (let depth = have + 1; depth <= want; depth++) {
      history.pushState({ nfLayer: depth }, '');
    }
  } else if (want < have) {
    traversing = true;
    history.go(want - have);
  }
}

let scheduled = false;

/** 开关一层的那一下（点击、按键、后端推来的打开文件）跑完之后再对一次账。 */
function schedule(): void {
  if (scheduled) {
    return;
  }
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    reconcile();
  }, 0);
}

function onPopState(): void {
  if (traversing) {
    traversing = false;
    reconcile();
    return;
  }
  // 作者按了返回：退到第几层，就把那一层以上开着的都收掉（一次多半只收一层；盖在最上面的浮窗先收，不算一层）。
  const have = currentDepth();
  for (let guard = 0; guard < 6 && wantedDepth() > have; guard++) {
    if (!closeTopLayer()) {
      break;
    }
  }
  reconcile();
}

/** 能打字的框（焦点在它上面，手机上就弹软键盘）。 */
const TYPING = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="password"], input[type="url"], [contenteditable="true"]';

/** 同一个宽度下见过的最高的可视高度：当它是「没有键盘」。转屏（宽度变了）重新量。 */
let tallest = 0;
let measuredWidth = 0;

/**
 * 软键盘弹着没有。页面声明了 `interactive-widget=resizes-content`（Android 壳是 adjustResize），键盘一弹整页变矮：
 * 比没键盘时矮了 150px 以上、焦点又在能打字的框里，就算弹着（地址栏伸缩只差几十像素）。按返回收了键盘、焦点还在框里，
 * 高度回来了就不算——底栏跟着回来。
 */
function trackKeyboard(): void {
  if (window.innerWidth !== measuredWidth) {
    measuredWidth = window.innerWidth;
    tallest = 0;
  }
  tallest = Math.max(tallest, window.innerHeight);
  const typing = !!document.activeElement?.matches(TYPING);
  document.body.classList.toggle('kb-open', narrow() && typing && window.innerHeight < tallest - 150);
}

function showMoreMenu(btn: HTMLElement): void {
  const logsDot = document.getElementById('logsErrorDot');
  const unseenErrors = !!logsDot && !logsDot.classList.contains('hidden');
  const items: MenuItem[] = MORE_TABS.filter(({ tab }) => document.getElementById(`pane-${tab}`)).map(({ tab, label }) => ({
    label: `${isTabActive(tab) && !editorOpen() ? '✓ ' : ''}${label}${tab === 'logs' && unseenErrors ? '（有新的错误）' : ''}`,
    run: () => revealTab(tab),
  }));
  const rect = btn.getBoundingClientRect();
  // 贴着按钮上沿往上弹（下面没地方，menuPlace 会翻上去）。
  window.__nfShowMenu?.(items, rect.right, rect.top);
}

export function installMobileNav(): void {
  // 只有独立版有窄屏底栏与编辑区那层；插件的 webview 不碰浏览器历史。
  if (!document.getElementById('wbMenubar')) {
    return;
  }
  el.tabbar.addEventListener('click', (e) => {
    const btn = closestFrom<HTMLElement>(e.target, '.tab');
    const nav = btn?.dataset.nav;
    if (!btn || !nav) {
      return;
    }
    if (nav === 'editor') {
      document.body.classList.add('editor-open');
    } else if (nav === 'more') {
      // 菜单挂在 body 上、document 的 click 会收掉它：这一下别冒上去。
      e.stopPropagation();
      showMoreMenu(btn);
    }
  });

  (window as Window & { nfBack?: () => boolean }).nfBack = () => {
    const closed = closeTopLayer();
    schedule();
    return closed;
  };

  window.addEventListener('popstate', onPopState);
  trackKeyboard();
  window.addEventListener('resize', () => {
    trackKeyboard();
    // 转屏、拖窄窗口：过了窄屏的界，压着的层数跟着变。
    schedule();
  });
  document.addEventListener('focusin', trackKeyboard);
  document.addEventListener('focusout', () => setTimeout(trackKeyboard, 0));
  // 开关一层的入口太多（点击、长按、快捷键、后端推来的打开文件），不一个个挂：作者点过之后、body 的类与直属子节点变了之后
  // 都对一次账（挂在 body 上的菜单与面板、编辑区那层都在后两样里；页面里常驻的弹窗靠点击那一下兜着）。打字不对账。
  for (const type of ['click', 'contextmenu'] as const) {
    document.addEventListener(type, schedule, true);
  }
  new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true });
}
