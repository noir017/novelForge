/**
 * 生成链：一件产物要分几次调用才拼得出来时，把那几次串起来。
 *
 * 三条链移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator），设定清单照角色图谱的路子补了一条：
 *
 * | 产物 | 链 | 上游出处 |
 * |---|---|---|
 * | 小说配置 | 写 → 转写；截断就整份重来 1 次；「全局要求」不合格只重写这一节 1 次；转写不成按小节读 | `GenerateConfigCommand`（AC:980-1163） |
 * | 角色图谱 | 身份清单（写 → 转写）→ 按冻结清单每批 3 人补详情（写 → 转写）；截断拆半 | `GenerateCharactersCommand`（AC:1254-1647） |
 * | 设定清单 | 分类目录树 + 清单 → 按冻结清单每批 6 条补正文，都是写 → 转写；截断拆半；调用次数封顶 | 本项目（设定名录） |
 * | 展开一条设定 / 落定设定 | 写 → 转写（重转一次）；截断、转写不成都不给写入 | 本项目（完善设定） |
 * | 细纲批次 | 写（自然语言）→ 转写成 JSON；截断或转写不出来：多章对半拆、单章紧凑重建；全程重转一次；漏章 fail-closed | `structured-batch-executor.ts` |
 * | 单章细纲 | 写（自然语言）→ 转写成 JSON；重转一次；还不行按小节读原文 | 本项目（细纲试点） |
 *
 * ## 单步与批量共用
 *
 * 对话页（generation/generate.ts）第一次调用是流式的，后面几次照样流进同一个气泡；
 * 工程页的批量（features/pipelineBatch.ts）走分档池。两边只在 {@link ChainIO} 上不同，
 * 链本身一份——批量写出来的细纲与对话页的是同一个质量、同一套降级。
 *
 * ## 不静默（第 2 条）
 *
 * 每一次降级都记进 `notes`：落盘卡片上列出来、日志里留一份。**链不写磁盘**——
 * 交出去的是规范化结果（将要落盘的样子），落不落盘仍由作者在卡片上决定（第 19 条），
 * 批量那条路由调用方决定（只补空白）。
 *
 * ## 比上游宽松的地方
 *
 * 配置与角色图谱是一次一份、摊在卡片上的产物：缺字段、人数不对、某人详情没出来都照收
 * 并说明，只有「一点能用的都没有」才报错。细纲批次保持上游的严格——那条路上没有人
 * 逐份过目，漏一章就会让流水线从此撒谎。
 */
import type { ChatMessage, StopSignal } from '../llm/provider';
import { CancelledError } from '../llm/provider';
import { describeError } from '../runtime/logger';
import type { BuildRequest, DraftPlotLine } from '../context/types';
import {
  RESTART_AFTER_INVALID,
  RESTART_AFTER_TRUNCATION,
  blueprintTranscribeMessages,
  configJsonContract,
  guidanceRetryMessages,
  loreDetailJsonContract,
  loreListJsonContract,
  rosterDetailJsonContract,
  rosterManifestJsonContract,
} from '../context/prompts';
import { loreExpandJsonContract } from '../context/loreExpandPrompt';
import { loreSettleJsonContract } from '../context/loreSettlePrompt';
import { LORE_LIST_CALLS_MAX, LORE_LIST_DETAIL_BATCH, PLOT_BATCH, ROSTER_DETAIL_BATCH, SettingDoc, isLoreSettle } from '../model/pipeline';
import { BookConfig } from '../model/settingFile';
import { hasContent } from '../model/markdown';
import { outlineRangeHeadings, parseOutline } from '../model/outlineFile';
import { BlueprintItem, blueprintToPlot, checkCoverage, decodeBlueprints, renderBlueprints } from '../features/blueprint';
import { parsePlotStrict } from '../features/artifact';
import {
  CharacterDetail,
  DetailsDecode,
  IdentitySlot,
  ManifestDecode,
  assembleRoster,
  decodeDetails,
  decodeManifest,
  renderRoster,
} from '../features/roster';
import {
  LoreDetail,
  LoreDetailsDecode,
  LoreListKnown,
  LoreListSlot,
  LoreManifestDecode,
  assembleLoreList,
  decodeLoreDetails,
  decodeLoreManifest,
  renderLoreList,
} from '../features/loreList';
import {
  ConfigDecode,
  decodeNovelConfig,
  guidanceProblem,
  isGuidanceValid,
  mergeWithAuthor,
  renderConfigDraft,
} from '../features/novelConfig';
import { LoreExpandDecode, LoreExpandKnown, decodeLoreExpansion, renderLoreExpansion } from '../features/loreExpand';
import { LoreSettleDecode, LoreSettleKnown, decodeLoreSettle, renderLoreSettle, renderNothingSettled } from '../features/loreSettle';
import { jsonValueOf, unfaithfulStrings, withoutNone } from '../features/structuredJson';
import { cnNumber } from '../model/timelineFile';
import { TRANSCRIBE_TEMPERATURE } from '../model/transcribe';
import { TranscribeCall, TranscribeResult, TranscribeSpec, transcribeJson } from '../features/transcribe';

/** 一次调用的结果。`stop` 缺席 = 网关没报收尾原因（有的兼容实现压根不发）。 */
export interface CallOutcome {
  text: string;
  stop?: StopSignal;
}

/** 链要的三样东西：调一次模型、按改过的请求重新装配、第一次调用发出去的那几条消息。 */
export interface ChainIO {
  /** 调一次模型。`label` 写进气泡与日志，说清这一次在补什么。 */
  call(messages: ChatMessage[], label: string, opts?: CallOptions): Promise<CallOutcome>;
  /**
   * 转写一次（2026-10-25 细纲试点）：把写好的原文照抄成 JSON 的那个模型——「转写」那一档（model/tiers.ts），不跟
   * 对话页选的、也不跟确认框上为这一次挑的模型。不流进气泡，只加一行「——label——」：JSON 在链结束时整份换上去。
   * 没实现的（测试里的假 IO）退回 `call`。
   */
  transcribe?(messages: ChatMessage[], label: string): Promise<CallOutcome>;
  /** 按改过的请求重新装配：同一个装配器、同一份预算，只换这几个字段。 */
  build(patch: Partial<BuildRequest>): Promise<ChatMessage[]>;
  /** 第一次调用的消息。字段级重写要借它的系统提示。 */
  messages: ChatMessage[];
  /**
   * 把气泡退回到这一份（正文续写丢弃一轮时）。流进气泡的那一轮已经收不回来了，
   * 不退回去的话作者看着的是一段不会被写入的文字。没有气泡的那条路（批量）不实现。
   */
  reset?(text: string): void;
}

