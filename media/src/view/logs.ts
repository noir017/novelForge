/**
 * 日志页。
 *
 * 日志页是用户唯一能事后复查「刚才那 76 段卡在哪」的地方，所以：
 * - 全量缓冲留在前端，筛选纯在本地做，不往后端要；
 * - **增量不重画整表**——长任务每秒好几条，重画会让滚动位置乱跳，
 *   而且只在原本就贴着底时才跟着滚（用户翻上去看东西时不该被拽回来）。
 */
import { el as mk, maybeById, setHidden } from '../dom';
import type { LogEntry, LogLevel } from '../protocol';
import { logTime } from './format';
import { el } from './refs';
import { vscode } from './store';
import { isTabActive } from './tabs';
import { toast } from './toast';

const LOG_ORDER: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LABEL: Record<string, string> = { debug: '调试', info: '信息', warn: '警告', error: '错误' };

/** 与后端 MAX_ENTRIES 同量级，避免网页开一整天后攒下几万个节点。 */
const MAX_ROWS = 800;
/** 离底多近算「贴着底」。 */
const AT_BOTTOM_SLACK = 40;

/** 全量缓冲的前端副本。 */
let logs: LogEntry[] = [];
/** 只在日志页之外累计，切过去就清零——徽标是「有没有没看过的错」。 */
let unseenErrors = 0;
/**
 * 从库里补进来的历史条数。
 *
 * 单独记一笔是为了让 `MAX_ROWS` 的裁剪不把刚加载的历史又切掉——
 * 用户点「加载更早」就是要往前看，结果最早那批被裁掉才是荒谬的。
 */
let loadedHistory = 0;
/** 再往前没有了。按钮据此禁用——一直点一个什么都不会发生的按钮很挫。 */
let historyExhausted = false;

export function renderLogs(entries: LogEntry[]): void {
  logs = entries || [];
  // 后端重推的是内存缓冲（不含历史），历史副本随之作废。
  loadedHistory = 0;
  historyExhausted = false;
  syncEarlierBtn();
  redraw();
}

/** 按当前筛选重画整表。加载历史与切筛选条件都走它。 */
function redraw(): void {
  el.logBody.innerHTML = '';
  const shown = logs.filter(matches);
  for (const entry of shown) {
    el.logBody.appendChild(buildLogRow(entry));
  }
  updateMeta(shown.length);
  if (el.logFollow.checked) {
    el.logBody.scrollTop = el.logBody.scrollHeight;
  }
}

/**
 * 库里取来的更早日志，接在最前面。
 *
 * **不自动滚动**：用户点「加载更早」是要往前看，把他拽回底部等于白点。
 * 按 seq 去重——内存缓冲与库里那份必然重叠（同一条既进了缓冲也写了库）。
 */
export function prependLogHistory(entries: LogEntry[], exhausted: boolean): void {
  historyExhausted = exhausted;
  const known = new Set(logs.map((e) => e.seq));
  const fresh = entries.filter((e) => !known.has(e.seq));
  if (fresh.length > 0) {
    logs = [...fresh, ...logs];
    loadedHistory += fresh.length;
    // 保住滚动位置：重画后把视口挪回原先那条上，不然会跳到顶。
    const anchor = el.logBody.scrollHeight - el.logBody.scrollTop;
    redraw();
    el.logBody.scrollTop = el.logBody.scrollHeight - anchor;
  }
  syncEarlierBtn();
}

/** 没有更早的了（或没有库）就禁用按钮并改文案。 */
function syncEarlierBtn(): void {
  const btn = maybeById<HTMLButtonElement>('logEarlierBtn');
  if (!btn) {
    return;
  }
  btn.disabled = historyExhausted;
  btn.textContent = historyExhausted ? '没有更早的了' : '加载更早';
}

