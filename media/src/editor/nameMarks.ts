/**
 * 名词高亮与悬停浮窗（独立版内置编辑器）。**不调模型**（第 4 条）：名词表是后端读盘给的那一份，认名字是找字。
 *
 * - **名词图层**：正文、草稿、细纲、角色卡、设定、情节大纲与叙事线（与名词补全同一份白名单 `completionApplies`，看后端给
 *   的 `kind`）里，角色名与设定名各铺一层淡底色，设定名录里出现过、还没建条目的名字画虚下划线（⚑）——高亮镜像层的
 *   `names` 图层。什么时候重算、打字 / 输入法组字 / 撤销时画着的那几段怎么跟上、两万字以上节流，与写作体检同一套
 *   （`liveLayer.ts`）；哪几段是名字在 `namesCore.ts` 的 `nameRanges`（长的优先、一个字的不认、卡自己那一份里不标它自己）。
 * - **悬停浮窗**：鼠标在一个名字上停 {@link HOVER_DELAY_MS} 毫秒，贴着鼠标弹一个小框：名字、类型（角色 / 设定的分类 /
 *   未建条目）、别名命中时写「这里写的是……」、一句话简介（卡或条目里现成的那一句），底下一行说 Ctrl+点击能打开什么。
 *   镜像层不接鼠标，鼠标底下是哪个名字靠 `highlight.ts` 的 `rangeAtPoint` 量镜像，再按那一段的字认回表里那一条。框本身
 *   `pointer-events: none`，不挡鼠标；打字、滚动、按下鼠标、移开、输入法组字、换文件就收起。按住鼠标拖选区时不弹。
 * - **Ctrl+点击**（Mac 上 ⌘+点击，Mac 的 Ctrl+点击是右键）：在这一块编辑区打开它的角色卡或设定条目（`openEditor`，正常
 *   标签，与「转到…」一样）；未建条目没有文件，说一句。按着 Ctrl 指着能打开的名字时鼠标变成手形。
 * - **右键一个名字**：菜单最前面一项「打开「林昭」的角色卡」（`api.ts` 的 `addAreaMenu`），未建条目不给。
 * - **触屏**：手指没有悬停，点一下之后补发的兼容鼠标事件也不当悬停（`touch.ts`）。**手指点在名字上**（光标照常落在那儿）
 *   就弹同一只浮窗，底下一颗「打开角色卡 / 设定条目」（手指长按在正文里走系统的选字菜单，没有我们那一项，见 view/menu.ts）；
 *   再点一下别处、打字、滚动、失焦就收。不做成点一下就打开卡片（点正文是要放光标、要看的是这个名字本身）。
 *   软键盘弹着（正在打字，body 挂 `kb-open`）时点名字不弹：那是在挪光标，浮窗只会盖住底下两行。
 *
 * 名词表与补全是同一份（`names.ts` 管收发：带指纹问、没变只回指纹、磁盘上变过才算过期），这里只在当前文件归这一层管时
 * 要，表换了整层重画。开关在「视图 → 名词高亮」（缺省开 ⚑，`novelforge.editor.prefs` 的 `nameHighlight`，只认明明白白
 * 的 `false`）；关着时不画，也不弹浮窗（浮窗靠画着的那一层认名字）。超过 30 万字的文件不画（镜像层的上限）。
 */
import { el } from '../dom';
import { toast } from '../globals';
import type { MenuItem } from '../globals';
import type { InMessage } from '../protocol';
import { onMessage } from '../vscodeApi';
import { onEditorChange } from './api';
import type { OpenFile, Pane } from './api';
import { measureOffset, nextFrame, rangeAtPoint, tooLargeToHighlight } from './highlight';
import type { HighlightRange } from './highlight';
import { createLiveLayer } from './liveLayer';
import type { LiveLayer } from './liveLayer';
import { currentNameCatalog, onNameCatalog, refreshNameIndex } from './names';
import { buildNameMatcher, completionApplies, nameItemOf, nameRanges } from './namesCore';
import type { NameCatalog, NameItem, NameMatcher } from './namesCore';
import { onPrefsChange, setStoredPrefs, storedPrefs } from './paragraphState';
import { isTouchEvent, lastPointerWasTouch, trackPointer } from '../touch';
import { addAreaMenu } from './api';
import { isMacPlatform } from './shortcuts';
import { panes } from './store';

