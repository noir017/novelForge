/**
 * 技能：给 agent 一份「怎么做某类事」的工作流说明，**按需读**，不占每一轮的 token。
 *
 * ## 它与提示词是两种东西
 *
 * | | 提示词（`context/prompts.ts`） | 技能 |
 * |---|---|---|
 * | 谁读 | 被调用的模型，每次生成都注入 | agent，需要时才读 |
 * | 内容 | 「你是谁、这一次产出什么、什么形状」 | 「怎么判断好坏、怎么修、改哪个文件」 |
 * | 长度 | 必须短，占的是作者的 token 预算 | 可以长，不进生成上下文 |
 *
 * **方法论放技能，结论放提示词。** 这也是为什么技能不进 `AGENT_SYSTEM`：
 * 那一份每回合都要重发，而十次里有九次用不上。
 *
 * ## 两个来源
 *
 * | 来源 | 位置 | 谁维护 |
 * |---|---|---|
 * | 内置 | `src/skills/<名>/SKILL.md` → 构建时烘成 {@link BUILTIN_SKILLS} | 我们，随应用发布 |
 * | 工程 | `.novelforge/skills/<名>/SKILL.md` | 作者自己写 |
 *
 * 内置那一半为什么必须烘成常量（三个壳的资源路径各不相同，其中一个根本没有
 * 「路径」这回事）写在 [scripts/build-skills.js](../../../scripts/build-skills.js)。
 *
 * 工程那一半不需要任何新东西：`.novelforge/skills/**` 在工程根之内，`guardRead`
 * 直接放行；`kindOfPath` 把它判成 `other`（工程页不显示、装配器不读），这是对的
 * ——技能不是创作产物。
 *
 * ## 名字总是带来源前缀
 *
 * `builtin:chapter-review` / `project:我的审章流程`。**前缀恒在**，不是只在撞名时
 * 才加：这样同一份技能在任何工程里的叫法都一样，模型不必猜这一次要不要带前缀。
 * 两个来源同名时**两份都列**，各带各的前缀，谁也不盖谁。
 *
 * ## 索引一轮只扫一次盘
 *
 * `system` 是每回合重拼的（`brief()` 每回合重读磁盘，因为作者可能正在另一个窗口
 * 改文件）。**技能索引不跟着重建**：一轮开始时扫一次，这一轮之内逐字不变，
 * 拼在 `AGENT_SYSTEM` 之后、`brief()` 之前。
 *
 * 两条理由：
 *
 * 1. **它不该变**。作者中途新建一个技能，本轮不认、下一轮才认——技能是方法论
 *    不是状态，中途换掉会让 agent 的判据在一轮之内漂移。
 * 2. **将来接 prompt caching 时断点就在这里**。把易变的东西排在稳定的东西之后，
 *    是接缓存的前提；反过来（索引每回合重扫重拼）会让这个断点做不出来。
 *
 * ## 索引只列名字
 *
 * 一次 `readdir`（工程那一半）加一次 `Object.keys()`（内置那一半），**零文件读取**。
 *
 * 代价说清楚：模型只看到名字，看不到「什么时候该用」。所以**技能名必须自带
 * 触发力**——`chapter-review` 好过 `reviewer`，`审章找AI味` 好过 `流程1`。
 * 若实测发现模型选不准，下一步是往索引里加一行描述，**而不是**回头去做模糊匹配。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import type { NovelProject } from '../model/project';
import { BUILTIN_SKILLS } from './builtin';

const log = scoped('技能');

export { BUILTIN_SKILLS };

/** 入口文件名。与 `scripts/build-skills.js` 那边的约定同一个字。 */
export const SKILL_ENTRY = 'SKILL.md';

/** 工程内技能的目录，在工程根之下（所以 `read` 够得着它们的 `references/`）。 */
export const PROJECT_SKILLS_DIR = '.novelforge/skills';

/** 来源前缀。**恒在**，不是只在撞名时才加。 */
export type SkillSource = 'builtin' | 'project';

export interface SkillRef {
  /** 带前缀的全名，`builtin:chapter-review`。模型看到的就是这个。 */
  name: string;
  source: SkillSource;
  /** 不带前缀的那一半，也就是目录名。 */
  stem: string;
}

/**
 * 扫出这个工程能用的全部技能。**只列名字，不读任何一份正文。**
 *
 * 内置那一半是 `Object.keys()`；工程那一半是一次 `readdir`——**不去确认每个
 * 目录里真有 `SKILL.md`**（那是 N 次 `stat`）。取不到的名字由 {@link readSkill}
 * 当场回一句 error，模型据此换一个，比开局多花 N 次系统调用划算。
 *
 * 排序：内置在前、工程在后，各自按名字排。顺序稳定，索引才在一轮之内逐字不变。
 */
