/**
 * handler 的共享形状。
 *
 * 一个 handler 回答三个问题：
 *
 * 1. **渲染**：结构化产物（`Artifact`）该变成这个种类的什么文件内容。
 * 2. **记账**：写完之后要把哪个上游指纹落进 frontmatter。
 * 3. **伴生**：改名/移动时要连带搬走什么。
 *
 * 三件事都可选。`plain` 三件都不做，`plot` 三件都做。
 */
import { NovelProject } from '../../model/project';
import { Artifact } from '../../features/artifact';
import { PathKind } from '../kind';

export interface HandlerCtx {
  project: NovelProject;
  /** 这次写入的目标路径（工作区相对，正斜杠）。 */
  rel: string;
  /** `kindOfPath` 的结果。章号、场号、所属细纲都在里面。 */
  path: PathKind;
}

export interface HandlerWriteResult {
  rel: string;
  skipped?: boolean;
  message: string;
  /**
   * 这次写入连带做了什么（记了哪个 hash、搬了哪个伴生目录）。进日志用。
   * **不静默**：网关替调用方做的事必须说得出来。
   */
  side?: string[];
}

export interface Handler {
  /** 把结构化产物渲染成该种类的文件内容。渲染需要读盘（沿用磁盘那份的标题等）。 */
  render?(ctx: HandlerCtx, artifact: Artifact): Promise<string>;
  /**
   * 落盘位置的最终裁决。
   *
   * 场景的文件名由「场号 + 标题」决定，而标题要读盘才知道——调用方给的
   * `scenes/012-入宗/02.md` 只是一个占位，真正的落点由 handler 说了算。
   * 不实现就用调用方给的路径。
   */
  resolve?(ctx: HandlerCtx, artifact?: Artifact): Promise<string>;
  /** 首次 append 到一个还不存在的文件时，正文前面要带的那一段（frontmatter + 标题行）。 */
  appendHead?(ctx: HandlerCtx): Promise<string>;
  /**
   * 两段 append 之间的分隔符。
   *
   * 正文用 `\n\n---\n\n`：那一行是**默认的拆分候选点**（第 23 条）。
   * 其余种类不该有这个约定，缺省只空一行。
   */
  readonly appendSeparator?: string;
  /** 写入之后的记账与伴生动作。返回补进 `side` 的说明。 */
  after?(ctx: HandlerCtx, text: string): Promise<string[]>;
  /** 改名/移动时要连带搬走什么。返回补进 `side` 的说明。 */
  companions?(ctx: HandlerCtx, from: string, to: string): Promise<string[]>;
  /** 删除时要连带搬走什么。返回补进 `side` 的说明。 */
  onRemove?(ctx: HandlerCtx, rel: string): Promise<string[]>;
}
