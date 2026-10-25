/**
 * 转写的整条走法（2026-10-25 起）：干活的模型按格式写了一段自然语言（`source`），这里交给「转写」那一档照抄成 JSON，
 * 查过再交回解出来的值。每一步只给一份 {@link TranscribeSpec}（合同、解码、哪些键按对应关系填），调用由调用方给
 * （对话页那条路是 `ChainIO.transcribe`，工程页任务是 features/poolIO.ts 的 `poolTranscriber`）。
 *
 * 1. 原文本身就是 JSON（模型没照格式写、老会话、测试里的假模型）：**不转**，按这一步的解码直接判——与改之前逐字一样。
 * 2. 原文连这一步的样子都没有（`looksLike`，比如「我不太确定」）：不转，按不合格交回去，不花转写那一次。
 * 3. 转写：照抄成 JSON → 原文写「无」的换成空的（`withoutNone`）→ **每段文字都得出自原文**（`unfaithfulStrings`，
 *    按对应关系填的键不比）→ 这一步的解码。哪一关没过就重转，说清上次哪里不对；缺省重转一次（`retries`）。
 * 4. 转写调用本身失败（池里同档换完了人、网关报错）不往外抛：交回 `failed`，写好的原文不能跟着丢（对话页留在气泡里，
 *    批量的照这一步原来解析失败的走法）。作者点了停止照旧往外抛。
 *
 * 调了几次、哪一次不合格都在结果里（`calls`、`notes`），调用方记进自己的账（第 2、4 条）。
 */
import type { ChatMessage, StopSignal } from '../llm/provider';
import { CancelledError } from '../llm/provider';
import { describeError } from '../runtime/logger';
import { transcribeMessages } from '../model/transcribe';
import { isRepairableJsonSyntax, jsonValueOf, unfaithfulStrings, withoutNone } from './structuredJson';

/** 转写一次的结果（与生成链的 `CallOutcome` 同形）。 */
export interface TranscribeOutcome {
  text: string;
  stop?: StopSignal;
}

/** 调一次转写模型。`label` 写进气泡与日志。 */
export type TranscribeCall = (messages: ChatMessage[], label: string) => Promise<TranscribeOutcome>;

export interface TranscribeSpec<T> {
  /** 这一步叫什么：气泡与日志里那一行是「{label}转写成 JSON」，说明里是「{label}转写不合格……」。 */
  label: string;
  /** 转写合同：JSON 形状、每个字段从原文哪里取、词怎么对到代码。 */
  contract: string;
  /** 这一步原来的解码与校验（吃 JSON 文本）。不合格交回一句人话——重转那一次原样告诉转写模型。 */
  decode(json: string): { ok: true; value: T } | { ok: false; message: string };
  /** 按对应关系填、不比原文的键（type、role、章号……）。 */
  mapped?: readonly string[];
  /** 原文有没有这一步的样子。缺席 = 都转。坏了语法的 JSON 一律转（转写顺带把它理顺）。 */
  looksLike?(source: string): boolean;
  /** 最多重转几次。缺省 1。 */
  retries?: number;
}

export type TranscribeResult<T> =
  | {
      ok: true;
      value: T;
      /** 规范化的 JSON 文本（直接给的是原文本身）：要落进气泡、日志的就是它。 */
      json: string;
      /** 原文本身就是 JSON，没有转。 */
      direct: boolean;
      calls: number;
      notes: string[];
    }
  | {
      ok: false;
      message: string;
      /** 转写调用本身失败了（不是转得不合格）。 */
      failed: boolean;
      calls: number;
      notes: string[];
    };

export async function transcribeJson<T>(source: string, spec: TranscribeSpec<T>, call: TranscribeCall): Promise<TranscribeResult<T>> {
  const text = source.trim();
  const notes: string[] = [];
  if (jsonValueOf(text) !== undefined) {
    const d = spec.decode(text);
    return d.ok
      ? { ok: true, value: d.value, json: text, direct: true, calls: 0, notes }
      : { ok: false, message: d.message, failed: false, calls: 0, notes };
  }
  if (spec.looksLike && !isRepairableJsonSyntax(text) && !spec.looksLike(text)) {
    return { ok: false, message: '没有按格式写', failed: false, calls: 0, notes };
  }
  const mapped = new Set(spec.mapped ?? []);
  const retries = spec.retries ?? 1;
  let calls = 0;
  let feedback: string | undefined;
  for (let round = 0; round <= retries; round++) {
    let out: TranscribeOutcome;
    calls++;
    try {
      out = await call(transcribeMessages(spec.contract, text, feedback) as ChatMessage[], `${spec.label}转写成 JSON`);
    } catch (err) {
      if (err instanceof CancelledError) {
        throw err;
      }
      return { ok: false, message: `转写调用失败（${describeError(err)}）`, failed: true, calls, notes };
    }
    const judged = judge(out, text, spec, mapped);
    if (judged.ok) {
      return { ok: true, value: judged.value, json: judged.json, direct: false, calls, notes };
    }
    feedback = judged.message;
    notes.push(round < retries ? `${spec.label}转写不合格（${feedback}），重转一次` : `${spec.label}重转仍不合格（${feedback}）`);
  }
  return { ok: false, message: feedback ?? '转写不合格', failed: false, calls, notes };
}

function judge<T>(
  out: TranscribeOutcome,
  source: string,
  spec: TranscribeSpec<T>,
  mapped: ReadonlySet<string>
): { ok: true; value: T; json: string } | { ok: false; message: string } {
  if (out.stop === 'maxTokens') {
    return { ok: false, message: '转写被输出上限截断' };
  }
  const raw = jsonValueOf(out.text);
  if (raw === undefined) {
    return { ok: false, message: '转写出来的不是一个完整的 JSON 对象' };
  }
  const value = withoutNone(raw);
  const off = unfaithfulStrings(source, value, mapped);
  if (off.length > 0) {
    return { ok: false, message: `这几处不是原文里的字：${off.map((s) => `「${s}」`).join('、')}` };
  }
  const json = JSON.stringify(value);
  const d = spec.decode(json);
  return d.ok ? { ok: true, value: d.value, json } : { ok: false, message: d.message };
}
