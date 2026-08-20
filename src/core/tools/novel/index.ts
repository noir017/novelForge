/**
 * Novel Forge 这套工具。**读三件 + generate + 写三件**：`list` / `read` /
 * `search` / `generate` / `write` / `edit` / `run`。
 *
 * 每个工具体都是下面几层的**薄包装**（不超过 60 行）：`Workspace` 的读写网关、
 * `generation.generate` 的一次单步、`features/*` 的工程动作。这一层真正的活是
 * 把返回值压成模型读得动的形状——`Workspace.list` 给的是结构化数组，模型要的是
 * 一屏能扫完的文本；`generate` 产出的是三千字正文，模型该拿到的只有「已生成，
 * 620 字，draftId d-3f2a」。
 *
 * ## 明确不给的工具
 *
 * **删除、改名、移动。** `workspace` 上有 `remove` / `move`，但不暴露：收益接近
 * 零（作者要删东西会自己删），而一次误操作的收拾成本极高——细纲改名会连带搬走
 * 场景目录与中转站正文，删除即使进了 `.trash/` 作者也未必知道它删过什么。同理
 * 没有 `bash`、没有工程根之外的路径、没有裸 `fs`（AGENTS 第 25(c) 条）。
 *
 * ## 工具数是硬约束
 *
 * 七个，没有第八个。每多一个都要在每一轮里发一遍描述，而且模型选错工具的概率
 * 随数量上升。要加之前先想：它能不能表达成现有某个工具的一个参数。
 */
import type { ToolDef, ToolEnv } from '../types';
import { ToolRegistry } from '../registry';
import { editTool } from './edit';
import { generateTool } from './generate';
import { listTool } from './list';
import { readTool } from './read';
import { runTool } from './run';
import { searchTool } from './search';
import { writeTool } from './write';

export { editTool, generateTool, listTool, readTool, runTool, searchTool, writeTool };

/**
 * 全部七个。**顺序即模型看到的顺序**：读在前、生成居中、写在后，让它先形成
 * 「先看一眼再动手」的路径。
 */
export const NOVEL_TOOLS: ToolDef[] = [
  listTool,
  readTool,
  searchTool,
  generateTool,
  writeTool,
  editTool,
  runTool,
];

/**
 * 绑一份环境，得到一个能被调用的工具集。
 *
 * 这是这一层对外的入口：**调用方（面板的 agent、将来的 MCP server）只要
 * 一份 `ToolEnv`**，不必认识任何一个具体工具。
 */
export function createNovelTools(env: ToolEnv, defs: ToolDef[] = NOVEL_TOOLS): ToolRegistry {
  return new ToolRegistry(defs, env);
}
