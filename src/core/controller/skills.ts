/**
 * 技能在面板这一侧：**作者呼出的那条路**，以及设置页那张表。
 *
 * agent 自己读技能走的是 `skill` 工具（`tools/novel/skill.ts`），与这里无关。
 * 这个文件管的是另一半——作者在输入框里打 `/` 挑一份，整份正文随下一句话过去。
 *
 * ## 挑的那一步在前端，不在宿主的选择器里
 *
 * 早一版走的是 `getHost().pick()`（与 `@` 引用同一条路）：插件弹 QuickPick、
 * 独立版弹网页模态框。改掉的理由是**这两件事不一样**。
 *
 * `@` 挑的是一个**文件**：候选是整个工程的树，几百项，要搜、要分组，作者挑完
 * 回到输入框接着写那句话——中间跳出一个居中的框是合理的，因为那本来就是一次
 * 独立的检索。
 *
 * `/` 挑的是**这句话按哪套方法做**，候选通常不到十项，而且它就是这句话的一部分。
 * 打 `/` 的时候手在键盘上、光标在输入框里；跳一个居中模态框出来，等于把光标从
 * 正在写的句子上拽走一次，挑完还要自己找回去。所以它是**贴着输入框上沿浮出来
 * 的候选列表**（Cursor / Claude Code 那一套，也是这个工程从前那个命令面板的形态）。
 *
 * 于是这一层的职责变了：不再是「弹个框问一句」，而是**把名单推给前端**
 * （{@link pushSkillList}），前端画面板、管键盘，挑中之后发一条 `useSkill`
 * 回来（{@link useSkill}）。
 *
 * ## 为什么呼出是「整份正文」，而不是让 agent 自己去 `skill` 一次
 *
 * 「仅用户」这一档的意思是**这份方法论不占每一轮的预算**：名字都不进索引。
 * 于是 agent 压根不知道它存在，也就不可能自己去读。作者呼出时若只递一个名字、
 * 让它自己调一次 `skill`，那就是一次白花的往返（第 4 条）——而且它还得先相信
 * 一个索引里没有的名字。
 *
 * 所以呼出走的是**折进那句话前面**（`foldSkills`）：作者要它按这套方法做事，
 * 那这套方法就是他这句话的一部分。
 *
 * ## 为什么不做成附件
 *
 * 附件走装配器那一层（`context/layers/dialog.ts` 的 `attachments`：按种类解析、
 * 按预算截断、`ATTACHMENT_NOTE` 各有一句说明），而那一层是**给单步创作装配
 * prompt 用的**。技能不是「引用的材料」，是「这件事怎么做」。混成一条之后，
 * 两边的解析规则会开始互相牵扯——而技能这一侧一个字都不该被截断（截掉一半的
 * 工作流比没有更糟）。
 */
import type { ChatController } from './index';
import { readConfig } from '../config';
import { scoped } from '../runtime/logger';

import type { PendingSkill, SkillRow } from '../protocol';
import { listInvocableSkills, listSkills, readSkill } from '../skills';
import type { SkillAudience } from '../model/skillMode';
import type { NovelProject } from '../model/project';

const log = scoped('面板');

/**
 * 作者已经呼出、等着随下一句话发出去的那几份技能。
 *
 * 存正文而不是只存名字：作者呼出的是**他此刻看到的那一份**。发送时再读一遍盘的
 * 话，他若正在另一个窗口改这份技能，发出去的会是改了一半的版本（与选区附件
 * 存快照同一个理由）。
 */
export interface HeldSkill {
  name: string;
  stem: string;
  source: 'builtin' | 'project';
  audience: SkillAudience;
  /**
   * `SKILL.md` 正文。**`generate` 那一类是空串**——它的正文不进 agent 这一轮，
   * 存一份在这里只是白占内存，而且会诱使日后某个改动把它折进去。
   */
  text: string;
}

