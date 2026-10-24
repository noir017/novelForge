/**
 * 作者在工程页改故事时间（2026-10-24 重做，设计见 docs/design/plans/2026-10-24-story-timeline-rework.md「五」；推翻了上一稿「只改文件」）：
 * 「时间线」组里右键一章「改时间…」、点第一行改历法与起点、右键「填为起点」。**不调模型**。
 *
 * - 都只改那一行、那两个键（`model/timelineFile.ts` 的 `setTimelineValue` / `setTimelineHead`），经网关写（`updateThread`：写之前那一刻
 *   重读、覆盖前存历史版本）。文件照样能手改。
 * - 改时间写下的是作者定的：去掉行尾的〔依据〕〔推测〕〔推不出〕，机器再也不动这一行（第 28 条）；清空 = 删掉这一行，留给机器重推。
 * - 输入框就是那一问（第 3 条）：作者自己写的值，不另弹对比。
 */
import { getHost } from '../host';
import { NovelProject } from '../model/project';
import {
  TIMELINE_CALENDARS,
  TimelineCalendar,
  checkTimeInput,
  computeTimeline,
  emptyTimeline,
  parseDate,
  renderTimeValue,
  setTimelineHead,
  setTimelineValue,
  suggestStart,
} from '../model/timelineFile';
import { describeError, scoped } from '../runtime/logger';
import { Workspace } from '../workspace';

const log = scoped('故事时间');

/** 右键一章「改时间…」：问一句，照作者写的改那一行。`no` 是章号。 */
export async function editTimelineEntry(project: NovelProject, no: number): Promise<void> {
  const host = getHost();
  const rel = project.relPath(project.timelinePath);
  const tl = (await project.readThreads()).timeline ?? emptyTimeline(rel);
  const e = tl.entries.find((x) => x.chapter === no);
  const current = e ? `${renderTimeValue(e.value)}${e.part ? `，${e.part}` : ''}` : '';
  const answer = await host.input({
    title: `第 ${no} 章的时间`,
    prompt:
      '这一章开头是哪天、比上一章晚多久：「八月十五」「第 20 天」「+3 天」「同日」「次日」「回忆」，可以带时段（「八月十五，傍晚」）。' +
      '改过的就是你定的，机器不再动，后面的章跟着顺延；清空就是删掉这一行，留给机器重推。',
    value: current,
    placeHolder: '八月十五，傍晚',
    validate: (v) => checkTimeInput(v, tl),
  });
  if (answer === undefined || answer.trim() === current) {
    return;
  }
  const done: { action: 'added' | 'replaced' | 'removed' | 'kept' } = { action: 'kept' };
  try {
    await new Workspace(project).updateThread(rel, (raw) => {
      const r = setTimelineValue(raw, no, answer);
      done.action = r?.action ?? 'kept';
      return r && r.action !== 'kept' ? r.text : undefined;
    });
  } catch (err) {
    log.warn(`第 ${no} 章的时间没改成：${describeError(err)}`, err);
    host.toast(`第 ${no} 章的时间没改成：${describeError(err)}`, 'error');
    return;
  }
  if (done.action === 'removed') {
    log.info(`第 ${no} 章的时间删掉了`, '留给机器重推');
    host.toast(`第 ${no} 章那一行删掉了：按紧接上一章算，同步或重推时机器再推。`);
  } else if (done.action !== 'kept') {
    log.info(`第 ${no} 章的时间改成「${answer.trim()}」`);
    host.toast(`第 ${no} 章的时间改成「${answer.trim()}」：这一行是你定的，机器不再动，后面的章跟着顺延。`);
  }
}

/**
 * 时间线组第一行：改历法与起点（先挑历法、再问起点）；右键「填为起点」带 `suggested`，直接填、不问。
 */
export async function setTimelineStart(project: NovelProject, suggested?: string): Promise<void> {
  const host = getHost();
  const rel = project.relPath(project.timelinePath);
  const tl = (await project.readThreads()).timeline ?? emptyTimeline(rel);
  let calendar: TimelineCalendar | undefined;
  let start: string | undefined = suggested?.trim();
  if (start === undefined) {
    calendar = await host.pick<TimelineCalendar>(
      TIMELINE_CALENDARS.map((c) => ({
        label: c,
        description: c === tl.calendar ? '现在用的' : '',
        detail: c === '简单历' ? '每月 30 天、一年 12 个月；节日按农历口径（中秋是八月十五）' : '真实的月份长短与闰年；只认元旦、国庆这类公历节日',
        value: c,
      })),
      '故事用哪一种历法？'
    );
    if (!calendar) {
      return;
    }
    const hint = suggestStart(tl, computeTimeline(tl));
    start = await host.input({
      title: '第 1 章开头是哪一天',
      prompt: `写第 1 章那一天：「大衍三年三月初七」「三月初七」「2026-03-07」；不填只显示第几天。${hint ? `（第 ${hint.chapter} 章写了「${hint.mark}」，倒推第 1 章是${hint.text}）` : ''}`,
      value: tl.startText || hint?.text || '',
      placeHolder: '三月初七',
      validate: (v) => (!v.trim() || parseDate(v) ? undefined : `认不出「${v.trim()}」：写「三月初七」「大衍三年三月初七」「2026-03-07」这样的`),
    });
    if (start === undefined) {
      return;
    }
  }
  try {
    await new Workspace(project).updateThread(rel, (raw) => setTimelineHead(raw, { ...(calendar ? { calendar } : {}), start }));
  } catch (err) {
    log.warn(`时间线的起点没改成：${describeError(err)}`, err);
    host.toast(`起点没改成：${describeError(err)}`, 'error');
    return;
  }
  log.info('时间线的历法与起点改了', `${calendar ?? tl.calendar}｜${start || '（没填）'}`);
  host.toast(start ? `起点改成「${start}」${calendar ? `（${calendar}）` : ''}：日期在时间线组与总览里看。` : `起点清空了${calendar ? `（${calendar}）` : ''}：只显示第几天。`);
}
