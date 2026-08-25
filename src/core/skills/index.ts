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
 * **方法论放技能，结论放提示词。**
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
 * ## 每一份各有一档注入方式
 *
 * 四档（见 [model/skillMode.ts](../model/skillMode.ts)）：`user` 只有作者用 `/`
 * 呼得出来、`title` 每轮给 agent 一个名字、`full` 名字加一句描述、`off` 两边都没有。
 * **缺省 `user`**——装一份技能不该让每一轮变贵。
 *
 * 这一层因此有两个出口，喂的是两拨人：
 *
 * | 出口 | 给谁 | 吃哪几档 |
 * |---|---|---|
 * | {@link describeSkills} | agent 每轮的 system | `title` / `full` |
 * | {@link listInvocableSkills} | 作者的 `/` 面板 | `user` / `title` / `full` |
 *
 * `off` 两边都不在。而 `user` 与 `off` 在 agent 那一侧完全一样——区别只在作者
 * 那一侧，所以它们是两件事，不是「关」的两种程度。
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
 * ## 描述是读出来的，不是猜的
 *
 * `full` 那一档要一句描述，来源是 `SKILL.md` 的 frontmatter `description`。
 * **只认这一个键**：名字由目录名决定（路径即身份），再从 frontmatter 读一遍
 * 就是给同一件事留两个真相。
 *
 * 内置那一半在构建时读好（`BUILTIN_SKILLS[x].description`），工程那一半要读盘
 * ——所以 {@link listSkills} 只在**真有 `full` 档**的技能时才去读那几个文件，
 * 见 `readProjectDescriptions`。缺省全是 `user`，那一趟一次都不跑。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scoped } from '../runtime/logger';
import type { NovelProject } from '../model/project';
import {
  DEFAULT_SKILL_AUDIENCE,
  DEFAULT_SKILL_MODE,
  SkillAudience,
  SkillMode,
  SkillModes,
  isIndexed,
  isSkillAudience,
} from '../model/skillMode';
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
  /** 带前缀的全名，`builtin:chapter-review`。模型与作者看到的都是这个。 */
  name: string;
  source: SkillSource;
  /** 不带前缀的那一半，也就是目录名。 */
  stem: string;
  /** 这一份的注入方式。配置里没有它就是缺省档。 */
  mode: SkillMode;
  /**
   * 写给谁读的（`agent` / `generate`）。**来自 frontmatter，不是配置**——
   * 受众是技能本身的属性（「去 AI 味」在任何工程里都是给创作模型的写法），
   * 而档位是作者按成本做的选择。
   */
  audience: SkillAudience;
  /**
   * frontmatter 里那一行描述。**可能是空串**（没写，或者写成了折行 YAML）。
   *
   * 只有 `full` 档的技能才会有值：其余几档谁都不显示描述，为它们读盘是白读。
   */
  description: string;
}

/**
 * 每份技能各自的档位。**类型与容错读取在数据层**
 * （[model/skillMode.ts](../model/skillMode.ts)）——`config.ts` 要用它们，
 * 而这个文件会 import `node:fs`。这里只是把名字接出去，省得调用方 import 两处。
 */
export type { SkillModes };
export {
  DEFAULT_SKILL_AUDIENCE,
  DEFAULT_SKILL_MODE,
  SKILL_AUDIENCES,
  SKILL_AUDIENCE_LABEL,
  SKILL_MODES,
  SKILL_MODE_LABEL,
  isSkillAudience,
  isSkillMode,
} from '../model/skillMode';
export type { SkillAudience, SkillMode };

/**
 * 扫出这个工程能用的全部技能，**含 `off` 那些**——设置页要列出来才改得动。
 * 挑给 agent / 挑给 `/` 的两份各自过滤（{@link describeSkills} /
 * {@link listInvocableSkills}）。
 *
 * 内置那一半是 `Object.keys()`；工程那一半是一次 `readdir`——**不去确认每个
 * 目录里真有 `SKILL.md`**（那是 N 次 `stat`）。取不到的名字由 {@link readSkill}
 * 当场回一句 error，模型据此换一个，比开局多花 N 次系统调用划算。
 *
 * **`project` 可以缺席**：独立版的空窗口里没有工程，而设置页那时也该能列出内置
 * 技能、改它们的档位。那种情况下工程那一半直接是空的——不是造一个假路径去
 * `readdir` 一次注定失败的目录。
 *
 * 排序：内置在前、工程在后，各自按名字排。顺序稳定，索引才在一轮之内逐字不变。
 */
