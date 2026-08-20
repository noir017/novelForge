/**
 * agent 动手之前那一句问，画在对话里。
 *
 * ```
 * 🔒 Agent 要写入设定「北境雪原」
 *    .novelforge/lore/北境雪原.md
 *    ▸ 参数
 *    [ 写入 ]  跳过这一步   停止 agent
 * ```
 *
 * **不是模态框**：作者要判断的上下文（它刚读了哪几章、正要写哪个文件）就在
 * 这条气泡里，一个盖住窗口的框会把这些全挡上，还顺手锁死界面——想先翻一眼
 * 那个文件再决定都做不到。所以这张卡片挂在工具串上，和随后的工具条排一起，
 * 页面照常能滚、能翻、能点别的。
 *
 * **两种问法长一个样**：agent 动手前的闸门，以及**产物落盘前那一句**——后者
 * 从前是气泡末尾那颗「采纳写入」，一颗可以永远不点的按钮。单步创作那条路的
 * 落盘卡片只有两颗按钮（没有循环可停），靠 `msg.stop` 在不在判断。
 *
 * 三颗按钮上的字全部由后端给（`agentGate`）：「写入」「替换」「执行」是工具
 * 自报的说辞，前端写死一份的话，改了文案两边就对不上。
 *
 * 答完之后卡片**收成一行**留在原地，不整条抹掉——紧跟着的那条工具条会说
 * 「未执行」，而「因为我按了跳过」这件事只有这一行讲得出。这一轮结束时气泡
 * 会按会话重建，那时它自然消失（决定本身已经记在工具条上了）。
 */
import { el as mk } from '../dom';
import type { OutMessage } from '../protocol';
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

/** 建一张等作者点头的卡片。 */
export function buildGateCard(msg: GateMessage): HTMLElement {
  const card = mk('div', 'tool-gate');
  card.dataset.gate = msg.requestId;

  const head = mk('div', 'tool-gate-head');
  head.appendChild(mk('span', 'tool-gate-icon', '🔒'));
  head.appendChild(mk('span', 'tool-gate-title', msg.title));
  card.appendChild(head);

  // 写到哪、写多少——「Agent 想调用 write，允许吗」作者答不上来，
  // 这一行才是他做判断的依据。
  if (msg.detail) {
    card.appendChild(mk('div', 'tool-gate-detail', msg.detail));
  }
  if (msg.argsText) {
    const det = mk('details', 'tool-gate-args');
    det.appendChild(mk('summary', undefined, '参数'));
    det.appendChild(mk('pre', 'tool-detail-text', msg.argsText));
    card.appendChild(det);
  }

  const answer = (verdict: 'proceed' | 'skip' | 'stop') => {
    // 先就地锁上：慢一点的后端回话之前，作者不该能把三颗都点一遍。
    settleGateCard(card, verdict);
    vscode.postMessage({ type: 'gateResult', requestId: msg.requestId, verdict });
  };

  // 同意是主按钮，另外两颗压成描边胶囊：三颗一样重的话，作者会下意识点最左边
  // 那颗——而这一下是「动我的磁盘」。停止那颗单独标红字，它掐的是整轮。
  //
  // **「停止 agent」可能没有**：单步创作（点「写剧情」）产出后那张落盘卡片
  // 背后没有循环可停，多一颗只会让作者以为自己在跟 agent 说话。
  const actions = mk('div', 'tool-gate-actions');
  actions.appendChild(gateBtn(msg.proceed, 'primary', () => answer('proceed')));
  actions.appendChild(gateBtn(msg.skip, 'chip-btn', () => answer('skip')));
  if (msg.stop) {
    actions.appendChild(gateBtn(msg.stop, 'chip-btn tool-gate-stop', () => answer('stop')));
  }
  card.appendChild(actions);
  return card;
}

/** 这张卡答完了：按钮换成一行结论，不再能点。 */
export function settleGateCard(card: HTMLElement, verdict: Verdict): void {
  if (card.classList.contains('settled')) {
    return;
  }
  card.classList.add('settled');
  card.classList.toggle('declined', verdict !== 'proceed');
  card.querySelector('.tool-gate-actions')?.replaceWith(mk('div', 'tool-gate-verdict', SETTLED[verdict]));
}

/** 按 requestId 找那张卡（两个视图各有一份 DOM，各找各的）。 */
export function gateCardOf(root: ParentNode, requestId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.tool-gate[data-gate="${requestId}"]`);
}

function gateBtn(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = mk('button', className, text);
  b.addEventListener('click', onClick);
  return b;
}
