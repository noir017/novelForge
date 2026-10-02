/**
 * 一致性预检的取数（五期）：本章细纲排了谁、他们的卡上「当前状态」怎么写的、前面定稿过的章留下了
 * 哪些连续性事实。判断在 model/preflight.ts（纯函数）。
 *
 * 零调用：只读细纲、角色卡与摘要。两个入口：对话页写第 N 章之前（controller/chat.ts，亮一张卡，
 * 可以「仅本次忽略」或「记为刻意安排」）；工程页批量写章开跑之前与每一章之前（features/pipelineBatch.ts）。
 *
 * 细纲里记下的永久放行（`preflightOk`，五期补遗 §2）在这里分出去：两个入口都只为剩下的那些停。
 */
import { NovelProject } from '../model/project';
import { PreflightRisk, describeRisk, findPreflightRisks, splitExempt } from '../model/preflight';

export { describeExempted, describeRisk, PREFLIGHT_SUGGESTION } from '../model/preflight';
export type { PreflightRisk } from '../model/preflight';

export interface PreflightResult {
  /** 要作者留意的（没有被永久放行的）。 */
  risks: PreflightRisk[];
  /** 细纲里记过永久放行的：不拦，只在说明里提一句。 */
  exempted: { risk: PreflightRisk; reason: string }[];
  /** 这一章细纲的路径（记永久放行要写它）。没有细纲时缺席。 */
  plotRelPath?: string;
}

/**
 * 第 `no` 章的预检。这一章没有细纲、细纲里没排人，都是空的——没有可比的东西。
 */
export async function preflightChapter(project: NovelProject, no: number): Promise<PreflightResult> {
  const plot = await project.getPlot(no);
  if (!plot || plot.characters.length === 0) {
    return { risks: [], exempted: [], ...(plot ? { plotRelPath: plot.relPath } : {}) };
  }
  const [cards, finalized] = await Promise.all([project.listCharacters(), project.finalizedFacts(no)]);
  const all = findPreflightRisks({
    no,
    planned: plot.characters,
    cards: cards.map((c) => ({
      name: c.name,
      aliases: c.aliases,
      state: c.sections.当前状态 ?? '',
      stateThrough: c.stateThrough,
      relPath: c.relPath,
    })),
    facts: finalized.map((f) => ({ no: f.no, relPath: f.relPath, statements: f.facts.map((x) => x.statement) })),
  });
  return { ...splitExempt(all, plot.preflightOk), plotRelPath: plot.relPath };
}

/** 一处风险的身份：同一章、同一个人。批量里「开跑前问过、作者说仅本次忽略」的那几处按它认。 */
export function riskKey(no: number, risk: PreflightRisk): string {
  return `${no}:${risk.name}`;
}

/** 卡片、确认框、日志里的那几行：「第 3 章：沈秋的当前状态……」。 */
export function describeRisks(no: number, risks: readonly PreflightRisk[], withChapter = false): string[] {
  return risks.map((r) => `${withChapter ? `第 ${no} 章：` : ''}${describeRisk(r)}`);
}
