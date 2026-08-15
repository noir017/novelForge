/** 设置页里那几种表单控件。弹窗与主表单共用。 */
import { el as mk } from '../../dom';

export function textField(
  label: string,
  value: string,
  placeholder: string,
  onInput: (value: string) => void
): HTMLLabelElement {
  const wrap = mk('label', 'field');
  wrap.appendChild(mk('span', undefined, label));

  const input = mk('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('input', () => onInput(input.value));
  wrap.appendChild(input);
  return wrap;
}

export function compactField(
  label: string,
  value: string,
  placeholder: string,
  onInput: (value: string) => void
): HTMLLabelElement {
  const wrap = textField(label, value, placeholder, onInput);
  wrap.classList.add('compact');
  return wrap;
}

/**
 * 勾选框。**不勾就是 undefined 而不是 false**：配置里只留作者真的勾过的项，
 * 与档位覆盖同一套做法（没动过的跟着日后的默认值走）。
 */
export function compactCheck(
  label: string,
  value: boolean | undefined,
  title: string,
  onChange: (value: boolean | undefined) => void
): HTMLLabelElement {
  const wrap = mk('label', 'field compact check');
  wrap.title = title;

  const input = mk('input');
  input.type = 'checkbox';
  input.checked = value === true;
  input.addEventListener('change', () => onChange(input.checked ? true : undefined));
  wrap.appendChild(input);
  wrap.appendChild(mk('span', undefined, label));
  return wrap;
}

/** 数字输入。留空 / 填了非正数都当「用默认值」，回调收到 undefined。 */
export function compactNumber(
  label: string,
  value: number | undefined,
  placeholder: string,
  onInput: (value: number | undefined) => void
): HTMLLabelElement {
  const wrap = mk('label', 'field compact');
  wrap.appendChild(mk('span', undefined, label));

  const input = mk('input');
  input.type = 'number';
  input.min = '0';
  input.step = '1000';
  input.value = value === undefined || value === null ? '' : String(value);
  input.placeholder = placeholder;
  input.addEventListener('input', () => {
    const n = Number(input.value);
    onInput(input.value.trim() && Number.isFinite(n) && n > 0 ? n : undefined);
  });
  wrap.appendChild(input);
  return wrap;
}
