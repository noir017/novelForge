import { NovelProject } from '../../model/project';
import { NovelConfig } from '../../model/types';
import { BuildRequest, ContextItem, LayerSpec } from '../types';
import type { Focus } from './focus';

/** 各层共享的可变状态。预算是一条流水线上的余额，层按配方顺序扣。 */
export interface Assembly {
  readonly project: NovelProject;
  readonly request: BuildRequest;
  readonly config: NovelConfig;
  readonly focus: Focus;
  readonly budget: number;
  /** 剩余预算。**层可以直接改它**——降级路径需要自己算完再扣。 */
  remaining: number;
  readonly items: ContextItem[];
  readonly excluded: ReadonlySet<string>;
  /** 常规注入：算 token、判余额、登记。放不下就记为 dropped。 */
  admit(item: Omit<ContextItem, 'tokens' | 'status'>, opts?: { force?: boolean }): ContextItem;
  /** 已自行算好 token 的条目（降级路径）：登记并扣余额。 */
  accept(item: Omit<ContextItem, 'tokens'>, tokens: number): void;
  /** 装不下 / 被排除：登记原因，不扣余额。**绝不静默丢弃。** */
  reject(item: Omit<ContextItem, 'tokens' | 'status'>, status: 'dropped' | 'excluded', note: string): void;
  /** 跨层协调的便签，只有两处用得上。 */
  scratch: { prevTail?: ContextItem; fullTextOrders: Set<number> };
}

export type LayerFn = (a: Assembly, spec: LayerSpec) => Promise<void>;
