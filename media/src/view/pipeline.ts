/**
 * 创作流水线条与「下一步」。
 *
 * 界面要回答三个问题，这里管前两个（第三个是工作区卡，见 workbench.ts）：
 *
 * - **我现在在哪一层？** —— 段名信息条 + 状态徽章 + 三层状态点
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
 * 它是状态机替你选的，没有参数可填：这一章该排什么剧情，大纲与前后章里都写着。
 * 旧界面逼作者先编一句「请生成」才肯发送，而那句废话还会被当成要求装进
 * prompt。输入框里有字就当补充要求带上，没有就不带。
 */
import { el as mk, clear, maybeById, setHidden } from '../dom';
import {
  CREATION_STAGES,
  PLOT_STAGE_LABEL,
  STAGE_LABEL,
  STAGE_QUESTION,
  chapterLabel,
  plotOfTarget,
  segmentLabel,
  volumeLabel,
  volumeOfTarget,
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
/** 状态机算出的下一步。全书那一层也有（去写大纲 / 去拆卷 / 去拆剧情段）。 */
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
 * 复用工程页右键那条 `fileAction: 'rename'`——后端的 `writePlot` 已经会保留
 * 序号前缀、把中转站正文跟着搬走。这里只负责说清「改的是哪一段」，
 * 不新增协议。
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
 * 目标是全书大纲时藏起来——那一层没有章可改名，留一个点了会报错的按钮
 * 比没有更糟。tooltip 里带上章名，作者才看得出改的是哪一章。
 */
function renderRenameBtn(): void {
  // 卷也能改名（改的是卷名，卷号前缀保留），所以两种落点都给。
  const relPath = plotOfTarget(store.session.target) ?? volumeOfTarget(store.session.target);
  setHidden(el.renamePlotBtn, !relPath);
  if (!relPath) {
    return;
  }
  el.renamePlotBtn.title = current && current.no > 0 ? `重命名${headLabel()}` : `重命名 ${relPath}`;
}

/**
 * 当前目标那一行的说法。
 *
 * 三种：一卷、一个已交付的段（它就是那几章）、一个还没交付的段。**说法不能混**
 * ——把剧情段叫成「第 N 章」会让作者以为它将来就是第 N 章，而一段可以拆成三章。
 * 与工程页、与后端日志同一份文案（`model/pipeline.ts`）。
 */
function headLabel(): string {
  const target = store.session.target;
  if (target.kind === 'volume') {
    return current && current.no > 0 ? volumeLabel(current.no, current.title) : '这一卷';
  }
  if (!current) {
    return '';
  }
  return current.chapter.exists
    ? chapterLabel(current.no, current.title)
    : segmentLabel(current.displayNo, current.title);
}

// ---------------------------------------------------------------- 章名信息条（只读）

/**
 * 顶部只报「在哪一卷 / 哪一段」，不负责导航。
 *
 * 切层靠下面的卷纲/剧情/正文按钮；切段靠工程页。这里做成可点只会多一个
 * 几乎没人用的入口，还让人以为点了会有什么深层动作。
 */
function renderCrumb(): void {
  const box = crumb();
  if (!box) {
    return;
  }
  clear(box);
  const target = store.session.target;
  const relPath = plotOfTarget(target) ?? volumeOfTarget(target);

  // 全书大纲那一层没有具体落点可报，整条收起。
  setHidden(box, !relPath);
  if (!relPath) {
    return;
  }

  // `no` 为 0 是后端给的「找不到」空壳（刚被改名或删掉），
  // 那时报文件名比报「第 0 章」有用。
  const title =
    current && current.no > 0 ? headLabel() : relPath.slice(relPath.lastIndexOf('/') + 1);
  box.appendChild(mk('span', 'crumb', title));

  // 段的状态徽章，与工程页那一列同一份文案（PLOT_STAGE_LABEL）。
  // 它是「这一段整体走到哪了」，与下面三层各自的状态点不重复。
  // 卷没有这条流水线（它只有一份卷纲），不挂。
  if (current && target.kind !== 'volume') {
    box.appendChild(mk('span', 'spacer'));
    const badge = mk('span', `cstage cstage-${current.stage}`, PLOT_STAGE_LABEL[current.stage]);
    badge.title = '这一段当前所处的阶段。由磁盘上的产物推导，不落盘。';
    box.appendChild(badge);
  }
}

// ---------------------------------------------------------------- 三层状态

/**
 * 卷纲 / 剧情 / 正文。每层一个可点的按钮，点了就切到那一层。
 *
 * 这三格是**当前这一段的上游链**：它所属那一卷的卷纲 → 它自己的细纲 →
 * 它的正文。从前第一格是「细节」（那一段拆出来的场景），而场景那一层已经
 * 删掉了（见 core/model/pipeline.ts 的文件头）。换成卷纲是因为作者在段之间
 * 走动时最常回头看的就是它——「这一卷要往哪去」决定了下一段该发生什么，
 * 而从前要看它只能去工程页翻。
 *
 * 完成度落成三态圆点（未开始 / 进行中 / 已完成），不用百分比条——这里
 * 表达的是状态机走到哪，不是「完成了百分之几」。
 *
 * 「上游变过」的标记（⟳）是这套流水线最有价值的一格信息：改了大纲之后，
 * 哪几段的剧情需要回头看，光靠人脑记不住。它由 hash 链算出来，零模型调用。
 */
function renderStages(): void {
  const box = stagesBox();
  if (!box) {
    return;
  }
  clear(box);

  const relPath = plotOfTarget(store.session.target);
  // 全书大纲阶段没有「这一段的三层」可言，整条收起来。
  setHidden(box, !relPath);
  if (!relPath) {
    return;
  }

  const progress: PipelineProgress = current?.progress ?? { plot: 0, manuscript: 0, summary: 0 };
  const volume = current?.volume;

  // 卷纲那一格不在 `PipelineProgress` 里：那份进度是**按段**算的，而卷纲是
  // 这一段的上游、不属于它。所以单独取——有卷纲且写过走向就算齐。
  const ratioOf = (stage: CreationStage): number => {
    switch (stage) {
      case 'volume':
        return volume?.filled ? 1 : 0;
      case 'plot':
        return progress.plot;
      default:
        return progress.manuscript;
    }
  };
  const stale: Partial<Record<CreationStage, boolean>> = {
    volume: !!volume?.upstreamStale,
    plot: !!current?.plot.upstreamStale,
    manuscript: !!current?.manuscript.upstreamStale,
  };

  for (const stage of CREATION_STAGES) {
    // 全书大纲不进这一排：它不属于某一段，入口在工程页。
    if (stage === 'outline') {
      continue;
    }
    // 未分卷的段（`plots/` 根下那些，老工程全是）没有卷纲可切。**收起来而不是
    // 摆一个点了报错的按钮**——那一格对它们本来就不存在。
    if (stage === 'volume' && !volume) {
      continue;
    }
    const status = stageStatus(ratioOf(stage));
    const btn = mk('button', 'pstage');
    btn.classList.toggle('active', store.session.stage === stage);
    btn.classList.toggle('done', status === 'done');
    btn.classList.toggle('partial', status === 'partial');
    btn.title = `${STAGE_LABEL[stage]}：${STAGE_STATUS_LABEL[status]} · ${STAGE_QUESTION[stage]}`;

    const mark = mk('span', `pstage-mark ${status}`);
    mark.setAttribute('aria-hidden', 'true');
    btn.appendChild(mark);
    btn.appendChild(mk('span', 'pstage-label', STAGE_LABEL[stage]));
    if (stale[stage]) {
      const dot = mk('span', 'pstage-stale', '⟳');
      dot.title = '上游产物改过，这一层可能需要回头看';
      btn.appendChild(dot);
    }
    const target = targetFor(stage, relPath);
    btn.addEventListener('click', () => go(target));
    box.appendChild(btn);
  }

  // 摘要不是创作阶段（它是写完之后的产物），所以只给一个状态点，不给按钮。
  if (current) {
    const s = mk('span', `psummary${current.summary.stale ? ' stale' : ''}`, current.summary.stale ? '摘要待更新' : '摘要已同步');
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
      ? '这一段各层都齐了。要改哪一层就点上面对应的那一层。'
      : '挑一段开始，或在输入框里打 / 挑一个命令。';
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
 * 「描述要续写的剧情」在剧情阶段是误导——那一层用户输入的是走向而不是纲要。
 * 而多数命令的输入是**可选**的，提示语要说出这一点。
 */
function updatePlaceholder(): void {
  const { stage, capability } = store.session;
  if (stage === 'manuscript' && capability === 'generate') {
    el.input.placeholder = '描述这一段要写什么剧情…（可留空，Enter 发送）';
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

/**
 * 切到某一层时保留当前剧情段。
 *
 * `volume` 那一档要的是**卷路径**，而它只能从后端推的那份流水线里拿
 * （`current.volume.relPath`）：段的归属靠目录，前端自己拼一份规则出来，
 * 在未分卷的老工程上会拼出一个不存在的卷。拿不到就退回剧情层——
 * 调用方已经把那一格收起来了，这里只是不撒谎。
 */
function targetFor(stage: CreationStage, plotRelPath: string): CreationTarget {
  switch (stage) {
    case 'outline':
      return { kind: 'outline' };
    case 'volume': {
      const volumeRelPath = current?.volume?.relPath;
      return volumeRelPath ? { kind: 'volume', volumeRelPath } : { kind: 'plot', plotRelPath };
    }
    case 'plot':
      return { kind: 'plot', plotRelPath };
    case 'manuscript':
      return { kind: 'manuscript', plotRelPath };
  }
}
