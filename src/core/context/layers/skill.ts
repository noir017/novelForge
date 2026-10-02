/**
 * `skill` 层：这一次装配所属阶段绑的那份写作技能（移植自 AI-Novel-Writer 的阶段 Skill）。
 *
 * - **自己读绑定**（与 `style` 层读 `style.md` 一样），不经 `BuildRequest` 传：对话页、agent 的
 *   `generate`、工程页批量三条路都走 `buildContext`，于是三条路带的是同一份。
 * - **整份带或整份不带，不截半截**：放不下就 dropped 并写明需要多少、剩多少（第 2 条）。
 *   不 force——一份 64 KiB 的技能强塞进一个 32k 窗口的模型，挤掉的是作者事实。配方里排在
 *   P0 那一组的最后：作者事实先拿预算，技能再拿（上游那句「作者事实……始终优先」）。
 * - **绑了却带不上的说出来**：找不到、变得不兼容、绑定文件读不懂，一律 dropped 带原因，
 *   而不是像上游那样让整次生成起不来。
 * - 讨论不带（`skillStageOf`）。**从已写正文整理（`derive`）也不带**：那一次是把写成的东西照实整理，
 *   不是规划——一份「规划」技能会让模型把已经发生的事按技能的排法改一遍。
 * - **记一条日志**：用了哪份、或者为什么没带。工程页批量不走 `logAssembly`、也没有明细可看，上游
 *   每次工作流同样记一句「本次 X 阶段使用……」。续写与修复那几轮会反复装配，同一句五分钟内只记一次。
 */
import { SKILL_SOURCE_LABEL, SKILL_STAGE_LABEL, renderSkillBlock, skillLabel, skillStageOf } from '../../model/writingSkill';
import { scoped } from '../../runtime/logger';
import { boundSkillFor } from '../../skills/bindings';
import { estimateTokens } from '../tokenizer';
import type { LayerFn } from './assembly';

const log = scoped('技能');

const QUIET_MS = 5 * 60 * 1000;
const lastSaid = new Map<string, number>();

/** 同一句话（连同说明）五分钟内只说一次。 */
function sayOnce(level: 'info' | 'warn', message: string, detail?: string): void {
  const key = `${message}\n${detail ?? ''}`;
  const now = Date.now();
  if (now - (lastSaid.get(key) ?? 0) < QUIET_MS) {
    return;
  }
  lastSaid.set(key, now);
  log[level](message, detail);
}

export const skill: LayerFn = async (a, spec) => {
  const stage = skillStageOf(a.request.action, a.request.writeMode);
  if (!stage || a.request.derive) {
    return;
  }
  const bound = await boundSkillFor(a.project, stage);
  if (bound.status === 'none') {
    return;
  }
  const base = { id: 'skill', kind: 'skill' as const, priority: spec.priority };
  if (bound.status === 'problem') {
    sayOnce('warn', `「${SKILL_STAGE_LABEL[stage]}」阶段绑的技能没带上`, bound.note);
    a.reject(
      {
        ...base,
        label: `技能 · ${SKILL_STAGE_LABEL[stage]}`,
        source: a.project.relPath(a.project.skillBindingsPath),
        text: '',
      },
      'dropped',
      bound.note
    );
    return;
  }
  const { inspection, source, relPath } = bound.skill;
  const label = skillLabel(inspection);
  const item = {
    ...base,
    label: `技能 · ${label}`,
    source: relPath,
    text: renderSkillBlock(label, inspection.body),
    note: `${SKILL_SOURCE_LABEL[source]} · 绑在「${SKILL_STAGE_LABEL[stage]}」阶段`,
  };
  if (a.excluded.has(item.id)) {
    a.admit(item);
    return;
  }
  const tokens = estimateTokens(item.text);
  if (!spec.force && tokens > a.remaining) {
    const note = `${item.note}；预算不足（需 ${tokens} token，剩 ${Math.max(0, a.remaining)}），整份没带`;
    sayOnce('warn', `技能「${label}」放不下，这次没带`, note);
    a.reject(item, 'dropped', note);
    return;
  }
  sayOnce('info', `「${SKILL_STAGE_LABEL[stage]}」阶段带上技能「${label}」`, `${bound.skill.id}｜${tokens} token`);
  a.admit(item, { force: spec.force });
};
