/**
 * `doc` handler：纯文本 + frontmatter，**没有上游指纹**。
 *
 * 接 `style` / `globalSummary` / `threads` / `character` / `lore` 五种。
 *
 * 它们的共同点是**在指纹链之外**：
 *
 * - `style.md` / 角色卡 / 设定条目根本不在生产链上——它们是横切的记忆与
 *   约束，被装配进 prompt，但不由某一层产物「生出来」。
 * - `summaries/global.md` 的上游是全部定稿过的细纲，那是一次显式的重建动作
 *   （features/summarize.ts 的 `through` 水位线），不是 hash 传播。
 * - 叙事线（`threads/<线名>.md`，一条线一个文件）由排线与定稿写（机器只追加、当前进度有指纹守着，
 *   见 model/threadFile.ts），是跨章的计划与记录，同样不在链上。
 *
 * 它们都没有对应的结构化产物，只走 `{text}` 那条路，所以这里什么都不用做。情节大纲从前也在这里（把 `outlineDoc`
 * 渲染成 `outline.md`）；现在它没有文件，是各章细纲梗概的汇总，读写由网关自己接住（`Workspace.writeOutline`），
 * 不经任何 handler。
 */
import { Handler } from './types';

export const docHandler: Handler = {};
