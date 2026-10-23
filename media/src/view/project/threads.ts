/**
 * 工程页「叙事线」页签（叙事线重做第 8 个提交）：一条线一行，最后一行是「未归属的伏笔」。
 *
 * 一行写 `林昭与沈青 · 感情线 · 进行中 · 最近第 12 章 · 2 条伏笔没收`，有问题的另加 `⚠ 断了 15 章`、
 * `⚠ 1 条伏笔逾期`、`⚠ 过了计划收束的第 40 章`。这几句由后端给（`views/threads.ts`，文案只有一份），这里只渲染、
 * 只在每一句前面加 ⚠。作者一眼要看出的是「哪条线走到哪了、哪条该管一管」，所以 ⚠ 另起一格、不截断。
 *
 * - **点一行打开那条线的文件**（单击临时标签、双击转正，同别的行）；右键「打开」「在总览里看」（叙事线重做三期：编辑区里
 *   「叙事线总览」标签打开、定位到这一行）。
 * - **失败的 ❗ 挂在对应的行上**：当前进度作者改过、没覆盖的黄 ❗ 挂在那条线的文件上；排线失败的红 ❗ 挂在叙事线
 *   目录上，没有对应的行，放在页签标题旁边、按钮前面。
 * - **「从大纲排出 / 从大纲补充」在页签标题旁边**（组标题只管折叠，点不开东西，`groups.ts` 的 `head`）：线从情节
 *   大纲排，还没有大纲时不给；排线在跑时也不给（点第二次只会撞上「已有任务在进行」，任务名与 features/threads.ts
 *   的 runTask 一字不差）。按钮不直接花钱：后端先弹确认框，写明 1 次调用。右键标题与页里的空白处也给这一项。
 * - **「总览」也在页签标题旁边**（三期）：打开编辑区里的「叙事线总览」（章 × 线的时间轴）。**能力探测**：先问
 *   `nf-threads-query` 有没有人画得了——只有内置编辑器（editor.js）回答，插件形态没有内置编辑器，「总览」与「在总览里看」
 *   都不画（设计稿 ⚑11：VS Code 插件先不做总览；不判断是哪个壳）。一条线、一条未归属的伏笔都没有时也不给（打开了是空的）。
 * - 挂伏笔靠作者在文件里剪贴（设计稿 ⚑10），这里不做「挪」。
 * - **叙事线判到哪**（四期）：定稿了、叙事线还没判的章（拆书导入、补齐整理出来的、补记停在半路的）在页里最上面说一句
 *   「⚠ 第 31–60 章还没判」——线的状态按判到的那一章算，这几章上线里本来就没有事件。文案由后端给（`views/threads.ts`）。
 *   这时标题旁多一个「从正文补记」（右键标题、页里空白处也有）：逐章走定稿第三步，后端先弹确认框写明章数与次数；补记在跑时
 *   不给（任务名与 features/threadsBackfill.ts 的 `BACKFILL_TASK` 一字不差）。不落后时不给——没有要补的。
 */
import { el as mk } from '../../dom';
import { commandThreadsOverview, queryThreadsOverview } from '../../globals';
import type { MenuItem } from '../../globals';
import type { ProjectTree, ThreadLineView, ThreadUnfiledView } from '../../protocol';
import { linkBtn } from '../buttons';
import { onContextMenu } from '../menu';
import { openPath } from '../store';
import { hasTask } from '../tasks';
import { baseMenuItems, projectAction } from './actions';
import { emptyRow, failureMark } from './rows';
import { indentOf } from './treeState';

/** 排线的任务名：与 features/threads.ts 的 runTask 一字不差。 */
const PLAN_TASK = '排叙事线';
/** 补记的任务名：与 features/threadsBackfill.ts 的 `BACKFILL_TASK` 一字不差。 */
const BACKFILL_TASK = '从已写正文补记叙事线';

/** 叙事线落后于定稿（有定稿了还没判的章）：给「从正文补记」。 */
function canBackfill(tree: ProjectTree): boolean {
  return !!tree.threads.lag;
}

/** 有情节大纲才排得出线。 */
function canPlan(tree: ProjectTree): boolean {
  return tree.architecture.some((a) => a.key === 'outline' && a.filled);
}

/** 没有线时「从大纲排出」，有了「从大纲补充」。 */
function planVerb(tree: ProjectTree): string {
  return tree.threads.lines.length === 0 ? '从大纲排出' : '从大纲补充';
}

