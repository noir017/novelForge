/**
 * 编辑器的页内对话框：关标签时问「保存 / 不保存 / 取消」、「还原」「用编辑器内容强制保存」之前的确认、
 * 磁盘上没了的文件要不要在原路径重建。编辑器里**不再用 `window.confirm`**——它只有确定 / 取消两颗、
 * 说不出「保存」与「不保存」的区别，还会把整个页面（连同 WebSocket 的回执）卡住。`beforeunload` 那一问
 * 仍是浏览器原生的，页面改不了。
 *
 * 外观复用页面上已有的弹窗那一套（`css/view/modal.css` 的 `.modal-overlay` / `.modal` / `.modal-head` /
 * `.modal-body` / `.modal-foot`，按钮是 `.primary` / `.secondary` / `.danger`）。DOM 每次现造、关掉就拆，
 * 页面模板里没有它。
 *
 * 键盘：焦点进对话框、缺省落在主按钮上；`Enter` 按下焦点所在的那颗（缺省就是主按钮），`Esc` 取消，
 * `Tab` / `Shift+Tab` 在几颗按钮之间绕、不出对话框。开着的时候 `Ctrl` / `Cmd` 组合键不往下传——
 * 别在作者正决定要不要保存的时候被 `Ctrl+S` / `Ctrl+W` 抢了先。关掉之后焦点回到打开之前的地方。
 *
 * 同一时刻只开一个：后来的排队，前一个答完才开。
 */
import { el } from '../dom';

export interface DialogButton<T extends string> {
  value: T;
  label: string;
  /** 主按钮：`Enter` 的缺省、打开时焦点落在它上面。只该有一颗。 */
  primary?: boolean;
  /** 会丢东西的那一颗（放弃修改、覆盖磁盘），画成红色。 */
  danger?: boolean;
}

export interface DialogSpec<T extends string> {
  title: string;
  message: string;
  /** 列在说明下面的几项（批量关闭时是哪几份）。`note` 跟在名字后面，`title` 是悬停提示。 */
  items?: { label: string; note?: string; title?: string }[];
  /** 列表下面再补一句（可选）。 */
  detail?: string;
  /** 从左到右摆；主按钮放最右（离「确定」最近的那一侧就是「继续」）。 */
  buttons: DialogButton<T>[];
  /** `Esc` 回的值。 */
  cancel: T;
}

let open = 0;
let queue: Promise<unknown> = Promise.resolve();

/** 有对话框开着（或排着队）。自动保存据此先不动手——作者正在决定。 */
export function isDialogOpen(): boolean {
  return open > 0;
}

/** 开一个对话框，回作者按下的那颗按钮的 `value`（`Esc` 回 `spec.cancel`）。没有别的开着时当场就画出来。 */
export function askDialog<T extends string>(spec: DialogSpec<T>): Promise<T> {
  open++;
  const run = open === 1 ? show(spec) : queue.then(() => show(spec));
  queue = run.catch(() => undefined);
  return run.finally(() => {
    open--;
  });
}

function show<T extends string>(spec: DialogSpec<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const overlay = el('div', 'modal-overlay ed-dialog-overlay');
    const box = el('div', 'modal ed-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const titleId = `edDialogTitle${Date.now().toString(36)}`;
    const messageId = `${titleId}m`;
    box.setAttribute('aria-labelledby', titleId);
    box.setAttribute('aria-describedby', messageId);

    const head = el('div', 'modal-head');
    const title = el('span', 'modal-title', spec.title);
    title.id = titleId;
    head.appendChild(title);

    const body = el('div', 'modal-body');
    const message = el('p', 'ed-dialog-message', spec.message);
    message.id = messageId;
    body.appendChild(message);
    if (spec.items?.length) {
      const list = el('ul', 'ed-dialog-list');
      for (const item of spec.items) {
        const li = el('li', undefined, item.label);
        if (item.title) {
          li.title = item.title;
        }
        if (item.note) {
          li.appendChild(el('span', 'ed-dialog-note', item.note));
        }
        list.appendChild(li);
      }
      body.appendChild(list);
    }
    if (spec.detail) {
      body.appendChild(el('p', 'ed-dialog-detail hint', spec.detail));
    }

    const foot = el('div', 'modal-foot');
    const buttons = spec.buttons.map((b) => {
      const btn = el('button', b.danger ? 'danger' : b.primary ? 'primary' : 'secondary', b.label);
      btn.type = 'button';
      btn.dataset.value = b.value;
      btn.addEventListener('click', () => finish(b.value));
      foot.appendChild(btn);
      return btn;
    });
    body.appendChild(foot);
    box.append(head, body);
    overlay.appendChild(box);

    const primary = buttons[spec.buttons.findIndex((b) => b.primary)] ?? buttons[buttons.length - 1];

    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) {
        return;
      }
      if (e.key === 'Escape') {
        stop(e);
        finish(spec.cancel);
      } else if (e.key === 'Enter') {
        stop(e);
        const focused = buttons.find((b) => b === document.activeElement) ?? primary;
        focused?.click();
      } else if (e.key === 'Tab') {
        stop(e);
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const step = e.shiftKey ? -1 : 1;
        const next = at < 0 ? primary : buttons[(at + step + buttons.length) % buttons.length];
        next?.focus();
      } else if (e.ctrlKey || e.metaKey) {
        stop(e);
      }
    };
    // 点到遮罩外面不算答（免得一失手关掉了还以为存了），焦点被点走了就拉回来。
    const keepFocus = (e: FocusEvent): void => {
      if (!box.contains(e.target as Node)) {
        primary?.focus();
      }
    };

    let done = false;
    function finish(value: T): void {
      if (done) {
        return;
      }
      done = true;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', keepFocus, true);
      overlay.remove();
      if (previous?.isConnected) {
        previous.focus();
      }
      resolve(value);
    }

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', keepFocus, true);
    document.body.appendChild(overlay);
    primary?.focus();
  });
}

function stop(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}