/** 设置页那张表。**含 `off` 那些**——禁用了也要列出来才改得回去。 */
export async function listSkillRows(
  project: NovelProject | undefined,
  modes = readConfig().skillModes
): Promise<SkillRow[]> {
  // 空窗口（独立版还没打开工程）时只有内置那几行——设置页在那时也该改得动
  // 内置技能的档位。
  const all = await listSkills(project, modes);
  return all.map((s) => ({
    name: s.name,
    source: s.source,
    stem: s.stem,
    description: s.description,
    mode: s.mode,
    audience: s.audience,
  }));
}

/**
 * 设置页里那张表的描述要**按 `full` 才读盘**（`listSkills` 的规矩）。而设置页
 * 要的是**每一行都有描述**——作者正是靠它判断某份技能值不值得开到「完整」。
 *
 * 所以这里单独把工程技能的描述补齐一遍。它只在设置页那条路上跑（切到设置页、
 * 保存之后），不在 agent 的每一轮里，多几次读盘不心疼。
 */
export async function withDescriptions(
  project: NovelProject | undefined,
  rows: SkillRow[]
): Promise<SkillRow[]> {
  if (!project) {
    return rows;
  }
  const modes = readConfig().skillModes;
  // 借 `full` 那条已经写好的路：把工程技能临时当成 full 扫一遍，只取描述。
  const forced = { ...modes };
  for (const row of rows) {
    if (row.source === 'project') {
      forced[row.name] = 'full';
    }
  }
  const described = new Map(
    (await listSkills(project, forced)).map((s) => [s.name, s.description])
  );
  return rows.map((row) => ({ ...row, description: described.get(row.name) ?? row.description }));
}

/**
 * 把 `/` 面板的候选推给前端。**「禁用」那些不在里面。**
 *
 * `user` / `title` / `full` 三档都在——后两档是「agent 也看得见」，不是「作者
 * 不能呼」。
 *
 * 描述在这里补齐（`withDescriptions`）：面板上那行副标题正是作者判断「是不是
 * 这一份」的依据，而 `listSkills` 只在 `full` 档读它（那条规矩是为了不让 agent
 * 的每一轮变贵，与这条人工挑选的路无关）。
 *
 * 每次打开面板都重扫一遍盘：作者可能刚在 `.novelforge/skills/` 下写完一份，
 * 这一刻他要的就是它。
 */
export async function pushSkillList(c: ChatController): Promise<void> {
  const all = await listSkills(c.project, readConfig().skillModes);
  const usable = listInvocableSkills(all).map(
    (s): SkillRow => ({
      name: s.name,
      source: s.source,
      stem: s.stem,
      description: s.description,
      mode: s.mode,
      audience: s.audience,
    })
  );
  c.post({ type: 'skillList', items: await withDescriptions(c.project, usable) });
}

/**
 * 作者在 `/` 面板里挑中了一份：读出正文，挂成输入框上方一枚标签。
 *
 * **档位在这里再核一遍**，不信前端那份名单：它可能是几分钟前推的，而作者刚在
 * 设置页把这一份改成了「禁用」。前端手上的名单是回显，判据仍在后端
 * （`listInvocableSkills`）。
 */
export async function useSkill(c: ChatController, name: string): Promise<void> {
  if (c.pendingSkills.some((s) => s.name === name)) {
    c.toast('已经呼出这一份了。');
    return;
  }
  const all = await listSkills(c.project, readConfig().skillModes);
  const usable = listInvocableSkills(all);

  // 给创作模型的那一类：**只记名字，不读正文。** 它折进那句话的是一句指令
  // （见 foldSkills），正文要到 agent 调 generate 时才由工具层读出来注入创作
  // 上下文。在这里读一遍等于把几万字搬进内存，还会诱使日后某个改动顺手折进去。
  const forGenerate = usable.find((s) => s.name === name && s.audience === 'generate');
  if (forGenerate) {
    c.pendingSkills.push({
      name: forGenerate.name,
      stem: forGenerate.stem,
      source: forGenerate.source,
      audience: 'generate',
      text: '',
    });
    log.info(`呼出写作方法 ${forGenerate.name}`, '随下一句话带一句指令过去，正文在创作模型那一侧展开');
    pushPendingSkills(c);
    return;
  }

  const got = await readSkill(c.project, usable, name);
  if (!got.ok) {
    // 读不到（目录空着、刚被删掉、刚被改成「禁用」）就照实说。作者刚刚在面板里
    // 看到它，不说的话他只会以为点击没生效。
    log.warn(`呼出技能失败：${name}`, got.error);
    c.toast(got.error, 'error');
    return;
  }
  c.pendingSkills.push({
    name: got.ref.name,
    stem: got.ref.stem,
    source: got.ref.source,
    audience: 'agent',
    text: got.text,
  });
  log.info(`呼出技能 ${got.ref.name}`, `${got.text.length} 字，随下一句话一起发出`);
  pushPendingSkills(c);
}