/** 一次调用的附带要求。只有正文续写用得上。 */
export interface CallOptions {
  /**
   * 这一次的输出与气泡里前面那段之间放什么。缺省是一行「——label——」：结构化产物的
   * 几次调用各是各的。正文续写放一个空行——读起来得是同一章。
   */
  separator?: string;
  /** 流式期间报进度：第几轮、这一次开始之前已经写到多少字。 */
  progress?: { round: number; base: number };
  /**
   * 不流进气泡：只在气泡里加一行「——label——」，输出不显示（删修饰交回的是带编号的段落，
   * 流出来作者会以为正文写坏了）。调用方用完要 `reset` 把气泡退回去。
   */
  quiet?: boolean;
  /** 这一次的温度，缺席用设置里的。 */
  temperature?: number;
}

export interface ChainResult {
  /** 规范化结果：交给气泡、也是采纳时重新解析的那一份。 */
  raw: string;
  /** 这一路上的降级与说明（第 2 条）。 */
  notes: string[];
  /** 一共调了几次模型（含第一次）。 */
  calls: number;
}

/** 链走不下去了。`notes` 与 `calls` 照样带着——卡片没了，日志里得说清花了几次、卡在哪。 */
export class ChainError extends Error {
  constructor(message: string, readonly notes: string[], readonly calls: number) {
    super(message);
    this.name = 'ChainError';
  }
}

/** 一条链上的账：说明与调用次数。 */
export class Tally {
  notes: string[] = [];
  calls: number;
  constructor(first: boolean) {
    this.calls = first ? 1 : 0;
  }
  note(...lines: string[]): void {
    this.notes.push(...lines.filter(Boolean));
  }
  fail(message: string): never {
    throw new ChainError(message, this.notes, this.calls);
  }
  async call(io: ChainIO, messages: ChatMessage[], label: string, opts?: CallOptions): Promise<CallOutcome> {
    this.calls++;
    return io.call(messages, label, opts);
  }
  /** 转写一次（{@link ChainIO.transcribe}）。也算一次调用（第 4 条）。 */
  async transcribe(io: ChainIO, messages: ChatMessage[], label: string): Promise<CallOutcome> {
    this.calls++;
    return chainTranscriber(io)(messages, label);
  }
  /**
   * 照 features/transcribe.ts 的 `transcribeJson` 走一遍（链上的转写都走它，除了细纲批次自己那一套）：调用记在这本账上，
   * 不合格、重转的说明也记上。
   */
  async transcribeJson<T>(io: ChainIO, source: string, spec: TranscribeSpec<T>): Promise<TranscribeResult<T>> {
    const r = await transcribeJson(source, spec, chainTranscriber(io));
    this.calls += r.calls;
    this.note(...r.notes);
    return r;
  }
}

/** 链上的转写调用：`io.transcribe`，没实现的（测试里的假 IO）退回 `io.call`，不流进气泡、温度 0。 */
export function chainTranscriber(io: ChainIO): TranscribeCall {
  return (messages, label) =>
    io.transcribe ? io.transcribe(messages, label) : io.call(messages, label, { quiet: true, temperature: TRANSCRIBE_TEMPERATURE });
}

export { TRANSCRIBE_TEMPERATURE };

function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
}

// ---------------------------------------------------------------- 转写（架构那几件、展开、落定设定）

/** 一步的解码结果（成功那一支）。 */
type Decoded<D> = Extract<D, { ok: true }>;

/**
 * 把这一步原来的解码包成转写要的样子（features/transcribe.ts 的 `TranscribeSpec.decode`）：成功交回整份解码结果（带
 * warnings、missing），失败交回那一句人话。
 */
function decoder<D extends { ok: boolean }>(
  decode: (json: string) => D,
  reason: (d: Exclude<D, { ok: true }>) => string
): (json: string) => { ok: true; value: Decoded<D> } | { ok: false; message: string } {
  return (json) => {
    const d = decode(json);
    return d.ok ? { ok: true, value: d as Decoded<D> } : { ok: false, message: reason(d as Exclude<D, { ok: true }>) };
  };
}

/** 设定的正文三节：展开、落定、设定清单的详情都认它。 */
const LORE_BODY_LOOK = /概要|规则与边界|现状/;

/**
 * 小说配置（2026-10-25 起改成转写）：故事结构、叙事视角是中文词对到英文枚举，规模是数字，不比原文。原文连「核心梗概」
 * 「金手指」这类小标题都没有就不转（多半是一段闲话）。
 */
function configSpec(): TranscribeSpec<Decoded<ConfigDecode>> {
  return {
    label: '小说配置',
    contract: configJsonContract(),
    decode: decoder(decodeNovelConfig, (d) => d.reason),
    mapped: ['plotStructure', 'narrativePOV', 'totalChapters', 'wordsPerChapter'],
    looksLike: (source) => /核心梗概|金手指|主角档案|全局要求/.test(source),
  };
}

/** 定位的中文词 → 身份清单的英文值（`decodeManifest` 只认英文值，认不出按配角算——主角被降成配角比多一次转写糟）。 */
const ROLE_CODE: Record<string, string> = { 主角: 'protagonist', 反派: 'antagonist', 配角: 'supporting', 次要: 'minor' };

/** 转写模型偶尔把定位照抄成中文：对回英文值再交给解码。其余一个字不动。 */
function withRoleCodes(json: string): string {
  const value = jsonValueOf(json) as { slots?: unknown } | undefined;
  if (!value || typeof value !== 'object' || !Array.isArray(value.slots)) {
    return json;
  }
  const slots = value.slots.map((row: unknown) => {
    const o = row && typeof row === 'object' ? (row as Record<string, unknown>) : undefined;
    const code = typeof o?.role === 'string' ? ROLE_CODE[o.role.trim()] : undefined;
    return code ? { ...o, role: code } : row;
  });
  return JSON.stringify({ ...value, slots });
}

/** 身份清单：编号（slotId）就是名字，关系指向对方的名字（context/prompts.ts 的 `rosterManifestJsonContract`），按对应关系填。 */
function manifestSpec(): TranscribeSpec<Decoded<ManifestDecode>> {
  return {
    label: '身份清单',
    contract: rosterManifestJsonContract(),
    decode: decoder((json: string) => decodeManifest(withRoleCodes(json)), (d) => d.message),
    mapped: ['slotId', 'targetSlotId', 'role', 'gender'],
    looksLike: (source) => /定位|叙事职责/.test(source),
  };
}

