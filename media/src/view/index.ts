/**
 * 面板的前端入口。插件与独立版共用同一份，差异全靠**能力探测**
 * （`#wbEditor` 在不在），不判断环境字符串。
 *
 * **前端无状态**：一切数据来自 `ViewState` / `ProjectTree` 的全量推送，
 * webview 销毁重建后一条 `ready` 就能完整恢复；展开/折叠等纯 UI 状态
 * 留在前端各自的模块里。
 *
 * 消息契约是 [core/protocol](../../../src/core/protocol/index.ts) 的
 * `InMessage` / `OutMessage`，经 src/protocol.ts 引进来——改协议这边
 * 对不上会直接编译不过。
 */
import { installComposer, renderChips } from './composer';
import { renderSessions } from './history';
import { appendLog, installLogs, prependLogHistory, renderLogs } from './logs';
import { installMenubar } from './menubar';
import { installMenus } from './menu';
import {
  buildAgentRunRow,
  buildGenCard,
  buildPendingToolRow,
  buildReasoningDetails,
  buildTextBlock,
  buildToolRow,
  bubbleOf,
  dropEmptyText,
  installMessages,
  lastSegment,
  renderSession,
  reasoningLabel,
  scrollToBottom,
  segmentAnchor,
  toolStripOf,
  upsertTurn,
} from './messages';
import { settleGate, showGate } from './gate';
import { applySummary, installProject, invalidateSummaries, renderProject } from './project';
import { baseMenuItems } from './project/actions';
import { installNewSession, installRenamePlot, renderPipeline } from './pipeline';
import { renderWorkbench, installWorkbench } from './workbench';
import { renderPrompt } from './prompt';
import { installSettings, renderSettings } from './settings';
import { renderState, setBusy } from './state';
import { restoreDraft, store, vscode } from './store';
import { installTabs, isTabActive, showTab } from './tabs';
import { renderTasks } from './tasks';
import { exposeToast, toast } from './toast';
import { installFolderPicker } from './folderPicker';
import { applyWorkspaces, installWelcome } from './welcome';
import { onMessage } from '../vscodeApi';

restoreDraft();
exposeToast();
installMenus(baseMenuItems);
installTabs();
installComposer();
installMessages();
installNewSession();
installRenamePlot();
installProject();
installLogs();
installSettings();
installWorkbench();
installMenubar();
installWelcome();
installFolderPicker();

onMessage((msg) => {
  switch (msg.type) {
    case 'init':
    case 'state':
      renderState(msg.state);
      break;

    case 'tab':
      showTab(msg.tab);
      break;

    case 'session':
      renderSession(msg.session);
      break;

    case 'sessions':
      renderSessions(msg.list);
      break;

    case 'project':
      // 后端推树 = 磁盘上有东西变了（可能正是某一章的正文或摘要）。
      // 摘要缓存一律作废，宁可再取一次也不拿旧摘要糊弄人。折叠文件夹走的是
      // rerenderProject()，不经这里，缓存留着。
      invalidateSummaries();
      renderProject(msg.tree);
      break;

    case 'summary':
      applySummary(msg.summary);
      break;

    case 'pipeline':
      renderPipeline(msg.pipeline);
      renderWorkbench(msg.workbench);
      break;

    case 'attachments':
      store.attachments = msg.items;
      renderChips();
      break;

    case 'delta':
      store.streamingId = msg.turnId;
      appendText(msg.turnId, msg.text);
      break;

    case 'toolDelta':
      appendGenerated(msg.turnId, msg.callId, msg.text);
      break;

    case 'reasoning':
      appendReasoning(msg.turnId, msg.text);
      break;

    // ---- agent 的三条：步数、工具调用、工具结果
    case 'agentStep':
      // 步数只进进度条（工程页顶部那条）与日志，气泡里不画——每一步一行
      // 「第 3 步」会把真正有信息量的工具调用挤散。
      break;

    case 'toolCall':
      appendToolCall(msg.turnId, msg.callId, msg.name, msg.title ?? msg.name, msg.detail, msg.argsText);
      break;

    case 'toolResult':
      settleToolCall(msg.turnId, msg);
      break;

    // ---- 动手之前那一句问：卡片固定在输入框上方，不弹全局模态框
    case 'gate':
      // 位置在 gate.ts 里定：**不在消息流里**——循环正卡在这一问上，一张跟着
      // 内容滚出视野的卡片等于没人看见。
      showGate(msg);
      // 顺手把消息流滚到底：作者要判断的依据（它刚读了什么、刚生成了什么）
      // 就在最后那几行上。
      scrollToBottom();
      // 人在别的页签上时那一格看不见，而循环正卡在这里等他——喊一声。
      // 不替他切页：他多半正是去工程页翻那个文件，好决定点不点头。
      if (!isTabActive('chat')) {
        toast('Agent 在等你点头，去对话页看看。');
      }
      break;

    case 'gateDone':
      // 另一个视图上答了，或者这一轮被取消了。两处的卡片都要收。
      settleGate(msg.requestId, msg.verdict);
      break;

    case 'agentDone':
      // 花销那一行立刻画出来（随后的 turnDone 会用会话里存的那份重建同一行）。
      settleAgentRun(msg.turnId, msg);
      // 非正常结束再补一句 toast——那一行上也写着，两处都有是有意的：
      // 正在看的人立刻知道，第二天回来翻的人也查得到。
      if (msg.stopReason !== 'done' && msg.message) {
        // `protocol`（接口把工具调用那一段丢了）跟 error 同一档：不换服务商
        // 就一直是这样，提示条得是红的。
        toast(msg.message, msg.stopReason === 'error' || msg.stopReason === 'protocol');
      }
      break;

    case 'turnDone':
      // 生成开始时控制器先插一条空回复，后续 delta 都挂在它上面。
      // 必须在这一刻就标成 streaming：否则气泡会以「可编辑」建出来，
      // 用户在生成途中的改动会被随后的 delta 追加和收尾重建冲掉。
      // 收尾的那次 turnDone 带着完整内容、busy 已为 false，于是解锁。
      store.streamingId =
        store.busy && msg.turn.role === 'assistant' && !msg.turn.content && !msg.turn.error
          ? msg.turn.id
          : null;
      upsertTurn(msg.turn);
      break;

    case 'busy':
      setBusy(msg.value);
      break;

    case 'settings':
      renderSettings(msg.settings, msg.keys, msg.ack);
      break;

    case 'tasks':
      renderTasks(msg.tasks);
      break;

    case 'logs':
      renderLogs(msg.entries);
      break;

    case 'logHistory':
      prependLogHistory(msg.entries, msg.exhausted);
      break;

    case 'log':
      appendLog(msg.entry);
      break;

    case 'toast':
      toast(msg.message, msg.level === 'error');
      break;

    case 'prompt':
      renderPrompt(msg);
      break;

    case 'workspaces':
      applyWorkspaces(msg);
      break;
  }
});

