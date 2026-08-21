/**
 * agent 动手之前那一句问，**固定在输入框上方那一格**。
 *
 * ```
 * ┌──────────────────────────────────────────┐
 * │ 权限请求                                  │
 * │ Agent 要把生成的产物覆盖到「全书大纲」      │
 * │ 全书大纲 · 6104 字 · 那里已经有内容了       │
 * │ ▸ 参数                                    │
 * │ 停止 agent            不采纳  覆盖并写入   │
 * └──────────────────────────────────────────┘
 * ┌ 大纲：故事讲什么？ ──────────────────────┐
 * ```
 *
 * **不是模态框**：作者要判断的上下文（它刚读了哪几章、正要写哪个文件）就在
 * 消息流里，一个盖住窗口的框会把这些全挡上，还顺手锁死界面——想先翻一眼那个
 * 文件再决定都做不到。
 *
 * **也不是消息流里的一张卡片**：那是这一版之前的样子。卡片挂在气泡上就会跟着
 * 内容滚——agent 随后还在说话、还在调工具，几行之后那张卡就滚出视野了，而循环
 * 正卡在它上面等回答。作者看到的是一个「卡住不动」的界面，要往上翻才找得到原
 * 因。所以它改挂在输入框上方：那里不滚、离手最近，且与「要不要发这句话」是同
 * 一个位置上的同一类决定（Cursor / Claude Code 那一套）。
 *
 * **答完卡片就走，记录留在消息流里**：紧跟着的那条工具条只会说「未执行」，而
 * 「因为我按了跳过」这件事得有地方讲——于是往那一轮的工具串（或产物正文下面）
 * 补一行 `.gate-note`。这一轮结束时气泡按会话重建，那一行自然消失（决定本身已
 * 经记在工具条上了）。
 *
 * 三颗按钮上的字全部由后端给（`agentGate`）：「写入」「替换」「执行」是工具
 * 自报的说辞，前端写死一份的话，改了文案两边就对不上。
 */
import { el as mk, setHidden, spacer } from '../dom';
import type { OutMessage } from '../protocol';
import { bubbleOf, toolStripOf } from './messages';
import { el } from './refs';
import { vscode } from './store';

type GateMessage = Extract<OutMessage, { type: 'gate' }>;
type Verdict = 'proceed' | 'skip' | 'stop' | 'cancelled';

/** 结算之后那一行上的说法。取消是「这一轮停了」，不是作者答的。 */
const SETTLED: Record<Verdict, string> = {
  proceed: '已允许',
  skip: '已跳过这一步',
  stop: '已停止 agent',
  cancelled: '已取消，没有执行',
};

/**
 * 推上来一条询问：卡片进输入框上方那一格。
 *
 * 重连时后端会把还没答的这几条原样再推一遍，已经画着的不再画第二张。
 * **不挑气泡**：认不出的 turnId 照样画——循环卡在这一问上，把卡片丢掉等于
 * 留一个没人看得见的死等。
 */
export function showGate(msg: GateMessage): void {
  if (gateCardOf(msg.requestId)) {
    return;
  }
  el.gateDock.appendChild(buildGateCard(msg));
  syncDock();
}

/**
 * 这一问答完了：卡片撤下，消息流里补一行记录。
 *
 * 三条路进这里——作者点了这边的按钮、作者在另一个视图上点了（后端广播
 * `gateDone`）、这一轮被取消。**只有第一次算数**：答过之后格子里已经没有这张
 * 卡，后来的广播就地静默（认不出的 requestId 同理，重连之后前端可能还留着
 * 一条早就结束了的询问）。
 *
 * @returns 这一下是不是真的结算了（false = 早就答过了，不必再发回后端）
 */
export function settleGate(requestId: string, verdict: Verdict): boolean {
  const card = gateCardOf(requestId);
  if (!card) {
    return false;
  }
  card.remove();
  syncDock();
  noteVerdict(card, verdict);
  return true;
}

// ---------------------------------------------------------------- 卡片

