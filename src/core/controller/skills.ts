/**
 * 设置页「技能」：列技能库、从 GitHub 检查与安装、卸载（本工程的叫删除）、本工程的阶段绑定。
 *
 * 与 [settings.ts](settings.ts) 一样**不依赖 controller**：独立版没打开工程时由 WorkspaceHub
 * 直接调这几个函数（`scope` 是空的），技能库照样能看、能装、能卸；只有绑定要工程。
 *
 * 装与卸在这里先弹确认框（`Host.confirm`）——外部 agent 那条路由 `skills install` 的 `always` 闸门问，两边都问
 * 一次，不多不少。
 */
import * as path from 'node:path';
import { getHost } from '../host';
import type { NovelProject } from '../model/project';
import {
  SKILL_STAGE_LABEL,
  SkillStage,
  describeIncompat,
  isSkillStage,
  parseSkillId,
  skillLabel,
} from '../model/writingSkill';
import type { OutMessage, SkillRow, SkillsView } from '../protocol';
import { describeError, scoped } from '../runtime/logger';
import {
  LoadedSkill,
  inspectGitHubSkill,
  installGitHubSkill,
  listSkills,
  loadSkill,
  readSkillBindings,
  saveSkillBinding,
  unbindSkillEverywhere,
  uninstallUserSkill,
  userSkillsDir,
} from '../skills';
import type { Workspace } from '../workspace';

const log = scoped('技能');

export interface SkillsSink {
  post(message: OutMessage): void;
  toast(message: string, level?: 'info' | 'error'): void;
}

/** 有工程时两样都有；独立版空窗口时都没有。 */
export interface SkillsScope {
  project?: NovelProject;
  workspace?: Workspace;
}

export async function pushSkillsTo(sink: SkillsSink, scope: SkillsScope, installed?: string): Promise<void> {
  sink.post({ type: 'skills', view: await buildSkillsView(scope.project), installed });
}

async function buildSkillsView(project?: NovelProject): Promise<SkillsView> {
  const [skills, file] = await Promise.all([
    listSkills(project),
    project ? readSkillBindings(project) : Promise.resolve(undefined),
  ]);
  const bindings = file?.bindings;
  return {
    rows: skills.map((s) => rowOf(s, bindings ?? {})),
    bindings,
    problems: file?.problems.map((p) => p.text) ?? [],
    userDir: userSkillsDir(),
  };
}

function rowOf(s: LoadedSkill, bindings: Partial<Record<SkillStage, string>>): SkillRow {
  const i = s.inspection;
  return {
    id: s.id,
    source: s.source,
    name: s.name,
    label: skillLabel(i),
    description: i.description,
    version: i.version,
    suggestedStage: i.suggestedStage,
    compatible: i.compatible,
    reasons: i.compatible ? [] : [describeIncompat(i.reasons)],
    bytes: i.bytes,
    relPath: s.relPath,
    boundTo: (Object.keys(bindings) as SkillStage[]).filter((stage) => bindings[stage] === s.id),
  };
}

/** 检查：下载来看，不写任何文件。结果（或错误）单独回一条，前端拿它画检查卡。 */
export async function inspectSkillFrom(sink: SkillsSink, url: string): Promise<void> {
  try {
    const r = await inspectGitHubSkill(url);
    const i = r.inspection;
    sink.post({
      type: 'skillInspection',
      url,
      inspection: {
        url: r.sourceUrl,
        resolvedUrl: r.resolvedUrl,
        name: i.name,
        label: skillLabel(i),
        description: i.description,
        version: i.version,
        suggestedStage: i.suggestedStage,
        bytes: i.bytes,
        body: i.body,
        blockers: r.blockers,
      },
    });
  } catch (err) {
    log.warn(`检查技能失败：${describeError(err)}`, url);
    sink.post({ type: 'skillInspection', url, error: describeError(err) });
  }
}

export async function installSkillFrom(sink: SkillsSink, scope: SkillsScope, url: string): Promise<void> {
  const choice = await getHost().confirm('把这份技能装进我的技能库？', ['安装'], {
    modal: true,
    detail:
      `${url}\n会重新下载一遍，与刚才检查的那一份核对一致才装。` +
      '装进去之后所有工程都看得见它，但要在「本工程的阶段绑定」里绑上才会用上。',
  });
  if (choice !== '安装') {
    return;
  }
  try {
    const skill = await installGitHubSkill(url);
    sink.toast(`已装进我的技能库：${skillLabel(skill.inspection)}。绑到某个阶段才会用上。`);
    await pushSkillsTo(sink, scope, skill.id);
  } catch (err) {
    log.error(`安装技能失败：${describeError(err)}`, url);
    sink.toast(`安装失败：${describeError(err)}`, 'error');
  }
}

