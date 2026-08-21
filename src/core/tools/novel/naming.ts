/**
 * 路径 → 说给作者听的名字。**三个框共用一份**。
 *
 * 覆盖审阅那个框（`workspace.write` 的 `what`）、动手前的确认框
 * （工具自报的 `intent`）、以及采纳写入那条路，说的是同一份东西——
 * 「第 12 章的细纲」。三处各写各的话，作者就会在两个框里看到同一份东西的
 * 两个名字，然后不确定它们是不是一回事。
 *
 * 措辞逐字沿用采纳路径（`generation/accept.ts`）。
 */
import { kindOfPath } from '../../workspace';
import type { PathKind } from '../../workspace';
import type { NovelProject } from '../../model/project';

/** 覆盖审阅框上显示的名字。 */
export function describeForReview(path: PathKind, rel: string): string {
  const no = path.no;
  switch (path.kind) {
    case 'outline':
      return '全书大纲';
    case 'style':
      return '文风指南';
    case 'globalSummary':
      return '全书滚动摘要';
    case 'volume':
      return no === undefined ? '这一卷的卷纲' : `第 ${no} 卷的卷纲`;
    // 这里报的是**段号**（文件名前缀），不是界面上那个「剧情 N」位次——
    // 框里紧接着还要显示路径，两者对得上作者才认得出是同一份文件。
    case 'plot':
      return no === undefined ? '这一段的细纲' : `剧情段 ${no} 的细纲`;
    case 'manuscript':
      return no === undefined ? '这一段的正文' : `剧情段 ${no} 的正文`;
    case 'chapter':
      return no === undefined ? '这一章' : `第 ${no} 章`;
    case 'summary':
      return no === undefined ? '这一章的摘要' : `第 ${no} 章的摘要`;
    case 'character':
      return `角色卡 ${rel}`;
    case 'lore':
      return `设定 ${rel}`;
    case 'draft':
      return `草稿 ${rel}`;
    default:
      return rel;
  }
}

/**
 * 确认框上显示的名字。**零 I/O**（`kindOfPath` 是纯函数），所以确认框上的
 * 名字与随后 diff 上的名字逐字一致。
 *
 * 拿不到 project（纯单测）时退回路径本身——名字变糙，但不会因为少一个参数
 * 就说不出这一步要动哪份东西。
 */
export function describePath(rel: string, project?: NovelProject): string {
  if (!rel) {
    return '（没给路径）';
  }
  return project ? describeForReview(kindOfPath(project, rel), rel) : rel;
}

/** 摘一段短的进确认框。整段正文摊在框里没人读得完。 */
export function clip(value: string, max = 60): string {
  const one = value.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** 参数取字符串，其余一律当没给。模型偶尔会塞个 null 进来。 */
export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