/** 高亮镜像层上的图层名。 */
export const NAMES_LAYER = 'names';
/** 鼠标在一个名字上停多久才弹浮窗。 */
export const HOVER_DELAY_MS = 400;
/** 偏好里那一项的键。 */
const PREF_KEY = 'nameHighlight';

// ---------------------------------------------------------------- 偏好

let enabled = readEnabled();

function readEnabled(): boolean {
  return storedPrefs()[PREF_KEY] !== false;
}

function setEnabled(on: boolean): void {
  if (enabled !== on) {
    setStoredPrefs({ [PREF_KEY]: on ? undefined : false });
  }
}

// ---------------------------------------------------------------- 认名字

let matcher: { catalog: NameCatalog; matcher: NameMatcher } | null = null;

/** 手上那份表切好的匹配表（表换了重切）。还没有表时 null。 */
function currentMatcher(): NameMatcher | null {
  const catalog = currentNameCatalog();
  if (!catalog) {
    matcher = null;
    return null;
  }
  if (matcher?.catalog !== catalog) {
    matcher = { catalog, matcher: buildNameMatcher(catalog) };
  }
  return matcher.matcher;
}

/** 每份文件上一次认出来的（哪一份文字、哪一张表），`render` 时文字没变就不重找。 */
const found = new WeakMap<OpenFile, { draft: string; matcher: NameMatcher; ranges: HighlightRange[] }>();

function rangesOf(file: OpenFile, text: string): HighlightRange[] {
  if (!enabled || tooLargeToHighlight(text)) {
    return [];
  }
  const m = currentMatcher();
  if (!m) {
    // 还没有表：要一份，到了整层重画（onNameCatalog）。
    refreshNameIndex();
    return [];
  }
  const known = found.get(file);
  if (known && known.draft === file.draft && known.matcher === m) {
    return known.ranges;
  }
  const ranges = nameRanges(m, text, file.path).map(({ start, end, cls }) => ({ start, end, cls }));
  found.set(file, { draft: file.draft, matcher: m, ranges });
  return ranges;
}

let layer: LiveLayer | undefined;

/** 鼠标底下那个名字：画着的那一段与它在表里的那一条。 */
function nameAt(pane: Pane, x: number, y: number): { range: HighlightRange; item: NameItem } | undefined {
  const m = currentMatcher();
  if (!enabled || !m || pane.isPreviewing()) {
    return undefined;
  }
  const range = rangeAtPoint(pane, NAMES_LAYER, x, y);
  const item = range && nameItemOf(m, pane.area.value.slice(range.start, range.end));
  return range && item ? { range, item } : undefined;
}

// ---------------------------------------------------------------- 浮窗

let tip: HTMLElement | null = null;
/** 浮窗正在说的（或等着要说的）是哪一块的哪一段。 */
let current: { pane: Pane; start: number; end: number } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function modLabel(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl';
}

function hideTip(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  tappedTip = false;
  current = null;
  tip?.remove();
  tip = null;
}

