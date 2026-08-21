/**
 * 消息气泡。一条 turn 对应一个 `.msg`：头部（角色/时刻/字数/⋯ 菜单）、附件、
 * 思考过程、**段区**、花销、上下文明细、行内动作各是一块。
 *
 * ## 段区：说的话与做的事交替
 *
 * agent 那一轮画的是 `turn.segments`——**顺序就是它发生的顺序**：
 *
 * ```
 * 🔧 list 2 项            ┐ 相邻的工具段并进同一串
 * 🔧 read 19 行           ┘
 * ┌ 我先看看工程现在的结构。      ← 一段文字
 * ✨ 生成 · 全书大纲 · 6104 字   ← generate 单独一张卡，正文限高滚动
 * ┌ 大纲已经生成并落盘到…        ← 又一段文字
 * ```
 *
 * 从前是「所有工具挤在正文上方 + 所有话灌进同一个 `.msg-body`」，作者看不出
 * 哪句话是在哪一步之后说的，而 `generate` 产出的几千字还和模型的话拌在一个
 * 文本节点里。没有段的轮次（单步创作、纯聊天）照旧只有一块正文。
 *
 * **生成中不可编辑**是这里最要紧的一条：contentEditable 的光标会被后续
 * delta 追加冲掉，用户改到一半的内容也会被 turnDone 的整体重建覆盖。
 * 判据是 `store.streamingId`，由 index.ts 在 turnDone 那一刻定下来。
 * **有段的那一轮一律不可编辑**：`editTurn` 的语义是「整轮内容换成这一段文字」，
 * 多块之间没法映射；agent 的产物改不改走落盘卡片那条路。
 *
 * **流式时只在贴着底才跟滚**：每来一段 delta 都会 `scrollToBottom()`，
 * 翻上去看前面的气泡时不该被拽回来（与日志页同一条理由）。
 */
import { el as mk, spacer } from '../dom';
import type {
  SerializedAgentRun,
  SerializedDigest,
  SerializedToolCall,
  SerializedTurn,
} from '../protocol';
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
 * 气泡里**最后**那一串工具条：没有就在段区末尾现建一个。
 *
 * 「最后」是段区的要点：一轮里工具串会被文字段打断好几次，新的一次调用要接在
 * **当下**那一串上，接到第一串上就等于把顺序又抹平了。
 *
 * 工具条与**权限请求答完那一行**（`.gate-note`，见 gate.ts）都往这里追加——
 * 它们是同一件事的两半（先问，再做），排在一起读起来才是「问了、答了、然后
 * 做了什么」。问本身不在这里：那张卡片固定在输入框上方，不跟着消息流滚。
 * 就地追加而不是重建气泡：重建会把正在流的内容冲掉（文字块是纯文本节点，
 * delta 靠 `textContent +=` 追加）。
 */
export function toolStripOf(turnId: string): HTMLElement | null {
  const node = bubbleOf(turnId);
  if (!node) {
    return null;
  }
  // **只有还排在末尾的那一串接得上**：中间说过一句话之后，那一串已经翻篇了，
  // 再往它上面追加等于把这次调用挪到那句话前面去。
  const last = lastSegment(node);
  if (last?.classList.contains('tools')) {
    return last as HTMLElement;
  }
  const strip = buildToolStrip();
  node.insertBefore(strip, segmentAnchor(node));
  return strip;
}

/** 段区里当下的最后一段（工具串 / 文字块 / generate 卡都算）。 */
export function lastSegment(node: ParentNode): HTMLElement | undefined {
  const segments = node.querySelectorAll<HTMLElement>('.msg-body[data-seg="text"], .tools, .gen');
  return segments[segments.length - 1];
}

/**
 * 撤掉那块**一个字都没写过**的正文占位。
 *
 * 它是一轮刚开始时留的位（见 `buildTurn`）。第一段结果是工具调用时，留着它就是
 * 在工具条上方摆一个空盒子，还会让随后的文字接不上——段区里空的文字块没有任何
 * 意义（后端那边 `textOf` 也把空段滤掉了）。
 */
export function dropEmptyText(node: ParentNode): void {
  for (const block of node.querySelectorAll<HTMLElement>('.msg-body[data-seg="text"]')) {
    if ((block.textContent ?? '') === '') {
      block.remove();
    }
  }
}

/**
 * 段区的末尾：新的一段插在**这个节点前面**。
 *
 * 气泡的孩子是「头 / 附件 / 思考 / 段区… / 花销 / 上下文 / 行内动作」，后三样
 * 是这一轮的收尾，任何一段新内容都该排在它们之前。三样都可能不在（跑到一半），
 * 所以按这个顺序找第一个在的；全都不在就返回 null（= 追加到末尾）。
 */