/** 组标题的副标题：`4 条 · 3 条进行中`；一条都没有说「还没有」。 */
export function threadsGroupLabel(tree: ProjectTree): string {
  const lines = tree.threads.lines;
  if (lines.length === 0) {
    return '还没有';
  }
  const going = lines.filter((l) => l.status === '进行中').length;
  return going > 0 ? `${lines.length} 条 · ${going} 条进行中` : `${lines.length} 条`;
}

/**
 * 「叙事线总览」画得了、也有东西可画：有内置编辑器（能力探测，插件形态没有人回答）、至少有一条线或一条未归属的伏笔。
 */
function canOverview(tree: ProjectTree): boolean {
  return (tree.threads.lines.length > 0 || !!tree.threads.unfiled) && queryThreadsOverview();
}

/** 一行右键「在总览里看」：打开编辑区里的叙事线总览，定位到这一行。没有内置编辑器时不给。 */
function overviewItems(tree: ProjectTree, relPath: string): MenuItem[] {
  return canOverview(tree) ? [{ label: '在总览里看', run: () => commandThreadsOverview(relPath) }] : [];
}

/** 组标题与页里空白处的右键：补记（落后时才有）、排线那一项（有情节大纲才有）、打开总览（有内置编辑器才有）。 */
export function threadsMenuItems(tree: ProjectTree): MenuItem[] {
  const items: MenuItem[] = [];
  if (canBackfill(tree)) {
    items.push({ label: '从已写正文补记叙事线', run: () => projectAction('backfillThreads') });
  }
  if (canPlan(tree)) {
    items.push({ label: `${planVerb(tree)}叙事线`, run: () => projectAction('generateThreads') });
  }
  if (canOverview(tree)) {
    items.push({ label: '打开叙事线总览', run: () => commandThreadsOverview() });
  }
  return items.length > 0 ? [...items, { sep: true }] : [];
}

/** 页签标题旁边那一截：排线失败的红 ❗、「从正文补记」（落后时）、「从大纲排出 / 补充」与「总览」。都没有时是 undefined。 */
export function threadsHead(tree: ProjectTree): HTMLElement | undefined {
  const box = mk('span', 'threads-head');
  const mark = failureMark(tree.threadsPath);
  if (mark) {
    box.appendChild(mark);
  }
  if (canBackfill(tree) && !hasTask(BACKFILL_TASK)) {
    const btn = linkBtn('从正文补记', () => projectAction('backfillThreads'));
    btn.classList.add('threads-backfill-btn');
    btn.title = `从已写正文补记叙事线：${tree.threads.lag!.text}，逐章认这一章在叙事线上发生了什么（先弹确认框，每章调用模型 1–3 次）；已有的不动，只往线里追加`;
    box.appendChild(btn);
  }
  if (canPlan(tree) && !hasTask(PLAN_TASK)) {
    const btn = linkBtn(planVerb(tree), () => projectAction('generateThreads'));
    btn.title = '从情节大纲排叙事线（先弹确认框，调用模型 1 次）；已有的线不动，同名跳过';
    box.appendChild(btn);
  }
  if (canOverview(tree)) {
    const btn = linkBtn('总览', () => commandThreadsOverview());
    btn.classList.add('threads-overview-btn');
    btn.title = '在编辑区打开叙事线总览：章 × 线的时间轴，每条线走到哪、伏笔埋了收了没有、计划的事哪一章没发生（不调模型）';
    box.appendChild(btn);
  }
  return box.childElementCount > 0 ? box : undefined;
}

/** 这一页的全部行：（叙事线落后于定稿时）最上面一句「还没判」，一条线一行（后端已排好），最后是「未归属的伏笔」；一条都没有时说清先做什么。 */
export function buildThreadRows(tree: ProjectTree): HTMLElement[] {
  const { lines, unfiled, lag } = tree.threads;
  const rows = lines.map((line) => buildLineRow(tree, line));
  if (lag) {
    rows.unshift(buildLagRow(tree, lag));
  }
  if (lines.length === 0) {
    rows.push(
      emptyRow(
        canPlan(tree)
          ? '还没有叙事线。点标题旁的「从大纲排出」，从情节大纲排出主线、支线、感情线、人物线；同步时也会从正文里认出新的线。'
          : '还没有叙事线。先排出情节大纲，再从大纲排出叙事线；同步时也会从正文里认出新的线。'
      )
    );
  }
  if (unfiled) {
    rows.push(buildUnfiledRow(tree, unfiled));
  }
  return rows;
}

