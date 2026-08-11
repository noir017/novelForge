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
 * ## 交互
 *
 * - 输入框为空时按 `/`，或点「/ 命令」按钮 → 弹面板
 * - 键入可过滤（中文标签、ascii 全拼、拼音首字母都认）
 * - ↑↓ 选，Enter/点击确认 → 变成输入框上方的一枚 chip
 * - chip 在时，发送用它；发完即清
 *
 * 命令表来自 core 的 `commandsFor`（零 import 的纯函数，前端直接打包），
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
let filter = '';

export function bindCommandPick(fn: (cmd: StageCommand) => void): void {
  onPick = fn;
}

export function isCommandPaletteOpen(): boolean {
  return !!panel;
}

export function closeCommands(): void {
  panel?.remove();
  panel = null;
  filter = '';
  active = 0;
}

export function toggleCommands(): void {
  if (panel) {
    closeCommands();
    return;
  }
  openCommands();
}

export function openCommands(): void {
  closeCommands();
  const all = commandsFor(store.session.stage);
  if (all.length === 0) {
    return;
  }

  panel = mk('div', 'cmd-panel');
  // 挂在下一步条里：它就在输入框上方，面板从那里往上展开，
  // 视线不用离开输入区。
  el.nextStep.appendChild(panel);
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
    closeCommands();
    document.removeEventListener('click', onDocClick);
  }
}

function redraw(): void {
  if (!panel) {
    return;
  }
  clear(panel);

  items = matching(commandsFor(store.session.stage), filter);
  active = Math.min(active, Math.max(0, items.length - 1));

  const head = mk('div', 'cmd-head');
  head.appendChild(mk('span', undefined, filter ? `/${filter}` : '/'));
  head.appendChild(mk('span', 'meta', items.length > 0 ? '↑↓ 选择，Enter 确认' : '没有匹配的命令'));
  panel.appendChild(head);

  items.forEach((cmd, i) => {
    const row = mk('button', `cmd-item${i === active ? ' active' : ''}`);
    row.dataset.capability = cmd.capability;
    row.appendChild(mk('span', 'cmd-label', cmd.label));
    row.appendChild(mk('span', 'cmd-hint', cmd.hint));
    // 会写文件的命令单独标一下：点了会花钱，而且会在磁盘上留下东西。
    if (cmd.writes) {
      row.classList.add('cmd-writes');
    }
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
  closeCommands();
  document.removeEventListener('click', onDocClick);
  onPick(cmd);
}

/**
 * 面板开着时接管键盘。返回 true 表示这一下已被消费，输入框不该再处理。
 *
 * 由 composer 的 keydown 转进来——面板挂在输入框外面，但键还是打在输入框里。
 */
export function handleCommandKey(e: KeyboardEvent): boolean {
  if (!panel) {
    return false;
  }
  switch (e.key) {
    case 'Escape':
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
    case 'Enter':
      if (items[active]) {
        pick(items[active]);
      }
      return true;
    case 'Backspace':
      // 退到 `/` 之前就是放弃这次唤出。
      if (filter === '') {
        closeCommands();
        return true;
      }
      filter = filter.slice(0, -1);
      redraw();
      return true;
    default:
      // 单个可打印字符进过滤串，其余（Tab、方向键、组合键）放行。
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        filter += e.key;
        active = 0;
        redraw();
        return true;
      }
      return false;
  }
}
