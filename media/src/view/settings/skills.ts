/**
 * 「每份技能让 agent 每轮看到多少」那张表。
 *
 * 一行一份技能，右边一个四档下拉框。与 `taskTiers.ts` 同一套做法：
 * **只有与缺省不同的项才写进配置**，这样日后调整缺省值时，作者没动过的技能
 * 会跟着新缺省走，而不是被一份「当年抄下来的缺省」钉死。
 *
 * 名单由后端每次推设置时重扫（`SkillRow[]`）——作者可能刚在
 * `.novelforge/skills/` 下加了一份，那一行得当场出现。所以它**不进 `draft`**
 * 的持久部分，只有「改过的档位」进（`draft.skillModes`）。
 *
 * 空窗口（独立版还没打开工程）时只有内置那几行：工程技能得有工程才扫得出来。
 * 那时列出来的仍然改得动——设置存在 `~/.novelforge/config.json`，与工程无关。
 *
 * ## 两类受众的下拉框不一样
 *
 * 受众来自 frontmatter，**这里只显示，不给改**（改它要改 `SKILL.md`）。但它
 * 决定下拉框里有几项：`generate` 那一类只有「启用 / 禁用」两种（见
 * `model/skillMode.ts` 的 `isIndexed`——它的正文本来就不进 agent 的每一轮，
 * 「仅标题」「完整」在那一类上没有分别）。四档全摆出来只会让人以为选了
 * 「仅用户」还能用 `/` 呼出而 agent 看不见，而实际上那一类正是靠索引里那一行
 * 才被带给 generate 的。
 */
import { el as mk, maybeById } from '../../dom';
import {
  DEFAULT_SKILL_MODE,
  SKILL_AUDIENCE_HINT,
  SKILL_AUDIENCE_LABEL,
  SKILL_MODES,
  SKILL_MODE_HINT,
  SKILL_MODE_LABEL,
} from '../../protocol';
import type { SkillMode, SkillRow } from '../../protocol';
import { draft, touch } from './draft';

/** 后端最近推来的那份名单。渲染与保存都读它。 */
let rows: SkillRow[] = [];

export function setSkillRows(next: SkillRow[] | undefined): void {
  // `undefined` 是「这条消息没带技能」（老后端、或者某条只更新 Key 状态的推送）
  // ——那时保留手上这份，别把整张表清空。
  if (next) {
    rows = next;
  }
}

export function renderSkills(): void {
  const box = maybeById<HTMLElement>('skillList');
  if (!box) {
    return;
  }
  box.innerHTML = '';
  if (rows.length === 0) {
    // 一份技能都没有：说清为什么，别摆一块空白让人以为没加载出来。
    box.appendChild(mk('div', 'hint', '一份技能都没扫到。内置技能随应用发布，工程技能放在 .novelforge/skills/<名字>/SKILL.md。'));
    return;
  }
  for (const row of rows) {
    box.appendChild(buildRow(row));
  }
}

function buildRow(row: SkillRow): HTMLElement {
  const box = mk('div', 'skill-row');

  const label = mk('div', 'skill-label');
  const name = mk('span', 'skill-name', row.stem);
  // 全名（含前缀）是它在配置里的键，也是 agent 那边要照抄的那一行。
  name.title = row.name;
  label.appendChild(name);
  label.appendChild(mk('span', 'skill-source', row.source === 'builtin' ? '内置' : '这个工程'));
  const audience = mk('span', 'skill-source', SKILL_AUDIENCE_LABEL[row.audience]);
  audience.title = SKILL_AUDIENCE_HINT[row.audience];
  label.appendChild(audience);
  // 描述没写就不占一行——那一行空着比没有更难看，也让人以为加载失败了。
  if (row.description) {
    label.appendChild(mk('span', 'skill-desc', row.description));
  }
  box.appendChild(label);

  const current = draft.skillModes[row.name] ?? row.mode;
  const sel = document.createElement('select');
  sel.className = 'skill-mode-select';
  // `generate` 那一类只有两种状态。用 `user` 当「启用」那一项的值是有意的：
  // 它是缺省档，于是「启用」在配置里一个键都不占（与下面「选回缺省就删掉」
  // 那条是同一件事），作者装一份新的写作方法什么都不用配就能用。
  const choices: SkillMode[] = row.audience === 'generate' ? ['user', 'off'] : SKILL_MODES;
  const labelOf = (mode: SkillMode): string =>
    row.audience === 'generate' ? (mode === 'off' ? '禁用' : '启用') : SKILL_MODE_LABEL[mode];
  const hintOf = (mode: SkillMode): string =>
    row.audience === 'generate'
      ? mode === 'off'
        ? '两边都看不到，/ 里也不列'
        : 'agent 每轮看到它的名字与描述，调 generate 时可以带上它'
      : SKILL_MODE_HINT[mode];
  for (const mode of choices) {
    const opt = document.createElement('option');
    opt.value = mode;
    // 标出哪个是缺省，改乱了能找回来（与任务档位那张表同一个做法）。
    opt.textContent =
      mode === DEFAULT_SKILL_MODE ? `${labelOf(mode)}（缺省）` : labelOf(mode);
    opt.title = hintOf(mode);
    sel.appendChild(opt);
  }
  // 配置里存着「仅标题」而受众是 generate（作者改过 frontmatter）时，下拉框里
  // 没有那一项——回落到缺省那一项，别让它显示成空白。
  sel.value = choices.includes(current) ? current : DEFAULT_SKILL_MODE;
  sel.title = hintOf(sel.value as SkillMode);
  sel.addEventListener('change', () => {
    const picked = sel.value as SkillMode;
    sel.title = hintOf(picked);
    if (picked === DEFAULT_SKILL_MODE) {
      // 选回缺省就把这一项删掉，配置里只留真正改过的。
      delete draft.skillModes[row.name];
    } else {
      draft.skillModes[row.name] = picked;
    }
    touch();
  });
  box.appendChild(sel);
  return box;
}
