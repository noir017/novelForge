import { readConfig } from '../config';
import { describeError, scoped } from '../logger';
import { describeModelIssue, resolveModelRef } from '../model/providers';
import { buildProvider } from './registry';
import { CancelledError, LlmProvider } from './provider';

const log = scoped('模型池');

/**
 * 工程页后台任务的取模型入口。
 *
 * 「默认模型」是一个**有序列表**（设置页可排序），这里把它变成两种能力：
 *
 * - **随机 fallback**：串行调用恒从第一个模型起；失败了就在**其余**模型里
 *   随机挑一个重试，最多 `fallbackAttempts` 次。单一模型 429 或抽风，
 *   不该让一次「同步 76 章摘要」整批断在第 30 章。
 * - **轮转负载均衡**：并发调用按游标在列表里轮转，把请求摊到几个服务商上，
 *   这正是并发跑得起来的前提（单个服务商的限流额度往往撑不住 3 路并发）。
 *
 * 只有工程页任务走这里。对话页续写不走——作者在下拉框里选了哪个模型，
 * 就必须是哪个模型写的正文，中途偷偷换人会让文风断掉。
 */
export interface ModelPool {
  /** 池里真正可用的引用，按配置顺序。至少一项。 */
  readonly refs: string[];
  readonly size: number;
  /** 给确认框与日志用的一句话，如「glm/glm-4-plus 等 3 个模型」。 */
  readonly label: string;
  /** 首选模型的 provider，供「模型 X」这类展示用。 */
  readonly primary: LlmProvider;
  /**
   * 跑一次带 fallback 的调用。
   *
   * @param what 出错时写进日志的对象描述，如「第 12 章」「角色卡「林昭」」。
   * @param fn   拿到 provider 与它的引用；同一个 fn 可能被换模型重跑，
   *             因此**必须是幂等的**（只读上下文 + 调模型，别在里面写盘）。
   */
  run<T>(what: string, fn: (llm: LlmProvider, ref: string) => Promise<T>): Promise<T>;
}

export interface ModelPoolOptions {
  /**
   * 是否按轮转取起始模型。并发任务传 true（负载均衡），
   * 串行任务传 false（恒用首选，与「默认模型」的直觉一致）。
   */
  concurrent?: boolean;
}

/**
 * 按当前设置构造模型池。
 *
 * 返回 undefined 表示一个可用模型都没有——调用方沿用既有的
 * 「没有可用的模型，XX 中止」分支即可，不必新增错误路径。
 *
 * 构造策略上有一条硬约束：**只有首选模型缺 Key 时才弹输入框**。
 * 备选模型一律静默构造，缺 Key / 环境不支持就剔除并 warn——
 * 一次点击连弹五个 API Key 输入框，比没有 fallback 更让人恼火。
 */
export async function createModelPool(opts: ModelPoolOptions = {}): Promise<ModelPool | undefined> {
  const config = readConfig();
  const entries: { ref: string; llm: LlmProvider }[] = [];
  const dropped: string[] = [];

  for (const [i, ref] of config.models.entries()) {
    const active = resolveModelRef(config.providers, ref);
    if (!active) {
      dropped.push(`${ref}（${describeModelIssue(config.providers, ref)}）`);
      continue;
    }
    // 首选照旧可以弹 Key 输入框；其余静默。
    const llm = await buildProvider(active, { promptForKey: i === 0 });
    if (!llm) {
      dropped.push(`${ref}（未取得 API Key 或当前环境不支持）`);
      continue;
    }
    entries.push({ ref: active.ref, llm });
  }

  if (dropped.length > 0) {
    // 「不静默截断」：池里少了谁、为什么少，必须说出来。
    log.warn(`${dropped.length} 个默认模型不可用，已排除在外`, dropped.join('\n'));
  }
  if (entries.length === 0) {
    log.error(
      '默认模型列表里没有一个可用的模型',
      config.models.length === 0
        ? '设置页的「默认模型」还是空的。'
        : `已配置：${config.models.join('、')}`
    );
    return undefined;
  }

  return new RoundRobinPool(entries, config.fallbackAttempts, opts.concurrent === true);
}

class RoundRobinPool implements ModelPool {
  private cursor = 0;

  constructor(
    private readonly entries: { ref: string; llm: LlmProvider }[],
    private readonly fallbackAttempts: number,
    private readonly concurrent: boolean
  ) {}

  get refs(): string[] {
    return this.entries.map((e) => e.ref);
  }

  get size(): number {
    return this.entries.length;
  }

  get label(): string {
    const [first, ...rest] = this.entries;
    return rest.length === 0 ? first.ref : `${first.ref} 等 ${this.entries.length} 个模型`;
  }

  get primary(): LlmProvider {
    return this.entries[0].llm;
  }

  async run<T>(what: string, fn: (llm: LlmProvider, ref: string) => Promise<T>): Promise<T> {
    // 起始模型：并发轮转，串行恒取首选。
    const startIndex = this.concurrent ? this.cursor++ % this.entries.length : 0;
    const tried = new Set<number>();
    let index = startIndex;
    // 只有一个模型时换谁都是它自己，重试只是白烧一次 token。
    const maxRetries = this.entries.length > 1 ? this.fallbackAttempts : 0;

    for (let attempt = 0; ; attempt++) {
      tried.add(index);
      const entry = this.entries[index];
      try {
        return await fn(entry.llm, entry.ref);
      } catch (err) {
        // 用户点了停止：立刻上抛，换模型重试只会让「停止」看起来失灵。
        if (err instanceof CancelledError || (err as Error)?.name === 'CancelledError') {
          throw err;
        }
        const nextIndex = this.pickFallback(tried);
        if (attempt >= maxRetries || nextIndex === undefined) {
          throw err;
        }
        log.warn(
          `${what}：${entry.ref} 失败，改用 ${this.entries[nextIndex].ref} 重试（第 ${attempt + 1}/${maxRetries} 次）`,
          describeError(err)
        );
        index = nextIndex;
      }
    }
  }

  /** 从没试过的模型里随机挑一个。全试过了返回 undefined。 */
  private pickFallback(tried: Set<number>): number | undefined {
    const candidates = this.entries.map((_, i) => i).filter((i) => !tried.has(i));
    if (candidates.length === 0) {
      return undefined;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
}
