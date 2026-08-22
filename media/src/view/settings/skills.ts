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
 */
import { el as mk, maybeById } from '../../dom';
import { DEFAULT_SKILL_MODE, SKILL_MODES, SKILL_MODE_HINT, SKILL_MODE_LABEL } from '../../protocol';
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
  // 描述没写就不占一行——那一行空着比没有更难看，也让人以为加载失败了。
  if (row.description) {
    label.appendChild(mk('span', 'skill-desc', row.description));
  }
  box.appendChild(label);

  const current = draft.skillModes[row.name] ?? row.mode;
  const sel = document.createElement('select');
  sel.className = 'skill-mode-select';
  for (const mode of SKILL_MODES) {
    const opt = document.createElement('option');
    opt.value = mode;
    // 标出哪个是缺省，改乱了能找回来（与任务档位那张表同一个做法）。
    opt.textContent =
      mode === DEFAULT_SKILL_MODE ? `${SKILL_MODE_LABEL[mode]}（缺省）` : SKILL_MODE_LABEL[mode];
    opt.title = SKILL_MODE_HINT[mode];
    sel.appendChild(opt);
  }
  sel.value = current;
  sel.title = SKILL_MODE_HINT[current];
  sel.addEventListener('change', () => {
    const picked = sel.value as SkillMode;
    sel.title = SKILL_MODE_HINT[picked];
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
