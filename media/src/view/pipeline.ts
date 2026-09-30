/**
 * 创作流水线条与「下一步」。
 *
 * 界面要回答三个问题，这里管前两个（第三个是工作区卡，见 workbench.ts）：
 *
 * - **我现在在哪一层？** —— 位置信息条 + 状态徽章 + 细纲 / 正文 / 定稿三格
 * - **我接下来该干什么？** —— 下一步条（一个主按钮 + 一个 `/ 命令`）
 *
 * ## 为什么是一个按钮而不是七个
 *
 * 改造前这里是 `STAGE_CAPABILITIES[stage]` 的平铺：七个等重的按钮，
 * 看不出该点哪个。可在任何一个具体时刻，作者真正要按的只有一个——
 * 那一个由状态机算得出来（`deriveNextStep`，判据与 `deriveStage` 同源）。
 * 于是：状态机那一个做主按钮，其余六个收进 `/` 命令面板。
 *
 * ## 为什么主按钮点了就跑
 *
 * 它是状态机替你选的，没有参数可填：这一章该发生什么，大纲与前后章里都写着。
 * 旧界面逼作者先编一句「请生成」才肯发送，而那句废话还会被当成要求装进
 * prompt。输入框里有字就当补充要求带上，没有就不带。
 */
import { el as mk, clear, maybeById, setHidden } from '../dom';
import {
  PLOT_STAGE_LABEL,
  SETTING_DOC_LABEL,
  STAGE_LABEL,
  STAGE_QUESTION,
  chapterLabel,
  plotOfTarget,
} from '../protocol';
import type {
  CreationStage,
  CreationTarget,
  NextStepView,
  PipelineProgress,
  PlotPipelineView,
} from '../protocol';
import { el } from './refs';
import { store, vscode } from './store';

// ---------------------------------------------------------------- 状态

/** 当前这一章的流水线。切目标或产物落盘后由后端重推。 */
let current: PlotPipelineView | null = null;
/** 状态机算出的下一步。全书那一层也有（生成架构 / 大纲 / 拆细纲）。 */
let next: NextStepView | null = null;

const crumb = () => maybeById('pipelineCrumb');
const stagesBox = () => maybeById('pipelineStages');

/** 由 composer 注入：主按钮点下去要走发送那条路（它管附件、草稿、busy）。 */
let runNextStep: (step: NextStepView) => void = () => {};

export function bindNextStepRunner(fn: (step: NextStepView) => void): void {
  runNextStep = fn;
}

/** 「开始新对话」：清空消息流，从同一目标重新起一段对话。 */
export function installNewSession(): void {
  el.newSessionBtn.addEventListener('click', () => {
    if (store.busy) {
      return;
    }
    vscode.postMessage({ type: 'newSession' });
  });
}

/**
 * 「重命名当前章节」。
 *
 * 复用工程页右键那条 `fileAction: 'rename'`——后端的 `writePlot` 会保留
 * 章号前缀。这里只负责说清「改的是哪一章」，不新增协议。
 */
export function installRenamePlot(): void {
  el.renamePlotBtn.addEventListener('click', () => {
    const relPath = plotOfTarget(store.session.target);
    if (!relPath || store.busy) {
      return;
    }
    vscode.postMessage({ type: 'fileAction', action: 'rename', relPath });
  });
}

export function renderPipeline(pipeline: PlotPipelineView | undefined, step: NextStepView | undefined): void {
  current = pipeline ?? null;
  next = step ?? null;
  redraw();
}

/**
 * 会话变了（切目标、开历史会话）时重画。
 *
 * 目标换到另一章时手上这份 pipeline 就过期了——先丢掉再等后端推新的，
 * **不要留着显示**：拿上一章的状态配这一章的名字，比什么都不显示更糟。
 */
export function onSessionChanged(): void {
  if (current && current.plotRelPath !== plotOfTarget(store.session.target)) {
    current = null;
    next = null;
  }
  redraw();
}

function redraw(): void {
  renderCrumb();
  renderRenameBtn();
  renderStages();
  renderNextStep();
  updatePlaceholder();
}