/** 摘掉一枚标签。认不出的名字静默忽略（前端可能留着一枚过时的）。 */
export function dropSkill(c: ChatController, name: string): void {
  const before = c.pendingSkills.length;
  c.pendingSkills = c.pendingSkills.filter((s) => s.name !== name);
  if (c.pendingSkills.length !== before) {
    pushPendingSkills(c);
  }
}

export function pushPendingSkills(c: ChatController): void {
  c.post({ type: 'pendingSkills', items: c.pendingSkills.map(serializePendingSkill) });
}

export function serializePendingSkill(s: HeldSkill): PendingSkill {
  return {
    name: s.name,
    stem: s.stem,
    source: s.source,
    chars: s.text.length,
    audience: s.audience,
  };
}

/**
 * 把呼出的技能折进作者那句话的**前面**。
 *
 * 顺序是「先按这套方法，再做这件事」：方法在前，要求在后。反过来的话，作者那
 * 句话会被几千字的说明推到很远的地方，而模型对最近的内容最敏感——要它做的事
 * 该挨着它读到的最后一句。
 *
 * ## 两类折进去的东西不一样
 *
 * | 受众 | 折进去的 | 为什么 |
 * |---|---|---|
 * | `agent` | **整份正文** | 「仅用户」那一档的意思正是名字都不进索引，agent 压根不知道它存在——只递一个名字，它得先相信一个索引里没有的名字，还要多一次白花的往返（第 4 条） |
 * | `generate` | **一句指令** | 正文是给创作模型读的。折进这里，agent 能做的也只是把几万字转述一遍，两头都付钱 |
 *
 * 第二类折进去的那句话要**点名到 `skills` 参数**：agent 手上的索引里本来就
 * 列着这个名字与它的用法，这句话只是把「这一次用哪一份」定死——作者已经替它
 * 做了那个判断。
 *
 * **一个字都不截**：截掉一半的工作流比没有更糟（它会照着半套流程做完，还以为
 * 自己做全了）。真的塞不下时由 `buildAgentMessages` 那一层报「压不下去」并停下，
 * 那条路会把话说清楚（第 2 条：不静默截断）。
 */
export function foldSkills(text: string, skills: HeldSkill[]): string {
  if (skills.length === 0) {
    return text;
  }
  const lines: string[] = [];

  const forAgent = skills.filter((s) => s.audience === 'agent');
  if (forAgent.length > 0) {
    lines.push(
      '# 作者指定了这一轮按哪套方法做',
      '',
      '下面是他呼出的技能说明。**按它说的做**，不必再用 skill 工具读一遍。'
    );
    for (const s of forAgent) {
      lines.push('', `## 技能 ${s.name}`, '', s.text.trim());
    }
  }

  const forGenerate = skills.filter((s) => s.audience === 'generate');
  if (forGenerate.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(
      '# 作者指定了这一轮的正文按哪套写法写',
      '',
      '这一轮**每一次 generate** 都要把下面这几个名字填进 `skills` 参数' +
        '（逐字照抄，含前缀）：',
      '',
      ...forGenerate.map((s) => `- ${s.name}`),
      '',
      '它们的正文会直接进创作模型的上下文——你读不到，也不需要读。',
      '这一次不调 generate 的话就忽略这一段。'
    );
  }

  lines.push('', '---', '', text);
  return lines.join('\n');
}
