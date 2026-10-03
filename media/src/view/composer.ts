/**
 * 输入区：附件标签、待执行命令、发送，以及那几个下拉框的联动。
 *
 * ## 三条发送路径，一个出口
 *
 * - **主按钮**（状态机算出的下一步）：点了就跑，输入框可空
 * - **`/` 命令**：挑一个 → 变成一枚 chip → Enter/发送时用它，确定性的单步
 * - **直接发送**：不挑命令就是在当前阶段讨论（`discuss`）。多步的活交给外部 agent 经 MCP 来做
 *
 * 三条都走同一个 `send()`：附件、草稿、busy 只在一处管。
 */
import { el as mk, setHidden } from '../dom';
import {
  CAPABILITY_LABEL,
  DEFAULT_THINKING_DEPTH,
  commandOf,
  isThinkingDepth,
  plotOfTarget,
} from '../protocol';
import type {
  Capability,
  CreationStage,
  NextStepView,
  SendPayload,
  StageCommand,
  ThinkingDepth,
} from '../protocol';
import {
  handleCommandKey,
  isCommandPaletteOpen,
  syncCommandPalette,
  toggleCommands,
} from './commands';
import { openIdeaForm } from './forms';
import { scrollToBottom } from './messages';
import { el } from './refs';
import { persistDraft, store, vscode, hasWorkspace } from './store';
import { setBusy } from './state';
import { toast } from './toast';

/**
 * 已挑好、尚未执行的命令。
 *
 * 只活到下一次发送为止：命令是**一次性的选择**，不是模式。挑了「挑刺」
 * 发出去之后，下一句话多半又是普通的讨论——让它粘住只会让人误发。
 */
let pending: { stage: CreationStage; capability: Capability; label: string } | null = null;

/** 当前输入框里的那一套参数。发送与「重新生成」共用。 */
export function payload(): SendPayload {
  return {
    text: el.input.value,
    // 阶段/目标记在会话里（后端是唯一真相，前端只是回显它）。挑了命令就用命令的，
    // 否则就是在当前阶段讨论——每一层都有讨论。后端还会再校验一遍。
    stage: pending?.stage ?? store.session.stage,
    capability: pending?.capability ?? 'discuss',
    target: store.session.target,
    targetNo: Number(el.targetSelect.value) || 1,
    attachments: store.attachments,
    excludedIds: [...store.excluded],
  };
}

export function renderChips(): void {
  el.chips.innerHTML = '';
  for (const att of store.attachments) {
    const chip = mk('span', 'chip');

    const label = mk('span', 'chip-label', att.label);
    label.title = att.relPath || att.label;
    chip.appendChild(label);

    const x = mk('button', 'chip-x', '×');
    x.title = '移除';
    x.addEventListener('click', () => {
      store.attachments = store.attachments.filter((a) => a.id !== att.id);
      renderChips();
    });
    chip.appendChild(x);

    el.chips.appendChild(chip);
  }
}

// ---------------------------------------------------------------- 待执行命令

/** 挑中一个命令：变成输入框上方的一枚 chip，等一次发送。 */
export function setPendingCommand(cmd: StageCommand): void {
  pending = { stage: store.session.stage, capability: cmd.capability, label: cmd.label };
  renderPending();
  el.input.focus();
}

export function clearPendingCommand(): void {
  pending = null;
  renderPending();
}

function renderPending(): void {
  el.pendingCmd.innerHTML = '';
  setHidden(el.pendingCmd, !pending);
  if (!pending) {
    return;
  }
  const chip = mk('span', 'chip cmd-chip');
  chip.appendChild(mk('span', 'chip-label', `/${pending.label}`));
  const x = mk('button', 'chip-x', '×');
  x.title = '取消这个命令';
  x.setAttribute('aria-label', '取消这个命令');
  x.addEventListener('click', () => {
    clearPendingCommand();
    el.input.focus();
  });
  chip.appendChild(x);
  el.pendingCmd.appendChild(chip);
}

// ---------------------------------------------------------------- 发送

function send(): void {
  if (store.busy || !hasWorkspace()) {
    return;
  }
  const p = payload();
  // 空输入只挡「讨论」——讨论的全部内容就是你那句话，而它不是命令，
  // `commandOf` 查不到它。命令（写细纲、写正文）本来就不需要
  // 作者再说什么。后端也有同一道判断。
  if (!p.text.trim() && !commandOf(p.stage, p.capability)) {
    toast(`「${CAPABILITY_LABEL[p.capability]}」需要先说点什么。`, true);
    el.input.focus();
    return;
  }
  setBusy(true);
  vscode.postMessage({ type: 'send', payload: p });
  el.input.value = '';
  store.attachments = [];
  clearPendingCommand();
  renderChips();
  persistDraft();
  scrollToBottom(true);
}

