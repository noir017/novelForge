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

// ---------------------------------------------------------------- 受众

/**
 * 这一份技能是**写给谁读的**。
 *
 * ## 为什么它与档位是两件事
 *
 * 档位（上面那四档）回答的是「这一份占不占 agent 每一轮的预算」——那是作者
 * 按成本做的选择。受众回答的是**另一个问题**：这套方法论是给 agent 用的，
 * 还是给创作模型用的。
 *
 * | 受众 | 谁读它的正文 | 怎么用 |
 * |---|---|---|
 * | `agent` | agent 自己 | 它用 `skill` 工具读进来，再按说的调那几个工具 |
 * | `generate` | **被调用的创作模型** | agent 调 `generate` 时把名字填进 `skills`，正文直接进创作上下文 |
 *
 * 分这一刀的理由是**这两种方法论根本不是一回事**：
 *
 * - 「跨章核对伏笔」是一套**动作**——搜哪几个词、按章号排、结论落到哪个文件。
 *   它要有工具才做得成，所以读者只能是 agent。
 * - 「章尾钩子怎么选、AI 味的句式怎么改」是一套**写法**——它要在落笔那一刻
 *   生效。让 agent 读进来，它能做的也只是把这几千字转述给创作模型，中间还多
 *   烧一遍 agent 上下文的钱。**该读它的是真正在写的那个模型。**
 *
 * 所以 `generate` 那一类的正文**永远不进 agent 的上下文**：索引里只给 agent
 * 一个名字加一句描述，让它知道有这么一套写法、什么时候该带上；带不带、带哪
 * 一份，由它按这一次要产出什么来判断（写正文别带排大纲的方法）。
 *
 * ## 缺省是 `agent`
 *
 * frontmatter 不写 `audience:` 就是 `agent`——现有那两份内置技能正是这一类，
 * 而「不声明就是给 agent 的」也与 `skill` 工具一直以来的行为一致。
 */
export type SkillAudience = 'agent' | 'generate';

export const SKILL_AUDIENCES: SkillAudience[] = ['agent', 'generate'];

export const DEFAULT_SKILL_AUDIENCE: SkillAudience = 'agent';

/** 设置页与日志共用这一份说法，前端不另写。 */
export const SKILL_AUDIENCE_LABEL: Record<SkillAudience, string> = {
  agent: '给 agent',
  generate: '给创作模型',
};

export const SKILL_AUDIENCE_HINT: Record<SkillAudience, string> = {
  agent: 'agent 用 skill 工具读进来，按它说的调工具做事',
  generate: 'agent 不读它，只在调 generate 时把名字带上——正文直接进创作模型的上下文',
};

export function isSkillAudience(value: unknown): value is SkillAudience {
  return typeof value === 'string' && (SKILL_AUDIENCES as string[]).includes(value);
}

/**
 * 这一份要不要出现在 agent 每轮的索引里。**两类各有一套判据。**
 *
 * - `agent` 类沿用 {@link isAgentVisible}：缺省「仅用户」不进索引，作者呼出才用。
 *   那一档成立的前提是**呼出时整份正文直接进这一轮**，agent 不必先知道它存在。
 * - `generate` 类只认 `off`。它的正文本来就不进 agent 的上下文（索引里那一行是
 *   名字加一句描述，几十个 token），而**少了那一行 agent 就永远不会把它带给
 *   `generate`**——那一档等于把技能装了却关掉。所以这一类不吃「仅用户」：
 *   作者要收起来，用「禁用」。
 */
export function isIndexed(audience: SkillAudience, mode: SkillMode): boolean {
  return audience === 'generate' ? mode !== 'off' : isAgentVisible(mode);
}
