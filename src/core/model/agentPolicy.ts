/**
 * Agent 策略：**哪些动作要先问一句作者。**
 *
 * 与 `tiers.ts` 同一个位置的东西——类型、可选值、界面上的说法都在数据层
 * 定义一次，判定逻辑（`gateFor`）在 [agent/policy.ts](../agent/policy.ts)。
 * 这样 `config.ts` 与 `protocol/` 不必依赖 agent 层。
 *
 * **策略只管「要不要先问」，管不着保护。** 八条守卫、覆盖前审阅、批量动作
 * 的「预计调用 N 次」确认框在任何模式下都在——那是产品承诺（第 3 / 4 / 19
 * 条），不是偏好设置。最放手的模式也不会让 agent 静默覆盖作者写过的东西。
 */

export type AgentPolicy = 'careful' | 'default' | 'bold';

export const AGENT_POLICIES: AgentPolicy[] = ['careful', 'default', 'bold'];

/**
 * 缺省是「默认」：查资料与生成自动跑，**落盘前问一句**。
 *
 * 不缺省成「放手」的理由是第 19 条：产物落盘前必须过一遍人。第一次用 agent
 * 的人不该在还没建立信任之前，就发现它已经往磁盘上写了七份东西。
 */
export const DEFAULT_AGENT_POLICY: AgentPolicy = 'default';

/** 设置页与日志共用这一份说法，前端不另写。 */
export const AGENT_POLICY_LABEL: Record<AgentPolicy, string> = {
  careful: '谨慎',
  default: '默认',
  bold: '放手',
};

export const AGENT_POLICY_HINT: Record<AgentPolicy, string> = {
  careful: '每次调模型、每次落盘都先问你一句',
  default: '查资料与生成自动跑，落盘前问你一句',
  bold: '除了覆盖已有内容，都不打断你',
};

export function isAgentPolicy(value: unknown): value is AgentPolicy {
  return typeof value === 'string' && (AGENT_POLICIES as string[]).includes(value);
}
