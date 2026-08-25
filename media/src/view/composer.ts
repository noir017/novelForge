/**
 * 输入区：技能标签、附件标签、发送，以及那几个下拉框的联动。
 *
 * **只有一条发送路径**：打字 → 发给 agent，它自己决定查什么、分几步做完。
 *
 * 从前这里有三条（状态机主按钮 / `/` 命令 / 直接发送），前两条都是确定性的
 * 单步生成——挑好层与能力，一次调用产出一份产物。删掉它们之后，「在哪一层、
 * 干什么」这个判断只剩一处（agent 每回合读到的状态注入，第 20 条），
 * 前端不再参与，也就不会与它分叉。
 *
 * `/` 这个键回来了，但**发送路径仍然只有一条**：它挑的是一份技能（「这类事该怎么
 * 做」），挑完只是在输入框上方挂一枚标签，发出去的仍是一条 `sendAgent`。面板本身
 * 在 [skillPalette.ts](skillPalette.ts)。
 */
import { el as mk } from '../dom';
import { DEFAULT_THINKING_DEPTH, isThinkingDepth } from '../protocol';
import type { ThinkingDepth } from '../protocol';
import { scrollToBottom } from './messages';
import { el } from './refs';
import {
  closeSkillPalette,
  handleSkillKey,
  syncSkillPalette,
  toggleSkillPalette,
} from './skillPalette';
import { persistDraft, store, vscode, hasWorkspace } from './store';
import { setBusy } from './state';
import { toast } from './toast';

export function renderChips(): void {
  el.chips.innerHTML = '';
  // 技能标签排在附件前面：它决定「怎么做」，附件只是「拿这些材料」。
  // 顺序与折进那句话时一致（方法在前，要求在后）。
  for (const skill of store.skills) {
    const chip = mk('span', 'chip skill-chip');

    const label = mk('span', 'chip-label', `⚡ ${skill.stem}`);
    // 给创作模型的那一类正文不在这一轮里（后端也没存），说「0 字」是句错话。
    label.title =
      skill.audience === 'generate'
        ? `${skill.name}（交给创作模型：这一轮每次生成都按它的写法写）`
        : `${skill.name}（${skill.chars} 字，随下一句话一起发出）`;
    chip.appendChild(label);

    const x = mk('button', 'chip-x', '×');
    x.title = '不用这份技能了';
    // **后端说了才算**：前端不先摘掉自己那一份（前端无状态那条基本盘），
    // 正文攒在后端，摘的必须是同一份。
    x.addEventListener('click', () => vscode.postMessage({ type: 'dropSkill', name: skill.name }));
    chip.appendChild(x);

    el.chips.appendChild(chip);
  }
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

// ---------------------------------------------------------------- 发送

/**
 * 发送。**只吃作者那一句话**——不带层、不带能力、不带目标。
 *
 * 那三样 agent 自己算（每回合注入的状态机结论）。前端捎一份过去等于让它也
 * 参与判断，两处迟早分叉；而作者选中的那一章后端本来就记在会话里。
 *
 * 呼出的技能也不在这里拼：**正文攒在后端**（`ChatController.pendingSkills`），
 * 前端手上只有名字与字数。把几千字放在前端等于让「刷新一次就丢」变成可能。
 */
function send(): void {
  if (store.busy || !hasWorkspace()) {
    return;
  }
  const text = el.input.value.trim();
  if (!text) {
    toast('先说说你要它做什么。', true);
    el.input.focus();
    return;
  }
  setBusy(true);
  vscode.postMessage({ type: 'sendAgent', text });
  el.input.value = '';
  // 输入框空了，面板的判据（「整个值只有一个 /词」）不再成立——它由 input 事件
  // 驱动，而这一下是代码改的值，不发那个事件。
  closeSkillPalette();
  // 引用是一次性的：发出去就清空（后端也清它那份 pending）。
  // 技能同理，但清的那一下由后端推 `pendingSkills` 回来（正文在它手上）。
  store.attachments = [];
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
  el.skillBtn.addEventListener('click', toggleSkillPalette);

  // 技能面板的开合是**输入框内容的函数**（见 skillPalette.ts）：打 `/` 就开、
  // 删掉就关、往后打字就过滤。挂在 input 而不是 keydown 上，输入法打的中文
  // （composition 结束才落值）才收得到。
  el.input.addEventListener('input', () => {
    persistDraft();
    syncSkillPalette();
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
  // 思考深度落在会话上（后端当场落盘），所以这里只发意图、不改本地状态——
  // 值由回来的那条 session 消息回填（前端无状态那条基本盘）。
  el.thinkSelect.addEventListener('change', () =>
    vscode.postMessage({ type: 'setThinking', depth: asDepth(el.thinkSelect.value) })
  );

  el.input.addEventListener('keydown', (e) => {
    // 面板开着时它先接管键盘：↑↓ 选、Enter/Tab 确认、Esc 关。**可打印字符一律
    // 放行**（过滤串由 syncSkillPalette 从输入框的值重算），所以这一下必须排在
    // Enter 发送之前——不然打了 `/` 之后按 Enter 会把 `/审章` 当成一句话发出去。
    if (handleSkillKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
      return;
    }
    // 输入 @ 直接打开引用选择器，跟 Cursor 一致。**那一条走宿主的选择器**：
    // 候选是整棵工程树（几百项，要搜要分组），那本来就是一次独立的检索。
    // `/` 不同——它挑的是这句话的一部分，所以是贴着输入框浮起来的面板，由
    // 上面那个 `input` 监听驱动，这里不拦（`/` 就是输入框里的一个普通字符）。
    if (e.key === '@') {
      e.preventDefault();
      vscode.postMessage({ type: 'pickAttachment' });
    }
  });
}
