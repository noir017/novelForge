import { BuildRequest, BuiltContext, buildContext } from '../context/builder';
import { describeUsage, recordUsage } from '../context/tokenizer';
import { CancelledError, ChatOptions, TokenUsage } from '../llm/provider';
import { buildProvider, resolveProvider } from '../llm/registry';
import { readConfig } from '../config';
import { describeError, elapsed, scoped } from '../logger';
import { NovelProject, sanitizeFileName } from '../model/project';
import {
  describeModelIssue,
  ProviderProfile,
  providerLabel,
  resolveModelRef,
  withDraftProvider,
} from '../model/providers';
import { Chapter } from '../model/types';

const log = scoped('续写');

export interface GenerateHandlers {
  onDelta(delta: string, full: string): void;
  /** 推理模型的思考增量。正文之前可能先想很久，界面靠它给出反馈。 */
  onReasoning?(delta: string, full: string): void;
  onDone(full: string): void;
  onError(message: string): void;
  onCancelled(): void;
}

/** 续写编排：装配上下文 → 流式生成 → 交由调用方决定采纳。 */
export class ContinueSession {
  private currentAbort: AbortController | undefined;

  constructor(private readonly project: NovelProject) {}

  get isGenerating(): boolean {
    return this.currentAbort !== undefined;
  }

  /** 只装配上下文，不调用模型——用于面板里的「预览上下文」。 */
  async preview(request: Omit<BuildRequest, 'providerMaxInputTokens'>): Promise<BuiltContext> {
    const config = readConfig();
    let providerMaxInputTokens: number | undefined;
    // vscode-lm 有硬配额，预览时也要按真实上限算，否则预览与实际不符。
    if (config.active?.profile.kind === 'vscode-lm') {
      const provider = await resolveProvider();
      providerMaxInputTokens = await provider?.maxInputTokens();
    }
    return buildContext(this.project, { ...request, providerMaxInputTokens }, config);
  }

  async generate(
    request: Omit<BuildRequest, 'providerMaxInputTokens'>,
    handlers: GenerateHandlers
  ): Promise<BuiltContext | undefined> {
    if (this.currentAbort) {
      log.warn('已有一个生成任务在进行中，本次请求被拒');
      handlers.onError('已有一个生成任务在进行中。');
      return undefined;
    }

    const config = readConfig();
    if (!config.active) {
      const issue = describeModelIssue(config.providers, config.model);
      log.error(`模型引用无效：${issue}`, `当前引用 ${config.model || '（空）'}`);
      handlers.onError(issue);
      return undefined;
    }
    const provider = await buildProvider(config.active);
    if (!provider) {
      log.error(`未配置「${providerLabel(config.active.profile)}」的 API Key`);
      handlers.onError(
        `未配置「${providerLabel(config.active.profile)}」的 API Key。可在设置页录入，或换一个已配置好的模型。`
      );
      return undefined;
    }

    const startedAt = Date.now();
    log.info(
      `开始${request.mode === 'discuss' ? '讨论' : '续写'}：目标第 ${request.targetOrder} 章`,
      `模型 ${provider.label}${request.targetWords ? `｜目标 ${request.targetWords} 字` : ''}` +
        `${request.attachments?.length ? `｜引用 ${request.attachments.length} 项` : ''}` +
        `${request.history?.length ? `｜历史 ${request.history.length} 轮` : ''}`
    );

    const providerMaxInputTokens = await provider.maxInputTokens();
    const buildStart = Date.now();
    const built = await buildContext(this.project, { ...request, providerMaxInputTokens }, config);
    logAssembly(built, buildStart);

    const abort = new AbortController();
    this.currentAbort = abort;

    let reasoning = '';
    // 服务商分多次回报用量（Anthropic 输入/输出分开给），按字段合并成一份。
    const usage: TokenUsage = {};
    const options: ChatOptions = {
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      timeoutMs: config.requestTimeoutMs,
      signal: abort.signal,
      onUsage: (u) => {
        if (u.inputTokens !== undefined) {
          usage.inputTokens = u.inputTokens;
        }
        if (u.outputTokens !== undefined) {
          usage.outputTokens = u.outputTokens;
        }
      },
      onReasoning: handlers.onReasoning
        ? (text) => {
            reasoning += text;
            handlers.onReasoning?.(text, reasoning);
          }
        : undefined,
    };

    try {
      let full = '';
      let firstDeltaAt = 0;
      for await (const delta of provider.chatStream(built.messages, options)) {
        if (!firstDeltaAt) {
          firstDeltaAt = Date.now();
          log.debug('首个正文分片已到达', `首字延迟 ${elapsed(startedAt, firstDeltaAt)}`);
        }
        full += delta;
        handlers.onDelta(delta, full);
      }
      handlers.onDone(cleanOutput(full));
      // 有实测用量就记一笔：估算准不准，只有对着服务商的账单才看得出来。
      recordUsage('续写', built.usedTokens, usage);
      const usageNote = describeUsage(built.usedTokens, usage);
      log.info(
        '生成完成',
        `产出 ${full.length} 字，用时 ${elapsed(startedAt)}` +
          `${reasoning ? `；另有思考 ${reasoning.length} 字` : ''}` +
          `${usageNote ? `；${usageNote}` : ''}`
      );
    } catch (err) {
      if (err instanceof CancelledError || abort.signal.aborted) {
        log.warn('生成被取消', `已产出内容，用时 ${elapsed(startedAt)}`);
        handlers.onCancelled();
      } else {
        log.error(`生成失败：${describeError(err)}`, err);
        handlers.onError(describeError(err));
      }
    } finally {
      this.currentAbort = undefined;
    }

    return built;
  }

