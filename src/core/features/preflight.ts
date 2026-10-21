/**
 * 一致性预检的取数（五期）：本章细纲排了谁、他们的卡上「当前状态」怎么写的、前面定稿过的章留下了
 * 哪些连续性事实。判断在 model/preflight.ts（纯函数）。
 *
 * 零调用：只读细纲（本章的计划与前面各章的定稿）与角色卡。两个入口：对话页写第 N 章之前（controller/chat.ts，亮一张卡，
 * 可以「仅本次忽略」或「记为刻意安排」）；工程页批量写章开跑之前与每一章之前（features/pipelineBatch.ts）。
 *
 * 细纲里记下的永久放行（`preflightOk`，五期补遗 §2）在这里分出去：两个入口都只为剩下的那些停。
 *
 * 叙事线的两类提醒（二期，设计稿「四、写前检查」）：伏笔逾期、线断了。照「设定还只有一句话」（`thinLoreFor`）那套做，
 * **不进 `risks`**（那是要拦人的），另放一个字段，说明里提一句、照写不拦。取数在 views/threads.ts 的 `threadReminders`。
 */
import { NovelProject } from '../model/project';
import { PreflightRisk, describeRisk, findPreflightRisks, splitExempt } from '../model/preflight';
import { ThreadReminder, describeThreadReminders, unrecordedBefore } from '../model/pipeline';
import { threadReminders } from '../views/threads';

export { describeExempted, describeRisk, PREFLIGHT_SUGGESTION } from '../model/preflight';
export type { PreflightRisk } from '../model/preflight';

export interface PreflightResult {
  /** 要作者留意的（没有被永久放行的）。 */
  risks: PreflightRisk[];
  /** 细纲里记过永久放行的：不拦，只在说明里提一句。 */
  exempted: { risk: PreflightRisk; reason: string }[];
  /** 这一章细纲的路径（记永久放行要写它）。没有细纲时缺席。 */
  plotRelPath?: string;
  /** 叙事线的提醒（二期）：伏笔逾期、线断了。不拦（不进 `risks`），说明里提一句（{@link describeThreadNotes}）。 */
  threads: ThreadReminder[];
  /** 叙事线记到第几章（定稿到的最后一章）：与这一章之间还有没定稿的章时，提醒可能不准，说法里注一句。 */
  threadsThrough: number;
}

/**
 * 第 `no` 章的预检。这一章没有细纲、细纲里没排人，风险都是空的——没有可比的东西；叙事线的提醒照算（它看的是叙事线，
 * 不看这一章排了谁）。
 */
export async function preflightChapter(project: NovelProject, no: number): Promise<PreflightResult> {
  const plot = await project.getPlot(no);
  const { reminders: threads, through: threadsThrough } = await threadReminders(project, [no]);
  if (!plot || plot.characters.length === 0) {
    return { risks: [], exempted: [], ...(plot ? { plotRelPath: plot.relPath } : {}), threads, threadsThrough };
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
  return { ...splitExempt(all, plot.preflightOk), plotRelPath: plot.relPath, threads, threadsThrough };
}

/**
 * 叙事线提醒那一句（对话页的卡片与说明、工作台、批量写章的确认框同一句，`describeThreadReminders`）：第 `first` 章起写，
 * 叙事线记到第 `through` 章。没有提醒是空串。
 */
export function describeThreadNotes(
  scope: '本章' | '区间里',
  reminders: readonly ThreadReminder[],
  through: number,
  first: number
): string {
  return describeThreadReminders(scope, reminders, unrecordedBefore(through, first));
}

/** 一处风险的身份：同一章、同一个人。批量里「开跑前问过、作者说仅本次忽略」的那几处按它认。 */
export function riskKey(no: number, risk: PreflightRisk): string {
  return `${no}:${risk.name}`;
}

/** 卡片、确认框、日志里的那几行：「第 3 章：沈秋的当前状态……」。 */
export function describeRisks(no: number, risks: readonly PreflightRisk[], withChapter = false): string[] {
  return risks.map((r) => `${withChapter ? `第 ${no} 章：` : ''}${describeRisk(r)}`);
}
