/**
 * 工具集：`list` / `read` / `search` / `generate` / `write`（`edit` / `run`
 * 随后加进来）。
 *
 * 三期只注册前四个，一个字都不写磁盘；四期把写工具接上——而**没有加一行新的
 * 保护代码**：一期把六处写盘收敛进 `workspace/` 的八条守卫，二期把落盘从
 * 生成里拆出来，四期只是把它们接到 agent 的确认流程上（`policy.ts`）。
 *
 * 每个工具体都是前三期成果的**薄包装**（不超过 60 行）。这一层真正的活是
 * 把返回值压成模型读得动的形状——`Workspace.list` 给的是结构化数组，模型要
 * 的是一屏能扫完的文本；`generate` 产出的是三千字正文，模型该拿到的只有
 * 「已生成，620 字，draftId d-3f2a」。
 *
 * ## 明确不给的工具
 *
 * **删除、改名、移动。** `workspace` 上有 `remove` / `move`，但不暴露给 agent：
 * 收益接近零（作者要删东西会自己删），而一次误操作的收拾成本极高——细纲改名
 * 会连带搬走场景目录与中转站正文，删除即使进了 `.trash/` 作者也未必知道它删过
 * 什么。同理没有 `bash`、没有工程根之外的路径、没有裸 `fs`。
 */
import type { ToolDef } from '../registry';
import { generateTool } from './generate';
import { listTool } from './list';
import { readTool } from './read';
import { searchTool } from './search';
import { writeTool } from './write';

export { generateTool, listTool, readTool, searchTool, writeTool };

/**
 * 只读四件套。**不写磁盘的那一半**，单独导出供测试与「只让它查一查」的场景用。
 */
export const READ_ONLY_TOOLS: ToolDef[] = [listTool, readTool, searchTool, generateTool];

/**
 * 四期注册的全部工具。顺序即模型看到的顺序：**读在前、生成居中、写在后**，
 * 让它先形成「先看一眼再动手」的路径。
 */
export const ALL_TOOLS: ToolDef[] = [listTool, readTool, searchTool, generateTool, writeTool];
