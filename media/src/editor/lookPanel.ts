/**
 * 外观面板（「视图 → 外观设置…」）：正文字体、字号、行距、版心宽度、主题。改了**当场生效**，「恢复默认」把排版
 * 那四项放回缺省（主题另记在 `novelforge.theme`，不跟着变 ⚑）。
 *
 * 写法与样式照 `dialog.ts`：DOM 现造现拆、页面模板里没有它，面板外观复用 `css/view/modal.css` 那一套
 * （`.modal` / `.modal-head` / `.modal-body` / `.modal-foot`，按钮 `.primary` / `.secondary`），焦点进面板、
 * 关掉之后回到打开之前的地方，`Esc` 关。**与 `dialog.ts` 不同的一处**：它不是模态的——改字号要一边改一边看正文，
 * 所以外面那一层不是 `.modal-overlay`（别的模块拿「有没有 `.modal-overlay` 开着」判断有没有弹窗，`Ctrl+P` 会因此
 * 不开），而是透明、不拦点击的 `.ed-look-overlay`（只有面板本身接得住），面板靠右上，正文照样能点、能滚、能打字；
 * 也不算「有对话框开着」（不拦自动保存）。同一时刻只有一个，再打开只是把焦点放回来。
 *
 * 段间距不单列一项（⚑）：textarea 画不出段与段之间的额外间距，镜像层又必须与它排得一模一样；空行分段时段间距
 * 就是那一行空行（跟着行距变），段首缩进的格式本来就不空行。面板上用一句话说清楚。
 */
import { el } from '../dom';
import { currentLook, onLookChange, resetLook, setLook } from './look';
import { FONT_CHOICES, FONT_SIZE, LINE_HEIGHT, MEASURE, measureLabel, normalizeFont } from './lookCore';
import { THEMES, THEME_LABEL, currentTheme, setTheme } from './shell';
import type { Theme } from './shell';

interface Panel {
  overlay: HTMLElement;
  box: HTMLElement;
  focusFirst(): void;
}

let panel: Panel | undefined;

/** 面板开着没有。 */
export function isLookPanelOpen(): boolean {
  return !!panel;
}

/** 打开外观面板（已经开着就把焦点放回去）。 */
export function openLookPanel(): void {
  if (panel) {
    panel.focusFirst();
    return;
  }
  panel = buildPanel();
}

/** 关掉外观面板。 */
export function closeLookPanel(): void {
  panel?.overlay.remove();
  panel = undefined;
}

