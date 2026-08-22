/**
 * 技能的注入方式：**这一份技能，agent 每一轮看得到多少。**
 *
 * 与 `agentPolicy.ts` 同一个位置的东西——类型、可选值、界面上的说法在数据层
 * 定义一次（`config.ts`、`protocol/` 与设置页都要用，它们不该依赖 `skills/`），
 * 判定与拼装在 [core/skills/](../skills/index.ts)。
 *
 * ## 四档，分的是两件独立的事
 *
 * | 档 | agent 每轮看到 | 作者 `/` 呼得出来 |
 * |---|---|---|
 * | `user` | 什么都没有 | ✓（呼出时**整份正文**注入这一轮） |
 * | `title` | 名字 | ✓ |
 * | `full` | 名字 + 一句描述 | ✓ |
 * | `off` | 什么都没有 | ✗ |
 *
 * `user` 与 `off` 在 agent 那一侧完全一样，区别只在作者那一侧——所以它们不是
 * 「关」的两种程度，而是两件事：**一个是「别占我的每轮预算」，一个是「这份先
 * 不用了」**。合成一档的话，作者想把某份技能收进抽屉就只能连呼出一起关掉。
 *
 * ## 为什么缺省是 `user`
 *
 * 技能的正文可以写得很长，代价是索引每一轮都要重发。`title` 一行也是钱，而
 * **十次里有九次那一行是白发的**——判断这一轮要不要用某份技能，作者比模型清楚
 * 得多（他知道自己接下来要干什么）。所以缺省把这个判断留给作者：他呼出来才注入。
 *
 * 反过来说，`title` / `full` 是**明确的加钱选择**：某份技能作者希望 agent 自己
 * 认出时机（比如「每次改完设定都核一遍连续性」），那就值得每轮发那一行。
 */

export type SkillMode = 'user' | 'title' | 'full' | 'off';

export const SKILL_MODES: SkillMode[] = ['user', 'title', 'full', 'off'];

/**
 * 缺省「仅用户」：**新装一份技能不会让每一轮变贵。**
 *
 * 这也是「方法论可以写得很长」这个前提的兑现方式——写多长都不进每轮上下文，
 * 直到作者主动呼出。
 */
export const DEFAULT_SKILL_MODE: SkillMode = 'user';

/** 设置页与日志共用这一份说法，前端不另写。 */
export const SKILL_MODE_LABEL: Record<SkillMode, string> = {
  user: '仅用户',
  title: '仅标题',
  full: '完整',
  off: '禁用',
};

export const SKILL_MODE_HINT: Record<SkillMode, string> = {
  user: 'agent 看不见它；你用 / 呼出时，整份正文进这一轮',
  title: '每轮让 agent 看到名字，它自己判断要不要用 skill 工具读正文',
  full: '名字加一句描述都进每一轮：它更容易选对，代价是每轮都发这两行',
  off: '两边都看不到，/ 里也不列',
};

export function isSkillMode(value: unknown): value is SkillMode {
  return typeof value === 'string' && (SKILL_MODES as string[]).includes(value);
}

/** agent 每轮的索引里有没有它。`user` 与 `off` 都没有。 */
export function isAgentVisible(mode: SkillMode): boolean {
  return mode === 'title' || mode === 'full';
}

/**
 * 每份技能各自的档位。键是**带前缀的全名**（`builtin:character-voice`）。
 *
 * 缺席 = {@link DEFAULT_SKILL_MODE}。所以只存与缺省不同的那几项（与 `taskTiers`
 * 同一套做法）：日后调整缺省值时，作者没动过的技能会跟着新缺省走。
 */
export type SkillModes = Record<string, SkillMode>;

/**
 * 配置里那份档位表的容错读取。认不出的档位名丢弃（那一项回落缺省）。
 *
 * **不剔除指向已删技能的键**：作者可能只是临时把 `.novelforge/skills/` 挪走了，
 * 清掉的话他挪回来时那份技能的档位已经没了。多留几个键不花钱。
 *
 * 住在数据层而不是 `skills/`：`config.ts` 要用它，而 `skills/` 会 import
 * `node:fs` 与那份烘出来的常量——配置读取不该把那些一起拖进来。
 */
export function normalizeSkillModes(raw: unknown): SkillModes {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: SkillModes = {};
  for (const [name, mode] of Object.entries(source)) {
    if (name.trim() && isSkillMode(mode)) {
      out[name] = mode;
    }
  }
  return out;
}