/**
 * 「重命名当前章节」按钮的显隐与 tooltip。
 *
 * 目标是架构或大纲时藏起来——那两层没有章可改名，留一个点了会报错的按钮
 * 比没有更糟。tooltip 里带上章名，作者才看得出改的是哪一章。
 */
function renderRenameBtn(): void {
  const relPath = plotOfTarget(store.session.target);
  setHidden(el.renamePlotBtn, !relPath);
  if (!relPath) {
    return;
  }
  el.renamePlotBtn.title = current && current.no > 0 ? `重命名${headLabel()}的细纲` : `重命名 ${relPath}`;
}

/** 当前目标那一行的说法。与工程页、与后端日志同一份文案（`model/pipeline.ts`）。 */
function headLabel(): string {
  const target = store.session.target;
  if (target.kind === 'setting') {
    return `故事架构 · ${SETTING_DOC_LABEL[target.doc]}`;
  }
  if (target.kind === 'outline') {
    return '情节大纲';
  }
  return current ? chapterLabel(current.no, current.title) : '';
}

// ---------------------------------------------------------------- 位置信息条（只读）

/**
 * 顶部只报「在哪」，不负责导航。
 *
 * 切层靠下面的细纲 / 正文两格；切章靠工程页。这里做成可点只会多一个几乎没人用的
 * 入口，还让人以为点了会有什么深层动作。
 */
function renderCrumb(): void {
  const box = crumb();
  if (!box) {
    return;
  }
  clear(box);
  const target = store.session.target;
  const relPath = plotOfTarget(target);

  // `no` 为 0 是后端给的「找不到」空壳（刚被改名或删掉），
  // 那时报文件名比报「第 0 章」有用。
  const title = !relPath
    ? headLabel()
    : current && current.no > 0
      ? headLabel()
      : relPath.slice(relPath.lastIndexOf('/') + 1);
  setHidden(box, !title);
  if (!title) {
    return;
  }
  box.appendChild(mk('span', 'crumb', title));

  // 这一章的状态徽章，与工程页那一列同一份文案（PLOT_STAGE_LABEL）。
  // 它是「这一章整体走到哪了」，与下面三格各自的状态不重复。
  if (current && relPath) {
    box.appendChild(mk('span', 'spacer'));
    const badge = mk('span', `cstage cstage-${current.stage}`, PLOT_STAGE_LABEL[current.stage]);
    badge.title = '这一章当前所处的阶段。由磁盘上的产物推导，不落盘。';
    box.appendChild(badge);
  }
}

// ---------------------------------------------------------------- 三格状态

/**
 * 细纲 / 正文两个可点的按钮（点了就切到那一层），加一个「定稿」状态点。
 *
 * 从前这里是「卷纲 / 剧情 / 正文」三层——卷那一层删掉了，一章一纲之后这一章的
 * 上游链只剩两格。定稿不是一个创作阶段（它是写完之后的一步工程动作），
 * 所以只给状态，不给按钮。
 *
 * 完成度落成三态圆点（未开始 / 进行中 / 已完成），不用百分比条——这里
 * 表达的是状态机走到哪，不是「完成了百分之几」。
 *
 * 「上游变过」的标记（⟳）是这套流水线最有价值的一格信息：改了大纲之后，
 * 哪几章的细纲需要回头看，光靠人脑记不住。它由 hash 链算出来，零模型调用。
 */