function buildPanel(): Panel {
  const previous = document.activeElement as HTMLElement | null;
  const overlay = el('div', 'ed-look-overlay');
  const box = el('div', 'modal ed-look');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'false');
  const titleId = `edLookTitle${Date.now().toString(36)}`;
  box.setAttribute('aria-labelledby', titleId);

  const head = el('div', 'modal-head');
  const title = el('span', 'modal-title', '外观');
  title.id = titleId;
  const x = el('button', 'icon-btn ed-look-x', '×');
  x.type = 'button';
  x.title = '关闭（Esc）';
  head.append(title, x);

  const body = el('div', 'modal-body');

  // ---- 正文字体
  const font = el('select', 'ed-look-font');
  for (const choice of FONT_CHOICES) {
    const opt = el('option', undefined, choice.label);
    opt.value = choice.id;
    // 下拉框里每一项用它自己的字体写（浏览器支持就看得出差别，不支持也无害）。
    opt.style.fontFamily = choice.stack;
    font.appendChild(opt);
  }
  font.addEventListener('change', () => setLook({ fontFamily: normalizeFont(font.value) }));

  // ---- 字号：− [15] px +
  const sizeDec = el('button', 'secondary ed-look-size-dec', '−');
  sizeDec.type = 'button';
  sizeDec.title = '缩小（编辑区里 Ctrl+-）';
  const size = el('input', 'ed-look-size');
  size.type = 'number';
  size.min = String(FONT_SIZE.min);
  size.max = String(FONT_SIZE.max);
  size.step = String(FONT_SIZE.step);
  const sizeInc = el('button', 'secondary ed-look-size-inc', '+');
  sizeInc.type = 'button';
  sizeInc.title = '放大（编辑区里 Ctrl+=）';
  sizeDec.addEventListener('click', () => setLook({ fontSize: currentLook().fontSize - FONT_SIZE.step }));
  sizeInc.addEventListener('click', () => setLook({ fontSize: currentLook().fontSize + FONT_SIZE.step }));
  // 打字时不跟（打「18」的那个「1」会被夹成 12）；按回车、离开输入框时才认，认完写回校验后的值。清空了不算数。
  size.addEventListener('change', () => {
    const value = Number(size.value);
    if (size.value.trim() !== '' && Number.isFinite(value)) {
      setLook({ fontSize: value });
    }
    size.value = String(currentLook().fontSize);
  });
  const sizeRow = el('span', 'ed-look-inline');
  sizeRow.append(sizeDec, size, el('span', 'ed-look-unit', 'px'), sizeInc);

  // ---- 行距：滑块 + 当前值
  const line = el('input', 'ed-look-line');
  line.type = 'range';
  line.min = String(LINE_HEIGHT.min);
  line.max = String(LINE_HEIGHT.max);
  line.step = String(LINE_HEIGHT.step);
  const lineValue = el('span', 'ed-look-unit ed-look-line-value');
  line.addEventListener('input', () => setLook({ lineHeight: Number(line.value) }));
  const lineRow = el('span', 'ed-look-inline');
  lineRow.append(line, lineValue);

  // ---- 版心宽度
  const measure = el('select', 'ed-look-measure');
  measure.addEventListener('change', () => setLook({ measure: Number(measure.value) }));

  // ---- 主题：三颗单选
  const themes = el('span', 'ed-look-inline ed-look-theme');
  themes.setAttribute('role', 'radiogroup');
  const themeName = `edLookTheme${Date.now().toString(36)}`;
  const themeInputs = THEMES.map((theme) => {
    const label = el('label', 'ed-look-choice');
    const input = el('input');
    input.type = 'radio';
    input.name = themeName;
    input.value = theme;
    input.addEventListener('change', () => {
      if (input.checked) {
        setTheme(theme as Theme);
      }
    });
    label.append(input, document.createTextNode(THEME_LABEL[theme]));
    themes.appendChild(label);
    return input;
  });

  body.append(
    row('正文字体', font),
    row('字号', sizeRow),
    row('行距', lineRow),
    row('版心宽度', measure, '宽屏时这一栏居中；「铺满」就是占满编辑区。'),
    el(
      'p',
      'hint ed-look-note',
      '段间距跟着分段格式走：空行分段时就是那一行空行（随行距变），段首缩进不空行。'
    ),
    row('主题', themes, '护眼是米黄底色，整个界面一起换。')
  );

  const foot = el('div', 'modal-foot');
  const reset = el('button', 'secondary ed-look-reset', '恢复默认');
  reset.type = 'button';
  reset.title = '字体、字号、行距、版心回到缺省（主题不变）';
  reset.addEventListener('click', () => resetLook());
  const close = el('button', 'primary ed-look-close', '关闭');
  close.type = 'button';
  foot.append(reset, el('span', 'spacer'), close);
  body.appendChild(foot);

  box.append(head, body);
  overlay.appendChild(box);

  const refresh = (): void => {
    const look = currentLook();
    font.value = look.fontFamily;
    if (document.activeElement !== size) {
      size.value = String(look.fontSize);
    }
    sizeDec.disabled = look.fontSize <= FONT_SIZE.min;
    sizeInc.disabled = look.fontSize >= FONT_SIZE.max;
    line.value = String(look.lineHeight);
    lineValue.textContent = look.lineHeight.toFixed(2);
    // 手改偏好写了一个不在几档里的宽度：也列出来，选中它。
    const values: number[] = [...MEASURE.presets];
    if (!values.includes(look.measure)) {
      values.push(look.measure);
      values.sort((a, b) => a - b);
    }
    measure.replaceChildren(
      ...values.map((v) => {
        const opt = el('option', undefined, measureLabel(v));
        opt.value = String(v);
        return opt;
      })
    );
    measure.value = String(look.measure);
    const theme = currentTheme();
    for (const input of themeInputs) {
      input.checked = input.value === theme;
    }
  };
  refresh();
  const unsubscribe = onLookChange(refresh);

  const onKey = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229 || e.key !== 'Escape') {
      return;
    }
    // 面板开着时 Esc 只收面板（不连带退出专注模式、不收查找条）。
    e.preventDefault();
    e.stopPropagation();
    finish();
  };

  function finish(): void {
    document.removeEventListener('keydown', onKey, true);
    unsubscribe();
    closeLookPanel();
    if (previous?.isConnected) {
      previous.focus();
    }
  }

  x.addEventListener('click', finish);
  close.addEventListener('click', finish);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  font.focus();

  return { overlay, box, focusFirst: () => font.focus() };
}

/** 一行：左边标签，右边控件，底下可选一行小字。控件没有自己的 `<label>`，名字挂在 aria-label 上。 */
function row(label: string, control: HTMLElement, note?: string): HTMLElement {
  const wrap = el('div', 'ed-look-row');
  const name = el('span', 'ed-look-label', label);
  const right = el('div', 'ed-look-control');
  for (const field of control.matches('select, input') ? [control] : [...control.querySelectorAll('select, input:not([type="radio"])')]) {
    field.setAttribute('aria-label', label);
  }
  if (control.getAttribute('role') === 'radiogroup') {
    control.setAttribute('aria-label', label);
  }
  right.appendChild(control);
  if (note) {
    right.appendChild(el('span', 'hint ed-look-hint', note));
  }
  wrap.append(name, right);
  return wrap;
}
