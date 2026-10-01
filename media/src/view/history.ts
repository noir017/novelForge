/** 历史页：会话列表。 */
import { el as mk, closestFrom } from '../dom';
import type { SessionListItem } from '../protocol';
import { linkBtn } from './buttons';
import { timeLabel } from './format';
import { el } from './refs';
import { vscode } from './store';
import { showTab } from './tabs';

export function renderSessions(list: SessionListItem[]): void {
  el.sessionList.innerHTML = '';
  el.historyMeta.textContent = `${list.length} 个会话`;

  if (list.length === 0) {
    // 空页写出去哪儿（W12）：会话是在对话页里说出第一句话时才存下来的。
    const li = mk('li', 'hint history-empty', '还没有保存的对话。在对话页跟着主按钮走，发出第一条消息后会自动保存在这里。');
    const go = mk('button', 'chip-btn', '去对话页');
    go.addEventListener('click', () => {
      showTab('chat');
      vscode.postMessage({ type: 'switchTab', tab: 'chat' });
    });
    li.appendChild(go);
    el.sessionList.appendChild(li);
    return;
  }
  for (const s of list) {
    el.sessionList.appendChild(buildSessionRow(s));
  }
}

function buildSessionRow(s: SessionListItem): HTMLElement {
  const li = mk('li', s.active ? 'active' : '');
  li.addEventListener('click', (e) => {
    // 「重命名」「删除」在这一行里，点它们不该顺带切走会话。
    if (closestFrom(e.target, 'button')) {
      return;
    }
    vscode.postMessage({ type: 'openSession', id: s.id });
  });

  const head = mk('div', 's-head');
  head.appendChild(mk('span', 's-title', s.title));
  head.appendChild(mk('span', 'meta', `${s.turnCount} 条 · ${timeLabel(s.updatedAt)}`));

  const actions = mk('span', 's-actions');
  actions.appendChild(linkBtn('重命名', () => vscode.postMessage({ type: 'renameSession', id: s.id })));
  actions.appendChild(linkBtn('删除', () => vscode.postMessage({ type: 'deleteSession', id: s.id })));
  head.appendChild(actions);
  li.appendChild(head);

  if (s.preview) {
    li.appendChild(mk('div', 's-preview', s.preview));
  }
  return li;
}
