/**
 * 工具集。**三期只有只读四件套**：`list` / `read` / `search` / `generate`。
 *
 * `write` / `edit` / `run` 三个写工具**不在这里**——四期才加，那时前三期的
 * 保护（workspace 的八条守卫、generation 的无状态化）已经全部就位。这不是
 * 「还没来得及做」，是**有意的顺序**：先让 agent 能查、能对账、能出草稿，
 * 落盘仍走作者点的那张采纳卡片。
 *
 * 每个工具体都是前三期成果的**薄包装**（不超过 50 行）。这一层真正的活是
 * 把返回值压成模型读得动的形状——`Workspace.list` 给的是结构化数组，模型要
 * 的是一屏能扫完的文本；`generate` 产出的是三千字正文，模型该拿到的只有
 * 「已生成，620 字，draftId d-3f2a」。
 */
import type { ToolDef } from '../registry';
import { generateTool } from './generate';
import { listTool } from './list';
import { readTool } from './read';
import { searchTool } from './search';

export { generateTool, listTool, readTool, searchTool };

/**
 * 三期注册的全部工具。顺序即模型看到的顺序：**读在前、生成在后**，
 * 让它先形成「先看一眼再动手」的路径。
 */
export const READ_ONLY_TOOLS: ToolDef[] = [listTool, readTool, searchTool, generateTool];
