/**
 * `/` 命令面板：当前阶段能下的其它命令。
 *
 * ## 为什么是命令而不是一排按钮
 *
 * 改造前这里是七个平铺的能力按钮（讨论/扩展/挑刺/检查/拆分/生成/改写）。
 * 问题不是不好看，是**七个等重的按钮看不出该点哪个**——而在任何一个具体
 * 时刻，作者真正要按的只有一个（状态机算得出来，见 pipeline.ts 的下一步条），
 * 其余六个是「偶尔要用」。偶尔要用的东西该收进命令面板。
 *
 * 而且那七个按钮是**单选器**：点「生成」什么都不发生，还得再输入一句话
 * 才能发送。挑一个命令与执行它之间隔着一次多余的操作。
 *
 * ## 交互：命令就打在输入框里（Cursor / Claude Code 那一套）
 *
 * 从前面板是「输入框上方另起一块」，`/` 由 keydown 拦下来**不落进输入框**，
 * 过滤串自己攒在模块变量里。那等于在输入框旁边又造了一个隐形的输入框：
 * 光标在哪、退格退的是谁，全靠这里的状态猜；输入法（中文候选框）打的字更是
 * 一个都收不到。
 *
 * 现在改成：
 * - **`/` 就是输入框里的一个普通字符**，面板只是浮在它上方的候选列表；
 * - 过滤串**从输入框的值算出来**（`slashQuery`），不再自己攒——中文、输入法、
 *   退格、粘贴、Ctrl+A 全都自动对；
 * - 面板只接管 ↑↓ / Enter / Tab / Esc 四种键，可打印字符一律放行给输入框。
 *
 * 判据是「整个输入框只有一个 `/词`」（`/^\/\S*$/`）：`/` 在中文正文里是普通
 * 字符（日期、比值、网址），只要后面跟了空格或前面有别的字，就不是在下命令。
 *
 * 命令表来自 core 的 `commandsFor`（零 import 的纯函数，前端直接打包）。
 * **带上 target 的种类**：大纲那一层有两种落点，同一个「拆分」在全书大纲上
 * 拆的是卷、在一卷上拆的是一个剧情段，说法必须跟着变。
 * 前端不自己维护一份——否则界面上会出现一个后端不认的命令，点了什么都不发生。
 */
import { el as mk, clear, closestFrom } from '../dom';
import { commandsFor } from '../protocol';
import type { StageCommand } from '../protocol';
import { el } from './refs';
import { store } from './store';

/** 当前打开的面板。同时只允许一个。 */
let panel: HTMLElement | null = null;
let onPick: (cmd: StageCommand) => void = () => {};
let items: StageCommand[] = [];
let active = 0;
/**
 * Esc 关过之后不该马上弹回来。
 *
 * 输入框里那个 `/` 还在（它是用户的字，我们不替他删），而面板是由输入框的值
 * 驱动的——不记一笔「他已经关过了」，下一次按键又会把它弹出来。
 */
let dismissed = false;

/**
 * 输入框当下的命令查询串；不在下命令时为 null。
 *
 * 整个值必须只有一个 `/词`。这条判据同时管着「要不要开面板」与「挑中命令后
 * 要不要把这几个字从输入框里抹掉」，所以只在这里写一次。
 */
export function slashQuery(value: string): string | null {
  const m = /^\/(\S*)$/.exec(value);
  return m ? m[1] : null;
}

export function bindCommandPick(fn: (cmd: StageCommand) => void): void {
  onPick = fn;
}

export function isCommandPaletteOpen(): boolean {
  return !!panel;
}

export function closeCommands(): void {
  panel?.remove();
  panel = null;
  active = 0;
  el.cmdBtn.classList.remove('active');
}

/**
 * 输入框的值变了：该开就开、该关就关、开着就重画。
 *
 * 由 composer 的 `input` 监听转进来。**面板的开合是输入框内容的函数**，
 * 不是一串各自为政的 keydown 分支。
 */
export function syncCommandPalette(): void {
  const q = slashQuery(el.input.value);
  if (q === null) {
    // 已经不是在下命令了（删掉了 `/`、或往后打了别的字）——顺手把
    // 「关过了」这一笔也清掉，下次打 `/` 才还能弹。
    dismissed = false;
    closeCommands();
    return;
  }
  if (dismissed) {
    return;
  }
  if (panel) {
    redraw();
  } else {
    openCommands();
  }
}

/**
 * 「/ 命令」按钮：开则关，关则开。
 *
 * 输入框为空时顺手把 `/` 打进去——按钮和键盘走的是同一条路，界面上不该
 * 出现「点按钮弹出来的面板」和「打 / 弹出来的面板」两种东西。输入框里已经
 * 有别的字时**不动那些字**：他正写着补充要求，挑个命令带上就好。
 */
export function toggleCommands(): void {
  if (panel) {
    dismissed = true;
    closeCommands();
    return;
  }
  dismissed = false;
  if (el.input.value === '') {
    el.input.value = '/';
  }
  el.input.focus();
  openCommands();
}