export function segmentAnchor(node: ParentNode): Element | null {
  return node.querySelector('.agent-run') ?? node.querySelector('.ctx') ?? node.querySelector('.msg-actions');
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
  // 段区：它说的话与它做的事按发生顺序交替。没有段的轮次就是一块正文。
  if (turn.role === 'assistant' && turn.segments && turn.segments.length > 0) {
    for (const node of buildSegments(turn)) {
      wrap.appendChild(node);
    }
  } else if (turn.role === 'user' || turn.content || turn.error || store.streamingId === turn.id) {
    // 空的 assistant 正文**只在这一轮正流着的时候**画：推理模型常常先想几十秒
    // 才吐第一个字，那段时间界面上得有个东西说「内容长在这儿」。已经结束、又
    // 什么都没说的轮次不画那个空盒子；第一段是工具调用时，它会被
    // `appendToolCall` 就地撤掉（一个字都没写过的块留着只是挡路）。
    wrap.appendChild(buildBody(turn));
  }

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
 * 气泡正文（**没有段的那一轮**：单步创作、纯聊天）。
 *
 * assistant 那一支**刻意保持成一个纯文本节点**：流式增量走的是
 * `body.textContent += delta`（index.ts），里面有子元素的话第一片增量就会
 * 把它们冲掉；就地编辑的 blur 判据也是拿 `body.textContent` 比 `turn.content`。
 * 要加结构的是 user 那一支。
 *
 * 有段的那一轮画的是 `buildTextBlock`（只读）：`editTurn` 换的是**整轮内容**，
 * 而那时正文分成好几块，改哪一块都映射不回去。
 */
function buildBody(turn: SerializedTurn): HTMLElement {
  const body = mk('div', 'msg-body');
  body.dataset.seg = 'text';

  if (turn.role === 'user') {
    delete body.dataset.seg;
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
 * **这里没有任何能写文件的按钮。** 写不写在产出的当下就问过了——那是输入框
 * 上方那张权限卡片（`view/gate.ts`），和 agent 动手前那一问长一个样。从前
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

  /**
   * 复制取的是**气泡里当下的文本**（可能被就地改过），不是 turn.content。
   *
   * 段区里可能有好几块文字（说一句、做一件事、再说一句），全都要——只取第一块
   * 的话，复制出来的是半截结论。工具条与 generate 卡不进剪贴板：那是过程与产物，
   * 产物有自己的落点。
   */
  const currentText = () => {
    const blocks = [...(bubbleOf(turn.id)?.querySelectorAll<HTMLElement>('.msg-body[data-seg="text"]') ?? [])];
    const text = blocks
      .map((b) => b.textContent?.trim() ?? '')
      .filter((t) => t.length > 0)
      .join('\n\n');
    return text || turn.content;
  };

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
 * 把一轮的段画成一串节点。
 *
 * **相邻的工具段并进同一个 `.tools` 组**：连着五次 `list` / `read` 仍然读成
 * 一串流水账，散成五块反而比从前更乱。文字段与 generate 卡打断它——那正是
 * 「读了三份 → 说一句 → 生成 → 再说一句」看得出来的地方。
 */
function buildSegments(turn: SerializedTurn): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  /** 当前那一串工具条。遇到别的段就作废，下一次工具调用重开一串。 */
  let strip: HTMLElement | undefined;

  for (const seg of turn.segments ?? []) {
    if (seg.kind === 'text') {
      strip = undefined;
      nodes.push(buildTextBlock(seg.text));
      continue;
    }
    if (isGenerate(seg.call)) {
      strip = undefined;
      nodes.push(buildGenCard(seg.call));
      continue;
    }
    if (!strip) {
      strip = buildToolStrip();
      nodes.push(strip);
    }
    strip.appendChild(buildToolRow(seg.call));
  }
  return nodes;
}

/**
 * 一段文字。**有段的那一轮一律只读**（见文件头）。
 *
 * `data-seg` 标出「这是段区里的一块文字」：流式追加要找的是**最后**那一块，
 * 而气泡里别的地方（用户那一支、错误文本）也叫 `.msg-body`。
 */
export function buildTextBlock(text: string): HTMLElement {
  const body = mk('div', 'msg-body', text);
  body.dataset.seg = 'text';
  return body;
}

/** 这一次调用是不是「花钱产出了一份东西」。产出的正文画成一张卡，不是一行。 */
function isGenerate(call: SerializedToolCall): boolean {
  return call.name === 'generate' || call.output !== undefined;
}

/**
 * `generate` 那一次的卡片。
 *
 * ```
 * ┌ ✨ generate                              23.6s ▾ ┐
 * │ ✓ 全书大纲 · 6104 字 · 已写入 .novelforge/outline.md│
 * ├──────────────────────────────────────────────────┤
 * │ ### 全书结构一览                                  │
 * │ **第一卷 活着**：半世界陷入病灾…                   │ ← 限高，卡内滚动
 * │ ▸ 参数与返回                                      │
 * └──────────────────────────────────────────────────┘
 * ```
 *
 * **它不是一行流水账**：`read` 回来的东西是它查资料的过程，而这几千字是**产物
 * 本身**——作者接下来要判断「这份要不要落盘」，读的就是它。所以默认展开（点头
 * 部可收起），限高滚动：铺开会把整轮对话顶出屏幕，藏起来又等于让他隔着一行摘要
 * 去决定要不要写进书里。
 *
 * 落盘的结论由后端拼在 `summary` 后面（「已生成 4/4 节 · 已写入 X」），画成**单独
 * 一行**而不是挤进头里：那一行在侧栏的宽度下会被截成
 * `gener… 全书大纲 · 6104 字 · 已写入 .novelforg…`，而「写到哪儿了」恰恰是作者
 * 最要看清的一句。这两行都长在 `<summary>` 里，所以**收起来之后它们还在**——
 * 折叠只藏产物正文。
 */
export function buildGenCard(call: SerializedToolCall & { open?: boolean }): HTMLElement {
  const card = mk('details', `gen${call.ok ? '' : ' gen-failed'}`);
  card.dataset.call = call.callId;
  (card as HTMLDetailsElement).open = call.open !== false;

  const head = mk('summary', 'gen-head');
  const line = mk('div', 'gen-line');
  line.appendChild(mk('span', 'gen-icon', '✨'));
  line.appendChild(mk('span', 'gen-title', call.title));
  line.appendChild(spacer());
  line.appendChild(mk('span', 'gen-elapsed', formatElapsed(call.elapsedMs)));
  head.appendChild(line);
  head.appendChild(buildGenState(call));
  card.appendChild(head);

  card.appendChild(mk('pre', 'gen-body', call.output ?? ''));

  // 参数与返回收在再一层折叠里。**花钱那一下更要查得出它动的是哪一章**：卡上
  // 那两行说的是「产出了什么」，而「它是按哪个落点、哪句要求生成的」只在参数里。
  const detail = buildToolDetail(call);
  if (detail) {
    const det = mk('details', 'gen-args');
    det.appendChild(mk('summary', undefined, '参数与返回'));
    det.appendChild(detail);
    card.appendChild(det);
  }
  return card;
}

/** 卡上那一行结论。还没跑完时说「生成中…」，不摆一句空话。 */
function buildGenState(call: SerializedToolCall): HTMLElement {
  const pending = call.elapsedMs < 0;
  const row = mk('div', `gen-state${call.ok || pending ? '' : ' gen-state-failed'}`);
  row.appendChild(mk('span', 'gen-state-icon', pending ? '…' : call.ok ? '✓' : '⊘'));
  row.appendChild(mk('span', 'gen-state-text', pending ? '生成中…' : call.summary));
  return row;
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

  const detail = buildToolDetail(call);

  // 没有明细可看（老会话里存的那些）就还是一行普通的条：给一个点开之后
  // 空空如也的三角，比不给更让人火大。
  if (!detail) {
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
  row.appendChild(detail);
  return row;
}

/**
 * 那一步的明细：**它填的参数**与**回给模型的那段文本**（两者都由后端截过）。
 *
 * 要核对「它读的是哪一章、看到的是什么」时，这里是唯一的去处。两样都没有就回
 * undefined——调用方据此不给折叠三角（点开之后空空如也比不给更让人火大）。
 */
function buildToolDetail(call: SerializedToolCall): HTMLElement | undefined {
  const parts: [string, string][] = [];
  if (call.argsText) {
    parts.push(['参数', call.argsText]);
  }
  if (call.resultText) {
    parts.push(['返回', call.resultText]);
  }
  if (parts.length === 0) {
    return undefined;
  }
  const body = mk('div', 'tool-detail');
  for (const [label, text] of parts) {
    body.appendChild(mk('div', 'tool-detail-label', label));
    body.appendChild(mk('pre', 'tool-detail-text', text));
  }
  return body;
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