/** 冻结的身份清单给补详情那一步看的样子：一人一行（名字、定位、性别、叙事职责），关系缩进在下面。 */
function frozenRoster(slots: readonly IdentitySlot[]): string {
  return slots
    .flatMap((s) => [
      `- ${s.name}（${[s.role, s.gender].filter(Boolean).join('，')}）${s.duty ? `：${s.duty}` : ''}`,
      ...s.relations.map((r) => `  - 与${r.target}：${r.relation}`),
    ])
    .join('\n');
}

/** 冻结的设定清单给补正文那一步看的样子：先一行分类，再一条一行（名字、分类、一句话）。 */
function frozenLoreList(categories: readonly string[], slots: readonly LoreListSlot[]): string {
  return [
    ...(categories.length > 0 ? [`分类：${categories.join('、')}`] : []),
    ...slots.map((s) => `- ${s.title}（${s.category || '未分类'}）${s.brief ? `：${s.brief}` : ''}`),
  ].join('\n');
}

// ---------------------------------------------------------------- 小说配置

export interface ConfigChainContext {
  /** 磁盘上那份 `config.md`。 */
  existing: BookConfig;
  /** 作者这一次给的那句话；给了就写进「一句话」一节。 */
  idea?: string;
  /** 一句话弹窗带过来的规模；给了就以它为准，并开「保留原文，追加生成」。 */
  setup?: { totalChapters: number; wordsPerChapter: number };
}

/** 上游合同字段 → 卡片上的说法。 */
const CONFIG_FIELD_LABEL: Record<string, string> = {
  genre: '类型',
  targetAudience: '受众',
  subGenre: '细分类型',
  coreOutline: '核心梗概',
  sellingPoints: '核心卖点',
  worldSetting: '世界观要点',
  goldenFinger: '金手指',
  protagonistProfile: '主角档案',
  globalGuidance: '全局要求',
  writingStyle: '文风',
};

/**
 * 小说配置：写（按小标题，2026-10-25 起）→ 截断整份重来 1 次 → 转写成 JSON（重转一次）→ 「全局要求」不合格只重写这一节
 * 1 次 → 与磁盘那份合并 → `config.md` 全文（外加一节文风）。
 *
 * 转写不成（转写调用失败、两次都不合格、原文连小标题都没有）不报错，原样交回去：解析那一层按小节读（「核心梗概」
 * 「金手指」……那八节与 `config.md` 同名），卡片上照样看得见——这件产物作者当场过目，宽松比作废划算（同从前模型没按
 * JSON 答时）。模型自己给了 JSON 就不转。
 */
export async function completeConfig(first: CallOutcome, io: ChainIO, ctx: ConfigChainContext): Promise<ChainResult> {
  // 显式标注类型：`t.fail()` 返回 never，TS 只对显式标注的变量做控制流收窄。
  const t: Tally = new Tally(true);
  let out = first;
  if (out.stop === 'maxTokens') {
    t.note('小说配置被输出上限截断，截断的那一半不可信，已丢弃并整份重来一次');
    out = await t.call(io, await io.build({ extraInstruction: RESTART_AFTER_TRUNCATION }), '配置被截断，整份重来');
    if (out.stop === 'maxTokens') {
      t.fail('小说配置重来一次仍被输出上限截断。调大设置页的「最大输出 token」，或降低思考深度再试。');
    }
  }

  const tr = await t.transcribeJson(io, out.text, configSpec());
  if (!tr.ok) {
    t.note(`小说配置没能整理成 JSON（${tr.message}），按小节读了原文：类型、受众、故事结构、叙事视角与文风读不出来，写入后可以手补`);
    return { raw: out.text, notes: t.notes, calls: t.calls };
  }
  const decoded = tr.value;
  const value = decoded.value;
  if (decoded.missing.length > 0) {
    t.note(`模型漏了：${decoded.missing.map((k) => CONFIG_FIELD_LABEL[k] ?? k).join('、')}`);
  }
  t.note(...decoded.warnings);

  const guidance = value.sections.全局要求;
  const problem = guidance ? guidanceProblem(guidance) : undefined;
  if (guidance && problem) {
    t.note(`${problem}，只重写这一节一次`);
    const others = JSON.stringify(
      {
        genre: value.genre,
        subGenre: value.subGenre,
        targetAudience: value.audience,
        coreOutline: value.sections.核心梗概,
        worldSetting: value.sections.世界观要点,
        goldenFinger: value.sections.金手指,
        protagonistProfile: value.sections.主角档案,
      },
      null,
      2
    );
    const fix = await t.call(io, guidanceRetryMessages(io.messages[0]?.content ?? '', others), '全局要求不合格，只重写这一节');
    const text = fix.text.trim();
    if (fix.stop !== 'maxTokens' && isGuidanceValid(text)) {
      value.sections.全局要求 = text;
    } else {
      t.note(`重写后的全局要求仍不合格（${fix.stop === 'maxTokens' ? '被截断' : guidanceProblem(text)}），保留原来那一版，写入后可以手改`);
    }
  }

  const authorWrote = Object.values(ctx.existing.sections).some((v) => hasContent(v));
  const merged = mergeWithAuthor(ctx.existing, value, {
    idea: ctx.idea,
    setup: ctx.setup,
    preserve: !!ctx.setup && authorWrote,
  });
  if (ctx.setup && authorWrote) {
    t.note('小说配置里已经有作者写的内容：保留原文，生成的追加在后');
  }
  return { raw: renderConfigDraft(merged, value.writingStyle), notes: t.notes, calls: t.calls };
}

// ---------------------------------------------------------------- 角色图谱

/**
 * 角色图谱：身份清单（截断重来 1 次）→ 按冻结清单每批 3 人补详情 → 拼卡。2026-10-25 起每一次都是按小标题写、
 * 转写模型照抄成 JSON（features/transcribe.ts）。
 *
 * 清单不合格（转写不成也算）就停：后面每一批都以它为准，一张坏清单补出来的详情只会错得更整齐。
 * 详情那一步反过来宽松——某人的详情实在出不来，照样按清单建卡并说明：截断或转写不合格对半拆，单人还不行、
 * 或转写调用本身失败，只按清单建卡。详情的转写**全程只重转一次**（同从前的语法修复只修一次）。
 */
