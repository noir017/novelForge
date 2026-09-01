/**
 * 「生成」页：**手动调一次 `generate`**。
 *
 * ## 与对话页那条路彻底分开
 *
 * 这一页不碰 `ChatSession`、不碰 `DraftStore`、不碰 [gate.ts](gate.ts) 的询问表。
 * 那三样是 agent 那条路的状态，循环、气泡、闸门卡片全挂在上面；借用它们能省
 * 一点代码，代价是**又一处「两条路共用一份状态」**——那正是这一轮重构要解开的
 * 东西。所以：
 *
 * - 待采纳的产物就一份，记在 `c.genDraft`，新的顶掉旧的；
 * - 落盘那一问是这一页自己底部那条采纳栏，不是 gate 卡片；
 * - 刷新页面就没了。没落盘的东西本来也不该活过一次刷新。
 *
 * **唯一共用的是并发锁**（`beginGeneration`）。那不是状态耦合，那就是它的职责：
 * 同一个 controller 同一时刻只许有一次模型调用在跑，否则两股流会互相盖。
 *
 * ## 复用的都是无状态的东西
 *
 * `generation/generate.ts`（装配 + 调模型 + 解析）、`generation/accept.ts`（落盘）、
 * `workspace/kind.ts`（路径 → 层）、`model/pipeline.ts`（job/stage 的定义与说法）、
 * `skills.ts`（名单与正文）。agent 那条路用的也是这几样，但它们不持有状态，
 * 共用不产生耦合。
 *
 * ## 三条与 `tools/novel/generate.ts` 必须一致的行为
 *
 * 1. **校验前置，一分钱不花。** job 与落点不同层、路径认不出、skill 名字对不上，
 *    在发请求之前就回一条错。工具那三条 `return { error }` 在这里是同样三条，
 *    只是错误文案落在表单上而不是模型的上下文里。
 * 2. **哪一层用哪个模型**照抄那张表（`STAGE_TIER_TASK`，直接 import 那一份，
 *    不在这里再写一遍），走池时**必须把 `primaryBudget` 一起传下去**（第 13 条）。
 * 3. **产出绝不自动落盘**（第 19 条）：`Draft` 只在内存，采纳是显式一颗按钮。
 *
 * 两件工具做而这里不做的：`usage.record`（那是 agent 的预算，这一页没有循环）
 * 与 debug 的 `sessionId`（这一页没有会话，硬造一个只会在工程里留下没人认领的
 * 目录——与工程页批量任务同一条理由）。
 */
import type { ChatController } from './index';
import { readBudgetFallback, readConfig } from '../config';
import { generate, parseDraftArtifact, type Draft } from '../generation/generate';
import { acceptArtifact } from '../generation/accept';
import { buildProvider } from '../llm/registry';
import { createModelPool } from '../llm/pool';
import type { LlmProvider } from '../llm/provider';
import { resolveModelRef } from '../model/providers';
import { describeTier, refsForTask, type LlmTask } from '../model/tiers';
import { STAGE_TIER_TASK } from '../tools/novel/generate';
import { listGenerateSkills, listSkills, readSkill, skillRelPath } from '../skills';
import type { SkillText } from '../context/types';
import type { BuiltContext } from '../context/builder';
import { kindOfPath } from '../workspace';
import { scoped } from '../runtime/logger';
import { isVolumeFilled } from '../model/volumeFile';
import { buildPipelineIndex } from '../views/pipeline';
import {
  CreationJob,
  CreationStage,
  CreationTarget,
  JOB_LABEL,
  STAGE_LABEL,
  segmentLabel,
  stageOfJob,
  volumeLabel,
} from '../model/pipeline';
import type { GenDraftView, GenLayerView, GenModelView, GenTargetItem, InMessage } from '../protocol';
import { describeArtifactOf } from './chat';
import { describeProvider } from './serialize';

const log = scoped('生成页');

type RunMessage = Extract<InMessage, { type: 'genRun' }>;

// ---------------------------------------------------------------- 落点候选

/**
 * 换了 job → 这一层的落点候选 + 这一层会用哪个模型。
 *
 * 两件事一起回，因为它们由同一个输入决定（job → stage）。分成两条消息只会
 * 让界面在换 job 之后有一瞬间显示着上一层的模型。
 */