/** 增量追加一条。 */
export function appendLog(entry: LogEntry): void {
  logs.push(entry);
  // 裁剪时把加载进来的历史算进上限：那是用户主动要的，不能被实时日志顶掉。
  const cap = MAX_ROWS + loadedHistory;
  if (logs.length > cap) {
    logs.splice(0, logs.length - cap);
  }

  if (entry.level === 'error' && !isTabActive('logs')) {
    unseenErrors++;
    syncDot();
  }
  if (!matches(entry)) {
    return;
  }

  const atBottom =
    el.logBody.scrollHeight - el.logBody.scrollTop - el.logBody.clientHeight < AT_BOTTOM_SLACK;
  el.logBody.appendChild(buildLogRow(entry));
  while (el.logBody.childElementCount > MAX_ROWS + loadedHistory) {
    el.logBody.removeChild(el.logBody.firstChild!);
  }
  updateMeta(el.logBody.childElementCount);
  if (el.logFollow.checked && atBottom) {
    el.logBody.scrollTop = el.logBody.scrollHeight;
  }
}

/** 切到日志页时把红点收掉。 */
export function clearUnseenErrors(): void {
  unseenErrors = 0;
  syncDot();
}

/** 独立版活动栏上的红点：有没看过的错误就亮着。插件里没这个节点。 */
function syncDot(): void {
  const dot = maybeById('logsErrorDot');
  if (dot) {
    setHidden(dot, unseenErrors === 0);
  }
}

function levelValue(): number {
  return LOG_ORDER[el.logLevel.value] || LOG_ORDER.info;
}

function matches(entry: LogEntry): boolean {
  if ((LOG_ORDER[entry.level] || 0) < levelValue()) {
    return false;
  }
  const needle = el.logFilter.value.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return `${entry.scope} ${entry.message} ${entry.detail || ''}`.toLowerCase().includes(needle);
}

function levelLabel(level: LogLevel): string {
  return LOG_LABEL[level] || level;
}

function buildLogRow(entry: LogEntry): HTMLElement {
  const row = mk('div', `log-row log-${entry.level}`);

  const head = mk('div', 'log-head');
  head.appendChild(mk('span', 'log-time', logTime(entry.at)));
  head.appendChild(mk('span', 'log-level', levelLabel(entry.level)));
  head.appendChild(mk('span', 'log-scope', entry.scope));
  head.appendChild(mk('span', 'log-msg', entry.message));
  row.appendChild(head);

  if (entry.detail) {
    // detail 默认收起：一次同步几十条，摊开就没法扫了。
    const det = mk('details', 'log-detail');
    det.appendChild(mk('summary', undefined, '详情'));
    det.appendChild(mk('pre', undefined, entry.detail));
    row.appendChild(det);
  }
  return row;
}

function updateMeta(shown: number): void {
  el.logMeta.textContent =
    shown === logs.length ? `${logs.length} 条` : `${shown} / ${logs.length} 条`;
}

/** 复制当前筛选出来的那些行，格式与终端里看到的一致。 */
function copyShown(): void {
  const text = logs
    .filter(matches)
    .map((e) => {
      const head = `[${logTime(e.at)}] ${levelLabel(e.level)} ${e.scope}｜${e.message}`;
      return e.detail
        ? `${head}\n${e.detail.split('\n').map((l) => `    ${l}`).join('\n')}`
        : head;
    })
    .join('\n');

  if (!text) {
    toast('没有可复制的日志。');
    return;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => toast('日志已复制到剪贴板。'))
    .catch(() => toast('复制失败，可手动选中复制。', true));
}

export function installLogs(): void {
  el.logLevel.addEventListener('change', () => redraw());
  el.logFilter.addEventListener('input', () => redraw());
  // 清空走后端：它要在缓冲里留一条「日志已清空」的痕迹。
  el.logClearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clearLogs' }));
  el.logCopyBtn.addEventListener('click', copyShown);

  // 「加载更早」是唯一会查数据库的入口。默认进日志页只看内存缓冲，
  // 一次查询都不做——那条路径必须保持零开销。
  const earlier = maybeById<HTMLButtonElement>('logEarlierBtn');
  earlier?.addEventListener('click', () => {
    // 已显示的最早那条的时间戳，据它继续往前翻。
    vscode.postMessage({ type: 'requestLogHistory', before: logs[0]?.at });
  });
}