function renderStages(): void {
  const box = stagesBox();
  if (!box) {
    return;
  }
  clear(box);

  const relPath = plotOfTarget(store.session.target);
  // 架构与大纲两层没有「这一章的两格」可言，整条收起来。
  setHidden(box, !relPath);
  if (!relPath) {
    return;
  }

  const progress: PipelineProgress = current?.progress ?? { plot: 0, manuscript: 0, summary: 0 };
  const cells: { stage: CreationStage; ratio: number; stale: boolean }[] = [
    { stage: 'plot', ratio: progress.plot, stale: !!current?.plot.upstreamStale },
    { stage: 'manuscript', ratio: progress.manuscript, stale: !!current?.chapter.upstreamStale },
  ];

  for (const cell of cells) {
    const status = stageStatus(cell.ratio);
    const btn = mk('button', 'pstage');
    btn.classList.toggle('active', store.session.stage === cell.stage);
    btn.classList.toggle('done', status === 'done');
    btn.classList.toggle('partial', status === 'partial');
    btn.title = `${STAGE_LABEL[cell.stage]}：${STAGE_STATUS_LABEL[status]} · ${STAGE_QUESTION[cell.stage]}`;

    const mark = mk('span', `pstage-mark ${status}`);
    mark.setAttribute('aria-hidden', 'true');
    btn.appendChild(mark);
    btn.appendChild(mk('span', 'pstage-label', STAGE_LABEL[cell.stage]));
    if (cell.stale) {
      const dot = mk('span', 'pstage-stale', '⟳');
      dot.title = '上游产物改过，这一层可能需要回头看';
      btn.appendChild(dot);
    }
    const target: CreationTarget = { kind: cell.stage as 'plot' | 'manuscript', plotRelPath: relPath };
    btn.addEventListener('click', () => go(target));
    box.appendChild(btn);
  }

  // 定稿：只报状态。没有正文时说「未写」，别把一格空的说成「待定稿」。
  if (current) {
    const text = !current.chapter.exists || current.chapter.words === 0
      ? '未写正文'
      : current.summary.exists && !current.summary.stale
        ? '已定稿'
        : '待定稿';
    const s = mk('span', `psummary${text === '待定稿' ? ' stale' : ''}`, text);
    box.appendChild(s);
  }
}

/**
 * 把 0..1 的比例收成界面要的三态——不把连续比例画成百分比。
 *
 * 类名刻意不用 `empty`：消息流的 `.empty` 带大 padding，撞上会把圆点撑成椭圆。
 */
function stageStatus(ratio: number): 'todo' | 'partial' | 'done' {
  if (ratio >= 1) {
    return 'done';
  }
  if (ratio > 0) {
    return 'partial';
  }
  return 'todo';
}

const STAGE_STATUS_LABEL = {
  todo: '未开始',
  partial: '进行中',
  done: '已完成',
} as const;

// ---------------------------------------------------------------- 下一步

/**
 * 下一步条：一句「为什么是这一步」 + 一个主按钮。
 *
 * 没有下一步（这一章全做完了）时主按钮收起——**不造一个假的下一步**。
 * 给一个「下一步」等于逼作者一直有事可做，而写完就是写完了。其余命令在
 * 输入框里打 `/` 就有（或点工具行上的「/ 命令」）。
 */
function renderNextStep(): void {
  setHidden(el.nextStep, false);

  if (!next) {
    el.nextStepHint.textContent = current
      ? '这一章都齐了。要改哪一层就点上面对应的那一格。'
      : '全书都写完了。要改哪一章就去工程页点它，或在输入框里打 / 挑一个命令。';
    setHidden(el.nextStepBtn, true);
    return;
  }

  el.nextStepHint.textContent = next.hint;
  setHidden(el.nextStepBtn, false);
  el.nextStepBtn.textContent = next.label;
  el.nextStepBtn.title = next.projectAction
    ? '这一步是工程动作，不消耗对话上下文'
    : `${STAGE_LABEL[next.stage]} · 点了立即执行，输入框里有字就一起带上`;
  el.nextStepBtn.disabled = store.busy;
  el.nextStepBtn.onclick = () => {
    if (!store.busy && next) {
      runNextStep(next);
    }
  };
}

/**
 * 输入框的提示语跟着阶段与能力走。
 *
 * 正文层写正文时，要写什么已经在细纲里了——输入框里是补充要求（「多写点雨里的
 * 细节」）。而多数命令的输入是**可选**的，提示语要说出这一点。
 */
function updatePlaceholder(): void {
  const { stage, capability } = store.session;
  if (stage === 'manuscript' && capability === 'generate') {
    el.input.placeholder = '这一章的补充要求…（可留空，Enter 发送）';
    return;
  }
  el.input.placeholder = `${STAGE_LABEL[stage]}：${STAGE_QUESTION[stage]}（可留空，打 / 挑命令）`;
}

// ---------------------------------------------------------------- 工具

function go(target: CreationTarget): void {
  if (store.busy) {
    return;
  }
  vscode.postMessage({ type: 'setTarget', target });
}