/**
 * 「⚠ 第 31–60 章还没判」（四期）：定稿了、叙事线还没判的章。挂在页里最上面（与角色组的「称呼冲突」同一个样子）：说清线的状态
 * 按判到的那一章算、总览上这几章的计划不算偏差。
 */
function buildLagRow(tree: ProjectTree, lag: NonNullable<ProjectTree['threads']['lag']>): HTMLElement {
  const through = tree.threads.through;
  const row = mk(
    'div',
    'row-conflict threads-lag',
    `⚠ ${lag.text}：这几章同步了，叙事线还没记上。` +
      `${through > 0 ? `线断了几章、伏笔逾期都按判到的第 ${through} 章算` : '线断了几章、伏笔逾期先不算'}，总览上这几章的计划不算偏差。` +
      '点标题旁的「从正文补记」逐章补上（先问你，每章 1–3 次调用）。'
  );
  row.title = `叙事线判到第 ${through} 章（从第 1 章起连续判过的），同步到第 ${tree.threads.current} 章。`;
  return row;
}

/** 状态点：进行中 ●、计划中 ○、已收束 ✓、已放弃 ✕。 */
const STATUS_DOT: Record<ThreadLineView['status'], string> = { 进行中: '●', 计划中: '○', 已收束: '✓', 已放弃: '✕' };

function buildLineRow(tree: ProjectTree, line: ThreadLineView): HTMLElement {
  const closed = line.status === '已收束' || line.status === '已放弃';
  const row = mk('div', `row row-thread${closed ? ' row-thread-closed' : ''}`);
  row.style.paddingLeft = `${indentOf(0)}px`;

  const dot = mk('span', 'dot', STATUS_DOT[line.status]);
  dot.title = line.status;
  row.appendChild(dot);

  const mark = failureMark(line.relPath);
  if (mark) {
    row.appendChild(mark);
  }

  const label = mk('span', 'row-label', line.name);
  label.title = [line.tip, `${line.relPath}\n点击打开这条线的文件`].filter(Boolean).join('\n\n');
  // 单击开成临时标签，双击转正（见章节那一行）。
  label.addEventListener('click', (e) => openPath(line.relPath, { preview: e.detail < 2 }));
  row.appendChild(label);

  row.appendChild(mk('span', 'meta row-detail', line.detail));
  appendWarnings(row, line.warnings);

  onContextMenu(row, () => [
    { label: '打开', run: () => openPath(line.relPath) },
    ...overviewItems(tree, line.relPath),
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/** 「未归属的伏笔 · N 条」：挂不上哪条线的伏笔。作者把一行伏笔连同它的事件剪到某条线的文件里，就是挂上了。 */
function buildUnfiledRow(tree: ProjectTree, u: ThreadUnfiledView): HTMLElement {
  const row = mk('div', 'row row-thread row-thread-unfiled');
  row.style.paddingLeft = `${indentOf(0)}px`;
  row.appendChild(mk('span', 'dot', '◇'));

  const mark = failureMark(u.relPath);
  if (mark) {
    row.appendChild(mark);
  }

  const label = mk('span', 'row-label', '未归属的伏笔');
  label.title = `${u.relPath}\n挂不上哪一条线的伏笔。把一行伏笔连同它的事件剪到某条线的文件里，就是挂上了。`;
  label.addEventListener('click', (e) => openPath(u.relPath, { preview: e.detail < 2 }));
  row.appendChild(label);

  row.appendChild(mk('span', 'meta row-detail', u.detail));
  appendWarnings(row, u.warnings);

  onContextMenu(row, () => [
    { label: '打开', run: () => openPath(u.relPath) },
    ...overviewItems(tree, u.relPath),
    { sep: true },
    ...baseMenuItems(),
  ]);
  return row;
}

/** ⚠ 一句一格，不截断：几条线里扫一眼要看的就是这个。 */
function appendWarnings(row: HTMLElement, warnings: readonly string[]): void {
  for (const w of warnings) {
    row.appendChild(mk('span', 'meta thread-warn', `⚠ ${w}`));
  }
}
