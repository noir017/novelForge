export interface BuiltinSkill {
  /** 也是 id 里的名字：`builtin:<name>`。 */
  name: string;
  /** 整份 `SKILL.md` 文本（frontmatter + 正文）。 */
  raw: string;
}
