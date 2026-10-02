/**
 * 空状态（W12）：空分组写出接下来做什么，按钮直接可点。
 *
 * 两条口径：
 *
 * 1. **「下一步：」只说全书的那一步**（第 20 条：只推一个下一步）。文字取后端给的
 *    `tree.next.label`——那是对话页主按钮在全书那一档会给的同一句话，前端不自己判断。
 *    别处的空状态（角色、设定）只说「这里该放什么、从哪来」，不另起一个「下一步」。
 * 2. **按钮不直接花钱**，与「去生成」「去写这一章」同一个道理：小说配置开一句话弹窗、
 *    拆细纲开拆细纲弹窗（弹窗上写着调用次数），其余进入那一层（对话页的主按钮就是它）；
 *    提取角色卡、从正文生成设定走的是自带确认框的工程动作。花钱的那一下总在作者看得见
 *    次数的地方。
 */
import { el as mk } from '../../dom';
import type { CreationTarget, NextStepView, ProjectTree } from '../../protocol';
import { openIdeaForm, openPlotBatchForm } from '../forms';
import { vscode } from '../store';
import { projectAction } from './actions';

interface HintButton {
  label: string;
  title: string;
  run(): void;
}

/** 一行说明 + 几颗小按钮。不是 `.row`：它不是树上的一项，没有右键菜单。 */
function hintRow(text: string, buttons: HintButton[]): HTMLElement {
  const row = mk('div', 'hint row-empty row-hint-action');
  row.appendChild(mk('span', 'row-hint-text', text));
  for (const b of buttons) {
    const btn = mk('button', 'chip-btn row-go', b.label);
    btn.title = b.title;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      b.run();
    });
    row.appendChild(btn);
  }
  return row;
}

function setTarget(target: CreationTarget): void {
  vscode.postMessage({ type: 'setTarget', target });
}

/** 全书的下一步那一颗按钮做什么。 */
function stepButton(step: NextStepView, tree: ProjectTree): HintButton {
  if (step.form === 'idea') {
    return { label: '去生成', title: '写一句话与规模，生成小说配置', run: () => openIdeaForm(step.formDefaults ?? tree.book) };
  }
  if (step.projectAction === 'deriveFromText') {
    // 已经有正文：照正文整理。后端先弹框报调用次数，点这一下不花钱。
    return { label: '补齐…', title: '照已写正文整理摘要、角色卡、架构、大纲与细纲；先报调用次数', run: () => projectAction('deriveFromText') };
  }
  if (step.stage === 'plot') {
    // 弹窗缺省就是「下一可写章起 5 章」，与这一步同一个区间；调用次数写在弹窗上。
    return { label: '拆细纲…', title: '选好区间，看清调用几次再拆', run: () => openPlotBatchForm(tree) };
  }
  return { label: '去生成', title: '进入这一层：对话页的主按钮就是这一步', run: () => setTarget(step.target) };
}

/** 「下一步：生成故事前提」+ 一颗按钮。 */
export function nextStepRow(step: NextStepView, tree: ProjectTree): HTMLElement {
  const row = hintRow(`下一步：${step.label}`, [stepButton(step, tree)]);
  row.classList.add('row-next-step');
  return row;
}

/** 已经写过正文没有（老工程直接把章放进来的也算）。 */
function hasText(tree: ProjectTree): boolean {
  return tree.totalWords > 0;
}

/**
 * 角色组为空。
 *
 * - 全书的下一步正是角色图谱：就说它，按钮进入那一层。
 * - 已经有正文（老工程）：角色卡可以从正文里提取（自带确认框，写着调用次数）。
 * - 否则：说清角色卡从哪来——轮到角色图谱时「故事架构」那一组会给「去生成」。
 */
export function charactersEmptyRow(tree: ProjectTree): HTMLElement {
  const next = tree.next;
  if (next && next.target.kind === 'setting' && next.target.doc === 'characters') {
    return nextStepRow(next, tree);
  }
  if (hasText(tree)) {
    return hintRow('还没有角色卡。已经写过正文，可以从正文里把出场的人提取成角色卡。', [
      { label: '提取角色卡…', title: '通读选定的几章，一次建一批角色卡；动手前会告诉你调用几次', run: () => projectAction('extractCharacters') },
    ]);
  }
  return hintRow('还没有角色卡。故事架构里的「角色图谱」会一次建好主角、盟友与对手；轮到它时，上面那一组会给「去生成」。', []);
}

/**
 * 设定组为空。设定条目是可选的，所以不说「下一步」：说清它是什么、什么时候用得上。
 * 手建一条不调模型；已经有正文时可以从正文里生成（自带确认框）。
 */
export function loreEmptyRow(tree: ProjectTree): HTMLElement {
  const buttons: HintButton[] = [
    { label: '＋ 设定', title: '新建一条设定（不调模型）', run: () => projectAction('newLore') },
  ];
  if (hasText(tree)) {
    buttons.push({
      label: '从正文生成…',
      title: '逐章通读正文，整理出地点、势力、物件这类设定；动手前会告诉你调用几次',
      run: () => projectAction('generateLore'),
    });
  }
  return hintRow('还没有设定条目。地点、势力、物件这类要前后一致的东西写成一条，keywords 命中时自动带进上下文。', buttons);
}
