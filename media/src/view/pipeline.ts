/**
 * 创作流水线条与「下一步」。
 *
 * 界面要回答三个问题，这里管前两个（第三个是工作区卡，见 workbench.ts）：
 *
 * - **我现在在哪一层？** —— 章名信息条 + 状态徽章 + 三层状态点
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
 * 它是状态机替你选的，没有参数可填：细纲要写什么，细纲文件与大纲里都写着。
 * 旧界面逼作者先编一句「请生成」才肯发送，而那句废话还会被当成要求装进
 * prompt。输入框里有字就当补充要求带上，没有就不带。
 */
import { el as mk, clear, maybeById, setHidden } from '../dom';
import {
  CHAPTER_STAGE_LABEL,
  CREATION_STAGES,
  STAGE_LABEL,
  STAGE_QUESTION,
  chapterLabel,
  chapterOfTarget,
} from '../protocol';
import type {
  ChapterPipelineView,
  CreationStage,
  CreationTarget,
  NextStepView,
  PipelineProgress,
} from '../protocol';
import { el } from './refs';
import { store, vscode } from './store';

// ---------------------------------------------------------------- 状态

/** 当前这一章的流水线。切目标或产物落盘后由后端重推。 */
let current: ChapterPipelineView | null = null;
/** 状态机算出的下一步。全书大纲阶段也有（去写大纲 / 去拆章节）。 */
let next: NextStepView | null = null;

const crumb = () => maybeById('pipelineCrumb');
const stagesBox = () => maybeById('pipelineStages');
const scenesBox = () => maybeById('pipelineScenes');

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
 * 复用工程页右键那条 `fileAction: 'rename'`——后端的 `renameEntry` 已经会
 * 保留序号前缀、同步正文 H1、把细纲/场景/摘要/草稿四套伴生文件连内容里的
 * 引用一起带走。这里只负责说清「改的是哪一章」，不新增协议。
 */
export function installRenameChapter(): void {
  el.renameChapterBtn.addEventListener('click', () => {
    const relPath = chapterOfTarget(store.session.target);
    if (!relPath || store.busy) {
      return;
    }
    vscode.postMessage({ type: 'fileAction', action: 'rename', relPath });
  });
}

export function renderPipeline(pipeline: ChapterPipelineView | undefined, step: NextStepView | undefined): void {
  current = pipeline ?? null;
  next = step ?? null;
  redraw();
}

/**
 * 会话变了（切目标、开历史会话）时重画。
 *
 * 目标换到另一章时手上这份 pipeline 就过期了——先丢掉再等后端推新的，
 * **不要留着显示**：拿上一章的状态配这一章的章名，比什么都不显示更糟。
 */
export function onSessionChanged(): void {
  if (current && current.chapterRelPath !== chapterOfTarget(store.session.target)) {
    current = null;
    next = null;
  }
  redraw();
}

function redraw(): void {
  renderCrumb();
  renderRenameBtn();
  renderStages();
  renderScenes();
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
  const relPath = chapterOfTarget(store.session.target);
  setHidden(el.renameChapterBtn, !relPath);
  if (!relPath) {
    return;
  }
  el.renameChapterBtn.title =
    current && current.order > 0
      ? `重命名${chapterLabel(current.order, current.title)}`
      : `重命名 ${relPath}`;
}

// ---------------------------------------------------------------- 章名信息条（只读）

/**
 * 顶部只报「在哪一章 / 哪一场」，不负责导航。
 *
 * 切层靠下面的细纲/细节/正文按钮；切章靠工程页。这里做成可点只会多一个
 * 几乎没人用的入口，还让人以为点了会有什么深层动作。
 */
function renderCrumb(): void {
  const box = crumb();
  if (!box) {
    return;
  }
  clear(box);
  const target = store.session.target;
  const relPath = chapterOfTarget(target);

  // 大纲阶段没有章可报，整条收起。
  setHidden(box, !relPath);
  if (!relPath) {
    return;
  }

  // `order` 为 0 是后端给的「这一章找不到」空壳（刚被改名或删掉），
  // 那时报文件名比报「第 0 章」有用。
  const title = current && current.order > 0
    ? chapterLabel(current.order, current.title)
    : relPath.slice(relPath.lastIndexOf('/') + 1);
  box.appendChild(mk('span', 'crumb', title));

  if (target.kind === 'scene') {
    const scene = current?.scenes.find((s) => s.no === target.sceneNo);
    box.appendChild(mk('span', 'crumb-sep', '›'));
    box.appendChild(mk('span', 'crumb', scene ? `场景 ${scene.no} ${scene.title}` : `场景 ${target.sceneNo}`));
  }

  // 章节状态徽章，与工程页那一列同一份文案（CHAPTER_STAGE_LABEL）。
  // 它是「这一章整体走到哪了」，与下面三层各自的状态点不重复。
  if (current) {
    box.appendChild(mk('span', 'spacer'));
    const badge = mk('span', `cstage cstage-${current.stage}`, CHAPTER_STAGE_LABEL[current.stage]);
    badge.title = '这一章当前所处的阶段。由磁盘上的四层产物推导，不落盘。';
    box.appendChild(badge);
  }
}