export async function completeRoster(first: CallOutcome, io: ChainIO): Promise<ChainResult> {
  // 显式标注类型：`t.fail()` 返回 never，TS 只对显式标注的变量做控制流收窄。
  const t: Tally = new Tally(true);
  let out = first;
  if (out.stop === 'maxTokens') {
    t.note('身份清单被输出上限截断，已丢弃并重来一次');
    out = await t.call(io, await io.build({ extraInstruction: RESTART_AFTER_TRUNCATION }), '身份清单被截断，重来');
    if (out.stop === 'maxTokens') {
      t.fail('角色身份清单重来一次仍被输出上限截断。调大设置页的「最大输出 token」，或降低思考深度再试。');
    }
  }
  const manifest = await t.transcribeJson(io, out.text, manifestSpec());
  if (!manifest.ok) {
    t.fail(`角色身份清单不合格：${manifest.message}。这一次没有产出可写入的角色图谱。`);
  }
  t.note(...manifest.value.warnings);
  const slots = manifest.value.slots;
  const frozen = frozenRoster(slots);

  const details: CharacterDetail[] = [];
  let retranscribed = false;
  const runBatch = async (batch: IdentitySlot[]): Promise<void> => {
    const names = batch.map((s) => s.name).join('、');
    const done = details.map((d) => slots.find((s) => s.slotId === d.slotId)?.name ?? '').filter(Boolean).join('、');
    const messages = await io.build({
      step: { kind: 'rosterDetails', manifest: frozen, names: batch.map((s) => s.name), done },
    });
    const res = await t.call(io, messages, `角色详情（${names}）`);
    const split = async (why: string) => {
      t.note(`${names}的详情${why}，拆成两半重试`);
      const mid = Math.floor(batch.length / 2);
      await runBatch(batch.slice(0, mid));
      await runBatch(batch.slice(mid));
    };
    if (res.stop === 'maxTokens') {
      if (batch.length > 1) {
        return split('被输出上限截断');
      }
      t.note(`「${names}」的详情被输出上限截断，只按身份清单建卡`);
      return;
    }
    const tr = await t.transcribeJson(io, res.text, {
      label: `${names}的详情`,
      contract: rosterDetailJsonContract(),
      decode: decoder((json: string): DetailsDecode => decodeDetails(json, batch), (d) => d.message),
      mapped: ['slotId', 'role'],
      looksLike: (source) => /身份|外貌|性格|当前状态/.test(source),
      retries: retranscribed ? 0 : 1,
    });
    retranscribed ||= tr.calls > 1;
    if (!tr.ok) {
      // 转写调用本身失败（转写那一档没人可用）：拆半再写也一样转不了。
      if (batch.length > 1 && !tr.failed) {
        return split(`解不出来（${tr.message}）`);
      }
      t.note(`「${names}」的详情解不出来（${tr.message}），只按身份清单建卡`);
      return;
    }
    t.note(...tr.value.warnings);
    details.push(...tr.value.items);
  };

  for (let i = 0; i < slots.length; i += ROSTER_DETAIL_BATCH) {
    await runBatch(slots.slice(i, i + ROSTER_DETAIL_BATCH));
  }
  const { entries, warnings } = assembleRoster(slots, details);
  t.note(...warnings);
  return { raw: renderRoster(entries), notes: t.notes, calls: t.calls };
}

// ---------------------------------------------------------------- 设定清单

/**
 * 设定清单（设定名录）：清单（截断或整理不出来重来 1 次）→ 按冻结清单每批 6 条补正文 → 拼条目。2026-10-25 起每一次
 * 都是按小标题写、转写模型照抄成 JSON。路子同 {@link completeRoster}：
 *
 * - 清单不合格就停：分类与名字只在清单里定一次，后面每一批都以它为准。转写调用本身失败不重写（写得没毛病）。
 * - 详情截断或转写不合格对半拆；单条还是不行、或转写调用失败，就只按清单建（一句话），并说明。详情的转写全程只重转
 *   一次（同从前的语法修复只修一次）。
 * - **调用次数封顶 {@link LORE_LIST_CALLS_MAX}**（主按钮报的上限，第 4 条），转写的调用也算：一批写一次、转写一次，
 *   剩的余量不够这两次就不再写，剩下的条目只按清单建；余量不够就不重转。三十条逐批拆到底是几十次调用，报给作者的数
 *   不能是摆设。
 */
