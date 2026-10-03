/**
 * 设置页「技能」那一页：本工程的阶段绑定、从 GitHub 检查与安装、技能库。
 *
 * 与其余两页不同，这一页**改了当场生效**，不进 `draft`、不等「保存设置」：绑定写的是工程里的
 * `.novelforge/skills.json`，装卸写的是我的技能库，都与 `config.json` 无关。每一次改动后端都会
 * 重推一份 `skills`，这里只负责照着画。
 *
 * 检查结果是这一页唯一的前端状态：它是「作者正在看的那一份」，后端不记得给谁看过。
 */
import { clear, el, maybeById } from '../../dom';
import { SKILL_SOURCE_LABEL, SKILL_STAGES, SKILL_STAGE_LABEL } from '../../protocol';
import type { SkillInspectionView, SkillRow, SkillsView, SkillStage } from '../../protocol';
import { vscode } from '../store';

export function renderSkills(next: SkillsView, installed?: string): void {
  if (installed) {
    // 刚装好：检查卡完成了它的事，收起来，地址框清空，免得作者以为还要再点一次。
    const url = maybeById<HTMLInputElement>('skillUrl');
    if (url) {
      url.value = '';
    }
    const box = maybeById('skillInspection');
    if (box) {
      clear(box);
    }
  }
  renderBindings(next);
  renderLibrary(next);
}

/** 检查的结果（或错误）。 */
export function renderSkillInspection(url: string, inspection?: SkillInspectionView, error?: string): void {
  setInspecting(false);
  const box = maybeById('skillInspection');
  if (!box) {
    return;
  }
  clear(box);
  if (!inspection) {
    box.appendChild(el('div', 'skill-error', `检查失败：${error ?? '原因不明'}`));
    return;
  }
  const card = el('div', 'skill-card skill-inspection');
  const head = el('div', 'skill-head');
  head.appendChild(el('span', 'skill-name', inspection.label));
  head.appendChild(
    el('span', `skill-tag ${inspection.blockers.length > 0 ? 'bad' : 'ok'}`, inspection.blockers.length > 0 ? '装不了' : '可以装')
  );
  card.appendChild(head);
  card.appendChild(el('div', 'skill-desc', inspection.description));
  card.appendChild(
    el(
      'div',
      'skill-meta',
      [
        `name=${inspection.name}`,
        inspection.version ? `版本 ${inspection.version}` : '',
        `建议阶段：${SKILL_STAGE_LABEL[inspection.suggestedStage]}`,
        `${inspection.bytes} 字节`,
      ]
        .filter(Boolean)
        .join(' · ')
    )
  );
  for (const blocker of inspection.blockers) {
    card.appendChild(el('div', 'skill-error', blocker));
  }
  // 正文给作者看：装进来的就是这些字，往后每一次生成都会带上它。
  const body = el('details', 'skill-body');
  body.appendChild(el('summary', undefined, '正文（装进来的就是这些字）'));
  body.appendChild(el('pre', undefined, inspection.body));
  card.appendChild(body);
  card.appendChild(el('div', 'hint', `下载地址：${inspection.resolvedUrl}。这些内容来自第三方，装之前看一眼。`));

  const actions = el('div', 'actions');
  const install = el('button', 'primary', '确认安装');
  install.id = 'installSkillBtn';
  install.disabled = inspection.blockers.length > 0;
  install.addEventListener('click', () => vscode.postMessage({ type: 'installSkill', url }));
  actions.appendChild(install);
  card.appendChild(actions);
  box.appendChild(card);
}

export function installSkillsPanel(): void {
  const button = maybeById<HTMLButtonElement>('inspectSkillBtn');
  const input = maybeById<HTMLInputElement>('skillUrl');
  if (!button || !input) {
    return;
  }
  const inspect = (): void => {
    const url = input.value.trim();
    if (!url) {
      input.focus();
      return;
    }
    setInspecting(true);
    const box = maybeById('skillInspection');
    if (box) {
      clear(box);
    }
    vscode.postMessage({ type: 'inspectSkill', url });
  };
  button.addEventListener('click', inspect);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      inspect();
    }
  });
}

/** 切到这一页时重扫一遍：作者可能刚手放了一份进来。 */
export function requestSkills(): void {
  vscode.postMessage({ type: 'requestSkills' });
}

function setInspecting(busy: boolean): void {
  const button = maybeById<HTMLButtonElement>('inspectSkillBtn');
  if (button) {
    button.disabled = busy;
    button.textContent = busy ? '检查中…' : '检查';
  }
}

// ---------------------------------------------------------------- 阶段绑定

function renderBindings(v: SkillsView): void {
  const box = maybeById('skillBindings');
  const hint = maybeById('skillBindingHint');
  if (!box) {
    return;
  }
  clear(box);
  const bindings = v.bindings;
  if (hint) {
    hint.textContent = !bindings
      ? '先打开一个工程：绑定跟着工程走（记在工程里的 .novelforge/skills.json）。'
      : v.problems.length > 0
        ? `.novelforge/skills.json 有读不懂的地方：${v.problems.join('；')}。先手动修好或删掉它，才能在这里改绑定。`
        : '每个阶段最多绑一份；同一份可以绑在几个阶段上。只列出兼容的技能；内置技能只在它所属的阶段列出。';
  }
  const usable = v.rows.filter((r) => r.compatible);
  for (const stage of SKILL_STAGES) {
    box.appendChild(bindingField(stage, usable, v.rows, bindings));
  }
}

