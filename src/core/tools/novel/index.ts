/**
 * Novel Forge 这套工具。**读三件 + skill + generate + 写三件**：`list` / `read` /
 * `search` / `skill` / `generate` / `write` / `edit` / `run`。
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
 * 八个。每多一个都要在每一轮里发一遍描述，而且模型选错工具的概率随数量上升。
 * 要加之前先想：它能不能表达成现有某个工具的一个参数。
 *
 * ### 为什么 `skill` 破了「七个」这条
 *
 * 从前这里写着「七个，没有第八个」。破它的理由只有一条能站住：**技能的正文
 * 取不到就等于没有技能，而现有七个里没有一个能取**——`read` 够不着内置那一半
 * （它们不在工程根内，甚至不在磁盘上，是烘进产物的常量）。
 *
 * 那就只剩两条路：让 `read` 多认一个「工程之外的只读来源」，或者加一个工具。
 * 前者是在网关上开一个「工程之外也能读」的口子，而第 7 条（文件访问不越界）
 * 是产品承诺里最不该松的一条；后者的代价是每轮多发一份几十字的描述。
 * **加一个只读、不写盘、不花钱的工具便宜得多。**
 *
 * 这条约束本身不作废：下一个想加的工具仍然要先回答「它能不能是现有工具的一个
 * 参数」，答不上来才谈得上加。
 */
import type { ToolDef, ToolEnv } from '../types';
import { ToolRegistry } from '../registry';
import { editTool } from './edit';
import { generateTool } from './generate';
import { listTool } from './list';
import { readTool } from './read';
import { runTool } from './run';
import { searchTool } from './search';
import { skillTool } from './skill';
import { writeTool } from './write';

export { editTool, generateTool, listTool, readTool, runTool, searchTool, skillTool, writeTool };

/**
 * 全部八个。**顺序即模型看到的顺序**：读在前、生成居中、写在后，让它先形成
 * 「先看一眼再动手」的路径。
 *
 * `skill` 排在读那三件之后、`generate` 之前：它取的是「这件事该怎么做」，
 * 位置就该在「看清楚了」与「动手」之间。
 */
export const NOVEL_TOOLS: ToolDef[] = [
  listTool,
  readTool,
  searchTool,
  skillTool,
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
