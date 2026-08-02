import * as vscode from 'vscode';
import { CancelledError, ChatMessage, ChatOptions, LlmError, LlmProvider } from './provider';

/**
 * 基于 VS Code Language Model API（复用 Copilot 订阅）。
 *
 * 两点与自建 API 不同：
 * 1. 没有独立的 system 角色，系统提示会并入首条 user 消息；
 * 2. 有硬性的 maxInputTokens 配额，装配器需要据此收紧预算。
 */
export class VsCodeLmProvider implements LlmProvider {
  readonly id = 'vscode-lm' as const;

  private model: vscode.LanguageModelChat | undefined;

  constructor(private readonly family: string) {}

  get label(): string {
    return this.model ? `${this.model.name}（VS Code LM）` : `${this.family}（VS Code LM）`;
  }

  private async resolveModel(): Promise<vscode.LanguageModelChat> {
    if (this.model) {
      return this.model;
    }
    let models = await vscode.lm.selectChatModels({ family: this.family });
    if (models.length === 0) {
      // family 填错或该模型不可用时，退而选任意可用模型，避免直接卡死。
      models = await vscode.lm.selectChatModels();
      if (models.length === 0) {
        throw new LlmError(
          '没有可用的 VS Code 语言模型。请确认已安装并登录 GitHub Copilot，或在设置里把 novel.provider 改为 openai/anthropic。'
        );
      }
      void vscode.window.showWarningMessage(
        `Novel Forge：找不到模型 family「${this.family}」，已改用「${models[0].family}」。`
      );
    }
    this.model = models[0];
    return this.model;
  }

  async maxInputTokens(): Promise<number | undefined> {
    try {
      return (await this.resolveModel()).maxInputTokens;
    } catch {
      return undefined;
    }
  }

  async *chatStream(messages: ChatMessage[], options: ChatOptions): AsyncIterable<string> {
    const model = await this.resolveModel();
    const source = new vscode.CancellationTokenSource();
    const sub = options.token?.onCancellationRequested(() => source.cancel());
    const timer = setTimeout(() => source.cancel(), options.timeoutMs);

    try {
      const response = await model.sendRequest(toLmMessages(messages), {
        justification: 'Novel Forge 需要调用语言模型续写小说正文。',
      }, source.token);

      for await (const fragment of response.text) {
        yield fragment;
      }
    } catch (err) {
      if (err instanceof vscode.CancellationError || source.token.isCancellationRequested) {
        throw new CancelledError();
      }
      if (err instanceof vscode.LanguageModelError) {
        throw new LlmError(translateLmError(err));
      }
      throw new LlmError(`VS Code 语言模型请求失败：${err instanceof Error ? err.message : String(err)}`, err);
    } finally {
      clearTimeout(timer);
      sub?.dispose();
      source.dispose();
    }
  }
}

function toLmMessages(messages: ChatMessage[]): vscode.LanguageModelChatMessage[] {
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const out: vscode.LanguageModelChatMessage[] = [];

  let systemMerged = !systemText;
  for (const m of rest) {
    if (m.role === 'assistant') {
      out.push(vscode.LanguageModelChatMessage.Assistant(m.content));
      continue;
    }
    if (!systemMerged) {
      out.push(vscode.LanguageModelChatMessage.User(`${systemText}\n\n---\n\n${m.content}`));
      systemMerged = true;
    } else {
      out.push(vscode.LanguageModelChatMessage.User(m.content));
    }
  }
  if (!systemMerged) {
    out.push(vscode.LanguageModelChatMessage.User(systemText));
  }
  return out;
}

function translateLmError(err: vscode.LanguageModelError): string {
  switch (err.code) {
    case vscode.LanguageModelError.NoPermissions.name:
      return '未获得使用该语言模型的授权，请在弹出的确认框中允许 Novel Forge 使用 Copilot 模型。';
    case vscode.LanguageModelError.Blocked.name:
      return '请求被模型的内容策略拦截。可尝试调整纲要措辞，或改用自建 API（novel.provider 设为 openai）。';
    case vscode.LanguageModelError.NotFound.name:
      return '找不到指定的语言模型，请检查设置 novel.vscodeLm.family。';
    default:
      return `VS Code 语言模型错误：${err.message}`;
  }
}