  stop(): void {
    if (this.currentAbort) {
      log.info('用户点了停止');
    }
    this.currentAbort?.abort(new CancelledError());
  }

  /**
   * 发一个最小请求验证配置能不能用。
   * 设置页的「测试连接」——比让用户先写半章再发现 Key 填错好得多。
   *
   * @param ref 要测的模型引用；留空则测当前选中的。
   * @param draft 设置页屏幕上那份尚未保存的服务商配置。给了就以它为准——
   *   「新加的模型必须先保存才能测」对用户毫无道理，而且保存一份没验过的
   *   配置正是测试想要避免的事。
   */
  async testConnection(ref?: string, draft?: ProviderProfile): Promise<{ ok: boolean; message: string }> {
    const config = readConfig();
    // 草稿只补充、不替换：其余服务商仍用已保存的，这样 ref 指向别家时照样能解析。
    const providers = withDraftProvider(config.providers, draft);
    const active = ref ? resolveModelRef(providers, ref) : config.active;
    if (!active) {
      return { ok: false, message: describeModelIssue(providers, ref ?? config.model) };
    }
    const provider = await buildProvider(active);
    if (!provider) {
      return {
        ok: false,
        message: `未配置「${providerLabel(active.profile)}」的 API Key，已取消测试。`,
      };
    }
    log.info(`测试连接 ${active.ref}`, provider.label);
    const startedAt = Date.now();
    const abort = new AbortController();
    try {
      let reply = '';
      for await (const delta of provider.chatStream(
        [{ role: 'user', content: '回复两个字：收到' }],
        { maxOutputTokens: 16, temperature: 0, timeoutMs: 30000, signal: abort.signal }
      )) {
        reply += delta;
        // 拿到任何内容就算通了，不必等它说完。
        if (reply.trim().length >= 2) {
          break;
        }
      }
      if (reply.trim()) {
        log.info(`${active.ref} 连接正常`, `回复「${reply.trim().slice(0, 20)}」，用时 ${elapsed(startedAt)}`);
        return { ok: true, message: `${active.ref} 连接正常：${provider.label} 回复「${reply.trim().slice(0, 20)}」` };
      }
      log.warn(`${active.ref} 连接成功但没有返回内容`, `用时 ${elapsed(startedAt)}，检查模型名是否正确`);
      return { ok: false, message: `${active.ref} 连接成功但没有返回内容，检查模型名是否正确。` };
    } catch (err) {
      log.error(`${active.ref} 连接失败：${describeError(err)}`, err);
      return { ok: false, message: `${active.ref}：${describeError(err)}` };
    }
  }

  dispose(): void {
    this.currentAbort?.abort(new CancelledError());
  }

