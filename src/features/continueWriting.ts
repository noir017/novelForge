import * as vscode from 'vscode';
import { BuildRequest, BuiltContext, buildContext } from '../context/builder';
import { CancelledError, ChatOptions } from '../llm/provider';
import { resolveProvider } from '../llm/registry';
import { NovelProject, readConfig, sanitizeFileName } from '../model/project';
import { Chapter } from '../model/types';

export interface GenerateHandlers {
  onDelta(delta: string, full: string): void;
  onDone(full: string): void;
  onError(message: string): void;
  onCancelled(): void;
}

/** 续写编排：装配上下文 → 流式生成 → 交由调用方决定采纳。 */
export class ContinueSession {
  private currentCancel: vscode.CancellationTokenSource | undefined;

  constructor(private readonly project: NovelProject) {}

  get isGenerating(): boolean {
    return this.currentCancel !== undefined;
  }

  /** 只装配上下文，不调用模型——用于面板里的「预览上下文」。 */
  async preview(request: Omit<BuildRequest, 'providerMaxInputTokens'>): Promise<BuiltContext> {
    const config = readConfig();
    let providerMaxInputTokens: number | undefined;
    // vscode-lm 有硬配额，预览时也要按真实上限算，否则预览与实际不符。
    if (config.provider === 'vscode-lm') {
      const provider = await resolveProvider();
      providerMaxInputTokens = await provider?.maxInputTokens();
    }
    return buildContext(this.project, { ...request, providerMaxInputTokens }, config);
  }

  async generate(
    request: Omit<BuildRequest, 'providerMaxInputTokens'>,
    handlers: GenerateHandlers
  ): Promise<BuiltContext | undefined> {
    if (this.currentCancel) {
      handlers.onError('已有一个生成任务在进行中。');
      return undefined;
    }

    const provider = await resolveProvider();
    if (!provider) {
      handlers.onError('未配置模型。请运行命令「Novel: 设置 API Key」，或把 novel.provider 改为 vscode-lm。');
      return undefined;
    }

    const config = readConfig();
    const providerMaxInputTokens = await provider.maxInputTokens();
    const built = await buildContext(this.project, { ...request, providerMaxInputTokens }, config);

    const source = new vscode.CancellationTokenSource();
    this.currentCancel = source;

    const options: ChatOptions = {
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      timeoutMs: config.requestTimeoutMs,
      token: source.token,
    };

    try {
      let full = '';
      for await (const delta of provider.chatStream(built.messages, options)) {
        full += delta;
        handlers.onDelta(delta, full);
      }
      handlers.onDone(cleanOutput(full));
    } catch (err) {
      if (err instanceof CancelledError || source.token.isCancellationRequested) {
        handlers.onCancelled();
      } else {
        handlers.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      source.dispose();
      this.currentCancel = undefined;
    }

    return built;
  }

  stop(): void {
    this.currentCancel?.cancel();
  }

  /**
   * 发一个最小请求验证配置能不能用。
   * 设置页的「测试连接」——比让用户先写半章再发现 Key 填错好得多。
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const provider = await resolveProvider();
    if (!provider) {
      return { ok: false, message: '未配置模型：请先设置 API Key，或把服务商改为 VS Code 语言模型。' };
    }
    const source = new vscode.CancellationTokenSource();
    try {
      let reply = '';
      for await (const delta of provider.chatStream(
        [{ role: 'user', content: '回复两个字：收到' }],
        { maxOutputTokens: 16, temperature: 0, timeoutMs: 30000, token: source.token }
      )) {
        reply += delta;
        // 拿到任何内容就算通了，不必等它说完。
        if (reply.trim().length >= 2) {
          break;
        }
      }
      return reply.trim()
        ? { ok: true, message: `连接正常：${provider.label} 回复「${reply.trim().slice(0, 20)}」` }
        : { ok: false, message: `${provider.label} 连接成功但没有返回内容，检查模型名是否正确。` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      source.cancel();
      source.dispose();
    }
  }

  dispose(): void {
    this.currentCancel?.cancel();
    this.currentCancel?.dispose();
  }

  /** 采纳草稿：追加到已有章节，或新建章节。 */
  async accept(
    draft: string,
    target: { mode: 'append'; order: number } | { mode: 'new'; order: number; title: string }
  ): Promise<vscode.Uri> {
    if (target.mode === 'append') {
      const chapter = await this.project.getChapter(target.order);
      if (!chapter) {
        throw new Error(`第 ${target.order} 章不存在。`);
      }
      const uri = await this.project.appendToChapter(chapter, draft);
      await this.project.syncManifest();
      return uri;
    }

    const uri = await this.project.createChapter(target.order, target.title, draft);
    await this.project.syncManifest();
    return uri;
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

/** 供命令面板走的极简续写（不开 Webview），结果流式写入新文档。 */
export async function quickContinue(project: NovelProject): Promise<void> {
  const outline = await vscode.window.showInputBox({
    title: 'Novel: 快速续写',
    prompt: '输入接下来的剧情纲要（详细的写作请用续写面板）',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : '纲要不能为空'),
  });
  if (!outline) {
    return;
  }

  const order = await project.nextChapterOrder();
  const session = new ContinueSession(project);
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: '' });
  const editor = await vscode.window.showTextDocument(doc, { preview: false });

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Novel Forge：生成中', cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => session.stop());
      await session.generate(
        { targetOrder: order, outline },
        {
          onDelta: (delta) => {
            void editor.edit(
              (b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, delta),
              { undoStopBefore: false, undoStopAfter: false }
            );
          },
          onDone: () => void vscode.window.showInformationMessage('Novel Forge：生成完成。'),
          onError: (msg) => void vscode.window.showErrorMessage(`Novel Forge：${msg}`),
          onCancelled: () => void vscode.window.showInformationMessage('Novel Forge：已取消。'),
        }
      );
    }
  );
}

export function describeTarget(chapters: Chapter[], order: number): string {
  const chapter = chapters.find((c) => c.order === order);
  return chapter ? `第 ${order} 章《${chapter.title}》` : `新的第 ${order} 章`;
}
