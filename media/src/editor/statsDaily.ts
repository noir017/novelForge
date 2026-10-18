/**
 * 「今日码字」记在哪、几个窗口怎么合（独立版内置编辑器，`stats.ts` 用）。
 *
 * ## 记在浏览器里，不进工程
 *
 * localStorage `novelforge.editor.stats.daily@<工程>`（`projectStorageKey`，键里带工程根目录），形状
 * `{ v: 1, days: { 'YYYY-MM-DD': { words, ms } } }`，留最近 30 天，只显示今天。这只是码字习惯数据，丢了无所谓：
 * **不往工程目录写、也不往 SQLite 写**。读不懂（坏值）就当没有、从零记（`parseDaily`）。网址上没有工程标识、
 * 或者浏览器不让记（隐私模式、配额满），就只在这一页的内存里算——面板上照实说一句。
 *
 * ## 几个窗口同开一个工程
 *
 * **各窗口只加自己的增量，不写自己的总数**：码一下记进这个窗口的「待写」（按当时的工程键与本地日期分开），
 * 至多 {@link FLUSH_MS} 写一次——写的时候现读 localStorage 里那一份、加上待写的、写回去（`addDaily`），待写清零。
 * 所以谁也不会把别的窗口记的冲掉，也不会重复算。页面藏起来、关掉、换工程时立刻写。别的窗口写了，这边收
 * `storage` 事件换上新的那份重画。显示的是「上次读到的 + 自己还没写进去的」。读改写之间还隔着别的窗口的
 * 读改写的话（几毫秒之内两边同时写）会丢一笔——浏览器不给 localStorage 加锁，这点误差可以接受。
 *
 * 跨午夜：每一笔按落笔那一刻的本地日期记，所以 23:59 打的字记在前一天，过了零点打的记在新的一天；显示的
 * 「今天」每次重画时现算。
 */
import { projectStorageKey, windowProject } from '../globals';
import { addDaily, bumpDaily, dayKey, parseDaily, serializeDaily } from './writingStats';
import type { DailyRecord, DayTally } from './writingStats';

const BASE_KEY = 'novelforge.editor.stats.daily';
/** 码字时至多隔多久写一次 localStorage（别的窗口至多晚这么久看到）。 */
export const FLUSH_MS = 2_000;

/** 工程键（没有工程标识时是 null，只在内存里算）→ 还没写进 localStorage 的增量。 */
const pending = new Map<string | null, DailyRecord>();
/** 工程键 → 上次读到 / 写下的那一份。 */
const stored = new Map<string, DailyRecord>();
/** localStorage 读或写抛过：之后只在内存里算。 */
let broken = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** 这个窗口的工程在 localStorage 里的键。网址上没有工程标识时 null。 */
function currentKey(): string | null {
  return windowProject() ? projectStorageKey(BASE_KEY) : null;
}

/** 记一笔（`at` 那一刻的本地日期）。 */
export function recordDaily(at: number, words: number, ms: number): void {
  if (words === 0 && ms === 0) {
    return;
  }
  const key = currentKey();
  let inc = pending.get(key);
  if (!inc) {
    inc = {};
    pending.set(key, inc);
  }
  bumpDaily(inc, at, words, ms);
  if (key !== null && !broken && flushTimer === undefined) {
    flushTimer = setTimeout(flushDaily, FLUSH_MS);
  }
}

/** 今天（`now` 那一刻的本地日期）这个工程码了多少，`persisted` 说是不是记在浏览器里（跨刷新、跨窗口）。 */
export function todayTally(now: number): DayTally & { persisted: boolean } {
  const key = currentKey();
  const day = dayKey(now);
  const base = key !== null ? storedOf(key)[day] : undefined;
  const mine = pending.get(key)?.[day];
  return {
    words: (base?.words ?? 0) + (mine?.words ?? 0),
    ms: (base?.ms ?? 0) + (mine?.ms ?? 0),
    persisted: key !== null && !broken,
  };
}

/** 把待写的写进 localStorage：现读、加上、写回。抛了就记下「记不了」，待写的留在内存里照样算进显示。 */
export function flushDaily(): void {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (broken) {
    return;
  }
  for (const [key, inc] of [...pending]) {
    if (key === null) {
      continue;
    }
    try {
      const next = addDaily(parseDaily(localStorage.getItem(key)), inc);
      localStorage.setItem(key, serializeDaily(next));
      stored.set(key, next);
      pending.delete(key);
    } catch {
      broken = true;
      return;
    }
  }
}

/** 别的窗口写了（`storage` 事件）、或者想重新读一次时：丢掉缓存，下次显示现读。 */
function forget(key: string | null): void {
  if (key === null) {
    stored.clear();
  } else {
    stored.delete(key);
  }
}

function storedOf(key: string): DailyRecord {
  let record = stored.get(key);
  if (!record) {
    try {
      record = parseDaily(localStorage.getItem(key));
    } catch {
      broken = true;
      record = {};
    }
    stored.set(key, record);
  }
  return record;
}

/** 别的窗口改了「今日码字」时通知（重画）。 */
export function onDailyChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 装一次（`stats.ts`）：别的窗口写了就重读重画；页面藏起来、关掉时立刻写。 */
export function installDaily(): void {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && !e.key.startsWith(BASE_KEY)) {
      return;
    }
    forget(e.key);
    for (const fn of [...listeners]) {
      fn();
    }
  });
  window.addEventListener('pagehide', flushDaily);
  window.addEventListener('beforeunload', flushDaily);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushDaily();
    }
  });
}
