/**
 * 输入区：附件标签、待执行命令、发送，以及那几个下拉框的联动。
 *
 * ## 三条发送路径，一个出口
 *
 * - **主按钮**（状态机算出的下一步）：点了就跑，输入框可空
 * - **`/` 命令**：挑一个 → 变成一枚 chip → Enter/发送时用它
 * - **直接发送**：不挑就用会话当前的 stage/capability（多半是讨论）
 *
 * 三条都走同一个 `send()`：附件、草稿、busy 只在一处管。
 */
import { el as mk, setHidden } from '../dom';
import { CAPABILITY_LABEL, commandOf } from '../protocol';
import type { Capability, CreationStage, NextStepView, SendPayload, StageCommand } from '../protocol';
import {
  handleCommandKey,
  isCommandPaletteOpen,
  syncCommandPalette,
  toggleCommands,
} from './commands';
import { el } from './refs';
import { persistDraft, store, vscode } from './store';
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
    // 阶段/能力/目标全都记在会话里（后端是唯一真相，前端只是回显它）。
    // 挑了命令就用命令的，否则沿用会话当前的那一对。后端还会再校验一遍。
    stage: pending?.stage ?? store.session.stage,
    capability: pending?.capability ?? store.session.capability,
    target: store.session.target,
    targetNo: Number(el.targetSelect.value) || 1,
    targetWords: Number(el.targetWords.value) || 0,
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
  if (store.busy) {
    return;
  }
  // Agent 那条路只吃一句话：它没有 stage/capability 的概念，「下一步该做什么」
  // 由后端每回合注入的状态机结论说了算（第 20 条）。所以这里**不带 payload**——
  // 把当前选的能力捎过去，等于让前端也参与判断，两处迟早分叉。
  if (el.agentToggle.checked) {
    const text = el.input.value.trim();
    if (!text) {
      toast('先说说你要它做什么。', true);
      el.input.focus();
      return;
    }
    setBusy(true);
    vscode.postMessage({ type: 'sendAgent', text });
    el.input.value = '';
    clearPendingCommand();
    persistDraft();
    return;
  }

  const p = payload();
  // 空输入只挡「讨论」——讨论的全部内容就是你那句话。其余命令（写剧情、
  // 拆场景、写这一场）本来就不需要作者再说什么。后端也有同一道判断。
  if (!p.text.trim() && (commandOf(p.stage, p.capability)?.needsText ?? true)) {
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
}

/**
 * 执行状态机算出的下一步。
 *
 * 工程动作（审阅阶段的「总结这一章」）不是一轮对话，走 projectAction；
 * 其余都当成一次带 stage/capability 的普通发送。
 */
export function runNextStep(step: NextStepView): void {
  if (store.busy) {
    return;
  }
  if (step.projectAction) {
    // 落点由后端随 next 一起给（target 里就是那一章的路径）。会话里的
    // targetNo 可能还没同步（旧会话、刚改过名），而工程动作拿不到对象
    // 会静默什么都不做。
    const relPath = step.target.kind === 'outline' ? undefined : step.target.plotRelPath;
    vscode.postMessage({ type: 'projectAction', action: step.projectAction, relPath });
    return;
  }
  setBusy(true);
  vscode.postMessage({
    type: 'send',
    payload: { ...payload(), stage: step.stage, capability: step.capability },
  });
  el.input.value = '';
  store.attachments = [];
  clearPendingCommand();
  renderChips();
  persistDraft();
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
  el.targetWords.addEventListener('input', persistDraft);
  // 目标下拉框换了一章 → **进入那一章当前该做的那一步**（由后端的状态机判定）。
  // 旧版一律落到正文层，于是选中一个连剧情都没排的章，界面直接把作者
  // 丢进正文——四层流水线在创作页上等于不存在。
  el.targetSelect.addEventListener('change', () => {
    const relPath = el.targetSelect.selectedOptions[0]?.dataset.rel;
    if (relPath) {
      vscode.postMessage({ type: 'selectPlot', plotRelPath: relPath });
      return;
    }
    // 没有 relPath 说明选的是「新建第 N 章」——那一章还不存在，
    // 只能落到大纲；真正新建走工程页的「新建章节」。
    vscode.postMessage({ type: 'setTarget', target: { kind: 'outline' } });
  });
  el.modelSelect.addEventListener('change', () =>
    vscode.postMessage({ type: 'selectModel', ref: el.modelSelect.value })
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
