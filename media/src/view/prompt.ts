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
import { openHostFilePicker } from './folderPicker';
import { renderMerge } from './merge';
import { el } from './refs';
import { vscode } from './store';

type PromptMessage = Extract<OutMessage, { type: 'prompt' }>;

/** 开着的那个弹窗的「取消」。遮罩上的 ×、点空白、Esc 都走它；不是这里开的就是 undefined。 */
let cancelActive: (() => void) | undefined;

export function renderPrompt(msg: PromptMessage): void {
  // 覆盖审阅（五期 W11）有它自己的一整块：两个版本并排、逐段挑，塞不进这个小弹窗。
  if (msg.kind === 'merge') {
    renderMerge(msg);
    return;
  }
  // 选本机文件：要逐层翻目录，用的是「打开文件夹」那个选择器，不是这个小弹窗。
  if (msg.kind === 'file') {
    openHostFilePicker(msg.requestId, msg.title, msg.value ?? '', msg.options ?? []);
    return;
  }
  const body = el.providerModalBody;
  el.providerModalTitle.textContent = msg.title;
  body.innerHTML = '';

  const reply = (value?: string) => {
    if (cancelActive !== cancel) {
      return;
    }
    cancelActive = undefined;
    setHidden(el.providerModal, true);
    body.innerHTML = '';
    vscode.postMessage({ type: 'promptResult', requestId: msg.requestId, value });
  };
  // 与「取消」按钮同一个回答：确认框回 no，其余回 undefined。
  const cancel = () => reply(msg.kind === 'confirm' ? 'no' : undefined);
  cancelActive = cancel;

  if (msg.message) {
    body.appendChild(mk('p', 'hint', msg.message));
  }

  if (msg.kind === 'confirm') {
    // 补充说明（Host.confirm 的 detail）：要调几次、看哪几章、会覆盖什么——作者点「确定」前要看得见。
    for (const line of (msg.value ?? '').split('\n').filter((l) => l.trim())) {
      body.appendChild(mk('p', 'hint prompt-detail', line));
    }
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

/**
 * 遮罩上的 ×、点空白、Esc：弹窗是这里开的才由这里关，并且照「取消」回后端——
 * 只把遮罩藏起来的话，后端那一头的 confirm / pick 会一直等着。服务商弹窗与表单各有自己的一套。
 */
export function installPrompt(): void {
  el.providerModalClose.addEventListener('click', () => cancelActive?.());
  el.providerModal.addEventListener('click', (e) => {
    if (e.target === el.providerModal) {
      cancelActive?.();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cancelActive?.();
    }
  });
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
