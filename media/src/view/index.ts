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
import { installComposer, payload, renderChips, runNextStep, setPendingCommand } from './composer';
import { bindCommandPick } from './commands';
import { renderSessions } from './history';
import { appendLog, installLogs, prependLogHistory, renderLogs } from './logs';
import { installMenubar } from './menubar';
import { installMenus } from './menu';
import {
  bindPayload,
  buildAgentRunRow,
  buildContextDetails,
  buildPendingToolRow,
  buildReasoningDetails,
  buildToolRow,
  buildToolStrip,
  bubbleOf,
  renderSession,
  scrollToBottom,
  upsertTurn,
} from './messages';
import { applySummary, installProject, invalidateSummaries, renderProject } from './project';
import { baseMenuItems } from './project/actions';
import { bindNextStepRunner, installNewSession, installRenamePlot, renderPipeline } from './pipeline';
import { renderWorkbench, installWorkbench } from './workbench';
import { renderPrompt } from './prompt';
import { installSettings, renderSettings } from './settings';
import { renderState, setBusy } from './state';
import { restoreDraft, store, vscode } from './store';
import { installTabs, showTab } from './tabs';
import { renderTasks } from './tasks';
import { countWords } from './format';
import { exposeToast, toast } from './toast';
import { installFolderPicker } from './folderPicker';
import { applyWorkspaces, installWelcome } from './welcome';
import { onMessage } from '../vscodeApi';

restoreDraft();
exposeToast();
installMenus(baseMenuItems);
installTabs();
installComposer();
bindPayload(payload);
// 主按钮走 composer 的发送路径（它管附件、草稿、busy）；`/` 面板挑中的命令
// 变成待执行 chip。两条线都不在各自模块里另起一套发送逻辑。
bindNextStepRunner(runNextStep);
installNewSession();
installRenamePlot();
bindCommandPick(setPendingCommand);
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
      renderPipeline(msg.pipeline, msg.next);
      renderWorkbench(msg.workbench);
      break;

    case 'attachments':
      store.attachments = msg.items;
      renderChips();
      break;

    case 'delta': {
      store.streamingId = msg.turnId;
      const node = bubbleOf(msg.turnId);
      if (node) {
        node.classList.add('streaming');
        const body = node.querySelector('.msg-body');
        if (body) {
          body.textContent += msg.text;
        }
        scrollToBottom();
      }
      break;
    }

    case 'reasoning':
      appendReasoning(msg.turnId, msg.text);
      break;

    // ---- agent 的三条：步数、工具调用、工具结果
    case 'agentStep':
      // 步数只进进度条（工程页顶部那条）与日志，气泡里不画——每一步一行
      // 「第 3 步」会把真正有信息量的工具调用挤散。
      break;

    case 'toolCall':
      appendToolRow(msg.turnId, msg.callId, msg.title ?? msg.name, msg.detail);
      break;

    case 'toolResult':
      settleToolRow(msg.turnId, msg);
      break;

    case 'agentDone':
      // 花销那一行立刻画出来（随后的 turnDone 会用会话里存的那份重建同一行）。
      settleAgentRun(msg.turnId, msg);
      // 非正常结束再补一句 toast——那一行上也写着，两处都有是有意的：
      // 正在看的人立刻知道，第二天回来翻的人也查得到。
      if (msg.stopReason !== 'done' && msg.message) {
        toast(msg.message, msg.stopReason === 'error');
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

    case 'context': {
      const node = bubbleOf(msg.turnId);
      if (node && !node.querySelector('details.ctx')) {
        node.insertBefore(buildContextDetails(msg.digest), node.querySelector('.msg-actions'));
      }
      break;
    }

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
 * 思考增量：气泡里没有折叠块就建一个（默认收起），有就往里追加。
 * **就地追加而不是重建节点**——重建会把用户展开的状态和滚动位置弄丢。
 */
function appendReasoning(turnId: string, text: string): void {
  const node = bubbleOf(turnId);
  if (!node) {
    return;
  }
  node.classList.add('streaming');

  let det = node.querySelector<HTMLDetailsElement>('details.reasoning');
  if (!det) {
    det = buildReasoningDetails('');
    node.insertBefore(det, node.querySelector('.msg-body'));
  }
  const box = det.querySelector<HTMLElement>('.reasoning-body');
  if (box) {
    box.textContent += text;
    const summary = det.querySelector('summary');
    if (summary) {
      summary.textContent = `思考过程 · ${countWords(box.textContent ?? '')} 字`;
    }
    // 展开着看的时候，让它跟着滚到最新。
    if (det.open) {
      box.scrollTop = box.scrollHeight;
    }
  }
  scrollToBottom();
}

/**
 * 工具调用开始：在气泡里挂一条「进行中…」的行。
 *
 * **就地追加而不是重建气泡**：重建会把正在流的正文冲掉（`.msg-body` 是
 * 纯文本节点，delta 靠 `textContent +=` 追加）。
 */
function appendToolRow(turnId: string, callId: string, title: string, detail?: string): void {
  const node = bubbleOf(turnId);
  if (!node) {
    return;
  }
  let strip = node.querySelector<HTMLElement>('.tools');
  if (!strip) {
    strip = buildToolStrip();
    node.insertBefore(strip, node.querySelector('.msg-body'));
  }
  strip.appendChild(buildPendingToolRow(callId, title, detail));
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

/** 工具跑完了：把那一行换成带耗时与结果摘要的最终形态。 */
function settleToolRow(
  turnId: string,
  result: { callId: string; name: string; ok: boolean; summary: string; elapsedMs: number }
): void {
  const row = bubbleOf(turnId)?.querySelector<HTMLElement>(`.tool-row[data-call="${result.callId}"]`);
  if (!row) {
    return;
  }
  const title = row.querySelector('.tool-title')?.textContent ?? result.name;
  row.replaceWith(buildToolRow({ ...result, title }));
  scrollToBottom();
}

renderChips();
vscode.postMessage({ type: 'ready' });