/**
 * 卸载我的技能库里的、删本工程的：整个目录挪进回收站（不真删）；本工程绑了它的阶段一起解绑。
 * 内置的删不掉。
 */
export async function uninstallSkillFrom(sink: SkillsSink, scope: SkillsScope, id: string): Promise<void> {
  const parsed = parseSkillId(id);
  if (parsed?.source === 'project') {
    await removeProjectSkill(sink, scope, id);
    return;
  }
  if (!parsed || parsed.source !== 'user') {
    sink.toast('内置技能删不掉；不想用就在阶段绑定里换掉它。', 'error');
    return;
  }
  const skill = await loadSkill(id);
  const label = skill ? skillLabel(skill.inspection) : parsed.name;
  const choice = await getHost().confirm(`从我的技能库卸载「${label}」？`, ['卸载'], {
    modal: true,
    detail:
      '整个目录挪进 ~/.novelforge/.trash/skills/，不真删。本工程绑了它的阶段会一起解绑；' +
      '别的工程里绑了它的，下次生成会在明细里写明「找不到」，然后不带。',
  });
  if (choice !== '卸载') {
    return;
  }
  try {
    await uninstallUserSkill(parsed.name);
    const unbound =
      scope.project && scope.workspace ? await unbindSkillEverywhere(scope.project, scope.workspace, id) : [];
    sink.toast(
      unbound.length > 0
        ? `已卸载「${label}」，本工程的${unbound.map((s) => `「${SKILL_STAGE_LABEL[s]}」`).join('')}不再带它。`
        : `已卸载「${label}」。`
    );
  } catch (err) {
    log.error(`卸载技能失败：${describeError(err)}`, id);
    sink.toast(`卸载失败：${describeError(err)}`, 'error');
  }
  await pushSkillsTo(sink, scope);
}

/** 删本工程的技能：`.novelforge/skills/<名字>/` 整个目录经网关挪进 `.novelforge/.trash/`。 */
async function removeProjectSkill(sink: SkillsSink, scope: SkillsScope, id: string): Promise<void> {
  if (!scope.project || !scope.workspace) {
    sink.toast('本工程的技能跟着工程走：先打开那个工程。', 'error');
    return;
  }
  const skill = await loadSkill(id, scope.project);
  if (!skill?.relPath) {
    sink.toast(`本工程里找不到「${id}」。`, 'error');
    await pushSkillsTo(sink, scope);
    return;
  }
  const label = skillLabel(skill.inspection);
  const dir = path.posix.dirname(skill.relPath);
  const choice = await getHost().confirm(`删掉本工程的技能「${label}」？`, ['删除'], {
    modal: true,
    detail: `整个 ${dir}/ 挪进 .novelforge/.trash/，可手动找回。绑了它的阶段会一起解绑。`,
  });
  if (choice !== '删除') {
    return;
  }
  try {
    const unbound = await unbindSkillEverywhere(scope.project, scope.workspace, id);
    await scope.workspace.remove(dir);
    sink.toast(
      unbound.length > 0
        ? `已删除「${label}」，${unbound.map((s) => `「${SKILL_STAGE_LABEL[s]}」`).join('')}不再带它。`
        : `已删除「${label}」。`
    );
  } catch (err) {
    log.error(`删除技能失败：${describeError(err)}`, id);
    sink.toast(`删除失败：${describeError(err)}`, 'error');
  }
  await pushSkillsTo(sink, scope);
}

export async function bindSkillFrom(
  sink: SkillsSink,
  scope: SkillsScope,
  stage: SkillStage,
  id: string | null
): Promise<void> {
  if (!scope.project || !scope.workspace) {
    sink.toast('绑定跟着工程走：先打开一个工程。', 'error');
    return;
  }
  if (!isSkillStage(stage)) {
    sink.toast(`认不出的阶段「${String(stage)}」`, 'error');
    return;
  }
  try {
    await saveSkillBinding(scope.project, scope.workspace, stage, id);
  } catch (err) {
    log.error(`绑定技能失败：${describeError(err)}`, `${stage} → ${id ?? '（不带）'}`);
    sink.toast(`绑定失败：${describeError(err)}`, 'error');
  }
  await pushSkillsTo(sink, scope);
}
