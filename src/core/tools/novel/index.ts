/**
 * Novel Forge 这套工具，按**它动的是什么**分：
 *
 * | 工具 | 管什么 |
 * |---|---|
 * | `list` / `read` / `search` | 查：看目录、读文件、全文搜 |
 * | `generate` | 为某一份产物调一次创作模型（架构 / 大纲 / 细纲 / 正文） |
 * | `write` / `edit` | 落盘：写一份文件、改一段文字 |
 * | `pipeline` | 流水线批量：补齐架构、批量拆细纲、批量写章、新建细纲骨架 |
 * | `summary` | 定稿与摘要 |
 * | `characters` | 角色卡 |
 * | `extract` | 提炼：文风、设定、叙事线 |
 * | `book` | 拆书：导入原稿、从已写正文补齐、从参考书学写法 |
 * | `skills` | 写作技能 |
 *
 * 前六个是**薄包装**：`Workspace` 的读写网关、`generation.generate` 的一次单步。这一层真正的活是
 * 把返回值压成模型读得动的形状——`generate` 产出的是三千字正文，模型该拿到的只有「已生成，
 * 620 字，draftId d-3f2a」。后六个是工程页按钮的口子（[actions.ts](actions.ts)），每个动作就是
 * 那颗按钮背后的同一个函数，确认框照弹。
 *
 * ## 怎么分才算合理
 *
 * 一个工具的参数就是它的全部用法：每个参数都对这个工具的大多数动作有意义，模型不必记「哪个动作
 * 认哪个参数」。工具之间按作者心里的那几块分（流水线、摘要、角色、技能……），与工程页上按钮的
 * 分组一致。加动作先想它属于哪一块；只有哪一块都不像、参数也合不进去时才新开一个工具。
 *
 * ## 明确不给的
 *
 * **删除、改名、移动。** `workspace` 上有 `remove` / `move`，但不暴露：收益接近零（作者要删东西
 * 会自己删），而一次误操作的收拾成本极高——章节改名会连带搬走摘要与草稿，删除即使进了 `.trash/`
 * 作者也未必知道它删过什么。同理没有 `bash`、没有工程根之外的路径、没有裸 `fs`、没有初始化工程、
 * 没有卸载技能（AGENTS 第 25 条）。**审稿与修稿也不给**：报告要作者勾选之后才修稿，他在对话页自己做。
 */
import type { ToolDef, ToolEnv } from '../types';
import { ToolRegistry } from '../registry';
import { bookTool } from './book';
import { charactersTool } from './characters';
import { editTool } from './edit';
import { extractTool } from './extract';
import { generateTool } from './generate';
import { listTool } from './list';
import { pipelineTool } from './pipeline';
import { readTool } from './read';
import { searchTool } from './search';
import { skillsTool } from './skills';
import { summaryTool } from './summary';
import { writeTool } from './write';

export {
  bookTool,
  charactersTool,
  editTool,
  extractTool,
  generateTool,
  listTool,
  pipelineTool,
  readTool,
  searchTool,
  skillsTool,
  summaryTool,
  writeTool,
};

/**
 * 全部工具。**顺序即模型看到的顺序**：读在前、生成居中、写在后、工程动作最后，让它先形成
 * 「先看一眼再动手」的路径。
 */
export const NOVEL_TOOLS: ToolDef[] = [
  listTool,
  readTool,
  searchTool,
  generateTool,
  writeTool,
  editTool,
  pipelineTool,
  summaryTool,
  charactersTool,
  extractTool,
  bookTool,
  skillsTool,
];

/** 绑一份环境，得到一个能被调用的工具集。调用方（MCP 的执行端）只要一份 `ToolEnv`。 */
export function createNovelTools(env: ToolEnv, defs: ToolDef[] = NOVEL_TOOLS): ToolRegistry {
  return new ToolRegistry(defs, env);
}
