import * as vscode from 'vscode';
import {
  AgentMessage,
  CancelledError,
  LlmError,
  LlmProvider,
  StreamEvent,
  StreamOptions,
  makeAbortSignal,
  normalizeError,
} from '../../core/llm/provider';

/**
 * 基于 VS Code Language Model API（复用 Copilot 订阅）。
 *
 * 三点与自建 API 不同：
 * 1. 没有独立的 system 角色，系统提示会并入首条 user 消息；
 * 2. 有硬性的 maxInputTokens 配额，装配器需要据此收紧预算；
 * 3. 工具参数**已经是解析好的对象**，不必像另外两家那样累积分片。
 */
export class VsCodeLmProvider implements LlmProvider {
  readonly id = 'vscode-lm' as const;

  private model: vscode.LanguageModelChat | undefined;

  /**
   * @param family 模型 family，如 `gpt-4o`、`claude-3.5-sonnet`。
   * @param providerName 服务商显示名，用于错误提示里指名道姓。
   */
  constructor(
    private readonly family: string,
    private readonly providerName = 'VS Code LM'
  ) {}

  get label(): string {
    return `${this.model?.name ?? this.family}（${this.providerName}）`;
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
          '没有可用的 VS Code 语言模型。请确认已安装并登录 GitHub Copilot，或在设置页改用自建 API 的服务商。'
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

  async *stream(messages: AgentMessage[], options: StreamOptions): AsyncIterable<StreamEvent> {
    const model = await this.resolveModel();
    const { signal, dispose, poke } = makeAbortSignal(options);
    const source = new vscode.CancellationTokenSource();
    // core 侧已统一为 AbortSignal，这里桥接回语言模型 API 需要的 token。
    const onAbort = () => source.cancel();
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const response = await model.sendRequest(
        toLmMessages(messages),
        {
          justification: 'Novel Forge 需要调用语言模型续写小说正文。',
          // 没有工具时一律不带这两个字段，与另外两家一致。
          ...(options.tools && options.tools.length > 0 && options.toolChoice !== 'none'
            ? {
                tools: options.tools.map((s) => ({
                  name: s.name,
                  description: s.description,
                  inputSchema: s.parameters,
                })),
                toolMode:
                  options.toolChoice === 'required'
                    ? vscode.LanguageModelChatToolMode.Required
                    : vscode.LanguageModelChatToolMode.Auto,
              }
            : {}),
        },
        source.token
      );
      poke();

      // 走 response.stream 而不是 response.text：后者把工具调用整段滤掉了。
      for await (const part of response.stream) {
        poke();
        if (part instanceof vscode.LanguageModelTextPart) {
          yield { type: 'text', text: part.value };
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          // input 已经是解析好的对象，不用累积、也没有坏 JSON 这一说。
          yield {
            type: 'toolCall',
            call: {
              id: part.callId,
              name: part.name,
              args: part.input as Record<string, unknown>,
              raw: JSON.stringify(part.input),
            },
          };
        }
      }
    } catch (err) {
      if (signal.aborted) {
        throw normalizeError(err, signal, this.label);
      }
      if (err instanceof vscode.CancellationError || source.token.isCancellationRequested) {
        throw new CancelledError();
      }
      if (err instanceof vscode.LanguageModelError) {
        throw new LlmError(translateLmError(err));
      }
      throw new LlmError(`VS Code 语言模型请求失败：${err instanceof Error ? err.message : String(err)}`, err);
    } finally {
      dispose();
      signal.removeEventListener('abort', onAbort);
      source.dispose();
    }
  }
}

/**
 * `AgentMessage[]` → VS Code 的消息数组。
 *
 * **系统提示并进首条 user** 是这个 provider 的特点而不是缺陷：LM API 根本
 * 没有 system 角色，不并进去这段提示就丢了。
 *
 * `tool` 消息走 User + `LanguageModelToolResultPart`（与 Anthropic 同一个
 * 道理：工具结果属于用户那一侧），`assistant` 的工具调用走 Assistant +
 * `LanguageModelToolCallPart`。
 */
function toLmMessages(messages: AgentMessage[]): vscode.LanguageModelChatMessage[] {
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const out: vscode.LanguageModelChatMessage[] = [];

  let systemMerged = !systemText;
  for (const m of rest) {
    if (m.role === 'tool') {
      out.push(
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(m.toolCallId, [
            new vscode.LanguageModelTextPart(m.content),
          ]),
        ])
      );
      continue;
    }
    if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
        if (m.content) {
          parts.push(new vscode.LanguageModelTextPart(m.content));
        }
        for (const c of m.toolCalls) {
          parts.push(new vscode.LanguageModelToolCallPart(c.id, c.name, c.args));
        }
        out.push(vscode.LanguageModelChatMessage.Assistant(parts));
      } else {
        out.push(vscode.LanguageModelChatMessage.Assistant(m.content));
      }
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
      return '请求被模型的内容策略拦截。可尝试调整纲要措辞，或在设置页切换到自建 API 的模型。';
    case vscode.LanguageModelError.NotFound.name:
      return '找不到指定的语言模型，请在设置页检查该服务商下配置的模型 family。';
    default:
      return `VS Code 语言模型错误：${err.message}`;
  }
}