function bindingField(
  stage: SkillStage,
  usable: SkillRow[],
  all: SkillRow[],
  bindings: SkillsView['bindings']
): HTMLElement {
  const field = el('label', 'field');
  field.appendChild(el('span', undefined, SKILL_STAGE_LABEL[stage]));
  const select = document.createElement('select');
  select.dataset.skillStage = stage;
  const none = el('option', undefined, '不带');
  none.value = '';
  select.appendChild(none);
  const current = bindings?.[stage] ?? '';
  // 内置的阶段是写死的（三份「去 AI 味」各管一个阶段），别的阶段不列；已经绑上的照列。
  // 我的技能库与本工程的「建议阶段」可能是猜的，全列，只是本阶段建议的排前面。
  const listed = usable.filter((r) => r.source !== 'builtin' || r.suggestedStage === stage || r.id === current);
  const suggested = listed.filter((r) => r.suggestedStage === stage);
  const others = listed.filter((r) => r.suggestedStage !== stage);
  if (others.length === 0 || suggested.length === 0) {
    appendOptions(select, listed);
  } else {
    appendOptions(select.appendChild(optgroup('本阶段建议')), suggested);
    appendOptions(select.appendChild(optgroup('其他技能')), others);
  }
  if (current && !usable.some((r) => r.id === current)) {
    // 绑着的那份找不到了或者变得不兼容：照实显示，别让下拉框装作「不带」——生成时明细里也是这么说的。
    const found = all.find((r) => r.id === current);
    const lost = el('option', undefined, found ? `${found.label}（现在不兼容，不会带）` : `${current}（找不到了，不会带）`);
    lost.value = current;
    select.appendChild(lost);
  }
  select.value = current;
  select.disabled = !bindings || all.length === 0;
  select.addEventListener('change', () => {
    vscode.postMessage({ type: 'bindSkill', stage, id: select.value || null });
  });
  field.appendChild(select);
  return field;
}

function optgroup(label: string): HTMLOptGroupElement {
  const group = document.createElement('optgroup');
  group.label = label;
  return group;
}

function appendOptions(parent: HTMLElement, rows: SkillRow[]): void {
  for (const row of rows) {
    const opt = el('option', undefined, `${row.label}（${SKILL_SOURCE_LABEL[row.source]}）`);
    opt.value = row.id;
    opt.title = row.description;
    parent.appendChild(opt);
  }
}

// ---------------------------------------------------------------- 技能库

function renderLibrary(v: SkillsView): void {
  const box = maybeById('skillList');
  if (!box) {
    return;
  }
  clear(box);
  const count = maybeById('skillCount');
  if (count) {
    count.textContent = `${v.rows.length} 份`;
  }
  const hint = maybeById('skillLibraryHint');
  if (hint) {
    hint.textContent =
      `我的技能库在 ${v.userDir}，所有工程共用；本工程的技能放在 .novelforge/skills/<名字>/SKILL.md，跟着工程走。` +
      '手放进去的，切回这一页就会出现。';
  }
  if (v.rows.length === 0) {
    box.appendChild(el('div', 'hint', '一份技能都没有。'));
    return;
  }
  for (const row of v.rows) {
    box.appendChild(libraryRow(row));
  }
}

function libraryRow(row: SkillRow): HTMLElement {
  const card = el('div', 'skill-card');
  card.dataset.skillId = row.id;
  const head = el('div', 'skill-head');
  const name = el('span', 'skill-name', row.label);
  name.title = row.id;
  head.appendChild(name);
  head.appendChild(el('span', 'skill-tag', SKILL_SOURCE_LABEL[row.source]));
  head.appendChild(el('span', `skill-tag ${row.compatible ? 'ok' : 'bad'}`, row.compatible ? '兼容' : '不兼容'));
  card.appendChild(head);
  if (row.description) {
    card.appendChild(el('div', 'skill-desc', row.description));
  }
  card.appendChild(
    el(
      'div',
      'skill-meta',
      [
        row.version ? `版本 ${row.version}` : '',
        `建议阶段：${SKILL_STAGE_LABEL[row.suggestedStage]}`,
        `${row.bytes} 字节`,
        row.boundTo.length > 0 ? `本工程绑在：${row.boundTo.map((s) => SKILL_STAGE_LABEL[s]).join('、')}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    )
  );
  for (const reason of row.reasons) {
    card.appendChild(el('div', 'skill-error', reason));
  }
  const actions = el('div', 'skill-actions');
  if (row.relPath) {
    const open = el('button', 'link', '打开');
    open.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: row.relPath! }));
    actions.appendChild(open);
  }
  if (row.source === 'user') {
    const remove = el('button', 'link danger', '卸载');
    remove.addEventListener('click', () => vscode.postMessage({ type: 'uninstallSkill', id: row.id }));
    actions.appendChild(remove);
  }
  if (actions.childElementCount > 0) {
    card.appendChild(actions);
  }
  return card;
}
