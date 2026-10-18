/**
 * handler 的共享形状。
 *
 * 一个 handler 回答三个问题：
 *
 * 1. **渲染**：结构化产物（`Artifact`）该变成这个种类的什么文件内容。
 * 2. **记账**：写完之后要把哪个上游指纹落进 frontmatter。
 * 3. **伴生**：改名/移动时要连带搬走什么。
 *
 * 三件事都可选。`plain` 三件都不做，`plot` 只做前两件（细纲改名不带走别的东西），`chapter` 做伴生
 * （草稿与细纲都镜像正文的路径，跟着正文搬）。
 */
import { NovelProject } from '../../model/project';
import { Artifact } from '../../features/artifact';
import { PathKind } from '../kind';

export interface HandlerCtx {
  project: NovelProject;
  /** 这次写入的目标路径（工作区相对，正斜杠）。 */
  rel: string;
  /** `kindOfPath` 的结果。种类与章号都在里面。 */
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
   * 给「文件名要读盘才算得出来」的种类用：调用方给的路径只是一个占位，
   * 真正的落点由 handler 说了算。不实现就用调用方给的路径。
   */
  resolve?(ctx: HandlerCtx, artifact?: Artifact): Promise<string>;
  /** 写入之后的记账与伴生动作。返回补进 `side` 的说明。 */
  after?(ctx: HandlerCtx, text: string): Promise<string[]>;
  /** 改名/移动时要连带搬走什么。返回补进 `side` 的说明。 */
  companions?(ctx: HandlerCtx, from: string, to: string): Promise<string[]>;
  /**
   * 复制出一份之后（`Workspace.copy`，字节原样拷过来）要补的账。`ctx` 是副本，`from` 是原件的路径。
   * 返回补进 `side` 的说明。**复制没有伴生**：草稿、细纲都不跟着复制（副本是新的一份，见 `Workspace.copy`）。
   * 章节不实现它——复制进来的章节由 `copy` 在最后统一同步一次 manifest（与 `deferAfter` 同一个理由）。
   */
  afterCopy?(ctx: HandlerCtx, from: string): Promise<string[]>;
  /** 删除时要连带搬走什么。返回补进 `side` 的说明。 */
  onRemove?(ctx: HandlerCtx, rel: string): Promise<string[]>;
}