export async function completeLoreList(first: CallOutcome, io: ChainIO, known: LoreListKnown): Promise<ChainResult> {
  // 显式标注类型：`t.fail()` 返回 never，TS 只对显式标注的变量做控制流收窄。
  const t: Tally = new Tally(true);
  let out = first;
  let retried = false;
  if (out.stop === 'maxTokens') {
    t.note('设定清单被输出上限截断，已丢弃并重来一次');
    out = await t.call(io, await io.build({ extraInstruction: RESTART_AFTER_TRUNCATION }), '设定清单被截断，重来');
    retried = true;
  }
  const spec: TranscribeSpec<Decoded<LoreManifestDecode>> = {
    label: '设定清单',
    contract: loreListJsonContract(),
    decode: decoder((json: string) => decodeLoreManifest(json, known), (d) => d.message),
    looksLike: (source) => /分类|清单/.test(source),
  };
  const truncated = (o: CallOutcome) =>
    o.stop === 'maxTokens'
      ? t.fail('设定清单重来一次仍被输出上限截断。调大设置页的「最大输出 token」，或降低思考深度再试。')
      : undefined;
  truncated(out);
  let manifest = await t.transcribeJson(io, out.text, spec);
  if (!manifest.ok && !manifest.failed && !retried) {
    t.note(`设定清单不合格（${manifest.message}），重来一次`);
    out = await t.call(io, await io.build({ extraInstruction: RESTART_AFTER_INVALID }), '设定清单不合格，重来');
    truncated(out);
    manifest = await t.transcribeJson(io, out.text, spec);
  }
  if (!manifest.ok) {
    t.fail(`设定清单不合格：${manifest.message}。这一次没有产出可写入的设定清单。`);
  }
  t.note(...manifest.value.warnings);
  const { categories, slots } = manifest.value;
  const frozen = frozenLoreList(categories, slots);

  const details: LoreDetail[] = [];
  let retranscribed = false;
  const runBatch = async (batch: LoreListSlot[]): Promise<void> => {
    const names = batch.map((s) => s.title).join('、');
    // 写一次、转写一次：余量不够这两次就不写了（写了转不了也是白写）。
    if (t.calls + 2 > LORE_LIST_CALLS_MAX) {
      t.note(`已经调了 ${t.calls} 次模型（上限 ${LORE_LIST_CALLS_MAX}），「${names}」只按清单建条目`);
      return;
    }
    const done = details.length
      ? details.map((d) => `- ${d.title}：${slots.find((s) => s.title === d.title)?.brief ?? ''}`).join('\n')
      : '';
    const messages = await io.build({
      step: { kind: 'loreListDetails', manifest: frozen, titles: batch.map((s) => s.title), done },
    });
    const res = await t.call(io, messages, `设定详情（${names}）`);
    const split = async (why: string) => {
      t.note(`${names}的正文${why}，拆成两半重试`);
      const mid = Math.floor(batch.length / 2);
      await runBatch(batch.slice(0, mid));
      await runBatch(batch.slice(mid));
    };
    if (res.stop === 'maxTokens') {
      if (batch.length > 1) {
        return split('被输出上限截断');
      }
      t.note(`「${names}」的正文被输出上限截断，只按清单建条目`);
      return;
    }
    const tr = await t.transcribeJson(io, res.text, {
      label: `${names}的正文`,
      contract: loreDetailJsonContract(),
      decode: decoder((json: string): LoreDetailsDecode => decodeLoreDetails(json, batch), (d) => d.message),
      looksLike: (source) => LORE_BODY_LOOK.test(source),
      // 重转那一次也要在上限以内（这一次写完之后还剩几次）。
      retries: !retranscribed && t.calls + 2 <= LORE_LIST_CALLS_MAX ? 1 : 0,
    });
    retranscribed ||= tr.calls > 1;
    if (!tr.ok) {
      if (batch.length > 1 && !tr.failed) {
        return split(`解不出来（${tr.message}）`);
      }
      t.note(`「${names}」的正文解不出来（${tr.message}），只按清单建条目`);
      return;
    }
    t.note(...tr.value.warnings);
    details.push(...tr.value.items);
  };

  for (let i = 0; i < slots.length; i += LORE_LIST_DETAIL_BATCH) {
    await runBatch(slots.slice(i, i + LORE_LIST_DETAIL_BATCH));
  }
  const { entries, warnings } = assembleLoreList(slots, details);
  t.note(...warnings);
  return { raw: renderLoreList(categories, entries), notes: t.notes, calls: t.calls };
}

// ---------------------------------------------------------------- 展开一条设定

/**
 * 展开一条设定（完善设定，2026-10-19）：写 1 次（2026-10-25 起按小标题写），转写模型照抄成 JSON 1 次，不合格重转
 * 1 次——上限 3 次，与报给作者的 `LORE_EXPAND_CALLS` 同一个数（第 4 条）。模型自己给了 JSON 就不转。
 *
 * **截断与转写不成都不给写入**：截断的那一半不可信，没整理开的原文盖掉条目比没写更糟（同定稿）——链停下，
 * 已经收到的输出留在气泡里，没有落盘卡片。解出来的照程序的规矩过一遍（features/loreExpand.ts：截长、关键词与
 * 子条目对照磁盘上的条目与角色卡），交给气泡的是规范化结果，丢掉了什么写进说明（第 2 条）。
 *
 * `opts.retranscribe: false`：转写不合格不重转（批量展开第二次重来时，上限只剩那么多——features/lore.ts 的
 * `expandLoreEntries`，`LORE_EXPAND_BATCH_CALLS`）。
 */
export async function completeLoreExpand(
  first: CallOutcome,
  io: ChainIO,
  known: LoreExpandKnown,
  opts: { retranscribe?: boolean } = {}
): Promise<ChainResult> {
  // 显式标注类型：`t.fail()` 返回 never，TS 只对显式标注的变量做控制流收窄。
  const t: Tally = new Tally(true);
  if (first.stop === 'maxTokens') {
    t.fail('展开被输出上限截断，截断的那一半不可信，这一次没有产出可写入的设定。调大设置页的「最大输出 token」，或降低思考深度再试。');
  }
  const tr = await t.transcribeJson(io, first.text, {
    label: '设定展开',
    contract: loreExpandJsonContract(),
    decode: decoder((json: string): LoreExpandDecode => decodeLoreExpansion(json, known), (d) => d.message),
    looksLike: (source) => LORE_BODY_LOOK.test(source),
    retries: opts.retranscribe === false ? 0 : 1,
  });
  if (!tr.ok) {
    t.fail(`展开解析不出来（${tr.message}），这一次没有产出可写入的设定。`);
  }
  t.note(...tr.value.warnings);
  return { raw: renderLoreExpansion(tr.value.value), notes: t.notes, calls: t.calls };
}

// ---------------------------------------------------------------- 落定设定

/**
 * 落定设定（完善设定二期）：写 1 次（2026-10-25 起按小标题写），转写 1 次、不合格重转 1 次——上限 3 次，与报给作者的
 * `LORE_SETTLE_CALLS` 同一个数（第 4 条）。截断与转写不成都不给写入（同展开）。解出来的照程序的规矩过一遍
 * （features/loreSettle.ts：截长、人名、重名、按磁盘认出改的是哪一条已有条目），交给气泡的是规范化结果，丢掉了什么
 * 写进说明（第 2 条）。
 *
 * 讨论里一条都没定下来（`entries` 是空的）不算失败：气泡里换成一段人话，说清没写什么、列出还没定的——没有落盘卡片，
 * 作者接着聊。
 */
export async function completeLoreSettle(first: CallOutcome, io: ChainIO, known: LoreSettleKnown): Promise<ChainResult> {
  // 显式标注类型：`t.fail()` 返回 never，TS 只对显式标注的变量做控制流收窄。
  const t: Tally = new Tally(true);
  if (first.stop === 'maxTokens') {
    t.fail('落定设定被输出上限截断，截断的那一半不可信，这一次没有产出可写入的设定。调大设置页的「最大输出 token」，或降低思考深度再试。');
  }
  const tr = await t.transcribeJson(io, first.text, {
    label: '落定设定',
    contract: loreSettleJsonContract(),
    decode: decoder((json: string): LoreSettleDecode => decodeLoreSettle(json, known), (d) => d.message),
    looksLike: (source) => LORE_BODY_LOOK.test(source) || /还没定的问题/.test(source),
  });
  if (!tr.ok) {
    t.fail(`落定设定解析不出来（${tr.message}），这一次没有产出可写入的设定。`);
  }
  const { value, warnings } = tr.value;
  t.note(...warnings);
  if (value.entries.length === 0) {
    return { raw: renderNothingSettled(value.questions), notes: t.notes, calls: t.calls };
  }
  return { raw: renderLoreSettle(value), notes: t.notes, calls: t.calls };
}