function buildTip(item: NameItem, written: string, touch = false, open?: () => void): HTMLElement {
  const box = el('div', `nm-tip nm-${item.source}`);
  box.setAttribute('role', 'tooltip');
  const head = el('div', 'nm-head');
  head.append(el('span', 'nm-name', item.name), el('span', 'nm-badge', item.source === 'unfiled' ? `${item.badge} · 未建条目` : item.badge));
  box.appendChild(head);
  if (written.toLowerCase() !== item.name.toLowerCase()) {
    box.appendChild(el('div', 'nm-alias', `这里写的是「${written}」`));
  }
  box.appendChild(item.brief ? el('div', 'nm-brief', item.brief) : el('div', 'nm-brief nm-empty', '还没有一句话简介'));
  const what = item.source === 'character' ? '角色卡' : '设定条目';
  if (item.path && touch && open) {
    // 手指点出来的浮窗：底下是一颗按钮。按下去不夺焦点——正文区一失焦浮窗就收了，点不到它。
    const btn = el('button', 'chip-btn nm-open', `打开${what}`);
    btn.type = 'button';
    for (const type of ['pointerdown', 'mousedown'] as const) {
      btn.addEventListener(type, (e) => e.preventDefault());
    }
    btn.addEventListener('click', () => {
      hideTip();
      open();
    });
    box.classList.add('nm-touch');
    box.appendChild(btn);
    return box;
  }
  box.appendChild(el('div', 'nm-foot', item.path ? `${modLabel()}+点击打开${what}` : '设定名录里出现过，还没建条目'));
  return box;
}

/** 贴着鼠标摆：鼠标下面一点，靠近底边翻到上面，横向夹进视口。 */
function placeTip(box: HTMLElement, x: number, y: number): void {
  const gap = 18;
  const width = box.offsetWidth;
  const height = box.offsetHeight;
  const left = Math.max(4, Math.min(x - 12, window.innerWidth - width - 4));
  const below = y + gap;
  const top = below + height > window.innerHeight - 4 && y - gap - height >= 4 ? y - gap - height : below;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
}

function showTip(pane: Pane, hit: { range: HighlightRange; item: NameItem }, x: number, y: number, touch = false): void {
  tip?.remove();
  const path = hit.item.path;
  const open = path ? () => post({ type: 'openEditor', path, pane: pane.id }) : undefined;
  tip = buildTip(hit.item, pane.area.value.slice(hit.range.start, hit.range.end), touch, open);
  document.body.appendChild(tip);
  placeTip(tip, x, y);
}

/** 手指点在一个名字上：光标照常落下，同时弹它的浮窗（触屏没有悬停）。点别处、打字、滚动、失焦照旧收起；正在打字时不弹。 */
function onTap(pane: Pane, e: MouseEvent): void {
  if (!isTouchEvent(e) || layer?.composing(pane)) {
    return;
  }
  const hit = nameAt(pane, e.clientX, e.clientY);
  hideTip();
  if (!hit || document.body.classList.contains('kb-open')) {
    return;
  }
  current = { pane, start: hit.range.start, end: hit.range.end };
  showTip(pane, hit, e.clientX, e.clientY, true);
  tappedTip = true;
}

/** 正开着的浮窗是手指点出来的（软键盘弹出来、页面变矮时要跟着那个名字挪）。 */
let tappedTip = false;

/**
 * 手指点出来的浮窗跟着名字挪：点一下正文，软键盘随即弹出来，页面变矮、编辑区收起章节条与工具栏（narrow.css），名字挪了地方，
 * 浮窗还停在点下去的那个坐标上（多半已经在键盘底下）。窗口尺寸变了就按那个名字现在的位置重摆，量不出来或滚出了编辑区就收起。
 */
function followTappedTip(): void {
  if (!tip || !tappedTip || !current) {
    return;
  }
  const { pane, start } = current;
  const area = pane.area;
  const rect = area.getBoundingClientRect();
  const pos = measureOffset(pane, start);
  if (!pos) {
    hideTip();
    return;
  }
  const top = rect.top + area.clientTop + pos.top - area.scrollTop;
  if (rect.height > 0 && (top + pos.height <= rect.top || top >= rect.bottom)) {
    hideTip();
    return;
  }
  placeTip(tip, rect.left + area.clientLeft + pos.left - area.scrollLeft + 12, top + pos.height / 2);
}