  /** 采纳草稿：追加到已有章节，或新建章节。返回工作区相对路径。 */
  async accept(
    draft: string,
    target: { mode: 'append'; order: number } | { mode: 'new'; order: number; title: string }
  ): Promise<string> {
    if (target.mode === 'append') {
      const chapter = await this.project.getChapter(target.order);
      if (!chapter) {
        log.error(`采纳失败：第 ${target.order} 章不存在`);
        throw new Error(`第 ${target.order} 章不存在。`);
      }
      const relPath = await this.project.appendToChapter(chapter, draft);
      await this.project.syncManifest();
      log.info(`已追加 ${draft.length} 字到第 ${target.order} 章`, `${relPath}｜该章摘要将变为过期`);
      return relPath;
    }

    const relPath = await this.project.createChapter(target.order, target.title, draft);
    await this.project.syncManifest();
    log.info(`已新建第 ${target.order} 章《${target.title}》`, `${relPath}｜${draft.length} 字`);
    return relPath;
  }

  /** 给新章节起个默认标题：优先用纲要首句。 */
  static suggestTitle(outline: string, order: number): string {
    const firstLine = outline
      .split(/\r?\n/)
      .map((s) => s.replace(/^[\s\-*\d.、)]+/, '').trim())
      .find((s) => s.length > 0);
    if (!firstLine) {
      return `第${order}章`;
    }
    const clipped = firstLine.split(/[。！？；,，.!?;]/)[0].trim().slice(0, 18);
    return sanitizeFileName(clipped) || `第${order}章`;
  }
}

/**
 * 清理模型输出里常见的赘余：包裹的代码块、开场白、被要求不写却仍写出的标题。
 * 只做保守清理，不改动正文本身。
 */
export function cleanOutput(text: string): string {
  let out = text.trim();

  const fence = /^```(?:\w+)?\r?\n([\s\S]*?)\r?\n?```$/.exec(out);
  if (fence) {
    out = fence[1].trim();
  }

  // 开头的「好的，以下是……」之类
  out = out.replace(/^(好的|没问题|明白了)[^\n]{0,40}[:：]\s*\r?\n+/, '');
  out = out.replace(/^(以下是|下面是)[^\n]{0,40}[:：]?\s*\r?\n+/, '');

  // 开头的章节标题行（我们在 prompt 里禁止了，但模型常忍不住）
  out = out.replace(/^#{1,6}\s*第?\s*[\d一二三四五六七八九十百]+\s*章[^\n]*\r?\n+/, '');
  out = out.replace(/^第\s*[\d一二三四五六七八九十百]+\s*章[ 　]*[^\n]{0,20}\r?\n+/, '');

  // 结尾的字数统计/创作说明
  out = out.replace(/\r?\n+[（(]?\s*(本章|全文|以上)?\s*(约|共)?\s*\d+\s*字\s*[)）]?\s*$/, '');
  out = out.replace(/\r?\n+[-—]{3,}[\s\S]*$/, (m) => (m.length < 200 ? '' : m));

  return out.trim();
}

/** 供命令面板走的极简续写（不开 Webview）已移到 src/vscode/quickContinue.ts（依赖编辑器）。 */

/**
 * 把这次装配的结果写进日志。
 *
 * 只记条目名与 token 数，**绝不记 prompt 全文**——那是十万字级的东西，
 * 一次就能把整个日志缓冲挤空。降级/丢弃的条目单列一段，对应
 * 「不静默截断」那条承诺：界面上的明细折叠着，日志里得看得见。
 */
function logAssembly(built: BuiltContext, startedAtMs: number): void {
  const kept = built.items.filter((i) => i.status === 'included' || i.status === 'degraded');
  const lost = built.items.filter((i) => i.status === 'dropped' || i.status === 'degraded');
  const percent = built.budget > 0 ? Math.round((built.usedTokens / built.budget) * 100) : 0;

  log.info(
    `上下文已装配：${built.usedTokens}/${built.budget} token（${percent}%），${kept.length} 项`,
    `${built.messages.length} 条消息，用时 ${elapsed(startedAtMs)}` +
      `${built.budgetClampedByProvider ? '｜预算被服务商配额压低' : ''}`
  );
  if (lost.length > 0) {
    log.warn(
      `${lost.length} 项被降级或丢弃`,
      lost.map((i) => `${statusLabel(i.status)} ${i.label}${i.note ? `——${i.note}` : ''}`).join('\n')
    );
  }
}

function statusLabel(status: string): string {
  return status === 'degraded' ? '[降级]' : status === 'dropped' ? '[丢弃]' : `[${status}]`;
}

export function describeTarget(chapters: Chapter[], order: number): string {
  const chapter = chapters.find((c) => c.order === order);
  return chapter ? `第 ${order} 章《${chapter.title}》` : `新的第 ${order} 章`;
}