// ---------------------------------------------------------------- 细纲批次

export interface BlueprintChainResult extends ChainResult {
  items: BlueprintItem[];
}

/** 刚排好的一章在前序细纲一览里的样子：关键事件、看点都照落盘后那两节的样子（一条一行）。 */
function draftLine(b: BlueprintItem): DraftPlotLine {
  const { sections } = blueprintToPlot(b);
  return { no: b.no, title: b.title, keyEvents: sections.关键事件, highlights: sections.看点 };
}

/**
 * 细纲批次：`chapters` 按 {@link PLOT_BATCH} 一批，每批走上游 SBE 的降级链，中间多一步转写（2026-10-25 细纲试点）。
 *
 * `first` 是对话页已经流式跑完的第一批（它的范围必须正好是 `chapters` 的前 5 章）；
 * 批量那条路不给，第一批也由链自己调。
 *
 * - 写细纲的模型按小标题写自然语言（context/prompts.ts 的 `blueprintFormat`），转写模型照抄成 JSON
 *   （{@link transcribeBlueprints}）。模型自己给了合格的 JSON 就不转。
 * - 截断：多章对半拆；单章紧凑重建（每章至多一次）。
 * - 转写不合格：全程只重转一次；还不合格，多章对半拆、单章紧凑重建（同截断）。
 * - 重复章、越界章：报错。
 * - **漏章**：原文里压根没写这一章（连「第 N 章」都没有）——模型偷懒，报错、整批不写，对偷懒的输出不无限重试
 *   （上游同一条规矩）；原文写了、转写漏了，算转写不合格。
 */
export async function completeBlueprints(
  first: CallOutcome | undefined,
  io: ChainIO,
  chapters: readonly number[]
): Promise<BlueprintChainResult> {
  // 显式标注类型：`t.fail()` 返回 never，TS 只对显式标注的变量做控制流收窄。
  const t: Tally = new Tally(!!first);
  const validated: BlueprintItem[] = [];
  const compacted = new Set<number>();
  const retry = { used: false };

  const exec = async (items: number[], compact?: { diagnostic?: string }, preset?: CallOutcome): Promise<void> => {
    const from = items[0];
    const to = items[items.length - 1];
    const where = span(from, to);
    const single = items.length === 1;
    let out: CallOutcome;
    if (preset) {
      out = preset;
    } else {
      const messages = await io.build({
        range: { from, to },
        targetNo: from,
        step: compact ? { kind: 'blueprintCompact', diagnostic: compact.diagnostic } : undefined,
        draftPlots: validated.map(draftLine),
      });
      out = await t.call(io, messages, compact ? `${where}单章重建` : `${where}的细纲`);
    }

    const canCompact = single && !compacted.has(from);
    const rebuild = async (why: string, diagnostic?: string) => {
      compacted.add(from);
      t.note(`${where}${why}，按紧凑合同单章重建一次`);
      await exec(items, { diagnostic: diagnostic ?? why });
    };
    const split = async (why: string) => {
      t.note(`${where}${why}，拆成两半重试`);
      const mid = Math.floor(items.length / 2);
      await exec(items.slice(0, mid));
      await exec(items.slice(mid));
    };

    if (out.stop === 'maxTokens') {
      if (!single) {
        return split('被输出上限截断');
      }
      if (canCompact) {
        return rebuild('被输出上限截断');
      }
      t.fail(`${where}的细纲单章重建仍被输出上限截断。调大设置页的「最大输出 token」，或降低思考深度再试。`);
    }

    const v = await transcribeBlueprints(t, io, out.text, items, retry);
    if (!v.ok) {
      if (v.kind === 'absent') {
        t.fail(`模型漏写了第 ${v.chapters.join('、')} 章。漏章时不猜也不补，这一批没有写入任何细纲。`);
      }
      if (v.kind === 'duplicate') {
        t.fail(`输出里第 ${v.chapters.join('、')} 章出现了不止一次，说不清哪一份算数。这一批没有写入任何细纲。`);
      }
      if (v.kind === 'unexpected') {
        t.fail(`输出里多出了这一批以外的第 ${v.chapters.join('、')} 章。这一批没有写入任何细纲。`);
      }
      if (!single) {
        return split(`解不出来（${v.message}）`);
      }
      if (canCompact) {
        return rebuild(`解不出来（${v.message}）`, v.diagnostic);
      }
      t.fail(`${where}的细纲不合格：${v.message}。这一批没有写入任何细纲。`);
    }
    t.note(...v.warnings);
    validated.push(...items.map((no) => v.items.find((b) => b.no === no)!));
  };

  for (let i = 0; i < chapters.length; i += PLOT_BATCH) {
    const batch = chapters.slice(i, i + PLOT_BATCH);
    await exec([...batch], undefined, i === 0 ? first : undefined);
  }
  return { raw: renderBlueprints(validated), notes: t.notes, calls: t.calls, items: validated };
}

// ---------------------------------------------------------------- 细纲的转写

/**
 * 转写时不比原文的键：按对应关系填的（章号、推进/埋、主角/反派、男/女、新不新、第几章前收），以及分类——
 * 原文没写分类时转写模型照名字补一个，是归类不是改写。其余每一段文字都得出自原文。
 */
const TRANSCRIBE_MAPPED: ReadonlySet<string> = new Set(['chapterNumber', 'type', 'role', 'gender', 'isNew', 'resolve', 'category']);

/** 合同字段 → 原文里的小标题。紧凑重建时告诉写细纲的模型缺的是哪一节（它写的是小标题，不认 JSON 路径）。 */
const FIELD_SECTION: Record<string, string> = {
  title: '标题',
  synopsis: '梗概',
  characters: '出场人物',
  keyEvents: '关键事件',
};

type BlueprintVerdict =
  | { ok: true; items: BlueprintItem[]; warnings: string[] }
  | {
      ok: false;
      /** absent：原文就没写这几章；duplicate / unexpected：同号不止一份、多出了这一批以外的；其余是转写不合格。 */
      kind: 'absent' | 'duplicate' | 'unexpected' | 'invalid';
      message: string;
      chapters: number[];
      /** 紧凑重建时给写细纲的模型的那一句。 */
      diagnostic?: string;
    };