/** 右键一个能打开的名字：菜单最前面给「打开「林昭」的角色卡」。未建条目没有文件，不给。 */
function menuItems(pane: Pane, at: { x: number; y: number }): MenuItem[] {
  const hit = nameAt(pane, at.x, at.y);
  const path = hit?.item.path;
  if (!hit || !path) {
    return [];
  }
  const what = hit.item.source === 'character' ? '角色卡' : '设定条目';
  return [{ label: `打开「${hit.item.name}」的${what}`, run: () => post({ type: 'openEditor', path, pane: pane.id }) }];
}

// ---------------------------------------------------------------- 鼠标

/** 最近一次鼠标在哪块、哪儿（下一帧量）。 */
let pointer: { pane: Pane; x: number; y: number; mod: boolean; dragging: boolean } | null = null;
let frame: number | undefined;

function modHeld(e: MouseEvent | KeyboardEvent): boolean {
  return isMacPlatform() ? e.metaKey : e.ctrlKey;
}

function setLinkCursor(pane: Pane, on: boolean): void {
  pane.area.classList.toggle('nm-link', on);
}

/** 量鼠标底下是不是名字：换了一个就重新计时，离开了就收起。 */
function probe(): void {
  frame = undefined;
  const p = pointer;
  if (!p) {
    return;
  }
  const hit = p.dragging || layer?.composing(p.pane) ? undefined : nameAt(p.pane, p.x, p.y);
  setLinkCursor(p.pane, !!hit?.item.path && p.mod);
  if (!hit) {
    if (current) {
      hideTip();
    }
    return;
  }
  if (current && current.pane === p.pane && current.start === hit.range.start && current.end === hit.range.end) {
    return;
  }
  hideTip();
  current = { pane: p.pane, start: hit.range.start, end: hit.range.end };
  const { x, y } = p;
  timer = setTimeout(() => {
    timer = undefined;
    // 停够了：再认一次（这期间可能打了字、滚了），还是它才弹。
    const again = nameAt(p.pane, x, y);
    if (current && again && again.range.start === current.start && again.range.end === current.end) {
      showTip(p.pane, again, x, y);
    } else {
      hideTip();
    }
  }, HOVER_DELAY_MS);
}

function onMove(pane: Pane, e: MouseEvent): void {
  // 手指点一下之后补发的兼容 mousemove 不是悬停（手指的浮窗走 onTap）。
  if (lastPointerWasTouch()) {
    return;
  }
  pointer = { pane, x: e.clientX, y: e.clientY, mod: modHeld(e), dragging: e.buttons !== 0 };
  if (frame === undefined) {
    frame = nextFrame(probe);
  }
}

/** Ctrl+点击（Mac 上 ⌘+点击）一个名字：打开它的卡或条目。不是名字照常（放光标）。 */
function onDown(pane: Pane, e: MouseEvent): void {
  hideTip();
  if (e.button !== 0 || !modHeld(e)) {
    return;
  }
  const hit = nameAt(pane, e.clientX, e.clientY);
  if (!hit) {
    return;
  }
  e.preventDefault();
  setLinkCursor(pane, false);
  if (!hit.item.path) {
    toast(`「${hit.item.name}」还没建条目（设定名录里出现过的名字）。`);
    return;
  }
  post({ type: 'openEditor', path: hit.item.path, pane: pane.id });
}

const hooked = new WeakSet<Pane>();

