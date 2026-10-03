/**
 * 假模型。
 *
 * 一律经 `registry.registerProviderFactory` 注入，并把服务商 `kind` 设成
 * `vscode-lm`：那是唯一一条走 factory 的路径，于是**不必碰 SecretStore** 就能塞进
 * 假模型（其余 kind 会去要 API Key，测试里会卡在输入框上）。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 一条应答可以是纯字符串（老用法），也可以是一个对象：
 *
 *   { text, stop?, reasoning?, chunks? }
 *
 * - `stop`：跟在正文之后发一条 `{ type: 'stop', reason }`（'end' / 'maxTokens' / 'other'）。
 *   续写要靠它区分「模型说完了」与「被输出上限截断」。不给就不发，与真实 provider
 *   里有的网关不报收尾原因一致。
 * - `reasoning`：先发一段思考，再发正文——测「思考把输出预算吃光」要用。
 * - `chunks`：把正文切成几片分别 yield，测流式拼接。
 */
function normalizeReply(item) {
  return typeof item === 'object' && item !== null ? item : { text: item ?? '' };
}

async function* emit(item) {
  const r = normalizeReply(item);
  if (r.reasoning) {
    yield { type: 'reasoning', text: r.reasoning };
  }
  const text = r.text ?? '';
  const n = Math.max(1, r.chunks ?? 1);
  const size = Math.ceil(text.length / n) || 1;
  for (let i = 0; i < text.length; i += size) {
    yield { type: 'text', text: text.slice(i, i + size) };
  }
  if (!text.length && !r.reasoning) {
    yield { type: 'text', text: '' };
  }
  if (r.stop) {
    yield { type: 'stop', reason: r.stop };
  }
}

/**
 * 造一段恰好 `n` 个字的中文正文，用来测字数门槛（「不到八成就续写」）。
 * `seed` 让不同轮的内容不重样——重演检测按 n-gram 认，重样的填充会被当成重演。
 * 末尾带一个句号（不计字数）：不收在句末标点上的正文会被当成停在半句上、自动续写。
 */
function filler(n, seed = 0) {
  const pool = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜';
  // 线性同余：确定性、不同 seed 出不同序列。按固定步长轮转的话，不同 seed
  // 只是同一圈的不同起点，8-gram 大面积重合，会被重演检测误判。
  let x = (seed + 1) * 2654435761 >>> 0;
  let out = '';
  while (out.length < n) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += pool[(x >>> 16) % pool.length];
  }
  return `${out}。`;
}

/**
 * @param {object} registry 载入的 `src/core/llm/registry.ts`
 * @param {object} [opts]
 * @param {Array<string|object>} [opts.replies] 应答队列（每条的形状见 `normalizeReply`）
 * @param {boolean} [opts.repeatLast] 队列见底后重复最后一条（默认 false：改用 fallback）
 * @param {string|object} [opts.fallback] 队列空时的应答
 * @param {(messages, index) => string|object} [opts.reply] 直接给一个函数，优先于 replies
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
            yield* emit(reply(messages, calls.length - 1));
            return;
          }
          const next = repeatLast && queue.length <= 1 ? queue[0] : queue.shift();
          yield* emit(next ?? fallback);
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

module.exports = { installFakeProvider, makeSettings, sleep, filler };