/**
 * 思考增量：接到**末尾那一块思考**上，末尾不是思考就新开一块。
 *
 * 与 `appendText` 是同一条规矩（也是同一个理由）：`想 → 查 → 想 → 说` 是
 * agent 的常态，第二次思考接到第一块上就等于把顺序抹平——而「它读完那三章
 * 之后在想什么」正是作者要看的那一段，跟第一回合的胡思乱想拌在一起就没了。
 *
 * **就地追加而不是重建节点**——重建会把用户展开的状态和滚动位置弄丢。
 */
function appendReasoning(turnId: string, text: string): void {
  const node = bubbleOf(turnId);
  if (!node) {
    return;
  }
  node.classList.add('streaming');
  // 一轮刚开始留的那块空正文（给「它在想」留的位）：思考块就是那个位子的
  // 主人，留着它等于在思考上方摆一个空盒子。
  dropEmptyText(node);

  const last = lastSegment(node);
  let det = last?.matches('details.reasoning') ? (last as HTMLDetailsElement) : undefined;
  if (!det) {
    det = buildReasoningDetails('');
    node.insertBefore(det, segmentAnchor(node));
  }
  const box = det.querySelector<HTMLElement>('.reasoning-body');
  if (box) {
    box.textContent = (box.textContent ?? '') + text;
    const summary = det.querySelector('summary');
    if (summary) {
      summary.textContent = reasoningLabel(box.textContent ?? '');
    }
    // 展开着看的时候，让它跟着滚到最新。
    if (det.open) {
      box.scrollTop = box.scrollHeight;
    }
  }
  scrollToBottom();
}

/**
 * 模型说的话又来了一段：追加到**最后那一块文字**上，没有就新开一块。
 *
 * 「没有就新开」正是交替：上一段是工具调用（或 generate 卡）时，这句话是新的
 * 一块，接到前一块上就等于把顺序抹平——那是从前所有话挤进同一个文本节点的
 * 由来。就地追加而不重建气泡：重建会冲掉正在流的内容。
 *
 * **纯空白的增量不开新块**：模型几乎总在调工具前后吐一两个换行，而
 * `.msg-body` 是 `pre-wrap` 加 8px 内边距——为一个 `\n` 开一块，画出来就是
 * 工具条之间一个一行多高的空盒子。同理，块首的空白也抹掉（那一块还什么都
 * 没有时，前导换行只是把第一行字往下推）。
 */
