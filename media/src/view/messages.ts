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
import { onSessionChanged } from './pipeline';
import { el } from './refs';
import { renderState } from './state';
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
  // 目标下拉框与流水线条都跟着会话走——会话里的 target 是唯一真相。
  if (store.state) {
    renderState(store.state);
  }
  onSessionChanged();
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
  // agent 调过的工具画成一串折叠条，也在正文上方——那是它得出结论的过程，
  // 读起来的顺序就是「先查了什么，然后说了什么」。
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    const strip = buildToolStrip();
    for (const call of turn.toolCalls) {
      strip.appendChild(buildToolRow(call));
    }
    wrap.appendChild(strip);
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

/**
 * 气泡正文。
 *
 * assistant 那一支**刻意保持成一个纯文本节点**：流式增量走的是
 * `body.textContent += delta`（index.ts），里面有子元素的话第一片增量就会
 * 把它们冲掉；就地编辑的 blur 判据也是拿 `body.textContent` 比 `turn.content`。
 * 要加结构的是 user 那一支。
 */
function buildBody(turn: SerializedTurn): HTMLElement {
  const body = mk('div', 'msg-body');

  if (turn.role === 'user') {
    return fillUserBody(body, turn);
  }

  body.textContent = turn.error ? turn.error : turn.content;

  // 结束后（turnDone 会重建这个节点）才放开就地编辑：结果可以改完再采纳。
  const streaming = store.streamingId === turn.id;
  if (!turn.error && !streaming) {
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

/**
 * 用户气泡：命令标签 +（可选的）补充要求。
 *
 * 命令类的轮次 content 本来就是空的——「写剧情」不需要作者说什么，该说的
 * 都在大纲和前后段里（见 `StageCommand.needsText`）。但**空气泡不能就这么空着**：
 * 翻回去看时认不出刚才点的是哪一下。所以把命令本身画成一枚 `/写剧情` 标签。
 */
function fillUserBody(body: HTMLElement, turn: SerializedTurn): HTMLElement {
  if (turn.command) {
    body.classList.add('has-command');
    body.appendChild(mk('span', 'msg-command', `/${turn.command}`));
  }
  const text = turn.error || turn.content;
  if (text) {
    body.appendChild(mk('span', 'msg-text', text));
  } else if (!turn.command) {
    // 既没有话也没有命令：只可能是旧会话里的空轮次（那时命令没被记下来）。
    // 留一句说明，总比一片看不出所以然的空白好。
    body.appendChild(mk('span', 'msg-text msg-text-empty', '（没有补充要求）'));
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
  } else if (turn.artifact) {
    // 结构化产物：说清落点与形状，覆盖时把「覆盖」两个字写在按钮上。
    // 一个光秃秃的「采纳写入」在四层产物之下已经不够——用户得知道
    // 这一下点下去会写到哪、会不会盖掉什么。
    const a = turn.artifact;
    bar.appendChild(mk('span', 'artifact-where', `${a.where} · ${a.summary}`));
    // 草稿还在才给按钮。`artifact` 是展示快照，会话很老时它还在而草稿已经
    // 没了——那时仍然看得出「这一轮产出过一份 4 场的场景清单」，只是采纳
    // 不了（落点在草稿身上，猜一个出来会把产物写到别的章去）。
    const draftId = turn.draftId;
    if (draftId) {
      const accept = mk('button', 'chip-btn', a.overwrites ? '覆盖并写入' : '采纳写入');
      accept.classList.toggle('danger', a.overwrites);
      accept.title = a.overwrites ? `${a.where} 已有内容，写入前会让你先对比一遍。` : `写入 ${a.where}`;
      accept.addEventListener('click', () =>
        vscode.postMessage({
          type: 'acceptArtifact',
          turnId: turn.id,
          // **不带 target**：落点由后端从 draft 里取。从前这里发的是当下
          // 选中的目标，用户生成完切了一章再点采纳就写错地方。
          draftId,
          text: currentText(),
        })
      );
      bar.appendChild(accept);
    }
  }
  // 没有 artifact 就没有采纳按钮：**讨论型的回答不该能写文件**。
  // 从前这里给一个「采纳写入」把任意一段文字追加进当前章节的正文，那是旧的
  // 单一产物时代留下的入口——四层产物之下，落点必须由后端算出来
  // （`draft.target`），前端猜不出这段话该写到哪一层。

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

/**
 * agent 工具调用的那一串折叠条。
 *
 * ```
 * 🔧 search「北境」        2 处命中   0.3s
 * 🔧 read chapters/009…   142 行     0.1s
 * ✨ generate 剧情         620 字     12.4s
 * ```
 *
 * **只画摘要，不画返回值**：`read` 一章正文是几千字，摊在气泡里会把作者真正
 * 要看的那段回答挤到屏幕外。要看内容点开那个文件就是了。
 */
export function buildToolStrip(): HTMLElement {
  return mk('div', 'tools');
}

export function buildToolRow(call: {
  callId: string;
  name: string;
  title: string;
  ok: boolean;
  summary: string;
  elapsedMs: number;
}): HTMLElement {
  const row = mk('div', `tool-row${call.ok ? '' : ' tool-failed'}`);
  row.dataset.call = call.callId;
  // 花钱的那个用另一个图标：作者一眼要能看出这一串里哪几下是收费的。
  row.appendChild(mk('span', 'tool-icon', call.name === 'generate' ? '✨' : '🔧'));
  row.appendChild(mk('span', 'tool-title', call.title));
  row.appendChild(mk('span', 'tool-summary', call.summary));
  row.appendChild(mk('span', 'tool-elapsed', formatElapsed(call.elapsedMs)));
  return row;
}

/** 一次工具调用刚开始，还没有结果。收到 `toolResult` 时就地补上。 */
export function buildPendingToolRow(callId: string, title: string, detail?: string): HTMLElement {
  return buildToolRow({
    callId,
    name: title.split(' ')[0],
    title,
    ok: true,
    summary: detail ?? '进行中…',
    elapsedMs: -1,
  });
}

function formatElapsed(ms: number): string {
  if (ms < 0) {
    return '';
  }
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
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
