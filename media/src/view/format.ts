/**
 * 数字与时间的格式化。整个 view 共用。
 *
 * `countWords` 这里统计的是**模型回复的长度**（去空白后的字符数）——
 * 与 editor/words.ts 的同名函数是两件事，那边要与后端算的章节字数对得上，
 * 走的是「中文按字、英文按词」。别合并。
 */

/** token 数之类的大数字：1000 以上折成 k。 */
export function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 章节字数：一万以上折成「万字」。 */
export function formatWords(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`;
}

export function countWords(text: string): number {
  return text.replace(/\s/g, '').length;
}

/** 长任务的已用时：一分钟以上给 `m:ss`，以下给 `Ns`。 */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  return m > 0 ? `${m}:${String(total % 60).padStart(2, '0')}` : `${total}s`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 消息与会话上的时刻：今天只给时分，往前的带上月日。 */
export function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/** 日志行的时刻：要看到秒，一次同步几十条全在同一分钟里。 */
export function logTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
