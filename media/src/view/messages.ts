/**
 * 消息气泡。一条 turn 对应一个 `.msg`，头部（角色/时刻/字数/⋯ 菜单）、
 * 附件、思考过程、正文、上下文明细、行内动作各是一块。
 *
 * **生成中不可编辑**是这里最要紧的一条：contentEditable 的光标会被后续
 * delta 追加冲掉，用户改到一半的内容也会被 turnDone 的整体重建覆盖。
 * 判据是 `store.streamingId`，由 index.ts 在 turnDone 那一刻定下来。
 *
 * **流式时只在贴着底才跟滚**：每来一段 delta 都会 `scrollToBottom()`，
 * 翻上去看前面的气泡时不该被拽回来（与日志页同一条理由）。
 */
import { el as mk, spacer } from '../dom';
import type { SerializedAgentRun, SerializedDigest, SerializedTurn } from '../protocol';
import { linkBtn } from './buttons';
import { countWords, fmt, timeLabel } from './format';
import { toggleButtonMenu } from './menu';
import { onSessionChanged } from './pipeline';
import { el } from './refs';
import { renderState, syncThinkingSelect } from './state';
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

  syncThinkingSelect();
  if (session.targetWords) {
    el.targetWords.value = String(session.targetWords);
  }
  // 目标下拉框与流水线条都跟着会话走——会话里的 target 是唯一真相。
  if (store.state) {
    renderState(store.state);
  }
  onSessionChanged();
  // 切会话 / 重放整份：人是要看最新的，强制贴底。
  scrollToBottom(true);
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

/**
 * 气泡里那条工具串：没有就现建一个，挂在正文上方。
 *
 * 工具条与**动手前那张权限卡片**都往这里追加——它们是同一件事的两半
 * （先问，再做），排在一起读起来才是「问了、答了、然后做了什么」。
 * 就地追加而不是重建气泡：重建会把正在流的正文冲掉（`.msg-body` 是纯文本
 * 节点，delta 靠 `textContent +=` 追加）。
 */
export function toolStripOf(turnId: string): HTMLElement | null {
  const node = bubbleOf(turnId);
  if (!node) {
    return null;
  }
  let strip = node.querySelector<HTMLElement>('.tools');
  if (!strip) {
    strip = buildToolStrip();
    node.insertBefore(strip, node.querySelector('.msg-body'));
  }
  return strip;
}

/** 离底多近算「贴着底」。与日志页同一档。 */
const AT_BOTTOM_SLACK = 40;

/**
 * 用户贴着底时跟着新内容滚；翻上去看前面的气泡时不该被拽回来。
 *
 * 用滚动事件记账，而不是在 `scrollToBottom` 里当场量距离：delta 是先
 * 追加正文再滚，量的时候内容已经变高，贴着底的人会被算成「离底好远」
 * 从而掉队。
 */
let follow = true;

function isAtBottom(): boolean {
  const box = el.messages;
  return box.scrollHeight - box.scrollTop - box.clientHeight < AT_BOTTOM_SLACK;
}

/**
 * 滚到消息流底部。
 *
 * 流式输出每来一段都会调这里；**只在原本就贴着底时才跟着滚**——
 * 用户翻上去看前面的气泡时不该被拽回来（日志页同一条理由）。
 * `force` 给切会话、主动发送：那是人自己起的头，应当看到最新。
 */
export function scrollToBottom(force = false): void {
  if (!force && !follow) {
    return;
  }
  el.messages.scrollTop = el.messages.scrollHeight;
  follow = true;
}

