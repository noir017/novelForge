/**
 * 生成链：一件产物要分几次调用才拼得出来时，把那几次串起来。
 *
 * 三条链，都移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）：
 *
 * | 产物 | 链 | 上游出处 |
 * |---|---|---|
 * | 小说配置 | 截断就整份重来 1 次；「全局要求」不合格只重写这一节 1 次 | `GenerateConfigCommand`（AC:980-1163） |
 * | 角色图谱 | 身份清单 → 按冻结清单每批 3 人补详情；截断拆半 | `GenerateCharactersCommand`（AC:1254-1647） |
 * | 细纲批次 | 截断或解不出来：多章对半拆、单章紧凑重建；语法坏了修一次；漏章 fail-closed | `structured-batch-executor.ts` |
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
import type { AgentMessage, StopSignal } from '../llm/provider';
import type { BuildRequest, DraftPlotLine } from '../context/types';
import {
  RESTART_AFTER_TRUNCATION,
  blueprintJsonContract,
  guidanceRetryMessages,
  rosterDetailJsonContract,
  syntaxRepairMessages,
} from '../context/prompts';
import { PLOT_BATCH, ROSTER_DETAIL_BATCH } from '../model/pipeline';
import { BookConfig } from '../model/settingFile';
import { hasContent } from '../model/markdown';
import { parseOutlineRanges } from '../model/outlineFile';
import { BlueprintItem, checkCoverage, decodeBlueprints, renderBlueprints } from '../features/blueprint';
import { CharacterDetail, IdentitySlot, assembleRoster, decodeDetails, decodeManifest, renderRoster } from '../features/roster';
import {
  decodeNovelConfig,
  guidanceProblem,
  isGuidanceValid,
  mergeWithAuthor,
  renderConfigDraft,
} from '../features/novelConfig';
import { isRepairableJsonSyntax, preservesJsonEvidence } from '../features/structuredJson';

/** 一次调用的结果。`stop` 缺席 = 网关没报收尾原因（有的兼容实现压根不发）。 */
export interface CallOutcome {
  text: string;
  stop?: StopSignal;
}