function buildGateCard(msg: GateMessage): HTMLElement {
  const card = mk('div', 'gate');
  card.dataset.gate = msg.requestId;
  // 答完要往哪条气泡上补那一行记录。卡片已经不在消息流里，只能自己记着。
  card.dataset.turn = msg.turnId;
  if (msg.callId) {
    card.dataset.call = msg.callId;
  }
  card.dataset.what = msg.title;

  // 头一行只有一个淡淡的名分。堆了两张以上时右边补「1 / 2」——一格里叠着
  // 好几张时，作者得知道自己在答哪一张。
  const head = mk('div', 'gate-head');
  head.appendChild(mk('span', 'gate-kind', '权限请求'));
  head.appendChild(spacer());
  head.appendChild(mk('span', 'gate-count'));
  card.appendChild(head);

  card.appendChild(mk('div', 'gate-title', msg.title));

  // 写到哪、写多少——「Agent 想调用 write，允许吗」作者答不上来，
  // 这一行才是他做判断的依据。
  if (msg.detail) {
    card.appendChild(mk('div', 'gate-detail', msg.detail));
  }
  if (msg.argsText) {
    const det = mk('details', 'gate-args');
    det.appendChild(mk('summary', undefined, '参数'));
    det.appendChild(mk('pre', 'tool-detail-text', msg.argsText));
    card.appendChild(det);
  }

  const answer = (verdict: 'proceed' | 'skip' | 'stop') => {
    // 先就地撤卡：慢一点的后端回话之前，作者不该能把三颗都点一遍。
    if (settleGate(msg.requestId, verdict)) {
      vscode.postMessage({ type: 'gateResult', requestId: msg.requestId, verdict });
    }
  };

  // 同意贴最右（离「发送」最近的那一侧就是「继续」），拒绝挨着它压成次级按钮。
  // 三颗一样重的话，作者会下意识点最左边那颗——而这一下是「动我的磁盘」。
  //
  // 「停止 agent」掐的是整轮，单独摆到最左边、画成一颗文字按钮：它与另外两颗
  // 不是同一类选择（那两颗答的是「这一步」）。**它可能根本没有**——单步创作
  // （点「写剧情」）产出后那张落盘卡片背后没有循环可停，多一颗只会让作者以为
  // 自己在跟 agent 说话。
  const actions = mk('div', 'gate-actions');
  if (msg.stop) {
    actions.appendChild(gateBtn(msg.stop, 'gate-quiet gate-stop', () => answer('stop')));
  }
  actions.appendChild(spacer());
  actions.appendChild(gateBtn(msg.skip, 'secondary', () => answer('skip')));
  actions.appendChild(gateBtn(msg.proceed, 'primary', () => answer('proceed')));
  card.appendChild(actions);
  return card;
}

function gateBtn(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = mk('button', className, text);
  b.addEventListener('click', onClick);
  return b;
}

/** 按 requestId 找那张还没答的卡。 */
function gateCardOf(requestId: string): HTMLElement | null {
  return el.gateDock.querySelector<HTMLElement>(`.gate[data-gate="${requestId}"]`);
}

/** 空了就整格收起来（免得输入框上方常年多一道边）；顺手重编「第几张」。 */
function syncDock(): void {
  const cards = [...el.gateDock.querySelectorAll<HTMLElement>('.gate')];
  setHidden(el.gateDock, cards.length === 0);
  cards.forEach((card, i) => {
    const count = card.querySelector('.gate-count');
    if (count) {
      count.textContent = cards.length > 1 ? `${i + 1} / ${cards.length}` : '';
    }
  });
}

/**
 * 往消息流里补一行「答了什么」。
 *
 * 挂哪儿和从前那张卡片一个规矩：带 `callId` 的是某一次工具调用的事，排进工具
 * 串（问了、答了、然后做了什么，读起来是一条线）；不带的是单步创作产出之后那
 * 一问，挂在正文**下面**——那份产物就是作者做判断的依据。
 *
 * 气泡可能已经不在了（换了会话、这一轮重建过）：那就不补，没有记录也好过往
 * 别人的气泡上乱插一行。
 */
function noteVerdict(card: HTMLElement, verdict: Verdict): void {
  const turnId = card.dataset.turn;
  if (!turnId) {
    return;
  }
  const host = card.dataset.call ? toolStripOf(turnId) : bubbleOf(turnId);
  if (!host) {
    return;
  }
  const note = mk('div', `gate-note${verdict === 'proceed' ? '' : ' declined'}`);
  note.dataset.gateNote = card.dataset.gate ?? '';
  note.appendChild(mk('span', 'gate-note-icon', verdict === 'proceed' ? '✓' : '⊘'));
  const what = card.dataset.what;
  note.appendChild(mk('span', 'gate-note-text', what ? `${SETTLED[verdict]}：${what}` : SETTLED[verdict]));
  if (card.dataset.call) {
    host.appendChild(note);
  } else {
    // 末尾那一行（复制/落点）之后没有意义，插在它前面。
    host.insertBefore(note, host.querySelector('.msg-actions'));
  }
}