export function openCommands(): void {
  closeCommands();
  if (commandsFor(store.session.stage).length === 0) {
    return;
  }

  panel = mk('div', 'cmd-panel');
  panel.setAttribute('role', 'listbox');
  // 挂在输入框那一格里（它是 position: relative），面板从输入框上沿往上浮。
  // 命令的字留在输入框里，候选浮在正上方——视线不用离开正在打字的地方。
  el.composerInput.appendChild(panel);
  el.cmdBtn.classList.add('active');
  redraw();

  // 点别处收起。延到下一拍再挂，否则「点按钮打开」这一次点击自己就把它关了。
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
}

function onDocClick(e: MouseEvent): void {
  if (!panel) {
    document.removeEventListener('click', onDocClick);
    return;
  }
  if (!panel.contains(e.target as Node) && !closestFrom(e.target, '#cmdBtn')) {
    dismissed = true;
    closeCommands();
    document.removeEventListener('click', onDocClick);
  }
}

function redraw(): void {
  if (!panel) {
    return;
  }
  clear(panel);

  const filter = slashQuery(el.input.value) ?? '';
  items = matching(commandsFor(store.session.stage), filter);
  active = Math.min(active, Math.max(0, items.length - 1));

  const head = mk('div', 'cmd-head');
  head.appendChild(mk('span', 'cmd-head-title', '命令'));
  head.appendChild(mk('span', 'meta', items.length > 0 ? '↑↓ 选择 · Enter 确认' : '没有匹配的命令'));
  panel.appendChild(head);

  items.forEach((cmd, i) => {
    const row = mk('button', `cmd-item${i === active ? ' active' : ''}`);
    row.dataset.capability = cmd.capability;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === active ? 'true' : 'false');

    const line = mk('span', 'cmd-line');
    // 名字前面带上斜杠：面板里挑的和输入框里打的是同一样东西。
    line.appendChild(mk('span', 'cmd-label', `/${cmd.label}`));
    // 面板里的命令全都会写文件（讨论不是命令，打字就是）——每条都标出来：
    // 点了会花钱，而且会在磁盘上留下东西。
    row.classList.add('cmd-writes');
    line.appendChild(mk('span', 'cmd-tag', '写文件'));
    row.appendChild(line);
    row.appendChild(mk('span', 'cmd-hint', cmd.hint));

    row.addEventListener('mouseenter', () => {
      if (active !== i) {
        active = i;
        redraw();
      }
    });
    row.addEventListener('click', () => pick(cmd));
    panel!.appendChild(row);
  });
}

/** 中文标签、ascii 全拼、拼音首字母都认，大小写不敏感。 */
function matching(all: StageCommand[], q: string): StageCommand[] {
  const needle = q.trim().toLowerCase();
  if (!needle) {
    return all;
  }
  return all.filter(
    (c) => c.label.includes(q.trim()) || c.keys.some((k) => k.startsWith(needle))
  );
}

function pick(cmd: StageCommand): void {
  // 命令那几个字是用来挑命令的，不是要发给模型的话——挑完就收走，
  // 剩下的输入框留给补充要求。输入框里本来就是别人的正文时（按钮开的面板）
  // 一个字都不动。
  if (slashQuery(el.input.value) !== null) {
    el.input.value = '';
  }
  dismissed = false;
  closeCommands();
  document.removeEventListener('click', onDocClick);
  onPick(cmd);
}

/**
 * 面板开着时接管键盘。返回 true 表示这一下已被消费，输入框不该再处理。
 *
 * 只认导航与确认那四种键：**可打印字符一律放行**给输入框，过滤串由
 * `syncCommandPalette` 从输入框的值重算。从前这里自己攒过滤串，于是
 * 输入法打的中文一个都收不到（composition 不发 keydown 的可打印键）。
 */
export function handleCommandKey(e: KeyboardEvent): boolean {
  if (!panel) {
    return false;
  }
  switch (e.key) {
    case 'Escape':
      dismissed = true;
      closeCommands();
      return true;
    case 'ArrowDown':
      active = items.length === 0 ? 0 : (active + 1) % items.length;
      redraw();
      return true;
    case 'ArrowUp':
      active = items.length === 0 ? 0 : (active - 1 + items.length) % items.length;
      redraw();
      return true;
    case 'Tab':
    case 'Enter':
      // 有候选就挑它；一个都没匹配上时 Enter 不该悄悄发一条 `/xxx` 出去。
      if (items[active]) {
        pick(items[active]);
      }
      return true;
    default:
      return false;
  }
}

/** 面板与「/ 命令」按钮在生成期间都该停手——两者都会发起新的一轮。 */
export function setCommandsDisabled(disabled: boolean): void {
  el.cmdBtn.disabled = disabled;
  if (disabled) {
    closeCommands();
  }
}