export async function listSkills(
  project: NovelProject | undefined,
  modes: SkillModes = {}
): Promise<SkillRef[]> {
  const modeOf = (name: string): SkillMode => modes[name] ?? DEFAULT_SKILL_MODE;

  const builtin = Object.keys(BUILTIN_SKILLS)
    .sort()
    .map((stem): SkillRef => {
      const name = `builtin:${stem}`;
      return {
        name,
        source: 'builtin',
        stem,
        mode: modeOf(name),
        audience: BUILTIN_SKILLS[stem].audience,
        description: BUILTIN_SKILLS[stem].description,
      };
    });

  let dirs: string[] = [];
  if (project) {
    try {
      const entries = await fs.readdir(path.join(project.root, PROJECT_SKILLS_DIR), {
        withFileTypes: true,
      });
      dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      // 没有这个目录是最常见的情况（绝大多数工程不会自己写技能），不是错误。
      dirs = [];
    }
  }
  const own = dirs.sort().map((stem): SkillRef => {
    const name = `project:${stem}`;
    return {
      name,
      source: 'project',
      stem,
      mode: modeOf(name),
      audience: DEFAULT_SKILL_AUDIENCE,
      description: '',
    };
  });

  const all = [...builtin, ...own];
  if (own.length > 0 && project) {
    await readProjectHeads(project, own);
  }
  return all;
}

/**
 * 把工程技能的 `audience` 与 `description` 从 frontmatter 里读出来。
 *
 * ## 这一趟不能再按档位省掉
 *
 * 从前只有 `full` 那一档要描述，于是这里只为那几份读盘——缺省全是 `user` 时
 * 一次盘都不读，「索引零文件读取」成立。
 *
 * **受众打破了它**：索引要按受众分成两段列，而 `generate` 那一类连正文都不进
 * agent 的上下文——不先知道每一份是哪一类，这一刀就分不出来。所以工程技能
 * 每一份都要读一次。
 *
 * 代价压在两处：
 *
 * 1. **只读文件头**（{@link HEAD_BYTES}）。frontmatter 在最开头，几十字节就
 *    够；一份三万字的技能也只读这么多。
 * 2. **只有工程技能要读**。内置那一半在构建时就读好了（`BUILTIN_SKILLS`），
 *    而绝大多数工程一份自己的技能都没有——那时 `own` 是空的，这个函数根本不跑
 *    （调用方先判了 `own.length > 0`）。
 *
 * 读不出来（没有 `SKILL.md`、没写 frontmatter）就留缺省，不报错：`listSkills`
 * 不 `stat` 就是为了不在这里花钱，读不到照旧列名字，取正文时由 {@link readSkill}
 * 当场回一句 error。
 */
async function readProjectHeads(project: NovelProject, own: SkillRef[]): Promise<void> {
  await Promise.all(
    own.map(async (ref) => {
      try {
        const head = await readHead(pathOf(project, ref));
        ref.audience = audienceOf(head);
        ref.description = descriptionOf(head);
      } catch {
        // 目录空着。缺省是「给 agent」——两者中较保守的那个：它至少要 agent
        // 明确去读才生效，而误判成 generate 会让一份根本读不出来的技能被塞进
        // 创作上下文。
      }
    })
  );
}

/**
 * 读多少字节够看到 frontmatter。
 *
 * 4 KiB 是**远超需要**的一个数：frontmatter 通常不到 200 字节，而 oh-story 那批
 * 最长的 `description` 也就四五百字。取整页的理由只是没必要抠——这一趟本来就
 * 只在有工程技能时跑。
 */
const HEAD_BYTES = 4096;

/**
 * 读一个文件的开头几字节。
 *
 * 按字节截断可能把最后一个多字节字符切成两半，`toString('utf8')` 会在末尾留一个
 * U+FFFD。**这不影响 frontmatter**：它在最开头，而截断永远发生在 4 KiB 处。
 * 真有一份技能把 frontmatter 写到 4 KiB 之后，正则匹配不上，两个字段都回落缺省
 * ——与「没写 frontmatter」同一条路。
 */