// ---------------------------------------------------------------- 三层状态

/**
 * 细纲 / 细节 / 正文。每层一个可点的按钮，点了就切到那一层。
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

  const relPath = chapterOfTarget(store.session.target);
  // 全书大纲阶段没有「这一章的三层」可言，整条收起来。
  setHidden(box, !relPath);
  if (!relPath) {
    return;
  }

  const progress: PipelineProgress = current?.progress ?? { plan: 0, scene: 0, manuscript: 0, summary: 0 };
  const stale: Partial<Record<CreationStage, boolean>> = {
    plan: !!current?.plan?.upstreamStale,
    scene: !!current?.scenes.some((s) => s.upstreamStale),
    manuscript: !!current?.manuscript.beatsStale,
  };

  for (const stage of CREATION_STAGES) {
    if (stage === 'outline') {
      continue;
    }
    const ratio = progress[stage === 'manuscript' ? 'manuscript' : stage];
    const status = stageStatus(ratio);
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
    btn.addEventListener('click', () => go(targetFor(stage, relPath)));
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

// ---------------------------------------------------------------- 场景列表

/** 场景列表只在细节/正文阶段展开——大纲和细纲阶段它是噪声。 */
function renderScenes(): void {
  const box = scenesBox();
  if (!box) {
    return;
  }
  clear(box);

  const stage = store.session.stage;
  const relPath = chapterOfTarget(store.session.target);
  const scenes = current?.scenes ?? [];
  const show = !!relPath && (stage === 'scene' || stage === 'manuscript') && scenes.length > 0;
  setHidden(box, !show);
  if (!show || !relPath) {
    return;
  }

  const target = store.session.target;
  const activeNo = target.kind === 'scene' || target.kind === 'manuscript' ? target.sceneNo : undefined;

  for (const scene of scenes) {
    const btn = mk('button', `pscene ${scene.status}`);
    btn.classList.toggle('active', activeNo === scene.no);
    btn.textContent = scene.detail;
    btn.title = [
      scene.ready ? '「必须发生」已填，可以写正文' : '还没填「必须发生」，写正文前先补上',
      scene.upstreamStale ? '本章细纲改过，这一场的前置条件可能已失效' : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (scene.upstreamStale) {
      btn.appendChild(mk('span', 'pscene-stale', '⟳'));
    }
    btn.addEventListener('click', () =>
      go(
        stage === 'manuscript'
          ? { kind: 'manuscript', chapterRelPath: relPath, sceneNo: scene.no }
          : { kind: 'scene', chapterRelPath: relPath, sceneNo: scene.no }
      )
    );
    box.appendChild(btn);
  }
}

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
      ? '这一章各层都齐了。要改哪一层就点上面对应的那一段。'
      : '挑一章开始，或在输入框里打 / 挑一个命令。';
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
 * 「描述要续写的剧情」在细纲阶段是误导——那一层用户输入的是要求而不是纲要。
 * 而多数命令的输入是**可选**的，提示语要说出这一点。
 */
function updatePlaceholder(): void {
  const { stage, capability } = store.session;
  if (stage === 'manuscript' && (capability === 'generate' || capability === 'rewrite')) {
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

/** 切到某一层时保留当前章节（与场号，如果那一层认它）。 */
function targetFor(stage: CreationStage, chapterRelPath: string): CreationTarget {
  const target = store.session.target;
  const sceneNo = target.kind === 'scene' || target.kind === 'manuscript' ? target.sceneNo : undefined;
  switch (stage) {
    case 'outline':
      return { kind: 'outline' };
    case 'plan':
      return { kind: 'plan', chapterRelPath };
    case 'scene':
      // 还没选具体哪一场时落到第一场——「细节阶段」但不指着任何一场，
      // 装配器只能给全章场景一览，多数时候不是用户想要的。
      return { kind: 'scene', chapterRelPath, sceneNo: sceneNo ?? current?.scenes[0]?.no ?? 1 };
    case 'manuscript':
      return { kind: 'manuscript', chapterRelPath, sceneNo };
  }
}
