/**
 * 常用服务商预设与几张对照表。
 *
 * 点一下预设添加**一整个服务商**（含几个常用模型），而不是覆盖当前配置——
 * 多服务商并存本来就是重点。
 *
 * ## 为什么这里只剩三个预设
 *
 * 两种协议现在各自认一条路：openai 走 **Responses**（`/responses`，Codex 那
 * 一套），anthropic 走 **Messages**。思考深度只在这两条路上有落点，所以两条
 * 老路（`/chat/completions`）不再保留。DeepSeek、智谱、Kimi、通义、本地
 * Ollama 只认 `/chat/completions`，留着它们的预设等于在「添加服务商」里摆几个
 * 点了就 404 的按钮——那比找不到更让人恼火。要用它们仍然可以手工添加（配一个
 * 自己那侧的 `/responses` 兼容网关地址）。
 */
import type { SerializedProvider } from '../../protocol';

export const KIND_LABEL: Record<string, string> = {
  openai: 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
  'vscode-lm': 'VS Code 语言模型',
};

/** 设置页上的数字输入框：配置项名 -> 页面上的 id。 */
export const NUMERIC_FIELDS = {
  temperature: 'setTemperature',
  recentChaptersFullText: 'setRecentChaptersFullText',
  prevChapterTailChars: 'setPrevChapterTailChars',
  summaryBatchSize: 'setSummaryBatchSize',
  requestTimeoutMs: 'setRequestTimeoutMs',
  concurrency: 'setConcurrency',
  fallbackAttempts: 'setFallbackAttempts',
} as const;

export type NumericField = keyof typeof NUMERIC_FIELDS;

export const PRESETS: SerializedProvider[] = [
  {
    id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1',
    models: [{ name: 'gpt-4o', contextWindow: 128000 }, { name: 'gpt-4o-mini', contextWindow: 128000 }],
  },
  {
    id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com',
    models: [{ name: 'claude-sonnet-4-5', contextWindow: 200000 }],
  },
  {
    id: 'copilot', label: 'VS Code 语言模型', kind: 'vscode-lm',
    models: [{ name: 'gpt-4o' }, { name: 'claude-3.5-sonnet' }],
  },
];
