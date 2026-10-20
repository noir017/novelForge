/**
 * 调模型之前那两个下拉框（模型、上下文详细度）的前端一半：工程页批量表单（forms.ts）与独立版确认框（prompt.ts）
 * 共用。作者在这里挑的只管这一次，不改设置；后端怎么用它见 core 的 `model/callChoice.ts`。
 */
import { CONTEXT_DETAILS, CONTEXT_DETAIL_HINT, CONTEXT_DETAIL_LABEL, TIERED_LABEL, isContextDetail } from '../protocol';
import type { CallChoice, CallPrompt, ContextDetail } from '../protocol';
import { el as mk, setHidden } from '../dom';
import { buildSelect } from './form';
import type { FormField, FormValues, SelectOption } from './form';

/** 模型下拉框：第一项「按分档」（值是空串），其余按服务商分组，同对话页。 */
function modelOptions(models: CallPrompt['models']): SelectOption[] {
  return [{ value: '', label: TIERED_LABEL }, ...models.map((m) => ({ value: m.ref, label: m.ref, group: m.group }))];
}

/** 详细度下拉框：「1 · 精简」……，与设置页同一套说法。 */
function detailOptions(): SelectOption[] {
  return CONTEXT_DETAILS.map((d) => ({ value: String(d), label: `${d} · ${CONTEXT_DETAIL_LABEL[d]}` }));
}

/** 工程页批量表单上的两个字段。缺省：按分档、设置页那一级。 */
export function callFields(models: CallPrompt['models'], contextDetail: ContextDetail): FormField[] {
  return [
    { kind: 'select', key: 'callModel', label: '模型', value: '', options: modelOptions(models) },
    { kind: 'select', key: 'callDetail', label: '上下文详细度', value: String(contextDetail), options: detailOptions() },
  ];
}

/** 两个字段的值 → 作者为这一次挑的（`projectAction.call`、`promptResult.choice`）。 */
export function callChoiceOf(v: FormValues): CallChoice {
  const model = String(v.callModel ?? '');
  const detail = Number(v.callDetail);
  return { ...(model ? { model } : {}), ...(isContextDetail(detail) ? { contextDetail: detail } : {}) };
}

/**
 * 独立版确认框里的那一块：两个下拉框（这一次的上下文不看详细度时只有模型那一个）。选着「按分档」时下面列出各项活交给谁，
 * 详细度下面一行说这一级带多少。
 */
export function buildCallPicker(call: CallPrompt): { element: HTMLElement; choice: () => CallChoice } {
  const box = mk('div', 'call-picker');
  const grid = mk('div', 'grid');
  const model = buildSelect(modelOptions(call.models), call.model);
  grid.appendChild(field('模型', model));
  const detail = call.contextDetail ? buildSelect(detailOptions(), String(call.contextDetail)) : undefined;
  if (detail) {
    grid.appendChild(field('上下文详细度', detail));
  }
  box.appendChild(grid);

  const tiers = mk('div', 'call-tiers');
  for (const line of call.tiers) {
    tiers.appendChild(mk('p', 'hint', line));
  }
  const hint = mk('p', 'hint call-detail-hint');
  box.append(tiers, ...(detail ? [hint] : []));

  const refresh = () => {
    setHidden(tiers, model.value !== '');
    if (detail) {
      hint.textContent = `上下文：${CONTEXT_DETAIL_HINT[Number(detail.value) as ContextDetail]}`;
    }
  };
  box.addEventListener('change', refresh);
  refresh();
  return { element: box, choice: () => callChoiceOf({ callModel: model.value, callDetail: detail?.value ?? '' }) };
}

/** 「标题在上、下拉框在下」的一格，与表单（form.ts）同一种样子。 */
function field(text: string, input: HTMLElement): HTMLElement {
  const label = mk('label', 'field');
  label.append(mk('span', undefined, text), input);
  return label;
}