export async function pushGenTargets(
  c: ChatController,
  job: CreationJob,
  model?: string
): Promise<void> {
  const stage = stageOfJob(job);
  c.post({
    type: 'genTargets',
    job,
    stage,
    items: await listTargets(c, job, stage),
    // `model` 是下拉框里此刻选的那个。空 = 按层自动，照抄工具那张表。
    model: describeModel(stage, model),
  });
}

/**
 * 这一层有哪些落点。**由后端按层列，不让作者去拼路径。**
 *
 * 工具收的是一条裸路径，因为模型手上只有路径；作者手上是「第 12 章」「第二卷」。
 * 候选里没有的落点（老工程、拆段那种「文件还不存在」的落点）走界面上那个
 * 「手填路径」。
 *
 * `hasContent` 用的是 `targetHasContent` 那两个同款判据（`isVolumeFilled`，
 * 以及 `plot.filled` 背后的 `isPlotFilled`），只是数据取自已经读过的那一份索引——**同一个函数，不重复
 * 读盘**。真正决定「是写入还是覆盖」的仍是采纳时那一遍（`describeArtifactOf`）。
 */
async function listTargets(
  c: ChatController,
  job: CreationJob,
  stage: CreationStage
): Promise<GenTargetItem[]> {
  // 两件「拆」往下加一份新的空壳，落点上本来就没东西——说「会覆盖」是吓唬人。
  const splits = job === 'volumeList' || job === 'plotSegment';

  if (stage === 'outline') {
    const outline = await c.project.readOutline();
    return [
      {
        relPath: c.project.relPath(c.project.outlinePath),
        label: '全书大纲',
        hasContent: !splits && outline.trim().length > 0,
      },
    ];
  }

  if (stage === 'volume') {
    const volumes = await c.project.listVolumes();
    return volumes.map((v) => ({
      relPath: v.relPath,
      label: volumeLabel(v.no, v.title),
      hasContent: !splits && isVolumeFilled(v.sections),
    }));
  }

  const index = await buildPipelineIndex(c.project);
  // 未交付的段在前（那是作者眼下在做的），已交付的在后并标出来——它们仍然
  // 可以重排、重写，只是那不是常态，不该混在待做的里面看不出区别。
  //
  // **已交付的也要列**：一个全书写完的工程里未交付的段是零，只列前者的话，
  // 正文层与剧情层的下拉框会双双是空的，而作者想做的恰恰是回头重写某一章。
  const ordered = [
    ...index.segments,
    ...[...index.pipelines.values()].filter((p) => p.consumed && p.plot.relPath),
  ];

  if (stage === 'plot') {
    return ordered.map((p) => ({
      relPath: p.plot.relPath,
      label: labelOf(p),
      hasContent: p.plot.filled,
    }));
  }

  // 正文的落点是中转站里那份镜像文件。**已发布的章不在候选里**：`kindOfPath`
  // 判它是 `chapter`，没有 stage 也没有 target，选中它只会在点「生成」时被
  // 挡下来——列一个必然报错的选项比不列更糟。要改已发布的章，走「手填路径」
  // 指向它那一段的中转站路径。
  // 说法与剧情层同一份：这一页的「② 落在哪」上方已经写着要哪一层的落点，
  // 每一项再缀一个「· 正文」只是把同一句话说两遍。真实路径在选项的 tooltip 上。
  return ordered.map((p) => ({
    relPath: p.manuscript.relPath,
    label: labelOf(p),
    // 正文是追加，不覆盖任何东西（与 `targetHasContent` 同一条）。
    hasContent: false,
  }));
}

/**
 * 一段在下拉框里的说法。
 *
 * 已交付的段没有「剧情 N」那个位次可用——那个 N 是在**未交付的段里**排第几
 * （见 model/pipeline.ts 的 `segmentDisplayNo`），给已交付的段套上去会得到一个
 * 与界面别处对不上的号。所以它只报标题，并标一句「已交付」。
 */
function labelOf(p: { consumed: boolean; displayNo: number; title: string; plot: { relPath: string } }): string {
  return p.consumed
    ? `${p.title || p.plot.relPath} · 已交付`
    : segmentLabel(p.displayNo, p.title);
}

// ---------------------------------------------------------------- 模型

/**
 * 这一次会用哪个模型。**只查配置，不建 provider、不建池。**
 *
 * 这一份是给界面回显用的，而换一次 job 下拉框就要算一遍——在这里建池会
 * 因为缺 Key 弹出输入框，作者只是换了个下拉框而已。
 *
 * `ref` 给了就是作者显式挑的那一个（严格用它、不走池）；缺席是「按层自动」，
 * 照抄工具那张表。
 */