export async function listSkills(project: NovelProject): Promise<SkillRef[]> {
  const builtin = Object.keys(BUILTIN_SKILLS)
    .sort()
    .map((stem): SkillRef => ({ name: `builtin:${stem}`, source: 'builtin', stem }));

  let dirs: string[] = [];
  try {
    const entries = await fs.readdir(path.join(project.root, PROJECT_SKILLS_DIR), {
      withFileTypes: true,
    });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // 没有这个目录是最常见的情况（绝大多数工程不会自己写技能），不是错误。
    dirs = [];
  }
  const project_ = dirs
    .sort()
    .map((stem): SkillRef => ({ name: `project:${stem}`, source: 'project', stem }));

  return [...builtin, ...project_];
}

/**
 * 索引：拼进 system 的那一段。**一轮只调一次**（`agent/loop.ts` 开局）。
 *
 * 一个技能都没有时返回空串，调用方据此整段不拼——比拼一句「（没有可用的技能）」
 * 好：那句话每回合都要发，而它什么都没告诉模型。
 */
export function describeSkills(skills: SkillRef[]): string {
  if (skills.length === 0) {
    return '';
  }
  return [
    '# 可用技能',
    '',
    '技能是「这类事该怎么做」的工作流说明。判断这一轮要做的事有对应技能时，' +
      '先用 skill 工具把它读进来，再按它说的做。名字要**逐字照抄**（含前缀）：',
    '',
    ...skills.map((s) => `- ${s.name}`),
  ].join('\n');
}

/** 取正文的结果。**不抛**——取不到是一句模型照着改得动的话。 */
export type SkillRead =
  | { ok: true; ref: SkillRef; text: string }
  | { ok: false; error: string };

/**
 * 取一份技能的 `SKILL.md` 正文。
 *
 * **不做模糊匹配**：猜错时模型会拿到一份自己没想要的技能，而且不会知道。
 * 名字对不上就回一句 error，并列出实际有哪些——名单从**实际扫到的那一份**来，
 * 写死一串名字，加了技能之后这句话就在撒谎（`tools/registry.ts` 那句
 * 「没有叫 X 的工具」是同一个做法）。
 *
 * 只回 `SKILL.md` 正文，**不回 `references/`**：工程内技能的附件由模型自己用
 * `read` 去取（技能正文里写着相对路径），内置技能没有附件。
 */
export async function readSkill(
  project: NovelProject,
  skills: SkillRef[],
  wanted: string
): Promise<SkillRead> {
  const name = (wanted ?? '').trim();
  const ref = skills.find((s) => s.name === name);
  if (!ref) {
    return { ok: false, error: unknownSkill(name, skills) };
  }

  if (ref.source === 'builtin') {
    const text = BUILTIN_SKILLS[ref.stem];
    if (text === undefined) {
      // 索引是从同一个对象来的，走不到这里；真走到了说明常量被生成坏了。
      return { ok: false, error: `技能 ${ref.name} 的内容缺失，这是一个 bug。换一个技能。` };
    }
    return { ok: true, ref, text };
  }

  // 工程那一半：**不经 `Workspace.read`**。那条路会把内容按种类解析、还带行号，
  // 而这里要的是原文——技能是一份说明，不是产物。越界不可能发生（路径是我们
  // 用扫出来的目录名拼的），大小与存在性在这里各判一次就够。
  const rel = `${PROJECT_SKILLS_DIR}/${ref.stem}/${SKILL_ENTRY}`;
  try {
    const text = await fs.readFile(path.join(project.root, rel), 'utf8');
    return { ok: true, ref, text };
  } catch (err) {
    log.debug(`读不到技能 ${ref.name}`, rel);
    return {
      ok: false,
      error:
        `${ref.name} 这个目录下没有 ${SKILL_ENTRY}（${rel}）。` +
        `一个技能 = 一个目录 + 里面的 ${SKILL_ENTRY}。换一个技能，或者直接做这件事。` +
        (err instanceof Error && !/ENOENT/.test(err.message) ? `（${err.message}）` : ''),
    };
  }
}

/**
 * 「没有叫 X 的技能」那句话。**名单从实际扫到的那一份来。**
 *
 * 名字为空也走这条：模型漏填参数与填错名字要给同一份名单，它下一步都是从里面挑。
 */
function unknownSkill(name: string, skills: SkillRef[]): string {
  const available =
    skills.length > 0
      ? `可用的是：${skills.map((s) => s.name).join(' / ')}。`
      : '这个工程里一个技能都没有。';
  const head = name ? `没有叫 ${name} 的技能。` : 'name 是必填的：给一个技能名。';
  return `${head}${available}名字要逐字照抄，含 builtin: / project: 前缀。`;
}