/** 原文里有没有提到第 N 章（「第 3 章」「第三章」都算）。 */
function mentionsChapter(source: string, no: number): boolean {
  return new RegExp(`第\\s*(?:${no}|${cnNumber(no)})\\s*章`).test(source);
}

/** 原文里有没有细纲的样子：小标题（梗概、关键事件），或者是一段坏了语法的 JSON（转写顺带把它理顺）。 */
function looksLikePlot(source: string): boolean {
  return /梗概|关键事件|synopsis|keyEvents/.test(source);
}

const NOT_A_PLOT = '没有按格式写（认不出「梗概」「关键事件」这些小标题）';

/**
 * 一份 JSON（转写的输出，或模型自己给的）按这一批的合同判：解得开、章对得上、每段文字出自原文。模型自己给的 JSON
 * （`text` 就是原文）不比原文——拿自己比自己。
 */
function judgeBlueprints(text: string, source: string, items: readonly number[]): BlueprintVerdict {
  const value = jsonValueOf(text);
  const decoded = decodeBlueprints(value === undefined ? text : JSON.stringify(withoutNone(value)));
  if (!decoded.ok) {
    const d = decoded.diagnostic;
    const section = FIELD_SECTION[d.path.split('.').pop() ?? ''];
    return {
      ok: false,
      kind: 'invalid',
      message: d.message,
      chapters: [],
      ...(section ? { diagnostic: `「${section}」那一节缺了或是空的` } : {}),
    };
  }
  const cov = checkCoverage(decoded.items, items);
  if (cov.duplicate.length > 0) {
    return { ok: false, kind: 'duplicate', message: `第 ${cov.duplicate.join('、')} 章出现了不止一次`, chapters: cov.duplicate };
  }
  if (cov.unexpected.length > 0) {
    return { ok: false, kind: 'unexpected', message: `多出了第 ${cov.unexpected.join('、')} 章`, chapters: cov.unexpected };
  }
  if (cov.missing.length > 0) {
    // 单章时原文不写章号也是这一章（转写合同里给了章号），漏了只能是转写的事。
    const absent = items.length > 1 ? cov.missing.filter((no) => !mentionsChapter(source, no)) : [];
    return absent.length > 0
      ? { ok: false, kind: 'absent', message: `原文没写第 ${absent.join('、')} 章`, chapters: absent }
      : { ok: false, kind: 'invalid', message: `缺第 ${cov.missing.join('、')} 章`, chapters: cov.missing };
  }
  const off = text === source ? [] : unfaithfulStrings(source, value, TRANSCRIBE_MAPPED);
  if (off.length > 0) {
    return { ok: false, kind: 'invalid', message: `这几处不是原文里的字：${off.map((s) => `「${s}」`).join('、')}`, chapters: [] };
  }
  return { ok: true, items: decoded.items, warnings: decoded.warnings };
}

/**
 * 一批细纲的原文 → 解出来的这几章（2026-10-25 细纲试点）。
 *
 * - 原文本身就是合格的 JSON（模型没照格式写、老会话）：不转，直接按合同判。
 * - 原文连细纲的样子都没有（{@link looksLikePlot}）：不转，按解不出来交回去——转写搬不出原文没有的东西。
 * - 否则交给转写模型（{@link ChainIO.transcribe}）。转写不合格——截断、解不开、漏了原文写了的章、改了原文的字——
 *   重转一次，说清上次哪里不对；**全程只重转一次**（`retry`，同从前的语法修复）。原文就没写的章（偷懒）不重转。
 */
async function transcribeBlueprints(
  t: Tally,
  io: ChainIO,
  source: string,
  items: readonly number[],
  retry: { used: boolean }
): Promise<BlueprintVerdict> {
  if (jsonValueOf(source) !== undefined) {
    return judgeBlueprints(source, source, items);
  }
  // 连「梗概」「关键事件」都没有的（「我不太确定这几章写什么」）不是细纲，转写也搬不出东西，不花这一次。
  if (!looksLikePlot(source)) {
    return { ok: false, kind: 'invalid', message: NOT_A_PLOT, chapters: [], diagnostic: NOT_A_PLOT };
  }
  const range = { from: items[0], to: items[items.length - 1] };
  const where = span(range.from, range.to);
  let feedback: string | undefined;
  for (;;) {
    const out = await tryTranscribe(t, io, blueprintTranscribeMessages(source, range, feedback), `${where}转写成 JSON`);
    if ('failed' in out) {
      // ChainError：写好的原文留在气泡里（generation/generate.ts），作者拿得走。
      t.fail(`${where}的转写调用失败（${out.failed}）。这一批没有写入任何细纲。`);
    }
    const v: BlueprintVerdict =
      out.stop === 'maxTokens'
        ? { ok: false, kind: 'invalid', message: '转写被输出上限截断', chapters: [] }
        : judgeBlueprints(out.text, source, items);
    if (v.ok || v.kind === 'absent' || retry.used) {
      return v;
    }
    retry.used = true;
    feedback = v.message;
    t.note(`${where}转写不合格（${v.message}），重转一次`);
  }
}

/**
 * 单章细纲（写第 N 章细纲、落定细纲）：写细纲的模型按小标题写了一章（第一次调用，对话页已经流式跑完），转写模型照抄成
 * JSON（2026-10-25 细纲试点）。气泡最后换成规范化 JSON（`{"blueprints":[…]}`，`features/artifact.ts` 的 `parsePlotStrict` 认它）。
 *
 * 比批次宽松，同从前的单章：这件产物作者当场过目。截断只说一句、照样转；转写不合格重转一次，还不合格就把原文交回去，
 * 解析那一层按小节读（梗概、关键事件……那七节读得出来，叙事线的计划、新角色与「设定」一节读不出来），说明里写清。
 * 模型自己给了 JSON 就不转，原样交回去（同从前）。
 */