/**
 * 执行状态机算出的下一步。
 *
 * 工程动作（「定稿」）不是一轮对话，走 projectAction；其余都当成一次带
 * stage/capability/target 的普通发送。
 *
 * **target 用状态机给的那个**（`step.target`），不用会话当下的：全书层的下一步
 * 常常落在另一份产物上（会话停在大纲，下一步是「拆细纲（第 1–5 章）」、落点是
 * 第 1 章的细纲）。从前这里只覆盖了 stage 与 capability，target 仍是会话那份，
 * 于是按钮上写着一件事、落盘时写到了另一处（§3.1-1）。
 */
export function runNextStep(step: NextStepView): void {
  if (store.busy || !hasWorkspace()) {
    return;
  }
  // 「生成小说配置」要作者先给一句话与规模：打开表单，提交时才发送（W4）。
  if (step.form === 'idea') {
    openIdeaForm(step.formDefaults);
    return;
  }
  if (step.projectAction) {
    // 落点由后端随 next 一起给（target 里就是那一章的路径）。会话里的
    // targetNo 可能还没同步（旧会话、刚改过名），而工程动作拿不到对象
    // 会静默什么都不做。
    const relPath = plotOfTarget(step.target);
    vscode.postMessage({ type: 'projectAction', action: step.projectAction, relPath });
    return;
  }
  setBusy(true);
  vscode.postMessage({
    type: 'send',
    payload: {
      ...payload(),
      stage: step.stage,
      capability: step.capability,
      target: step.target,
      targetNo: step.no ?? step.range?.from ?? (Number(el.targetSelect.value) || 1),
      range: step.range,
      // 「接着写」追加、「重写第 N 章」覆盖审阅：写法随这一步走（后端按它落盘）。
      writeMode: step.writeMode,
    },
  });
  el.input.value = '';
  store.attachments = [];
  clearPendingCommand();
  renderChips();
  persistDraft();
  scrollToBottom(true);
}

/** 下拉框的值是字符串；认不出一律当「不思考」，与后端的容错读取同规矩。 */
function asDepth(value: string): ThinkingDepth {
  return isThinkingDepth(value) ? value : DEFAULT_THINKING_DEPTH;
}

export function installComposer(): void {
  el.sendBtn.addEventListener('click', send);
  el.stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  el.atBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickAttachment' }));
  el.selBtn.addEventListener('click', () => vscode.postMessage({ type: 'addSelection' }));
  el.cmdBtn.addEventListener('click', toggleCommands);

  // 面板的开合是**输入框内容的函数**（见 commands.ts）：打 `/` 就开、删掉
  // 就关、往后打字就过滤。挂在 input 而不是 keydown 上，输入法打的中文
  // （composition 结束才落值）才收得到。
  el.input.addEventListener('input', () => {
    persistDraft();
    syncCommandPalette();
  });
  // 目标下拉框换了一章 → **进入那一章当前该做的那一步**（由后端的状态机判定）。
  el.targetSelect.addEventListener('change', () => {
    const relPath = el.targetSelect.selectedOptions[0]?.dataset.rel;
    if (relPath) {
      vscode.postMessage({ type: 'selectPlot', plotRelPath: relPath });
      return;
    }
    // 没有 relPath 说明选的是「情节大纲」那一项：回到全书那一层，
    // 主按钮会是全书的下一步（生成架构 / 大纲 / 拆细纲 / 写下一章）。
    vscode.postMessage({ type: 'setTarget', target: { kind: 'outline' } });
  });
  el.modelSelect.addEventListener('change', () =>
    vscode.postMessage({ type: 'selectModel', ref: el.modelSelect.value })
  );
  // 思考深度落在会话上（后端当场落盘），所以这里只发意图、不改本地状态——
  // 值由回来的那条 session 消息回填（前端无状态那条基本盘）。
  el.thinkSelect.addEventListener('change', () =>
    vscode.postMessage({ type: 'setThinking', depth: asDepth(el.thinkSelect.value) })
  );

  el.input.addEventListener('keydown', (e) => {
    // 面板开着时导航键归它（↑↓ 选、Enter/Tab 确认、Esc 收起）。
    // 可打印字符一律放行——过滤串由上面那个 input 监听从输入框的值重算。
    if (isCommandPaletteOpen() && handleCommandKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
      return;
    }
    // 输入 @ 直接打开引用选择器，跟 Cursor 一致。
    if (e.key === '@') {
      e.preventDefault();
      vscode.postMessage({ type: 'pickAttachment' });
    }
    // `/` 不再在这里拦：它就打进输入框，面板由 input 监听按值唤出。
    // 从前拦下来自己攒过滤串，等于在输入框旁边又造了一个隐形输入框。
  });
}
