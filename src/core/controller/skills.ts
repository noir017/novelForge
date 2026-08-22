/**
 * 技能在面板这一侧：**作者呼出的那条路**，以及设置页那张表。
 *
 * agent 自己读技能走的是 `skill` 工具（`tools/novel/skill.ts`），与这里无关。
 * 这个文件管的是另一半——作者在输入框里打 `/` 挑一份，整份正文随下一句话过去。
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
import { getHost } from '../host';
import type { PickChoice } from '../host';
import { scoped } from '../runtime/logger';

import type { PendingSkill, SkillRow } from '../protocol';
import { listInvocableSkills, listSkills, readSkill } from '../skills';
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
 * 作者打了 `/`：弹宿主的选择器让他挑一份。
 *
 * **`off` 那些不在候选里**，其余三档都在——`title` / `full` 是「agent 也看得见」，
 * 不是「作者不能呼」。
 */
export async function pickSkill(c: ChatController): Promise<void> {
  const all = await listSkills(c.project, readConfig().skillModes);
  const usable = listInvocableSkills(all);
  if (usable.length === 0) {
    c.toast('还没有可用的技能。内置技能可以在设置页里打开，也可以在 .novelforge/skills/ 下自己写一份。', 'error');
    return;
  }

  // 描述在这里补：选择器上那一行副标题正是作者判断「是不是这一份」的依据，
  // 而 `listSkills` 只在 `full` 档读它（那条规矩是为了不让 agent 的每一轮变贵，
  // 与这条人工挑选的路无关）。
  const described = await withDescriptions(
    c.project,
    usable.map((s) => ({
      name: s.name,
      source: s.source,
      stem: s.stem,
      description: s.description,
      mode: s.mode,
    }))
  );

  const choices: PickChoice<string>[] = described.map((s) => ({
    label: s.stem,
    // 没写描述的就不显示副标题，别拼一句「（没有描述）」占一行。
    description: s.description || undefined,
    detail: s.name,
    group: s.source === 'builtin' ? '内置' : '这个工程',
    value: s.name,
  }));
  const picked = await getHost().pick(choices, '呼出技能');
  if (!picked) {
    return;
  }
  await holdSkill(c, picked);
}

/** 把选中的那一份读进来，挂成输入框上方一枚标签。 */
async function holdSkill(c: ChatController, name: string): Promise<void> {
  if (c.pendingSkills.some((s) => s.name === name)) {
    c.toast('已经呼出这一份了。');
    return;
  }
  const all = await listSkills(c.project, readConfig().skillModes);
  const got = await readSkill(c.project, listInvocableSkills(all), name);
  if (!got.ok) {
    // 读不到（目录空着、刚被删掉）就照实说。作者刚刚在选择器里看到它，
    // 不说的话他只会以为点击没生效。
    log.warn(`呼出技能失败：${name}`, got.error);
    c.toast(got.error, 'error');
    return;
  }
  c.pendingSkills.push({
    name: got.ref.name,
    stem: got.ref.stem,
    source: got.ref.source,
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
  return { name: s.name, stem: s.stem, source: s.source, chars: s.text.length };
}

/**
 * 把呼出的技能折进作者那句话的**前面**。
 *
 * 顺序是「先按这套方法，再做这件事」：方法在前，要求在后。反过来的话，作者那
 * 句话会被几千字的说明推到很远的地方，而模型对最近的内容最敏感——要它做的事
 * 该挨着它读到的最后一句。
 *
 * **一个字都不截**：截掉一半的工作流比没有更糟（它会照着半套流程做完，还以为
 * 自己做全了）。真的塞不下时由 `buildAgentMessages` 那一层报「压不下去」并停下，
 * 那条路会把话说清楚（第 2 条：不静默截断）。
 */
export function foldSkills(text: string, skills: HeldSkill[]): string {
  if (skills.length === 0) {
    return text;
  }
  const lines: string[] = [
    '# 作者指定了这一轮按哪套方法做',
    '',
    '下面是他呼出的技能说明。**按它说的做**，不必再用 skill 工具读一遍。',
  ];
  for (const s of skills) {
    lines.push('', `## 技能 ${s.name}`, '', s.text.trim());
  }
  lines.push('', '---', '', text);
  return lines.join('\n');
}
