import { loreOfTarget, plotLabel } from '../../model/pipeline';
import { LoreThinKind, loreThin } from '../../model/loreFile';
import { LoreEntry } from '../../model/types';
import { MATERIAL_TOKENS, expansionMaterial, loreEntryAt } from '../../views/loreMaterial';
import { estimateTokens } from '../tokenizer';
import { ItemKind } from '../types';
import type { Assembly, LayerFn } from './assembly';
import { loreBodyFor } from './render';

/*
 * 单条设定（展开，完善设定 2026-10-19）的两层。目标不是单条设定时什么都不带——设定阶段那张配方照挂它们，
 * 由层自己判（同 `written`）。
 *
 * - `loreSelf`（P0 force）：焦点，这一条现有的全部内容。**含暗设**：展开要改的就是它，标明读者还不知道。
 * - `loreMaterial`（P1）：两样原料（views/loreMaterial.ts 的 `expansionMaterial`）——已排（没定稿）的细纲里用到它
 *   的地方（展开是为这些情节服务的），与定稿过的记录（同建条目、整合那一份，已经写进正文的不能推翻）。两样合计
 *   照整合的 `MATERIAL_TOKENS` 封顶：两边都放不下时各占一半，一边用不完让给另一边；没带上的在明细里说出来（第 2 条）。
 *
 * 相关条目、角色、配置 / 前提 / 世界观照设定阶段现有的层（`lore` 层在单条设定上挑相关的，见 background.ts）。
 */

const THIN_NOTE: Record<LoreThinKind, string> = {
  empty: '这一条还只有一句话：正文是空的',
  placeholder: '这一条还只有一句话：正文还是「新建设定」留下的占位',
  untold: '这一条还只有一句话：三节都写着「（未交代）」',
};

export const loreSelf: LayerFn = async (a, spec) => {
  const relPath = loreOfTarget(a.request.target);
  if (!relPath) {
    return;
  }
  const { entry, exists } = await loreEntryAt(a.project, relPath);
  const thin = exists ? loreThin(entry) : undefined;
  a.admit(
    {
      id: 'loreSelf',
      kind: 'loreSelf',
      priority: spec.priority,
      label: `设定 · ${entry.title}（这一条）`,
      source: relPath,
      text: renderSelf(entry, exists),
      note: !exists ? '还没有这个文件：写入时按这个路径新建' : thin ? THIN_NOTE[thin] : undefined,
    },
    { force: spec.force }
  );
};

/**
 * 这一条的全部内容：`【名〔分类〕】`、一句话、关键词、正文。正文规划时的样子（`loreBodyFor`）：暗设挪到最后，
 * 标题换成「暗设（读者还不知道）」。
 */
function renderSelf(entry: LoreEntry, exists: boolean): string {
  const head = `【${entry.title}${entry.category ? `〔${entry.category}〕` : ''}】`;
  const body = loreBodyFor(entry.body, true).text;
  return [
    head,
    `一句话：${entry.brief.trim() || '（还没写）'}`,
    `关键词：${entry.keywords.length > 0 ? entry.keywords.join('、') : '（还没有）'}`,
    body || (exists ? '（正文还是空的）' : '（还没有这一条，这一次写下的就是它的第一版）'),
  ].join('\n');
}

export const loreMaterial: LayerFn = async (a, spec) => {
  const relPath = loreOfTarget(a.request.target);
  if (!relPath) {
    return;
  }
  const entries = await a.project.listLore();
  const { entry } = await loreEntryAt(a.project, relPath, entries);
  const { uses, records } = await expansionMaterial(a.project, entry, { entries });
  const planLines = uses.map((u) => `- ${plotLabel(u.no, u.title)}（${u.where}）：${u.text}`);
  const recordLines = records.map((f) => `- 第 ${f.no} 章：${f.text}`);

  // 两边合计封顶：都放不下时各占一半，一边用不完的让给另一边。
  const planNeed = tokensOf(planLines);
  const recordNeed = tokensOf(recordLines);
  const planBudget = Math.min(planNeed, Math.max(MATERIAL_TOKENS / 2, MATERIAL_TOKENS - recordNeed));
  const recordBudget = MATERIAL_TOKENS - planBudget;

  admitLines(a, spec.priority, {
    id: 'lorePlan',
    kind: 'lorePlan',
    label: `设定 · ${entry.title} · 已排细纲里用到它（${uses.length} 处）`,
    lines: planLines,
    budget: planBudget,
    empty: '（已排的细纲里还没有点到它的地方。）',
    what: '已排细纲里用到它的地方',
    nos: uses.map((u) => u.no),
  });
  admitLines(a, spec.priority, {
    id: 'loreRecord',
    kind: 'loreRecord',
    label: `设定 · ${entry.title} · 定稿过的记录（${records.length} 条）`,
    lines: recordLines,
    budget: recordBudget,
    empty: '（定稿过的章里还没有关于它的记录。）',
    what: '定稿过的记录',
    nos: records.map((f) => f.no),
  });
};

/** 一行一 token 的换行也算上，与 `takeHead` 按整段估差不了几个。 */
function tokensOf(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + estimateTokens(line) + 1, 0);
}

/** 能放下前几行（按章号升序，越早越先放）。 */
function fit(lines: readonly string[], budget: number): number {
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    used += estimateTokens(lines[i]) + 1;
    if (used > budget) {
      return i;
    }
  }
  return lines.length;
}

/**
 * 装一样原料：封顶之内整份带；超了只带前几行、标降级并写明带到第几章（第 2 条）；一行都没有就带一句「没有」，
 * 让模型知道是空的、不是忘了给。总预算放不下就丢、说出来。
 */
function admitLines(
  a: Assembly,
  priority: Parameters<Assembly['admit']>[0]['priority'],
  o: { id: string; kind: ItemKind; label: string; lines: string[]; budget: number; empty: string; what: string; nos: number[] }
): void {
  const base = { id: o.id, kind: o.kind, priority, label: o.label };
  if (a.excluded.has(o.id)) {
    a.admit({ ...base, text: '' });
    return;
  }
  if (o.lines.length === 0) {
    a.admit({ ...base, text: o.empty });
    return;
  }
  const kept = fit(o.lines, o.budget);
  if (kept === o.lines.length) {
    a.admit({ ...base, text: o.lines.join('\n') });
    return;
  }
  const why =
    `${o.what}共 ${o.lines.length} 行，计划与定稿记录合计封顶 ${MATERIAL_TOKENS} token，` +
    (kept > 0 ? `只带了前 ${kept} 行（到第 ${o.nos[kept - 1]} 章），第 ${o.nos[kept]} 章起的没带` : '一行都没放下');
  if (kept === 0) {
    a.reject({ ...base, text: '' }, 'dropped', why);
    return;
  }
  const text = o.lines.slice(0, kept).join('\n');
  const tokens = estimateTokens(text);
  if (tokens > a.remaining) {
    a.reject({ ...base, text: '' }, 'dropped', `预算不足（需 ${tokens} token，剩 ${Math.max(0, a.remaining)}）`);
    return;
  }
  a.accept({ ...base, text, status: 'degraded', note: why }, tokens);
}