export function installMessages(): void {
  el.messages.addEventListener('scroll', () => {
    follow = isAtBottom();
  });
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

  // agent 那一轮的花销：几步、几次生成、大约多少 token。第 4 条要求它
  // 看得见，而且要留得住——所以画的是会话里存的那一份，不是实时消息。
  if (turn.agentRun) {
    wrap.appendChild(buildAgentRunRow(turn.agentRun));
  }

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
 * 都在大纲和前后段里（命令一律不要求输入，见 `commandsFor`）。但**空气泡不能就这么空着**：
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

/**
 * 气泡末尾那一行：这一轮产出的东西**落到哪儿了**，加一颗「复制」。
 *
 * **这里没有任何能写文件的按钮。** 写不写在产出的当下就问过了——那是气泡
 * 里的一张权限卡片（`view/gate.ts`），和 agent 动手前那一问长一个样。从前
 * 这里是「采纳写入 / 覆盖并写入」：一颗**可以永远不点的按钮**，于是「产物
 * 落盘前必须过一遍人」在界面上成了一件可以无限拖延的事，作者手里攒着三份
 * 没落地的产物，谁也说不清哪份写过。
 *
 * 留下的是记录：写了的说写到哪（可点开），没写的标一句「未采纳」。
 */
function buildActions(turn: SerializedTurn): HTMLElement {
  const bar = mk('div', 'msg-actions');
  if (turn.role !== 'assistant' || !turn.content || turn.error) {
    return bar;
  }

  /** 复制取的是**气泡里当下的文本**（可能被就地改过），不是 turn.content。 */
  const currentText = () => bubbleOf(turn.id)?.querySelector('.msg-body')?.textContent ?? turn.content;

  if (turn.acceptedTo) {
    bar.appendChild(mk('span', 'accepted', `✓ 已写入 ${turn.acceptedTo}`));
    bar.appendChild(linkBtn('打开', () => openPath(turn.acceptedTo!)));
  } else if (turn.artifact) {
    // 产出过一份结构化产物，但没落盘：说清是什么、本来要写到哪。
    const a = turn.artifact;
    const line = `${a.where} · ${a.summary}${a.declined ? ' · 未采纳' : ''}`;
    bar.appendChild(mk('span', 'artifact-where', line));
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

/**
 * agent 工具调用的那一串折叠条。
 *
 * ```
 * 🔧 search「北境」        2 处命中   0.3s
 * 🔧 read chapters/009…   142 行     0.1s
 * ✨ generate 剧情         620 字     12.4s
 * ```
 *
 * **那一行上只画摘要**：`read` 一章正文是几千字，摊在气泡里会把作者真正要看的
 * 那段回答挤到屏幕外。参数与返回文本收在折叠里——想核对「它读的是哪一章、
 * 看到的是什么」点开就有，不想看时它一行都不占（后端已经截过，见
 * `controller/agent.ts`）。
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
  argsText?: string;
  resultText?: string;
  open?: boolean;
}): HTMLElement {
  const line = mk('summary', 'tool-line');
  // 花钱的那个用另一个图标：作者一眼要能看出这一串里哪几下是收费的。
  line.appendChild(mk('span', 'tool-icon', call.name === 'generate' ? '✨' : '🔧'));
  line.appendChild(mk('span', 'tool-title', call.title));
  line.appendChild(mk('span', 'tool-summary', call.summary));
  line.appendChild(mk('span', 'tool-elapsed', formatElapsed(call.elapsedMs)));

  const parts: [string, string][] = [];
  if (call.argsText) {
    parts.push(['参数', call.argsText]);
  }
  if (call.resultText) {
    parts.push(['返回', call.resultText]);
  }

  // 没有明细可看（老会话里存的那些）就还是一行普通的条：给一个点开之后
  // 空空如也的三角，比不给更让人火大。
  if (parts.length === 0) {
    const flat = mk('div', `tool-row tool-flat${call.ok ? '' : ' tool-failed'}`);
    flat.dataset.call = call.callId;
    for (const child of [...line.childNodes]) {
      flat.appendChild(child);
    }
    return flat;
  }

  const row = mk('details', `tool-row${call.ok ? '' : ' tool-failed'}`);
  row.dataset.call = call.callId;
  row.open = call.open === true;
  row.appendChild(line);
  const body = mk('div', 'tool-detail');
  for (const [label, text] of parts) {
    body.appendChild(mk('div', 'tool-detail-label', label));
    body.appendChild(mk('pre', 'tool-detail-text', text));
  }
  row.appendChild(body);
  return row;
}

/**
 * 一次工具调用刚开始，还没有结果。收到 `toolResult` 时就地补上。
 *
 * 参数这时就有了，所以这一条已经能展开——它正在读哪个路径，是「它卡在
 * 哪一步」最先要看的东西。
 */
export function buildPendingToolRow(
  callId: string,
  title: string,
  detail?: string,
  argsText?: string
): HTMLElement {
  return buildToolRow({
    callId,
    name: title.split(' ')[0],
    title,
    ok: true,
    summary: detail ?? '进行中…',
    elapsedMs: -1,
    argsText,
  });
}

function formatElapsed(ms: number): string {
  if (ms < 0) {
    return '';
  }
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * agent 那一轮末尾的花销行。
 *
 * ```
 * ─────────────────────────────────
 * 5 步 · 1 次生成 · 约 1.8 万 token
 * ```
 *
 * **非正常结束时把原因写在同一行**（触顶、原地打转、作者叫停）：那句话是
 * 「为什么只做到这里」的唯一去处，toast 五秒就没了。
 */
export function buildAgentRunRow(run: SerializedAgentRun): HTMLElement {
  const row = mk('div', 'agent-run');
  const parts = [`${run.steps} 步`];
  if (run.calls > 0) {
    parts.push(`${run.calls} 次生成`);
  }
  if (run.tokens > 0) {
    parts.push(`约 ${formatTokens(run.tokens)} token`);
  }
  row.appendChild(mk('span', 'agent-run-cost', parts.join(' · ')));
  if (run.stopReason !== 'done' && run.message) {
    const why = mk('span', 'agent-run-why', run.message);
    row.appendChild(why);
    row.classList.add('agent-run-stopped');
  }
  return row;
}

/** 与日志的口径一致：上万就报「万」，几千的照实说。 */
function formatTokens(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n);
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
