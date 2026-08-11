/**
 * 创作流水线条与能力按钮组。
 *
 * 这是 `mode: 'write' | 'discuss'` 那个下拉框的替代者。旧的两个选项按
 * **AI 的输出形式**分，而作者的实际流程是四层产物：大纲 → 细纲 → 细节 → 正文。
 * 界面上因此要回答两个问题：
 *
 * - **我现在在哪一层？** —— 流水线条（面包屑 + 四段进度）
 * - **我要它干什么？** —— 能力按钮组（讨论/挑刺/生成…，随阶段变）
 *
 * ## 为什么按钮组是按钮而不是又一个下拉框
 *
 * 下拉框把「这一层能做什么」藏起来了。作者在细纲阶段该看得见「可以拆场景」，
 * 而不是点开下拉才发现多了一项。代价是横向占地方，值得。
 *
 * ## 为什么默认永远是「讨论」
 *
 * 切阶段时能力回落到 discuss（后端 `DEFAULT_CAPABILITY` 也是这么定的）。
 * 默认动作不该是花钱产出一份要不要都不知道的产物——「不偷偷烧 token」
 * 在交互上的落法就是让用户主动点「生成」。
 */
import { el as mk, clear, maybeById, setHidden } from '../dom';
import {
  CAPABILITY_HINT,
  CAPABILITY_LABEL,
  CREATION_STAGES,
  STAGE_CAPABILITIES,
  STAGE_LABEL,
  STAGE_QUESTION,
  chapterOfTarget,
  outputKindOf,
} from '../protocol';
import type {
  ChapterPipelineView,
  CreationStage,
  CreationTarget,
  PipelineProgress,
} from '../protocol';
import { el } from './refs';
import { store, vscode } from './store';

/**
 * `split` 在不同阶段拆出的是不同的东西，按钮上直说。
 *
 * 这是唯一一处前端自己加的文案：后端的 `CAPABILITY_LABEL` 要在日志与确认框里
 * 通用，说「拆分」是对的；按钮上有阶段做上下文，说「拆场景」更直接。
 */
const SPLIT_LABEL: Partial<Record<CreationStage, string>> = {
  outline: '拆章节',
  plan: '拆场景',
};

// ---------------------------------------------------------------- 状态

/** 当前这一章的流水线。切目标或产物落盘后由后端重推。 */
let current: ChapterPipelineView | null = null;

const crumb = () => maybeById('pipelineCrumb');
const stagesBox = () => maybeById('pipelineStages');
const scenesBox = () => maybeById('pipelineScenes');
const capsBox = () => maybeById('capabilities');

export function renderPipeline(pipeline: ChapterPipelineView): void {
  current = pipeline;
  redraw();
}

/**
 * 会话变了（切目标、开历史会话）时重画。
 *
 * 目标换到另一章时手上这份 pipeline 就过期了——先丢掉再等后端推新的，
 * **不要留着显示**：拿上一章的进度条配这一章的面包屑，比什么都不显示更糟。
 */
export function onSessionChanged(): void {
  if (current && current.chapterRelPath !== chapterOfTarget(store.session.target)) {
    current = null;
  }
  redraw();
}

function redraw(): void {
  renderCrumb();
  renderStages();
  renderScenes();
  renderCapabilities();
}

// ---------------------------------------------------------------- 面包屑

function renderCrumb(): void {
  const box = crumb();
  if (!box) {
    return;
  }
  clear(box);
  const target = store.session.target;

  box.appendChild(crumbItem('全书大纲', target.kind === 'outline', () => go({ kind: 'outline' })));

  const relPath = chapterOfTarget(target);
  if (!relPath) {
    return;
  }
  const title = current?.title
    ? `第 ${current.order} 章《${current.title}》`
    : relPath.slice(relPath.lastIndexOf('/') + 1);
  box.appendChild(mk('span', 'crumb-sep', '›'));
  box.appendChild(
    crumbItem(title, target.kind !== 'scene', () => go({ kind: 'manuscript', chapterRelPath: relPath }))
  );

  if (target.kind === 'scene') {
    const scene = current?.scenes.find((s) => s.no === target.sceneNo);
    box.appendChild(mk('span', 'crumb-sep', '›'));
    box.appendChild(crumbItem(scene ? `场景 ${scene.no} ${scene.title}` : `场景 ${target.sceneNo}`, true));
  }
}

function crumbItem(text: string, active: boolean, onClick?: () => void): HTMLElement {
  const node = mk(onClick ? 'button' : 'span', `crumb${active ? ' active' : ''}`, text);
  if (onClick) {
    node.addEventListener('click', onClick);
  }
  return node;
}

// ---------------------------------------------------------------- 四段进度

/**
 * 四段进度条。每段是一个可点的按钮，点了就切到那一层。
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
  // 全书大纲阶段没有「这一章的四段」可言，整条收起来。
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
    const btn = mk('button', 'pstage');
    btn.classList.toggle('active', store.session.stage === stage);
    btn.classList.toggle('done', ratio >= 1);
    btn.title = `${STAGE_LABEL[stage]}：${STAGE_QUESTION[stage]}`;

    const bar = mk('span', 'pstage-bar');
    const fill = mk('span', 'pstage-fill');
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    bar.appendChild(fill);

    btn.appendChild(mk('span', 'pstage-label', STAGE_LABEL[stage]));
    btn.appendChild(bar);
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

// ---------------------------------------------------------------- 能力按钮

function renderCapabilities(): void {
  const box = capsBox();
  if (!box) {
    return;
  }
  clear(box);

  const stage = store.session.stage;
  for (const capability of STAGE_CAPABILITIES[stage] ?? []) {
    const label = capability === 'split' ? (SPLIT_LABEL[stage] ?? CAPABILITY_LABEL.split) : CAPABILITY_LABEL[capability];
    const btn = mk('button', 'cap', label);
    btn.classList.toggle('active', store.session.capability === capability);
    // 会写文件的能力单独标一下：点了会产出可采纳的东西，与「只是聊聊」不同。
    btn.classList.toggle('cap-artifact', outputKindOf({ stage, capability }) === 'artifact');
    btn.title = CAPABILITY_HINT[capability];
    btn.addEventListener('click', () => {
      store.session.capability = capability;
      renderCapabilities();
      updatePlaceholder();
    });
    box.appendChild(btn);
  }
  updatePlaceholder();
}

/**
 * 输入框的提示语跟着阶段与能力走。
 *
 * 「描述要续写的剧情」在细纲阶段是误导——那一层用户输入的是要求而不是纲要。
 */
function updatePlaceholder(): void {
  const { stage, capability } = store.session;
  if (stage === 'manuscript' && (capability === 'generate' || capability === 'rewrite')) {
    el.input.placeholder = '描述这一段要写什么剧情…（Enter 发送，Shift+Enter 换行）';
    return;
  }
  el.input.placeholder = `${STAGE_LABEL[stage]} · ${CAPABILITY_LABEL[capability]}：${STAGE_QUESTION[stage]}`;
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
