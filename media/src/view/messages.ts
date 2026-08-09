/**
 * 消息气泡。一条 turn 对应一个 `.msg`，头部（角色/时刻/字数/⋯ 菜单）、
 * 附件、思考过程、正文、上下文明细、行内动作各是一块。
 *
 * **生成中不可编辑**是这里最要紧的一条：contentEditable 的光标会被后续
 * delta 追加冲掉，用户改到一半的内容也会被 turnDone 的整体重建覆盖。
 * 判据是 `store.streamingId`，由 index.ts 在 turnDone 那一刻定下来。
 */
import { el as mk, spacer } from '../dom';
import type { SerializedDigest, SerializedTurn } from '../protocol';
import { linkBtn } from './buttons';
import { countWords, fmt, timeLabel } from './format';
import { toggleButtonMenu } from './menu';
import { el } from './refs';
import { openPath, store, vscode } from './store';
import { toast } from './toast';
import type { SendPayload } from '../protocol';

/** 由 composer.ts 注入：「重新生成」要带上输入框里当下的那套参数。 */
let currentPayload: () => SendPayload = () => {
  throw new Error('messages.bindPayload 还没调用');
};

export function bindPayload(fn: () => SendPayload): void {
  currentPayload = fn;
}

export function renderSession(session: typeof store.session): void {
  store.session = session;
  store.excluded = new Set();
  el.messages.innerHTML = '';

  if (session.turns.length === 0) {
    el.messages.appendChild(el.emptyHint);
    el.emptyHint.classList.remove('hidden');
  }
  for (const turn of session.turns) {
    el.messages.appendChild(buildTurn(turn));
  }

  if (session.targetWords) {
    el.targetWords.value = String(session.targetWords);
  }
  if (store.state && session.targetOrder !== undefined) {
    const want = String(session.targetOrder);
    if ([...el.targetSelect.options].some((o) => o.value === want)) {
      el.targetSelect.value = want;
    }
  }
  scrollToBottom();
}

export function upsertTurn(turn: SerializedTurn): void {
  el.emptyHint.classList.add('hidden');
  const existing = el.messages.querySelector(`[data-turn="${turn.id}"]`);
  const node = buildTurn(turn);
  if (existing) {
    existing.replaceWith(node);
  } else {
    el.messages.appendChild(node);
  }
  const idx = store.session.turns.findIndex((t) => t.id === turn.id);
  if (idx === -1) {
    store.session.turns.push(turn);
  } else {
    store.session.turns[idx] = turn;
  }
  scrollToBottom();
}

export function bubbleOf(turnId: string): HTMLElement | null {
  return el.messages.querySelector(`[data-turn="${turnId}"]`);
}

export function scrollToBottom(): void {
  el.messages.scrollTop = el.messages.scrollHeight;
}

function buildTurn(turn: SerializedTurn): HTMLElement {
  const wrap = mk('div', `msg ${turn.role}`);
  wrap.dataset.turn = turn.id;
  if (turn.error) {
    wrap.classList.add('msg-error');
  }

  wrap.appendChild(buildHead(turn));

  if (turn.attachments && turn.attachments.length > 0) {
    wrap.appendChild(buildAttachments(turn.attachments));
  }
  // 思考过程放在正文上方，默认折叠——它不是正文，但正文迟迟不来时
  // 它是唯一的进度反馈。用户展开后的状态由 details 自己维持。
  if (turn.reasoning) {
    wrap.appendChild(buildReasoningDetails(turn.reasoning));
  }

  wrap.appendChild(buildBody(turn));

  if (turn.context) {
    wrap.appendChild(buildContextDetails(turn.context));
  }
  wrap.appendChild(buildActions(turn));
  return wrap;
}

function buildHead(turn: SerializedTurn): HTMLElement {
  const head = mk('div', 'msg-head');
  head.appendChild(mk('span', 'msg-role', turn.role === 'user' ? '我' : '模型'));
  head.appendChild(mk('span', undefined, timeLabel(turn.at)));

  if (turn.role === 'assistant' && turn.content) {
    head.appendChild(mk('span', undefined, `· ${countWords(turn.content)} 字`));
  }
  if (turn.interrupted) {
    head.appendChild(mk('span', undefined, '· 已中断'));
  }
  // 低频且有破坏性的操作（重新生成/删除）收进右上角的 ⋯，
  // 不和「采纳写入」「复制」挤在一起。
  head.appendChild(spacer());
  head.appendChild(buildMenuBtn(turn));
  return head;
}

function buildBody(turn: SerializedTurn): HTMLElement {
  const body = mk('div', 'msg-body');
  body.textContent = turn.error ? turn.error : turn.content;

  // 结束后（turnDone 会重建这个节点）才放开就地编辑：结果可以改完再采纳。
  const streaming = store.streamingId === turn.id;
  if (turn.role === 'assistant' && !turn.error && !streaming) {
    body.setAttribute('contenteditable', 'true');
    body.spellcheck = false;
    body.addEventListener('blur', () => {
      if (body.textContent !== turn.content) {
        turn.content = body.textContent ?? '';
        vscode.postMessage({ type: 'editTurn', turnId: turn.id, text: turn.content });
      }
    });
  }
  return body;
}

