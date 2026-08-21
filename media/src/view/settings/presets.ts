/**
 * 常用服务商预设与几张对照表。
 *
 * 点一下预设添加**一整个服务商**（含几个常用模型），而不是覆盖当前配置——
 * 多服务商并存本来就是重点。
 *
 * ## 四种协议，两种是 OpenAI 的
 *
 * `openai` 是**通用 `/chat/completions`**——生态里说「OpenAI 兼容」指的就是
 * 它，第三方服务商几乎只认这一条，所以这个名字归它，预设里的大多数也走它。
 * `openai-responses` 是 OpenAI 的 Responses（`/responses`，Codex 那一套），
 * 目前基本只有官方与少数网关有。
 *
 * 思考深度三条协议都有落点，只是通用那条上「想多深」各家的字段名不一样
 * （见 `thinkingStyle`）：缺省自动协商，猜错了可以在弹窗里钉死。所以这里
 * 不再需要「点了就 404 的按钮」那套取舍——国产与本地那几家可以照常摆出来。
 */
import type { SerializedProvider } from '../../protocol';

export const KIND_LABEL: Record<string, string> = {
  openai: 'OpenAI 通用（chat/completions）',
  'openai-responses': 'OpenAI Responses',
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

/**
 * 预设里**带上 `thinkingStyle`**：这几家认哪一套字段是已知的事实，让作者
 * 白等几次 400 去重新问一遍没有道理。自己填地址的服务商仍然走自动协商。
 */
export const PRESETS: SerializedProvider[] = [
  {
    id: 'openai', label: 'OpenAI', kind: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
    models: [{ name: 'gpt-4o', contextWindow: 128000 }, { name: 'gpt-4o-mini', contextWindow: 128000 }],
  },
  {
    id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com',
    models: [{ name: 'claude-sonnet-4-5', contextWindow: 200000 }],
  },
  {
    id: 'deepseek', label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    thinkingStyle: 'thinking',
    models: [{ name: 'deepseek-chat', contextWindow: 128000 }],
  },
  {
    id: 'glm', label: '智谱 GLM', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    thinkingStyle: 'thinking',
    models: [{ name: 'glm-4.6', contextWindow: 200000 }],
  },
  {
    id: 'kimi', label: 'Kimi（月之暗面）', kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1',
    thinkingStyle: 'effort',
    models: [{ name: 'kimi-k2-turbo-preview', contextWindow: 128000 }],
  },
  {
    id: 'qwen', label: '通义千问', kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    thinkingStyle: 'enable',
    models: [{ name: 'qwen-plus', contextWindow: 128000 }],
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    thinkingStyle: 'reasoning',
    models: [{ name: 'z-ai/glm-4.6', contextWindow: 200000 }],
  },
  {
    id: 'ollama', label: '本地 Ollama', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1',
    thinkingStyle: 'effort',
    models: [{ name: 'qwen3:8b', contextWindow: 32768 }],
  },
  {
    id: 'copilot', label: 'VS Code 语言模型', kind: 'vscode-lm',
    models: [{ name: 'gpt-4o' }, { name: 'claude-3.5-sonnet' }],
  },
];