export async function completePlot(first: CallOutcome, io: ChainIO, no: number | undefined): Promise<ChainResult> {
  const t: Tally = new Tally(true);
  if (first.stop === 'maxTokens') {
    t.note('输出被输出上限截断，后半段可能缺失。调大设置页的「最大输出 token」再生成一次更稳。');
  }
  const source = first.text.trim();
  if (jsonValueOf(source) !== undefined) {
    return { raw: source, notes: t.notes, calls: t.calls };
  }
  if (!looksLikePlot(source)) {
    t.note(`${NOT_A_PLOT}，没有转写`);
    return { raw: source, notes: t.notes, calls: t.calls };
  }
  const range = no !== undefined ? { from: no, to: no } : undefined;
  let feedback: string | undefined;
  for (let round = 0; round < 2; round++) {
    const out = await tryTranscribe(t, io, blueprintTranscribeMessages(source, range, feedback), '转写成 JSON');
    if ('failed' in out) {
      t.note(`转写调用失败（${out.failed}）`);
      break;
    }
    const problem = plotTranscriptProblem(out, source);
    if (!problem) {
      return { raw: JSON.stringify(withoutNone(jsonValueOf(out.text)), null, 2), notes: t.notes, calls: t.calls };
    }
    feedback = problem;
    t.note(round === 0 ? `转写不合格（${problem}），重转一次` : `重转仍不合格（${problem}）`);
  }
  t.note('转写没成，按小节读了原文：叙事线的计划、新角色与「设定」一节没带上，要它们就重新生成一次');
  return { raw: source, notes: t.notes, calls: t.calls };
}

/**
 * 转写一次。调用本身失败（池里同档换完了人、网关报错）不往外抛，交回原因——写好的原文不能跟着丢：批次报 `ChainError`、
 * 原文留在气泡里，单章按小节读。作者点了停止照旧往外抛。
 */
async function tryTranscribe(t: Tally, io: ChainIO, messages: ChatMessage[], label: string): Promise<CallOutcome | { failed: string }> {
  try {
    return await t.transcribe(io, messages, label);
  } catch (err) {
    if (err instanceof CancelledError) {
      throw err;
    }
    return { failed: describeError(err) };
  }
}

/** 单章的转写哪里不合格；合格返回 undefined。只查解不解得开、有没有内容、文字是不是出自原文——形状宽松，同单章的解析。 */
function plotTranscriptProblem(out: CallOutcome, source: string): string | undefined {
  if (out.stop === 'maxTokens') {
    return '转写被输出上限截断';
  }
  const value = jsonValueOf(out.text);
  if (value === undefined) {
    return '转写出来的不是一个完整的 JSON 对象';
  }
  const off = unfaithfulStrings(source, value, TRANSCRIBE_MAPPED);
  if (off.length > 0) {
    return `这几处不是原文里的字：${off.map((s) => `「${s}」`).join('、')}`;
  }
  return parsePlotStrict(JSON.stringify(withoutNone(value))) ? undefined : '转写出来是空的';
}

// ---------------------------------------------------------------- 单次产物的说明

/**
 * 不走链的产物（前提、世界观、大纲）也要把看得见的问题说出来：
 * 输出被截断、续写的那一段大纲没覆盖到本批的最后一章。
 */
export function singleShotNotes(
  stage: string,
  raw: string,
  stop: StopSignal | undefined,
  range?: { from: number; to: number }
): string[] {
  const notes: string[] = [];
  if (stop === 'maxTokens') {
    notes.push('输出被输出上限截断，后半段可能缺失。调大设置页的「最大输出 token」再生成一次更稳。');
  }
  if (stage === 'outline' && range) {
    const nos = new Set(parseOutline(raw).map((e) => e.no));
    const merged = outlineRangeHeadings(raw);
    if (merged > 0) {
      notes.push(`有 ${merged} 个「## 第a–b章」这样的区间标题：大纲一章一条，区间标题不认，那几节写入后不算进任何一章`);
    }
    if (nos.size === 0) {
      notes.push('产出里认不出「## 第N章：标题」这样的章标题，写入后算不出大纲覆盖到第几章');
    } else {
      const covered = Math.max(...nos);
      if (covered < range.to) {
        notes.push(`产出只写到第 ${covered} 章（这一批要写到第 ${range.to} 章），写入后主按钮会接着推续写`);
      }
      const missing: number[] = [];
      for (let no = range.from; no <= Math.min(covered, range.to); no++) {
        if (!nos.has(no)) {
          missing.push(no);
        }
      }
      if (missing.length > 0) {
        notes.push(`缺第 ${missing.join('、')} 章：这几章拆细纲时没有大纲可依，可以重新生成，或手动补上`);
      }
    }
  }
  return notes;
}

/**
 * 这次生成要不要接链、接哪一条。正文那一条在 generation/continuation.ts，审稿与修稿（五期）
 * 在 generation/review.ts、generation/revision.ts。
 *
 * **审稿必须在正文之前认出来**：它也在正文层，按「正文层不是讨论就走续写链」的旧判据，一份审稿
 * JSON 会被当成一章正文去续写、去查重演。
 */
export type ChainKind =
  | 'config'
  | 'roster'
  | 'loreList'
  | 'loreExpand'
  | 'loreSettle'
  | 'blueprints'
  | 'plot'
  | 'manuscript'
  | 'review'
  | 'revision';

/** 架构那几件里要接链的：配置、角色图谱、设定清单。前提、世界观一次就完。 */
const SETTING_CHAIN: Partial<Record<SettingDoc, ChainKind>> = { config: 'config', characters: 'roster', lore: 'loreList' };

export function chainOf(request: Pick<BuildRequest, 'action' | 'target' | 'range' | 'writeMode'>): ChainKind | undefined {
  const { stage, capability } = request.action;
  if (capability === 'discuss') {
    return undefined;
  }
  if (capability === 'review') {
    return 'review';
  }
  if (stage === 'manuscript') {
    return request.writeMode === 'revise' ? 'revision' : 'manuscript';
  }
  // 落定设定（完善设定二期）：目标是设定目录，但不是设定清单那条链——按能力认，排在那张表之前。
  if (isLoreSettle(request.action)) {
    return 'loreSettle';
  }
  if (stage === 'setting' && request.target.kind === 'setting') {
    return SETTING_CHAIN[request.target.doc];
  }
  // 单条设定（展开）：不落到架构五件那张表上——`doc === 'lore'` 是整批清单那条链。
  if (stage === 'setting' && request.target.kind === 'lore') {
    return 'loreExpand';
  }
  if (stage === 'plot' && capability === 'generate' && request.range) {
    return 'blueprints';
  }
  // 单章细纲（写第 N 章细纲、落定细纲）：写完转写一次（2026-10-25 细纲试点）。
  if (stage === 'plot' && (capability === 'generate' || capability === 'settle')) {
    return 'plot';
  }
  return undefined;
}

/** 一段区间里的章号（闭区间）。 */
export function chaptersOf(range: { from: number; to: number }): number[] {
  const out: number[] = [];
  for (let no = range.from; no <= range.to; no++) {
    out.push(no);
  }
  return out;
}