async function readHead(file: string, bytes = HEAD_BYTES): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * 从 frontmatter 里抠一个键。**只认单行 `key: value`**（可带引号）。
 *
 * 与 `scripts/build-skills.js` 里那一份是同一个规则的两处实现——那边是
 * CommonJS、跑在 TS 编译之前，import 不动这里。两处都只支持 `key: value`，
 * 与 `model/markdown.ts` 那个轻量解析器同一套限制。
 */
function frontmatterValue(text: string, key: string): string {
  const fence = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fence) {
    return '';
  }
  const line = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(fence[1]);
  if (!line) {
    return '';
  }
  const raw = line[1].trim();
  const unquoted =
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
      ? raw.slice(1, -1)
      : raw;
  return unquoted.trim();
}

/** frontmatter 里那一行描述。**可能是空串**（没写，或者写成了折行 YAML）。 */
export function descriptionOf(text: string): string {
  return frontmatterValue(text, 'description');
}

/**
 * frontmatter 里那一行受众。**认不出的值一律回落缺省**，不报错。
 *
 * 拼错一个词不该让一份技能消失；而回落到「给 agent」是两者中较保守的那个
 * ——它至少要 agent 明确去读才生效。
 */
export function audienceOf(text: string): SkillAudience {
  const raw = frontmatterValue(text, 'audience');
  return isSkillAudience(raw) ? raw : DEFAULT_SKILL_AUDIENCE;
}

/**
 * 索引：拼进 system 的那一段。**一轮只调一次**（`agent/loop.ts` 开局）。
 *
 * ## 两段，因为读者是两拨
 *
 * | 段 | 列的是 | agent 拿它做什么 |
 * |---|---|---|
 * | 可用技能 | `agent` 类 | 用 `skill` 工具读进来，按它说的调工具 |
 * | 可交给创作模型的写作方法 | `generate` 类 | 调 `generate` 时填进 `skills` 参数 |
 *
 * 合成一段的话，agent 会拿 `skill` 去读第二类——那正是这一刀要避免的事：
 * 几千字的写法进 agent 的上下文，它能做的也只是转述一遍给创作模型，中间白烧
 * 一轮的钱。所以两段分开，各自把用法写在段首。
 *
 * ## 各段进不进索引的判据不同
 *
 * 见 `model/skillMode.ts` 的 `isIndexed`：`agent` 类只有 `title` / `full` 在
 * （`user` 是作者呼出的，呼出时整份正文直接进这一轮，agent 不必先知道）；
 * `generate` 类只要不是 `off` 就在——少了那一行 agent 永远不会把它带给
 * `generate`，等于装了却关掉。
 *
 * 两段都空时返回空串，调用方据此整段不拼——比拼一句「（没有可用的技能）」好：
 * 那句话每回合都要发，而它什么都没告诉模型。
 */
export function describeSkills(skills: SkillRef[]): string {
  const visible = skills.filter((s) => isIndexed(s.audience, s.mode));
  const blocks: string[] = [];

  const mine = visible.filter((s) => s.audience === 'agent');
  if (mine.length > 0) {
    blocks.push(
      [
        '# 可用技能',
        '',
        '技能是「这类事该怎么做」的工作流说明。判断这一轮要做的事有对应技能时，' +
          '先用 skill 工具把它读进来，再按它说的做。名字要**逐字照抄**（含前缀）：',
        '',
        // 描述**只有 `full` 那一档带**。判的是档位，不是「有没有描述」——内置技能
        // 的描述是从常量里白拿的（构建时就读好了），照后者判的话「仅标题」会把
        // 描述一起发出去，那一档就不存在了，而作者选它正是为了不付这一行的钱。
        ...mine.map((s) =>
          s.mode === 'full' && s.description ? `- ${s.name} —— ${s.description}` : `- ${s.name}`
        ),
      ].join('\n')
    );
  }

  const forGenerate = visible.filter((s) => s.audience === 'generate');
  if (forGenerate.length > 0) {
    blocks.push(
      [
        '# 可交给创作模型的写作方法',
        '',
        '下面这些**不是给你读的**——它们是落笔那一刻才生效的写法（钩子怎么选、' +
          'AI 味的句式怎么改、这一类题材的套路是什么），正文很长。' +
          '`skill` 工具取不到它们。',
        '',
        '用法：调 generate 时把名字填进 `skills` 参数，可以填多份，' +
          '正文会直接进创作模型的上下文，不占你这一轮。',
        '**按这一次要产出什么挑**——写正文别带排大纲的方法，反过来也一样；' +
          '没有对得上的就别填，硬凑一份只是让这次生成变贵。',
        '',
        // 这一类**总是带描述**（写了的话）。它是 agent 判断「什么时候该带上」的
        // 唯一依据：正文它读不到，名字又只有几个字。没有描述就只能靠名字自带
        // 触发力，那正是要在「怎么写一个技能」里写清的一条。
        ...forGenerate.map((s) =>
          s.description ? `- ${s.name} —— ${s.description}` : `- ${s.name}`
        ),
      ].join('\n')
    );
  }

  return blocks.join('\n\n');
}

