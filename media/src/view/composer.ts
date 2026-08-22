/**
 * 输入区：附件标签、发送，以及那几个下拉框的联动。
 *
 * **只有一条发送路径**：打字 → 发给 agent，它自己决定查什么、分几步做完。
 *
 * 从前这里有三条（状态机主按钮 / `/` 命令 / 直接发送），前两条都是确定性的
 * 单步生成——挑好层与能力，一次调用产出一份产物。删掉它们之后，「在哪一层、
 * 干什么」这个判断只剩一处（agent 每回合读到的状态注入，第 20 条），
 * 前端不再参与，也就不会与它分叉。
 */
import { el as mk } from '../dom';
import { DEFAULT_THINKING_DEPTH, isThinkingDepth } from '../protocol';
import type { ThinkingDepth } from '../protocol';
import { scrollToBottom } from './messages';
import { el } from './refs';
import { persistDraft, store, vscode, hasWorkspace } from './store';
import { setBusy } from './state';
import { toast } from './toast';

export function renderChips(): void {
  el.chips.innerHTML = '';
  // 技能标签排在附件前面：它决定「怎么做」，附件只是「拿这些材料」。
  // 顺序与折进那句话时一致（方法在前，要求在后）。
  for (const skill of store.skills) {
    const chip = mk('span', 'chip skill-chip');

    const label = mk('span', 'chip-label', `⚡ ${skill.stem}`);
    label.title = `${skill.name}（${skill.chars} 字，随下一句话一起发出）`;
    chip.appendChild(label);

    const x = mk('button', 'chip-x', '×');
    x.title = '不用这份技能了';
    // **后端说了才算**：前端不先摘掉自己那一份（前端无状态那条基本盘），
    // 正文攒在后端，摘的必须是同一份。
    x.addEventListener('click', () => vscode.postMessage({ type: 'dropSkill', name: skill.name }));
    chip.appendChild(x);

    el.chips.appendChild(chip);
  }
  for (const att of store.attachments) {
    const chip = mk('span', 'chip');

    const label = mk('span', 'chip-label', att.label);
    label.title = att.relPath || att.label;
    chip.appendChild(label);

    const x = mk('button', 'chip-x', '×');
    x.title = '移除';
    x.addEventListener('click', () => {
      store.attachments = store.attachments.filter((a) => a.id !== att.id);
      renderChips();
    });
    chip.appendChild(x);

    el.chips.appendChild(chip);
  }
}

// ---------------------------------------------------------------- 发送

/**
 * 发送。**只吃作者那一句话**——不带层、不带能力、不带目标。
 *
 * 那三样 agent 自己算（每回合注入的状态机结论）。前端捎一份过去等于让它也
 * 参与判断，两处迟早分叉；而作者选中的那一章后端本来就记在会话里。
 *
 * 呼出的技能也不在这里拼：**正文攒在后端**（`ChatController.pendingSkills`），
 * 前端手上只有名字与字数。把几千字放在前端等于让「刷新一次就丢」变成可能。
 */
function send(): void {
  if (store.busy || !hasWorkspace()) {
    return;
  }
  const text = el.input.value.trim();
  if (!text) {
    toast('先说说你要它做什么。', true);
    el.input.focus();
    return;
  }
  setBusy(true);
  vscode.postMessage({ type: 'sendAgent', text });
  el.input.value = '';
  // 引用是一次性的：发出去就清空（后端也清它那份 pending）。
  // 技能同理，但清的那一下由后端推 `pendingSkills` 回来（正文在它手上）。
  store.attachments = [];
  renderChips();
  persistDraft();
  scrollToBottom(true);
}

/** 下拉框的值是字符串；认不出一律当「不思考」，与后端的容错读取同规矩。 */
function asDepth(value: string): ThinkingDepth {
  return isThinkingDepth(value) ? value : DEFAULT_THINKING_DEPTH;
}

export function installComposer(): void {
  el.sendBtn.addEventListener('click', send);
  el.stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  el.atBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickAttachment' }));
  el.selBtn.addEventListener('click', () => vscode.postMessage({ type: 'addSelection' }));
  el.skillBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickSkill' }));

  el.input.addEventListener('input', persistDraft);
  el.targetWords.addEventListener('input', persistDraft);
  // 目标下拉框换了一章 → **进入那一章当前该做的那一步**（由后端的状态机判定）。
  // 旧版一律落到正文层，于是选中一个连剧情都没排的章，界面直接把作者
  // 丢进正文——四层流水线在创作页上等于不存在。
  el.targetSelect.addEventListener('change', () => {
    const relPath = el.targetSelect.selectedOptions[0]?.dataset.rel;
    if (relPath) {
      vscode.postMessage({ type: 'selectPlot', plotRelPath: relPath });
      return;
    }
    // 没有 relPath 说明选的是「新建第 N 章」——那一章还不存在，
    // 只能落到大纲；真正新建走工程页的「新建章节」。
    vscode.postMessage({ type: 'setTarget', target: { kind: 'outline' } });
  });
  el.modelSelect.addEventListener('change', () =>
    vscode.postMessage({ type: 'selectModel', ref: el.modelSelect.value })
  );
  // 思考深度落在会话上（后端当场落盘），所以这里只发意图、不改本地状态——
  // 值由回来的那条 session 消息回填（前端无状态那条基本盘）。
  el.thinkSelect.addEventListener('change', () =>
    vscode.postMessage({ type: 'setThinking', depth: asDepth(el.thinkSelect.value) })
  );

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
      return;
    }
    // 输入 @ 直接打开引用选择器，跟 Cursor 一致。
    if (e.key === '@') {
      e.preventDefault();
      vscode.postMessage({ type: 'pickAttachment' });
      return;
    }
    // 输入 / 呼出技能选择器。**只在空输入框里**：句子中间的斜杠是普通字符
    // （路径、日期、「他/她」都要打得出来），在那里拦下来会让输入框莫名其妙。
    if (e.key === '/' && el.input.value === '') {
      e.preventDefault();
      vscode.postMessage({ type: 'pickSkill' });
    }
  });
}
