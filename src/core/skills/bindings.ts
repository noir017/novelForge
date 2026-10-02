/**
 * 工程的阶段绑定：`.novelforge/skills.json` 里记着每个阶段绑了哪份技能。
 *
 * 绑定跟着**工程**走（上游同样存在工程里）：同一份技能在这本书里绑在写正文上，换一本书
 * 可能根本不想用。一个阶段最多一份；同一份可以绑在几个阶段上。没绑就什么都不带——
 * 内置技能也不自动绑。
 *
 * 写盘走 `Workspace.writeSkillBindings`（第 7 条：工程里的写盘只经网关）。
 */
import type { NovelProject } from '../model/project';
import { readTextIfExists } from '../model/fs';
import {
  SKILL_STAGE_LABEL,
  SkillBindings,
  SkillStage,
  describeIncompat,
  isSkillStage,
  parseSkillBindings,
  renderSkillBindings,
  skillLabel,
} from '../model/writingSkill';
import type { Workspace } from '../workspace';
import { scoped } from '../runtime/logger';
import { LoadedSkill, loadSkill } from './library';

const log = scoped('技能');

export interface BindingsFile {
  bindings: SkillBindings;
  /** 读不懂的地方（第 1 条：跳过、不抛；第 2 条：说出来）。 */
  problems: { stage?: string; text: string }[];
}

export async function readSkillBindings(project: NovelProject): Promise<BindingsFile> {
  const raw = (await readTextIfExists(project.skillBindingsPath)) ?? '';
  return parseSkillBindings(raw);
}

/** 这一个阶段该带的那份技能，或者带不了的原因。 */
export type BoundSkill =
  | { status: 'none' }
  | { status: 'problem'; note: string }
  | { status: 'ok'; skill: LoadedSkill };

/**
 * 装配器问的那一句：这个阶段绑了什么、带不带得上。
 *
 * 绑了却带不上（找不到、变得不兼容、绑定文件读不懂）**不让这次生成起不来**——上游是整个工作流
 * 拒绝启动——而是这一次不带，由装配器在明细里写明原因（第 2 条）。
 */
export async function boundSkillFor(project: NovelProject, stage: SkillStage): Promise<BoundSkill> {
  const { bindings, problems } = await readSkillBindings(project);
  const id = bindings[stage];
  if (!id) {
    const relevant = problems.filter((p) => p.stage === undefined || p.stage === stage);
    if (relevant.length === 0) {
      return { status: 'none' };
    }
    return {
      status: 'problem',
      note: `技能绑定文件读不懂（${relevant.map((p) => p.text).join('；')}），这次没带技能`,
    };
  }
  const skill = await loadSkill(id, project);
  if (!skill) {
    return {
      status: 'problem',
      note: `绑定的技能 ${id} 找不到了（卸载了、改了名，或者 SKILL.md 读不出来），这次没带`,
    };
  }
  if (!skill.inspection.compatible) {
    return {
      status: 'problem',
      note: `绑定的技能「${skillLabel(skill.inspection)}」现在不兼容（${describeIncompat(skill.inspection.reasons)}），这次没带`,
    };
  }
  return { status: 'ok', skill };
}

/**
 * 绑定或解绑（`id` 为 null）一个阶段。
 *
 * 绑之前要求这份技能**存在且兼容**（上游只查 id 的格式，绑一份不存在的技能要等到下一次生成才
 * 发现）。绑定文件读不懂时拒绝改写：重写一遍会把读不懂的那几项悄悄冲掉（第 3 条），先让作者
 * 自己修好或删掉。
 */
export async function saveSkillBinding(
  project: NovelProject,
  workspace: Workspace,
  stage: SkillStage,
  id: string | null
): Promise<LoadedSkill | undefined> {
  if (!isSkillStage(stage)) {
    throw new Error(`认不出的阶段「${String(stage)}」`);
  }
  let skill: LoadedSkill | undefined;
  if (id !== null) {
    skill = await loadSkill(id, project);
    if (!skill) {
      throw new Error(`找不到技能 ${id}`);
    }
    if (!skill.inspection.compatible) {
      throw new Error(`「${skillLabel(skill.inspection)}」不兼容（${describeIncompat(skill.inspection.reasons)}），绑不上`);
    }
  }
  const { bindings, problems } = await readSkillBindings(project);
  if (problems.length > 0) {
    throw new Error(
      `${project.relPath(project.skillBindingsPath)} 有读不懂的地方（${problems.map((p) => p.text).join('；')}），` +
        '先手动修好或删掉它再绑。'
    );
  }
  if ((bindings[stage] ?? null) === id) {
    return skill;
  }
  const next: SkillBindings = { ...bindings };
  if (id === null) {
    delete next[stage];
  } else {
    next[stage] = id;
  }
  await workspace.writeSkillBindings(renderSkillBindings(next));
  log.info(
    id === null
      ? `「${SKILL_STAGE_LABEL[stage]}」阶段不再带技能`
      : `「${SKILL_STAGE_LABEL[stage]}」阶段绑定技能「${skillLabel(skill!.inspection)}」`,
    id ?? undefined
  );
  return skill;
}

/** 把指向某份技能的绑定全部解掉（卸载之后用）。返回解掉了哪几个阶段。 */
export async function unbindSkillEverywhere(
  project: NovelProject,
  workspace: Workspace,
  id: string
): Promise<SkillStage[]> {
  const { bindings, problems } = await readSkillBindings(project);
  const stages = (Object.keys(bindings) as SkillStage[]).filter((s) => bindings[s] === id);
  if (stages.length === 0 || problems.length > 0) {
    return [];
  }
  const next: SkillBindings = { ...bindings };
  for (const s of stages) {
    delete next[s];
  }
  await workspace.writeSkillBindings(renderSkillBindings(next));
  return stages;
}