function buildAttachments(attachments: NonNullable<SerializedTurn['attachments']>): HTMLElement {
  const box = mk('div', 'msg-attachments');
  for (const att of attachments) {
    const chip = mk('span', 'chip');
    chip.appendChild(mk('span', 'chip-label', att.label));
    if (att.relPath) {
      chip.style.cursor = 'pointer';
      chip.title = att.relPath;
      chip.addEventListener('click', () => openPath(att.relPath!));
    }
    box.appendChild(chip);
  }
  return box;
}

/** 采纳/复制这类常用动作留在行内，其余进 ⋯ 菜单。 */
function buildActions(turn: SerializedTurn): HTMLElement {
  const bar = mk('div', 'msg-actions');
  if (turn.role !== 'assistant' || !turn.content || turn.error) {
    return bar;
  }

  /** 采纳与复制取的都是**气泡里当下的文本**（可能被就地改过），不是 turn.content。 */
  const currentText = () => bubbleOf(turn.id)?.querySelector('.msg-body')?.textContent ?? turn.content;

  if (turn.acceptedTo) {
    bar.appendChild(mk('span', 'accepted', `✓ 已写入 ${turn.acceptedTo}`));
    bar.appendChild(linkBtn('打开', () => openPath(turn.acceptedTo!)));
  } else {
    const accept = mk('button', 'chip-btn', '采纳写入');
    accept.addEventListener('click', () => {
      const opt = el.targetSelect.selectedOptions[0];
      vscode.postMessage({
        type: 'accept',
        turnId: turn.id,
        mode: opt && opt.dataset.mode === 'new' ? 'new' : 'append',
        order: Number(el.targetSelect.value),
        title: '',
        text: currentText(),
      });
    });
    bar.appendChild(accept);
  }

  bar.appendChild(
    linkBtn('复制', () => {
      void navigator.clipboard.writeText(currentText());
      toast('已复制到剪贴板。');
    })
  );
  return bar;
}

// ---------------------------------------------------- 气泡右上角的 ⋯ 菜单

function buildMenuBtn(turn: SerializedTurn): HTMLElement {
  const btn = mk('button', 'msg-menu-btn', '⋯');
  btn.title = '更多操作';
  btn.setAttribute('aria-label', '更多操作');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleButtonMenu(btn, menuItemsFor(turn));
  });
  return btn;
}

/** 这条消息在 ⋯ 菜单里能做什么。 */
function menuItemsFor(turn: SerializedTurn) {
  const items = [];
  // 「重新生成」只对用户消息有意义：重来是从那一条分叉，
  // 丢掉它之后的所有轮次再跑一遍。
  if (turn.role === 'user') {
    items.push({
      label: '重新生成',
      run: () => {
        if (store.busy) {
          toast('正在生成，请先停止。', true);
          return;
        }
        vscode.postMessage({ type: 'retry', turnId: turn.id, payload: currentPayload() });
      },
    });
  }
  items.push({
    label: '删除',
    danger: true,
    run: () => vscode.postMessage({ type: 'deleteTurn', turnId: turn.id }),
  });
  return items;
}

// ---------------------------------------------------------------- 折叠块

/**
 * 思考过程的折叠块。
 *
 * 推理模型（gemma/gemini thinking、DeepSeek reasoner 等）可能先想几十秒
 * 才开始吐正文。这段内容不是正文——采纳写入时不会带上它——但把它显示
 * 出来，用户才知道模型在动，而不是界面卡住了。
 */
export function buildReasoningDetails(text: string): HTMLDetailsElement {
  const det = mk('details', 'reasoning');
  det.appendChild(mk('summary', undefined, `思考过程 · ${countWords(text)} 字`));
  det.appendChild(mk('div', 'reasoning-body', text));
  return det;
}

/** 上下文明细：装配器放进去了什么、各占多少 token、降级或丢弃的原因。 */
export function buildContextDetails(digest: SerializedDigest): HTMLDetailsElement {
  const det = mk('details', 'ctx');

  const kept = digest.items.filter((i) => i.status === 'included' || i.status === 'degraded').length;
  const sum = mk(
    'summary',
    undefined,
    `上下文 ${fmt(digest.usedTokens)} / ${fmt(digest.budget)} token${
      digest.clamped ? '（已按模型配额压缩）' : ''
    } · ${kept} 项`
  );
  if (digest.usedTokens > digest.budget) {
    sum.classList.add('over-budget');
  }
  det.appendChild(sum);

  const ul = mk('ul');
  for (const item of digest.items) {
    const li = mk('li', item.status);
    li.appendChild(mk('span', 'badge', `P${item.priority}`));
    li.appendChild(mk('span', 'label', item.label));
    if (item.source) {
      li.appendChild(linkBtn('打开', () => openPath(item.source!)));
    }
    li.appendChild(mk('span', 'tokens', item.tokens > 0 ? `${fmt(item.tokens)} tk` : '—'));
    if (item.note) {
      li.appendChild(mk('span', 'note', item.note));
    }
    ul.appendChild(li);
  }
  det.appendChild(ul);
  return det;
}