function appendText(turnId: string, text: string): void {
  const node = bubbleOf(turnId);
  if (!node) {
    return;
  }
  node.classList.add('streaming');
  const blocks = node.querySelectorAll<HTMLElement>('.msg-body[data-seg="text"]');
  const last = blocks[blocks.length - 1];
  // 末尾那一块才接得上；它后面已经排了工具条或卡片的话，得另开一块。
  if (last && last === lastSegment(node)) {
    // 一轮刚开始那块占位（或刚被空白喂过的块）还是空的：别把换行攒在最前面。
    last.textContent = (last.textContent ?? '').trim() === '' ? text.trimStart() : last.textContent + text;
  } else {
    const fresh = text.trimStart();
    if (!fresh) {
      return;
    }
    node.insertBefore(buildTextBlock(fresh), segmentAnchor(node));
  }
  scrollToBottom();
}

/**
 * `generate` 流出来的正文又来了一段：进它那一张卡。
 *
 * **卡内滚动，不动整条对话**：这几千字正在往下涨，要是让它把消息流一路往下顶，
 * 作者连上面刚说的那句话都看不成了。
 */
function appendGenerated(turnId: string, callId: string, text: string): void {
  const body = bubbleOf(turnId)?.querySelector<HTMLElement>(`.gen[data-call="${callId}"] .gen-body`);
  if (!body) {
    return;
  }
  body.textContent += text;
  body.scrollTop = body.scrollHeight;
}

/**
 * 工具调用开始：在气泡里挂一条「进行中…」的行，或者给 generate 开一张卡。
 *
 * **就地追加而不是重建气泡**：重建会把正在流的内容冲掉（文字块是纯文本节点，
 * delta 靠 `textContent +=` 追加）。
 */
function appendToolCall(
  turnId: string,
  callId: string,
  name: string,
  title: string,
  detail?: string,
  argsText?: string
): void {
  const node = bubbleOf(turnId);
  if (!node) {
    return;
  }
  // 一轮刚开始留的那块空正文（给「它在想」留的位）到这里就没意义了。
  dropEmptyText(node);
  if (name === 'generate') {
    // 卡片当场就建：正文马上要顺着 `toolDelta` 流进来，晚一步就没地方放。
    node.insertBefore(
      buildGenCard({ callId, name, title, ok: true, summary: '', elapsedMs: -1, argsText, output: '' }),
      segmentAnchor(node)
    );
    scrollToBottom();
    return;
  }
  const strip = toolStripOf(turnId);
  if (!strip) {
    return;
  }
  strip.appendChild(buildPendingToolRow(callId, title, detail, argsText));
  scrollToBottom();
}

/**
 * 一轮 agent 结束：在气泡末尾画上花销那一行。
 *
 * 就地插入而不是重建气泡——重建会把正在流的正文冲掉（`.msg-body` 是纯文本
 * 节点），与工具条那一串同一条理由。
 */
function settleAgentRun(
  turnId: string,
  run: { steps: number; calls: number; tokens: number; stopReason: string; message: string }
): void {
  const node = bubbleOf(turnId);
  if (!node) {
    return;
  }
  const row = buildAgentRunRow({ ...run, message: run.message || undefined });
  const existing = node.querySelector('.agent-run');
  if (existing) {
    existing.replaceWith(row);
  } else {
    node.insertBefore(row, node.querySelector('.ctx') ?? node.querySelector('.msg-actions'));
  }
  scrollToBottom();
}

/**
 * 工具跑完了：把那一行（或那张卡）换成带耗时与结果摘要的最终形态。
 *
 * **展开状态要跟过去**：作者点开这一条是想盯着它看，整条重建时把它合回去，
 * 等于每次有结果就把他刚翻开的东西合上。
 *
 * generate 那张卡还有一件事：**正文不能丢**。它是顺着 `toolDelta` 一段段攒在
 * 卡里的，而这条 `toolResult` 里根本没有它——重建时得把卡里当下那份带过去。
 * （落盘的结论随后还会重推一次同样的 `toolResult`，那时同样不能把正文抹掉。）
 */
function settleToolCall(
  turnId: string,
  result: {
    callId: string;
    name: string;
    ok: boolean;
    summary: string;
    elapsedMs: number;
    argsText?: string;
    resultText?: string;
  }
): void {
  const node = bubbleOf(turnId);
  const card = node?.querySelector<HTMLDetailsElement>(`.gen[data-call="${result.callId}"]`);
  if (card) {
    const title = card.querySelector('.gen-title')?.textContent ?? result.name;
    const output = card.querySelector('.gen-body')?.textContent ?? '';
    card.replaceWith(buildGenCard({ ...result, title, output, open: card.open }));
    scrollToBottom();
    return;
  }
  const row = node?.querySelector<HTMLElement>(`.tool-row[data-call="${result.callId}"]`);
  if (!row) {
    return;
  }
  const title = row.querySelector('.tool-title')?.textContent ?? result.name;
  const open = row instanceof HTMLDetailsElement && row.open;
  row.replaceWith(buildToolRow({ ...result, title, open }));
  scrollToBottom();
}

renderChips();
vscode.postMessage({ type: 'ready' });