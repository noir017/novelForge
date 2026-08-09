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
    mode: el.modeSelect.value as SendPayload['mode'],
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
  el.modeSelect.addEventListener('change', persistDraft);
  el.targetWords.addEventListener('input', persistDraft);
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
