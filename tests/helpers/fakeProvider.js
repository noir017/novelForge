/**
 * 假模型。
 *
 * 一律经 `registry.registerProviderFactory` 注入，并把服务商 `kind` 设成
 * `vscode-lm`：那是唯一一条走 factory 的路径，于是**不必碰 SecretStore** 就能塞进
 * 假模型（其余 kind 会去要 API Key，测试里会卡在输入框上）。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} registry 载入的 `src/core/llm/registry.ts`
 * @param {object} [opts]
 * @param {string[]} [opts.replies] 应答队列
 * @param {boolean} [opts.repeatLast] 队列见底后重复最后一条（默认 false：改用 fallback）
 * @param {string} [opts.fallback] 队列空时的应答
 * @param {(messages, index) => string} [opts.reply] 直接给一个函数，优先于 replies
 * @param {Record<string, 'unavailable'|'fail'|'cancel'>} [opts.behavior] 按模型引用注入异常
 * @param {number} [opts.delayMs] 每次调用的人为延时——不留延时的话并发与串行跑出来一样
 * @param {object} [opts.errors] `{ LlmError, CancelledError }`，用到 behavior 时必须给
 */
function installFakeProvider(registry, opts = {}) {
  const {
    replies = [],
    repeatLast = false,
    fallback = '',
    reply,
    behavior = {},
    delayMs = 0,
    errors = {},
  } = opts;

  /** 每次调用的完整 messages，用来断言「装了什么进上下文」「调了几次」。 */
  const calls = [];
  const queue = [...replies];

  /** 并发观察：同一时刻在跑的请求数与峰值。 */
  let inFlight = 0;
  let peak = 0;

  registry.registerProviderFactory((active) => {
    const spec = behavior[active && active.ref];
    if (spec === 'unavailable') return undefined;
    return {
      id: 'vscode-lm',
      label: (active && active.ref) || '假模型',
      maxInputTokens: async () => undefined,
      stream: async function* (messages) {
        calls.push(messages);
        if (active) calls[calls.length - 1].ref = active.ref;
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          if (spec === 'fail') {
            throw new errors.LlmError(`${active.ref} 假装 429 限流`);
          }
          if (spec === 'cancel') {
            throw new errors.CancelledError();
          }
          if (delayMs) await sleep(delayMs);
          if (reply) {
            yield { type: 'text', text: reply(messages, calls.length - 1) };
            return;
          }
          const next = repeatLast && queue.length <= 1 ? queue[0] : queue.shift();
          yield { type: 'text', text: next ?? fallback };
        } finally {
          inFlight--;
        }
      },
    };
  });

  return {
    calls,
    /** 往队列后面补应答。 */
    push: (...items) => queue.push(...items),
    /** 重排队列。 */
    reset(items = []) {
      queue.length = 0;
      queue.push(...items);
      calls.length = 0;
      peak = 0;
    },
    peak: () => peak,
    callCount: () => calls.length,
  };
}

/**
 * 一份最小可用的设置：一个假服务商、一个模型。
 * `contextWindow` 调小可以逼出多批切分。
 */
function makeSettings(extra = {}) {
  return {
    providers: [{ id: 'fake', kind: 'vscode-lm', models: [{ name: 'm' }] }],
    models: ['fake/m'],
    contextWindow: 12000,
    maxOutputTokens: 500,
    concurrency: 1,
    ...extra,
  };
}

module.exports = { installFakeProvider, makeSettings, sleep };
