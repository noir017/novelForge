/**
 * `skill` —— 取一份技能的正文。`core/skills/` 的薄包装。
 *
 * ## 为什么它值得当第八个工具
 *
 * 技能的正文取不到就等于没有技能，而现有七个工具里没有一个能取：`read` 够不着
 * 内置那一半（它们不在工程根内，甚至不在磁盘上——烘成常量了）。让 `read` 多认
 * 一个只读来源，就是在网关上开一个「工程之外也能读」的口子，而**第 7 条（文件
 * 访问不越界）是产品承诺里最不该松的一条**。加一个只读、不写盘、不花钱的工具，
 * 比在网关上开口子便宜得多。
 *
 * ## 三条
 *
 * - **`gate: 'auto'`**：不花钱、不写盘、不改任何东西，跟 `list` / `read` / `search`
 *   同一档。三种策略下都自动执行，不弹框。
 * - **只回 `SKILL.md` 正文**，不回 `references/`。工程内技能的附件由模型自己用
 *   `read` 去取（技能正文里写着相对路径）；内置技能没有附件。
 * - **不做模糊匹配**。猜错时它会拿到一份自己没想要的技能，而且不会知道。
 *
 * ## 它够得着的就是索引里那些
 *
 * 每份技能各有一档注入方式（`model/skillMode.ts`）。这里**按同一份配置过滤**
 * ——只有 `title` / `full` 那些取得到。
 *
 * 这一条必须在这里再判一次，不能只靠「索引里没列它，模型就不会要」：作者可能
 * 把某份技能从 `title` 改成了 `user`，而模型手上还有上一轮的索引；更要紧的是
 * `user` 那一档的意思正是**「agent 别自己去读，等作者呼」**，而作者呼出走的是
 * 另一条路（整份正文直接进那一轮）。这里放行的话，那一档就没有意义了。
 *
 * 取不到时回的是同一句「没有叫 X 的技能」，名单是它此刻**真能取到**的那些
 * ——把 `user` 档列进「可用的是」再拒掉它，模型只会照着再试一次。
 *
 * ## 索引与这里各扫各的
 *
 * system 里那份索引由循环开局扫一次（一轮之内不变），这里每次调用**重新扫**。
 * 两者不共用一份缓存是有意的：工具层不认识「一轮」这个概念（它将来要能端出去
 * 做 MCP，那条路上没有 agent 的回合），而多一次 `readdir` 是几十微秒。
 */
import type { ToolContext, ToolDef, ToolIntent, ToolResult } from '../types';
import { objectSchema, str } from '../schema';
import { readConfig } from '../../config';
import { isAgentVisible } from '../../model/skillMode';
import { listSkills, readSkill } from '../../skills';

export const skillTool: ToolDef = {
  name: 'skill',
  description:
    '读一份技能：某类事该怎么做的工作流说明（判断标准、步骤、产出落到哪个文件）。' +
    '可用的技能名列在 system 里的「可用技能」下，**逐字照抄**（含 builtin: / project: 前缀）。' +
    '判断这一轮要做的事有对应技能时，先读它再动手；没有对应的就直接做，不必勉强套一个。' +
    '技能只是说明——按它做事仍然走其余那些工具，该问作者的照旧问。',
  parameters: objectSchema(
    {
      name: str('技能名，含 builtin: / project: 前缀。照抄「可用技能」里的那一行。'),
    },
    ['name']
  ),

  intent(): ToolIntent {
    return { gate: 'auto', title: '读一份技能说明' };
  },

  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const wanted = typeof args.name === 'string' ? args.name.trim() : '';
    // 与索引同一份配置。过滤掉「仅用户」与「禁用」那些：前者的意思正是
    // 「等作者呼出」，agent 自己读走了那一档就没有意义了。
    const all = await listSkills(ctx.project, readConfig().skillModes);
    const reachable = all.filter((s) => isAgentVisible(s.mode));
    const got = await readSkill(ctx.project, reachable, wanted);
    if (!got.ok) {
      return { text: '', error: got.error };
    }
    return {
      text: got.text,
      display: { title: `skill ${got.ref.name}`, detail: `${got.text.length} 字` },
    };
  },
};