/** 链要的三样东西：调一次模型、按改过的请求重新装配、第一次调用发出去的那几条消息。 */
export interface ChainIO {
  /** 调一次模型。`label` 写进气泡与日志，说清这一次在补什么。 */
  call(messages: AgentMessage[], label: string): Promise<CallOutcome>;
  /** 按改过的请求重新装配：同一个装配器、同一份预算，只换这几个字段。 */
  build(patch: Partial<BuildRequest>): Promise<AgentMessage[]>;
  /** 第一次调用的消息。字段级重写要借它的系统提示。 */
  messages: AgentMessage[];
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
class Tally {
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
  async call(io: ChainIO, messages: AgentMessage[], label: string): Promise<CallOutcome> {
    this.calls++;
    return io.call(messages, label);
  }
}

function span(from: number, to: number): string {
  return from === to ? `第 ${from} 章` : `第 ${from}–${to} 章`;
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
  worldSetting: '世界观要点',
  goldenFinger: '金手指',
  protagonistProfile: '主角档案',
  globalGuidance: '全局要求',
  writingStyle: '文风',
};

/**
 * 小说配置：截断整份重来 1 次 → 解码 → 「全局要求」不合格只重写这一节 1 次 →
 * 与磁盘那份合并 → `config.md` 全文（外加一节文风）。
 *
 * 模型根本没按 JSON 答（一段 Markdown）时不报错，原样交回去：解析那一层会按小节读，
 * 卡片上照样看得见——这件产物作者当场过目，宽松比作废划算。
 */
export async function completeConfig(first: CallOutcome, io: ChainIO, ctx: ConfigChainContext): Promise<ChainResult> {
  // 显式标注类型：`t.fail()` 返回 never，TS 只对显式标注的变量做控制流收窄。
  const t: Tally = new Tally(true);
  let out = first;
  if (out.stop === 'maxTokens') {
    t.note('配置 JSON 被输出上限截断，截断的那一半不可信，已丢弃并整份重来一次');
    out = await t.call(io, await io.build({ extraInstruction: RESTART_AFTER_TRUNCATION }), '配置被截断，整份重来');
    if (out.stop === 'maxTokens') {
      t.fail('小说配置重来一次仍被输出上限截断。调大设置页的「最大输出 token」，或降低思考深度再试。');
    }
  }

  const decoded = decodeNovelConfig(out.text);
  if (!decoded.ok) {
    t.note(`模型没有按 JSON 合同作答（${decoded.reason}），按 Markdown 小节读`);
    return { raw: out.text, notes: t.notes, calls: t.calls };
  }
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
 * 角色图谱：身份清单（截断重来 1 次）→ 按冻结清单每批 3 人补详情 → 拼卡。
 *
 * 清单不合格就停：后面每一批都以它为准，一张坏清单补出来的详情只会错得更整齐。
 * 详情那一步反过来宽松——某人的详情实在出不来，照样按清单建卡并说明。
 */
export async function completeRoster(first: CallOutcome, io: ChainIO): Promise<ChainResult> {
  // 显式标注类型：`t.fail()` 返回 never，TS 只对显式标注的变量做控制流收窄。
  const t: Tally = new Tally(true);
  let out = first;
  if (out.stop === 'maxTokens') {
    t.note('身份清单被输出上限截断，已丢弃并重来一次');
    out = await t.call(io, await io.build({ extraInstruction: RESTART_AFTER_TRUNCATION }), '身份清单被截断，重来');
  }
  const manifest = decodeManifest(out.text);
  if (!manifest.ok) {
    t.fail(`角色身份清单不合格：${manifest.message}。这一次没有产出可写入的角色图谱。`);
  }
  t.note(...manifest.warnings);
  const slots = manifest.slots;
  const frozen = JSON.stringify({
    slots: slots.map((s) => ({ slotId: s.slotId, name: s.name, role: s.role, narrativeDuty: s.duty, relations: s.relations })),
  });

  const details: CharacterDetail[] = [];
  let repairUsed = false;
  const runBatch = async (batch: IdentitySlot[]): Promise<void> => {
    const names = batch.map((s) => s.name).join('、');
    const done = details.length
      ? JSON.stringify(details.map((d) => ({ slotId: d.slotId, name: slots.find((s) => s.slotId === d.slotId)?.name })))
      : '';
    const messages = await io.build({
      step: { kind: 'rosterDetails', manifest: frozen, slotIds: batch.map((s) => s.slotId), done },
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
    let text = res.text;
    if (isRepairableJsonSyntax(text) && !repairUsed) {
      repairUsed = true;
      const fix = await t.call(io, syntaxRepairMessages(rosterDetailJsonContract(), text), '角色详情的 JSON 语法坏了，修一次');
      if (fix.stop !== 'maxTokens' && preservesJsonEvidence(text, fix.text)) {
        text = fix.text;
        t.note('角色详情的 JSON 语法坏了，修了一次（只改标点）');
      } else {
        t.note('角色详情的语法修复改动了内容或没修好，没有采用');
      }
    }
    const decoded = decodeDetails(text, batch);
    if (!decoded.ok) {
      if (batch.length > 1) {
        return split(`解不出来（${decoded.message}）`);
      }
      t.note(`「${names}」的详情解不出来（${decoded.message}），只按身份清单建卡`);
      return;
    }
    t.note(...decoded.warnings);
    details.push(...decoded.items);
  };

  for (let i = 0; i < slots.length; i += ROSTER_DETAIL_BATCH) {
    await runBatch(slots.slice(i, i + ROSTER_DETAIL_BATCH));
  }
  const { entries, warnings } = assembleRoster(slots, details);
  t.note(...warnings);
  return { raw: renderRoster(entries), notes: t.notes, calls: t.calls };
}

// ---------------------------------------------------------------- 细纲批次

export interface BlueprintChainResult extends ChainResult {
  items: BlueprintItem[];
}

function draftLine(b: BlueprintItem): DraftPlotLine {
  return { no: b.no, title: b.title, keyEvents: b.keyEvents, suspenseHook: b.suspenseHook };
}

/**
 * 细纲批次：`chapters` 按 {@link PLOT_BATCH} 一批，每批走上游 SBE 的降级链。
 *
 * `first` 是对话页已经流式跑完的第一批（它的范围必须正好是 `chapters` 的前 5 章）；
 * 批量那条路不给，第一批也由链自己调。
 *
 * - 截断：多章对半拆；单章紧凑重建（每章至多一次）。
 * - JSON 语法坏了：全程只修一次，只许改标点（`preservesJsonEvidence`），改了内容就拒收。
 * - 解不出来：多章对半拆，单章紧凑重建。
 * - 重复章、越界章：报错。
 * - **漏章**：只有修过语法（说明是截断把后面的章吞了）才拆半或重建；模型正常收尾却
 *   漏写了，就报错、整批不写——对偷懒的输出不无限重试（上游同一条规矩）。
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
  let repairUsed = false;

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

    let text = out.text;
    let repaired = false;
    if (isRepairableJsonSyntax(text) && !repairUsed) {
      repairUsed = true;
      repaired = true;
      const fix = await t.call(io, syntaxRepairMessages(blueprintJsonContract({ from, to }), text), `${where}的 JSON 语法坏了，修一次`);
      if (fix.stop === 'maxTokens') {
        if (!single) {
          return split('语法修复时被输出上限截断');
        }
        if (canCompact) {
          return rebuild('语法修复时被输出上限截断');
        }
        t.fail(`${where}的细纲语法修复被输出上限截断。`);
      }
      if (!preservesJsonEvidence(text, fix.text)) {
        t.fail(`${where}的语法修复改动了细纲的内容，已拒收——修复只许改标点，不许补造或改写事实。`);
      }
      text = fix.text;
      t.note(`${where}的 JSON 语法坏了，修了一次（只改标点）`);
    }

    const decoded = decodeBlueprints(text);
    if (!decoded.ok) {
      const d = decoded.diagnostic;
      if (!single) {
        return split(`解不出来（${d.message}）`);
      }
      if (canCompact) {
        return rebuild(`解不出来（${d.message}）`, `${d.path}：${d.message}`);
      }
      t.fail(`${where}的细纲不合格：${d.message}。这一批没有写入任何细纲。`);
    }

    const cov = checkCoverage(decoded.items, items);
    if (cov.duplicate.length > 0) {
      t.fail(`输出里第 ${cov.duplicate.join('、')} 章出现了不止一次，说不清哪一份算数。这一批没有写入任何细纲。`);
    }
    if (cov.unexpected.length > 0) {
      t.fail(`输出里多出了这一批以外的第 ${cov.unexpected.join('、')} 章。这一批没有写入任何细纲。`);
    }
    if (cov.missing.length > 0) {
      if (repaired && !single) {
        return split(`修过语法后仍缺第 ${cov.missing.join('、')} 章`);
      }
      if (repaired && canCompact) {
        return rebuild('修过语法后仍缺这一章');
      }
      t.fail(`模型漏写了第 ${cov.missing.join('、')} 章。漏章时不猜也不补，这一批没有写入任何细纲。`);
    }
    t.note(...decoded.warnings);
    validated.push(...items.map((no) => decoded.items.find((b) => b.no === no)!));
  };

  for (let i = 0; i < chapters.length; i += PLOT_BATCH) {
    const batch = chapters.slice(i, i + PLOT_BATCH);
    await exec([...batch], undefined, i === 0 ? first : undefined);
  }
  return { raw: renderBlueprints(validated), notes: t.notes, calls: t.calls, items: validated };
}

// ---------------------------------------------------------------- 单次产物的说明

/**
 * 不走链的产物（前提、世界观、大纲、单章细纲）也要把看得见的问题说出来：
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
    const ranges = parseOutlineRanges(raw);
    if (ranges.length === 0) {
      notes.push('产出里认不出「## 第a–b章：标题」这样的区间标题，写入后算不出大纲覆盖到第几章');
    } else {
      const covered = ranges.reduce((m, r) => Math.max(m, r.to), 0);
      if (covered < range.to) {
        notes.push(`产出只覆盖到第 ${covered} 章（这一批要写到第 ${range.to} 章），写入后主按钮会接着推续写`);
      }
    }
  }
  return notes;
}

/** 这次生成要不要接链、接哪一条。 */
export type ChainKind = 'config' | 'roster' | 'blueprints';

export function chainOf(request: Pick<BuildRequest, 'action' | 'target' | 'range'>): ChainKind | undefined {
  const { stage, capability } = request.action;
  if (capability === 'discuss') {
    return undefined;
  }
  if (stage === 'setting' && request.target.kind === 'setting') {
    return request.target.doc === 'config' ? 'config' : request.target.doc === 'characters' ? 'roster' : undefined;
  }
  if (stage === 'plot' && capability === 'generate' && request.range) {
    return 'blueprints';
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