function describeModel(stage: CreationStage, ref?: string): GenModelView {
  const config = readConfig();
  const fallback = readBudgetFallback();

  if (ref) {
    const active = resolveModelRef(config.providers, ref);
    if (!active) {
      return { ref, label: ref, contextWindow: 0, maxOutputTokens: 0, issue: `认不出模型「${ref}」。` };
    }
    return {
      ref,
      label: ref,
      contextWindow: active.model.contextWindow ?? fallback.contextWindow,
      maxOutputTokens: active.model.maxOutputTokens ?? fallback.maxOutputTokens,
    };
  }

  const task = STAGE_TIER_TASK[stage];
  if (!task) {
    // 不分档的三层（正文 / 大纲 / 卷纲）：严格用对话页选定的那个（第 12 条）。
    if (!config.active) {
      return {
        ref: '',
        label: '',
        contextWindow: 0,
        maxOutputTokens: 0,
        issue: '还没有可用的模型，先去设置页配一个。',
      };
    }
    return {
      ref: config.model,
      label: describeProvider(config),
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens,
      tierNote: `${STAGE_LABEL[stage]}层不分档，用默认模型`,
    };
  }

  const picked = refsForTask(config, task);
  const tierNote = `${STAGE_LABEL[stage]}层走${describeTier(picked)}`;
  for (const candidate of picked.refs) {
    const active = resolveModelRef(config.providers, candidate);
    if (active) {
      return {
        ref: candidate,
        label: candidate,
        contextWindow: active.model.contextWindow ?? fallback.contextWindow,
        maxOutputTokens: active.model.maxOutputTokens ?? fallback.maxOutputTokens,
        tierNote,
      };
    }
  }
  return {
    ref: '',
    label: '',
    contextWindow: 0,
    maxOutputTokens: 0,
    tierNote,
    issue: '这一档里一个解析得出的模型都没有，先去设置页配一个。',
  };
}

/**
 * 真要发请求了，把模型建出来。
 *
 * 返回空对象 = 用对话页选定的那个（`generate` 的缺省），这也是池建不出来时的
 * 退路：报一条 warn 然后照常跑，好过在这里硬失败。
 *
 * **走池时只取 `primary`，不用 `pool.run` 的失败换人**（与工具同一条）：生成是
 * 流式的，换一个模型重跑会把半份产物再冲一遍进作者的输出框。
 */
async function buildModel(
  stage: CreationStage,
  ref?: string
): Promise<{ provider?: LlmProvider; budget?: { contextWindow: number; maxOutputTokens: number } }> {
  const config = readConfig();
  const fallback = readBudgetFallback();

  if (ref) {
    const active = resolveModelRef(config.providers, ref);
    if (!active) {
      return {};
    }
    const provider = await buildProvider(active);
    if (!provider) {
      // 缺 Key（作者拒了输入框）。回落到缺省那个，`generate` 会再报一次清楚的话。
      return {};
    }
    // 传了 provider 就必须一起传窗口（第 13 条）。
    return {
      provider,
      budget: {
        contextWindow: active.model.contextWindow ?? fallback.contextWindow,
        maxOutputTokens: active.model.maxOutputTokens ?? fallback.maxOutputTokens,
      },
    };
  }

  const task: LlmTask | undefined = STAGE_TIER_TASK[stage];
  if (!task) {
    return {};
  }
  const pool = await createModelPool({ task });
  if (!pool) {
    log.warn(`${STAGE_LABEL[stage]}层没有可用的分档模型，改用默认模型`);
    return {};
  }
  return { provider: pool.primary, budget: pool.primaryBudget };
}

// ---------------------------------------------------------------- 跑一次

/**
 * 手动生成一次。
 *
 * 顺序是刻意的：**三条校验全在占锁与发请求之前**——认不出落点、层对不上、
 * skill 名字错了，这三种情况一分钱都不该花。
 */