function hook(pane: Pane): void {
  if (hooked.has(pane)) {
    return;
  }
  hooked.add(pane);
  const area = pane.area;
  area.addEventListener('mousemove', (e) => onMove(pane, e));
  area.addEventListener('mousedown', (e) => onDown(pane, e));
  area.addEventListener('click', (e) => onTap(pane, e));
  area.addEventListener('mouseleave', () => {
    pointer = null;
    setLinkCursor(pane, false);
    // 手指点出来的浮窗不跟鼠标走：点完之后补发的兼容 mouseleave 不收它（点别处、打字、滚动照旧收）。
    if (!lastPointerWasTouch()) {
      hideTip();
    }
  });
  // 右键（长按）弹菜单时也收：两样都是 fixed 的，叠在一起谁都读不清。
  for (const type of ['keydown', 'scroll', 'wheel', 'compositionstart', 'blur', 'contextmenu'] as const) {
    area.addEventListener(type, (e) => {
      // 光按下修饰键不算（按住 Ctrl 正是要点它）。
      if (e instanceof KeyboardEvent && ['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) {
        return;
      }
      if (current?.pane === pane) {
        hideTip();
      }
    });
  }
}

/** 按下 / 松开 Ctrl（⌘）时鼠标没动：手形跟着变。 */
function onModKey(e: KeyboardEvent): void {
  const p = pointer;
  if (!p || (e.key !== 'Control' && e.key !== 'Meta')) {
    return;
  }
  const mod = modHeld(e);
  if (mod !== p.mod) {
    p.mod = mod;
    if (frame === undefined) {
      frame = nextFrame(probe);
    }
  }
}

// ---------------------------------------------------------------- 装配

let post: (msg: InMessage) => void = () => {};

/** 当前正对着一份归这一层管的文件（要不要问名词表）。 */
function wantsIndex(): boolean {
  return (
    enabled &&
    Object.values(panes).some((pane) => {
      const file = pane?.activeFile();
      return !!file && completionApplies(file.kind);
    })
  );
}

/** 装一次（`index.ts`，在 `installNames` 之后：名词表的收发归它）。 */
export function installNameMarks(send: (msg: InMessage) => void): void {
  post = send;
  trackPointer();
  addAreaMenu(menuItems);
  layer = createLiveLayer({
    layer: NAMES_LAYER,
    applies: (file) => completionApplies(file.kind),
    ranges: rangesOf,
  });

  onEditorChange((ev) => {
    if (ev.type === 'render') {
      hook(ev.pane);
      if (current?.pane === ev.pane) {
        hideTip();
      }
      const file = ev.pane.activeFile();
      if (enabled && file && completionApplies(file.kind)) {
        refreshNameIndex();
      }
    } else if (current?.pane === ev.pane) {
      hideTip();
    }
  });
  for (const pane of Object.values(panes)) {
    if (pane) {
      hook(pane);
    }
  }
  document.addEventListener('keydown', onModKey, true);
  document.addEventListener('keyup', onModKey, true);
  window.addEventListener('blur', hideTip);
  // 软键盘弹出 / 收起：页面变矮又变高，手指点出来的浮窗跟着名字挪（下一帧，等新排版落定）。
  window.addEventListener('resize', () => nextFrame(followTappedTip));

  // 表换了（到了新的一份、换工程作废）：整层按新表重画。
  onNameCatalog(() => {
    hideTip();
    layer?.recheckAll();
  });

  // 磁盘上变过（names.ts 先记一笔过期）：正对着要画的文件就再问一次，没变的话后端只回指纹。
  onMessage((msg) => {
    if (msg.type === 'state' && wantsIndex()) {
      queueMicrotask(refreshNameIndex);
    }
  });

  onPrefsChange(() => {
    const next = readEnabled();
    if (next === enabled) {
      return;
    }
    enabled = next;
    hideTip();
    for (const pane of Object.values(panes)) {
      if (pane) {
        setLinkCursor(pane, false);
      }
    }
    layer?.recheckAll(true);
  });

  window.addEventListener('nf-names-query', (e) => {
    e.detail.highlight = enabled;
  });

  window.addEventListener('nf-names-command', (e) => {
    if (e.detail.name === 'toggleHighlight') {
      setEnabled(!enabled);
    }
  });
}
