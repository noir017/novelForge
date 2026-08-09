/**
 * 常用服务商预设与几张对照表。
 *
 * 点一下预设添加**一整个服务商**（含几个常用模型），而不是覆盖当前配置——
 * 多服务商并存本来就是重点。
 */
import type { SerializedProvider } from '../../protocol';

export const KIND_LABEL: Record<string, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  'vscode-lm': 'VS Code 语言模型',
};

/** 设置页上的数字输入框：配置项名 -> 页面上的 id。 */
export const BUDGET_FIELDS = {
  contextWindow: 'setContextWindow',
  maxOutputTokens: 'setMaxOutputTokens',
  temperature: 'setTemperature',
  recentChaptersFullText: 'setRecentChaptersFullText',
  prevChapterTailChars: 'setPrevChapterTailChars',
  summaryBatchSize: 'setSummaryBatchSize',
  requestTimeoutMs: 'setRequestTimeoutMs',
  concurrency: 'setConcurrency',
  fallbackAttempts: 'setFallbackAttempts',
} as const;

export type BudgetField = keyof typeof BUDGET_FIELDS;

export const PRESETS: SerializedProvider[] = [
  {
    id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1',
    models: [{ name: 'gpt-4o', contextWindow: 128000 }, { name: 'gpt-4o-mini', contextWindow: 128000 }],
  },
  {
    id: 'deepseek', label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    models: [{ name: 'deepseek-chat', contextWindow: 64000 }, { name: 'deepseek-reasoner', contextWindow: 64000 }],
  },
  {
    id: 'glm', label: '智谱 GLM', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [{ name: 'glm-4-plus', contextWindow: 128000 }, { name: 'glm-4-air', contextWindow: 128000 }],
  },
  {
    id: 'kimi', label: 'Kimi', kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1',
    models: [{ name: 'moonshot-v1-128k', contextWindow: 128000 }],
  },
  {
    id: 'qwen', label: '通义千问', kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [{ name: 'qwen-max', contextWindow: 32000 }, { name: 'qwen-long', contextWindow: 1000000 }],
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    // OpenRouter 的模型名自带斜杠，正好验证「只切第一个斜杠」。
    models: [
      { name: 'z-ai/glm-4.6', contextWindow: 200000 },
      { name: 'anthropic/claude-sonnet-4.5', contextWindow: 200000 },
    ],
  },
  {
    id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com',
    models: [{ name: 'claude-sonnet-4-5', contextWindow: 200000 }],
  },
  {
    id: 'ollama', label: '本地 Ollama', kind: 'openai', baseUrl: 'http://localhost:11434/v1',
    models: [{ name: 'qwen2.5:14b', contextWindow: 32000 }],
  },
  {
    id: 'copilot', label: 'VS Code 语言模型', kind: 'vscode-lm',
    models: [{ name: 'gpt-4o' }, { name: 'claude-3.5-sonnet' }],
  },
];