export async function runGenerate(c: ChatController, msg: RunMessage): Promise<void> {
  const rel = msg.target.trim();
  const path = kindOfPath(c.project, rel);
  if (!path.stage || !path.target) {
    fail(c, `认不出「${rel}」是哪一层的产物。可以先在「工程」页看看那个目录下实际有什么。`);
    return;
  }

  const wantStage = stageOfJob(msg.job);
  if (wantStage !== path.stage) {
    fail(
      c,
      `${JOB_LABEL[msg.job]}要的是${STAGE_LABEL[wantStage]}层的落点，` +
        `而「${rel}」是${STAGE_LABEL[path.stage]}层的产物。`
    );
    return;
  }

  // 写作方法在花钱之前读好。名字错了整次拒绝——这一步不花一分钱，而默默不带
  // 等于让作者付了钱却没用上他要的写法。
  const picked = await resolveSkills(c, msg.skills);
  if (!picked.ok) {
    fail(c, picked.error);
    return;
  }

  const lease = c.beginGeneration();
  if (!lease) {
    fail(c, '已有一个生成任务在进行中，先停掉它。');
    return;
  }

  // 上一次那份作废：作者按了「生成」，就是不要上一份了。留着的话采纳栏会
  // 指着一份与眼前正文对不上的旧产物。
  c.genDraft = undefined;
  c.post({ type: 'genPhase', phase: 'building' });
  c.post({ type: 'busy', value: true });

  const model = await buildModel(path.stage, msg.model);
  let failure: string | undefined;
  let cancelled = false;
  let built: BuiltContext | undefined;
  let reasoningChars = 0;
  // 第一片正文到达之前都算「还在想」——推理模型常常先想几十秒，那段时间
  // 界面不能是空的（第 11 条：不闷着干活）。
  let writing = false;

  try {
    const result = await generate(
      c.project,
      {
        job: msg.job,
        target: path.target,
        targetNo: path.no,
        ask: msg.ask ?? '',
        targetWords: msg.targetWords,
        // 空数组：这一页没有对话历史，也不该有——它是一次独立的产出。
        history: [],
        skills: picked.skills,
      },
      {
        onDelta: (delta) => {
          if (!writing) {
            writing = true;
            c.post({ type: 'genPhase', phase: 'writing' });
          }
          c.post({ type: 'genDelta', text: delta });
        },
        onReasoning: (delta) => {
          if (!writing && reasoningChars === 0) {
            c.post({ type: 'genPhase', phase: 'thinking' });
          }
          reasoningChars += delta.length;
          c.post({ type: 'genReasoning', text: delta });
        },
        onDone: () => undefined,
        onError: (message) => {
          failure = message;
        },
        onCancelled: () => {
          cancelled = true;
        },
      },
      {
        signal: lease.signal,
        ...model,
        // 作者在这一页显式挑的那一档。工具刻意不带它（agent 一轮可能调好几次，
        // 每次都按极限档想一遍等于一个倍率不明的开关）；手动这一次是作者自己
        // 按下的，那条理由不成立。
        ...(msg.thinking ? { thinking: msg.thinking } : {}),
      }
    );
    built = result.built;

    if (!result.draft) {
      c.post({ type: 'genPhase', phase: cancelled ? 'cancelled' : 'error', message: failure });
      c.post({ type: 'genDone' });
      return;
    }

    c.genDraft = result.draft;
    // 字数捎在状态行上：作者最先看的就是那一行，而形状要等下面那条才画得出来。
    c.post({ type: 'genPhase', phase: 'done', message: `${result.draft.words} 字` });
    c.post({ type: 'genDone', draft: await viewOf(c, result.draft, built, reasoningChars) });
  } finally {
    lease.release();
    c.post({ type: 'busy', value: false });
  }
}

/** 作者点了「停止」。没有在跑的就什么也不做。 */
export function stopGenerate(c: ChatController): void {
  c.stopGeneration();
}

// ---------------------------------------------------------------- 采纳

/**
 * 把这份产出落盘。
 *
 * **按输出框里当下的文本重新解析**，不是生成那一刻的原文：作者可以在采纳
 * 之前改，而 `draft.raw` 只是生成那一刻的快照。
 *
 * 落点以 `draft.target` 为准（生成时那一个），不看前端此刻表单里选的是哪个
 * ——作者可能在等着这一份的时候又把下拉框拨到了别处。
 */
