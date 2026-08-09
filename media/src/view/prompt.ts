/**
 * 独立版的弹窗（仅独立版）。
 *
 * 插件形态里 `host.input/confirm/pick` 走 VS Code 原生的 QuickPick / InputBox；
 * 浏览器里没有那些，后端改推一条 `prompt`，由这里变成一个 modal，
 * 用户提交后回 `promptResult`。
 *
 * 复用 providerModal 的遮罩层，body 换成临时内容——两个弹窗不会同时出现
 * （这条消息只在用户触发某个动作后到达），共用一层省一套样式。
 */
import { el as mk, setHidden } from '../dom';
import type { OutMessage } from '../protocol';
import { primaryBtn, secondaryBtn } from './buttons';
import { el } from './refs';
import { vscode } from './store';

type PromptMessage = Extract<OutMessage, { type: 'prompt' }>;

export function renderPrompt(msg: PromptMessage): void {
  const body = el.providerModalBody;
  el.providerModalTitle.textContent = msg.title;
  body.innerHTML = '';

  const reply = (value?: string) => {
    setHidden(el.providerModal, true);
    body.innerHTML = '';
    vscode.postMessage({ type: 'promptResult', requestId: msg.requestId, value });
  };

  if (msg.message) {
    body.appendChild(mk('p', 'hint', msg.message));
  }

  if (msg.kind === 'confirm') {
    body.appendChild(actionRow(primaryBtn('确定', () => reply('yes')), secondaryBtn('取消', () => reply('no'))));
  } else if (msg.kind === 'pick') {
    body.appendChild(buildPickList(msg.options ?? [], reply));
    body.appendChild(actionRow(secondaryBtn('取消', () => reply(undefined))));
  } else {
    const input = buildInput(msg, reply);
    body.appendChild(input);
    body.appendChild(
      actionRow(primaryBtn('确定', () => reply(input.value)), secondaryBtn('取消', () => reply(undefined)))
    );
    input.focus();
  }

  setHidden(el.providerModal, false);
}

function buildPickList(options: string[], reply: (value?: string) => void): HTMLElement {
  const list = mk('div', 'picklist');
  for (const opt of options) {
    const btn = mk('button', 'pick-item', opt);
    btn.addEventListener('click', () => reply(opt));
    list.appendChild(btn);
  }
  return list;
}

function buildInput(
  msg: PromptMessage,
  reply: (value?: string) => void
): HTMLInputElement | HTMLTextAreaElement {
  const input = msg.multiline ? mk('textarea') : mk('input');
  if (input instanceof HTMLTextAreaElement) {
    input.rows = 6;
  } else if (msg.password) {
    input.type = 'password';
  }
  input.placeholder = msg.placeholder ?? '';
  input.value = msg.value ?? '';
  input.style.width = '100%';

  // 挂在 HTMLElement 上而不是那个联合类型：两种元素的 keydown 事件映射
  // 各是各的，联合之后 TS 只认得回最宽的 Event。
  (input as HTMLElement).addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    // 多行输入里 Enter 是换行，不能拿去提交。
    if (key === 'Enter' && !msg.multiline) {
      e.preventDefault();
      reply(input.value);
    }
    if (key === 'Escape') {
      reply(undefined);
    }
  });
  return input;
}

function actionRow(...buttons: HTMLElement[]): HTMLElement {
  const row = mk('div', 'actions');
  row.append(...buttons);
  return row;
}
