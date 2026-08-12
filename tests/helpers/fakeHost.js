/**
 * 可编程的假宿主。
 *
 * `src/core/host.ts` 的 `Host` 是 core 对宿主的唯一依赖面，交互方法
 * （input / confirm / pick / reviewReplace）在测试里按**队列**取答案：
 * 排了什么就答什么，没排队就当用户取消（返回 undefined）。
 *
 * 用法：
 *   const h = makeFakeHost();          // 基线：全部当用户取消
 *   bundle.host.initHost(h.host);
 *   h.expect('确定');                   // 下一次 confirm 答「确定」
 *   ...
 *   assert.ok(!h.erred());             // 没有 error 级 toast
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} [opts]
 * @param {'vscode'|'standalone'} [opts.name]
 * @param {boolean} [opts.supportsVscodeLm]
 * @param {object|(() => object)} [opts.settings] `config.read()` 的返回值
 * @param {object} [opts.overrides] 直接覆盖 Host 上的任意方法
 */
function makeFakeHost(opts = {}) {
  const {
    name = 'standalone',
    supportsVscodeLm = false,
    settings,
    overrides = {},
  } = opts;

  /** 交互答案队列：input / confirm / pick / reviewReplace 共用。 */
  const answers = [];
  /** 录制器 */
  const toasts = [];
  const confirms = [];
  const picks = [];
  const inputs = [];
  const reviewed = [];
  const opened = [];
  const progressCalls = [];

  /** reviewReplace 的默认结论；用例可改成 'discard' / undefined。 */
  const state = { reviewVerdict: 'apply' };

  /** 并发观察：同一时刻在跑的 reviewReplace 数与峰值。 */
  let reviewInFlight = 0;
  let reviewPeak = 0;
  /** reviewReplace 里的人为延时，用来让重入真的可观察。 */
  let reviewDelayMs = 0;

  const readSettings = () => {
    if (typeof settings === 'function') return settings();
    return settings ?? {};
  };

  const host = {
    name,
    supportsVscodeLm,
    config: { read: readSettings, write: async () => {} },

    input: async (o) => {
      inputs.push(o);
      return answers.shift();
    },
    confirm: async (message, actions, o) => {
      confirms.push({ message, actions, detail: o && o.detail });
      return answers.shift();
    },
    pick: async (choices, title) => {
      picks.push({ choices, title });
      return answers.shift();
    },
    progress: async (title, fn) => {
      const abort = new AbortController();
      return fn(abort.signal, (m) => progressCalls.push(`${title}｜${m}`));
    },
    watch: () => ({ dispose: () => {} }),
    openFile: async (p) => { opened.push(p); },
    toast: (m, level) => toasts.push(`${level ?? 'info'}: ${m}`),
    selectionAttachment: async () => undefined,
    reviewReplace: async (n, current, proposed) => {
      reviewInFlight++;
      reviewPeak = Math.max(reviewPeak, reviewInFlight);
      reviewed.push({ name: n, current, proposed });
      if (reviewDelayMs) await sleep(reviewDelayMs);
      reviewInFlight--;
      return state.reviewVerdict;
    },

    ...overrides,
  };

  return {
    host,
    answers, toasts, confirms, picks, inputs, reviewed, opened, progressCalls,

    /** 排队下一批答案，同时清空上一轮的录制。 */
    expect(...values) {
      answers.length = 0;
      toasts.length = 0;
      confirms.length = 0;
      picks.length = 0;
      inputs.length = 0;
      reviewed.length = 0;
      opened.length = 0;
      answers.push(...values);
    },
    /** 这一轮是否出现过 error 级 toast。 */
    erred() {
      return toasts.some((t) => t.startsWith('error:'));
    },
    setReviewVerdict(v) { state.reviewVerdict = v; },
    setReviewDelay(ms) { reviewDelayMs = ms; },
    reviewPeak: () => reviewPeak,
    resetPeaks() { reviewPeak = 0; reviewInFlight = 0; },
  };
}

module.exports = { makeFakeHost, sleep };
