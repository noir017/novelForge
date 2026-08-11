/**
 * 输入区：附件标签、发送、以及那几个下拉框的联动。
 */
import { el as mk } from '../dom';
import type { SendPayload } from '../protocol';
import { el } from './refs';
import { persistDraft, store, vscode } from './store';
import { setBusy } from './state';
import { toast } from './toast';

/** 当前输入框里的那一套参数。发送与「重新生成」共用。 */
export function payload(): SendPayload {
  return {
    text: el.input.value,
    // 阶段/能力/目标全都记在会话里（后端是唯一真相，前端只是回显它）。
    // 按钮点击先改本地这一份，发送时原样带上去，后端再校验一遍。
    stage: store.session.stage,
    capability: store.session.capability,
    target: store.session.target,
    targetOrder: Number(el.targetSelect.value) || 1,
    targetWords: Number(el.targetWords.value) || 0,
    attachments: store.attachments,
    excludedIds: [...store.excluded],
  };
}

export function renderChips(): void {
  el.chips.innerHTML = '';
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

function send(): void {
  if (store.busy) {
    return;
  }
  if (!el.input.value.trim()) {
    toast('请先输入内容。', true);
    el.input.focus();
    return;
  }
  setBusy(true);
  vscode.postMessage({ type: 'send', payload: payload() });
  el.input.value = '';
  store.attachments = [];
  renderChips();
  persistDraft();
}

export function installComposer(): void {
  el.sendBtn.addEventListener('click', send);
  el.stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  el.atBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickAttachment' }));
  el.selBtn.addEventListener('click', () => vscode.postMessage({ type: 'addSelection' }));
  el.syncBtn.addEventListener('click', () => vscode.postMessage({ type: 'syncSummaries' }));

  el.input.addEventListener('input', persistDraft);
  el.targetWords.addEventListener('input', persistDraft);
  // 目标下拉框换了一章 → 切创作目标。它现在不只是「采纳写到哪」，
  // 而是「我在改哪一章」，装配的每一层都跟着它走。
  el.targetSelect.addEventListener('change', () => {
    const relPath = el.targetSelect.selectedOptions[0]?.dataset.rel;
    vscode.postMessage({
      type: 'setTarget',
      // 没有 relPath 说明选的是「新建第 N 章」——那一章还不存在，
      // 只能落到大纲；真正新建走工程页或采纳时的「新建章节」。
      target: relPath ? { kind: 'manuscript', chapterRelPath: relPath } : { kind: 'outline' },
    });
  });
  el.modelSelect.addEventListener('change', () =>
    vscode.postMessage({ type: 'selectModel', ref: el.modelSelect.value })
  );

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
    // 输入 @ 直接打开引用选择器，跟 Cursor 一致。
    if (e.key === '@') {
      e.preventDefault();
      vscode.postMessage({ type: 'pickAttachment' });
    }
  });
}