export async function adoptGen(c: ChatController, draftId: string, text: string): Promise<void> {
  const draft = c.genDraft;
  if (!draft || draft.id !== draftId) {
    c.post({ type: 'genAdopted', message: '这份产出已经不在了，重新生成一次吧。' });
    return;
  }
  if (!text.trim()) {
    c.post({ type: 'genAdopted', message: '内容是空的，没有写入任何文件。' });
    return;
  }
  const artifact = parseDraftArtifact(draft.job, text);
  if (!artifact) {
    // 解析不出来时**不写**。写一个空产物比不写更糟：作者会以为存下了。
    log.warn('产物解析不出内容，未写入', JOB_LABEL[draft.job]);
    c.post({ type: 'genAdopted', message: '这段内容解析不出可写入的产物，没有写入任何文件。' });
    return;
  }

  // 覆盖已有内容时这一步里面还有 workspace 网关的覆盖审阅（插件开 diff）
  // ——那是另一层，两层都过了才真的改磁盘。
  const result = await acceptArtifact(c.project, draft.target, artifact);
  c.toast(result.message);
  if (result.skipped || !result.relPath) {
    c.post({ type: 'genAdopted', message: result.message });
    return;
  }
  c.genDraft = undefined;
  c.post({ type: 'genAdopted', relPath: result.relPath, message: result.message });
  await c.pushState();
}

/** 丢掉这份产出。磁盘不动。 */
export function discardGen(c: ChatController, draftId: string): void {
  if (c.genDraft?.id === draftId) {
    c.genDraft = undefined;
  }
  c.post({ type: 'genAdopted', message: '没有采纳这份产物，磁盘上什么都没变。' });
}

// ---------------------------------------------------------------- 内部

function fail(c: ChatController, message: string): void {
  c.post({ type: 'genPhase', phase: 'error', message });
  c.post({ type: 'genDone' });
}

/**
 * 一份产出的界面投影。**正文不在里面**——它已经流过去了。
 *
 * `artifact` 缺席表示解析不出这一层要的结构，前端据此不画采纳按钮。
 */
async function viewOf(
  c: ChatController,
  draft: Draft,
  built: BuiltContext | undefined,
  reasoningChars: number
): Promise<GenDraftView> {
  return {
    draftId: draft.id,
    words: draft.words,
    artifact: await describeArtifactOf(c, draft.raw, draft),
    relPath: relPathOf(c, draft.target),
    reasoningChars,
    layers: (built?.items ?? []).map(layerOf),
    usedTokens: built?.usedTokens ?? 0,
    budget: built?.budget ?? 0,
  };
}

/** 采纳按钮上写的那个路径。落点由 target 决定，与前端表单无关。 */
function relPathOf(c: ChatController, target: CreationTarget): string {
  switch (target.kind) {
    case 'outline':
      return c.project.relPath(c.project.outlinePath);
    case 'volume':
      return target.volumeRelPath;
    case 'plot':
      return target.plotRelPath;
    case 'manuscript':
      return c.project.manuscriptMirrorRelPath(target.plotRelPath);
  }
}

const STATUS_LABEL: Record<string, string> = {
  included: '完整',
  degraded: '已降级',
  dropped: '已丢弃',
  excluded: '已排除',
};

function layerOf(item: BuiltContext['items'][number]): GenLayerView {
  return {
    label: item.label,
    tokens: item.tokens,
    status: STATUS_LABEL[item.status] ?? item.status,
    note: item.note,
    source: item.source,
  };
}

type ResolvedSkills = { ok: true; skills: SkillText[] } | { ok: false; error: string };

/**
 * 勾中的那几个名字 → 正文。**一个对不上就整次拒绝**（与工具同一条）。
 *
 * 判据是「此刻真能带上的那些」（`listGenerateSkills`）而不是前端手上那份名单：
 * 那份可能是几分钟前推的，作者刚在设置页把某一份改成了「禁用」。
 */
async function resolveSkills(c: ChatController, names: string[]): Promise<ResolvedSkills> {
  const picked = (names ?? []).map((n) => n.trim()).filter(Boolean);
  if (picked.length === 0) {
    return { ok: true, skills: [] };
  }
  const all = await listSkills(c.project, readConfig().skillModes);
  const usable = listGenerateSkills(all);

  const skills: SkillText[] = [];
  for (const name of picked) {
    if (!usable.some((s) => s.name === name)) {
      return { ok: false, error: `「${name}」现在不能交给创作模型了（可能刚被禁用或删掉）。刷新一下这一页。` };
    }
    const got = await readSkill(c.project, usable, name);
    if (!got.ok) {
      return { ok: false, error: got.error };
    }
    skills.push({ name: got.ref.name, text: got.text, source: skillRelPath(got.ref) });
  }
  return { ok: true, skills };
}