/**
 * agent 自己够得着的那些：`agent` 类里进了索引的。**`skill` 工具的名单。**
 *
 * `generate` 类不在里面——它的正文一个字都不该进 agent 的上下文。工具那边
 * 因此要单独认一下这个名字（「这一份是给创作模型的，用 generate 的 skills
 * 参数带上它」），否则模型只会照着同一句「没有叫 X 的技能」再试一次。
 */
export function listAgentSkills(skills: SkillRef[]): SkillRef[] {
  return skills.filter((s) => s.audience === 'agent' && isIndexed(s.audience, s.mode));
}

/**
 * 能交给创作模型的那些：`generate` 类里没被禁用的。**`generate` 工具的名单。**
 *
 * 在工具那一侧再过滤一次而不是只靠「索引里没列它，模型就不会填」：作者可能刚
 * 把某一份改成了「禁用」，而模型手上还有上一轮的索引。
 */
export function listGenerateSkills(skills: SkillRef[]): SkillRef[] {
  return skills.filter((s) => s.audience === 'generate' && isIndexed(s.audience, s.mode));
}

/**
 * 作者 `/` 呼得出来的那些：**除了 `off` 都在**。
 *
 * 包括 `title` / `full`——那两档是「agent 也看得见」，不是「作者看不见」。
 * 顺序沿用 {@link listSkills}（内置在前、各自按名字排），面板照着画就是了。
 *
 * **两类受众都在。** `generate` 那一类作者一样呼得出来——他知道这一段要按哪套
 * 写法写。区别在呼出之后发生什么：`agent` 类折进那句话的是**整份正文**，
 * `generate` 类折进去的只有**一句指令**（「这一轮的 generate 带上这一份」），
 * 正文仍然只在创作模型那一侧展开。见 `controller/skills.ts` 的 `foldSkills`。
 */
export function listInvocableSkills(skills: SkillRef[]): SkillRef[] {
  return skills.filter((s) => s.mode !== 'off');
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
 *
 * **不看档位**：`skills` 里有哪些是调用方挑的——`skill` 工具递进来的是 agent
 * 看得见的那一份，`/` 那条路递进来的是作者呼得出的那一份。在这里再判一次档位，
 * 等于把「谁能看到什么」拆到两个地方去回答。
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
    const skill = BUILTIN_SKILLS[ref.stem];
    if (skill === undefined) {
      // 索引是从同一个对象来的，走不到这里；真走到了说明常量被生成坏了。
      return { ok: false, error: `技能 ${ref.name} 的内容缺失，这是一个 bug。换一个技能。` };
    }
    return { ok: true, ref, text: skill.body };
  }

  // 工程那一半：**不经 `Workspace.read`**。那条路会把内容按种类解析、还带行号，
  // 而这里要的是原文——技能是一份说明，不是产物。越界不可能发生（路径是我们
  // 用扫出来的目录名拼的），大小与存在性在这里各判一次就够。
  const rel = `${PROJECT_SKILLS_DIR}/${ref.stem}/${SKILL_ENTRY}`;
  try {
    const text = await fs.readFile(pathOf(project, ref), 'utf8');
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

/** 工程技能那份 `SKILL.md` 的绝对路径。名字是扫出来的目录名，拼不出越界。 */
function pathOf(project: NovelProject, ref: SkillRef): string {
  return path.join(project.root, PROJECT_SKILLS_DIR, ref.stem, SKILL_ENTRY);
}

/**
 * 工程技能那份 `SKILL.md` 的**工程内相对路径**；内置技能没有，回 undefined。
 *
 * 上下文明细里那一行靠它变成可点的链接（内置技能不在磁盘上，点了也打不开）。
 */
export function skillRelPath(ref: SkillRef): string | undefined {
  return ref.source === 'project' ? `${PROJECT_SKILLS_DIR}/${ref.stem}/${SKILL_ENTRY}` : undefined;
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
