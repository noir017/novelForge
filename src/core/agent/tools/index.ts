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
 * 的是一屏能扫完的文本。
 */
import type { ToolDef } from '../registry';

/** 只读四件套 + 生成。顺序即模型看到的顺序（先查后写，读在前）。 */
export const READ_ONLY_TOOLS: ToolDef[] = [];
