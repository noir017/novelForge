/**
 * 工程页顶部的长任务进度条。
 *
 * 后端每次进度变化都全量重推 `tasks`，这里整块重画——列表最多两三项，
 * 增量更新换来的那点开销不值得多维护一份状态。
 *
 * **计时由前端自己走**：后端只在有进度时才推，一次模型调用能安静一分钟，
 * 那期间计时器停住会让人以为卡死了。收到快照时记下 `Date.now() - elapsedMs`
 * 当基线，之后每秒**只改计时文本**——重建 DOM 会打断「停止」按钮上的点击。
 */
import { el as mk, setHidden, spacer } from '../dom';
import type { TaskSnapshot } from '../protocol';
import { linkBtn } from './buttons';
import { durationText } from './format';
import { el } from './refs';
import { vscode } from './store';

/** 快照 + 收到它时的本地基线时刻。 */
interface RunningTask {
  snapshot: TaskSnapshot;
  baseAt: number;
}

let tasks: RunningTask[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

export function renderTasks(list: TaskSnapshot[]): void {
  const now = Date.now();
  tasks = (list || []).map((snapshot) => ({ snapshot, baseAt: now - (snapshot.elapsedMs || 0) }));

  el.taskList.innerHTML = '';
  setHidden(el.taskList, tasks.length === 0);

  if (tasks.length === 0) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return;
  }
  for (const task of tasks) {
    el.taskList.appendChild(buildTaskRow(task.snapshot));
  }
  timer ??= setInterval(tick, 1000);
}

/** 某个标题的长任务是否在跑。用于避免重复触发同一个动作。 */
export function hasTask(title: string): boolean {
  return tasks.some((t) => t.snapshot.title === title);
}

/** 每秒只改计时文本，不重建 DOM——重建会打断「停止」按钮上的点击。 */
function tick(): void {
  for (const { snapshot, baseAt } of tasks) {
    const node = el.taskList.querySelector(`[data-task="${snapshot.id}"] .task-time`);
    if (node) {
      node.textContent = durationText(Date.now() - baseAt);
    }
  }
}

function buildTaskRow(t: TaskSnapshot): HTMLElement {
  const box = mk('div', 'task');
  box.dataset.task = t.id;

  const head = mk('div', 'task-head');
  head.appendChild(mk('span', 'task-title', t.title));
  head.appendChild(mk('span', 'meta task-counter', counterText(t)));
  head.appendChild(spacer());
  head.appendChild(mk('span', 'meta task-time', durationText(t.elapsedMs || 0)));
  head.appendChild(linkBtn('停止', () => vscode.postMessage({ type: 'cancelTask', id: t.id })));
  box.appendChild(head);

  box.appendChild(buildBar(t));
  box.appendChild(mk('div', 'task-msg', t.message || ''));
  return box;
}

function buildBar(t: TaskSnapshot): HTMLElement {
  const bar = mk('div', 'task-bar');
  const fill = mk('div', 'task-fill');
  const total = t.total ?? 0;
  if (total > 0) {
    fill.style.width = `${Math.min(100, Math.round(((t.current || 0) / total) * 100))}%`;
  } else {
    // 不知道总量时走一条来回扫的条，至少表明还活着——别显示假的百分比。
    bar.classList.add('indeterminate');
    fill.style.width = '35%';
  }
  bar.appendChild(fill);
  return bar;
}

function counterText(t: TaskSnapshot): string {
  const total = t.total ?? 0;
  if (total <= 0) {
    return '';
  }
  const current = Math.min(t.current || 0, total);
  return `${current}/${total} · ${Math.round((current / total) * 100)}%`;
}
