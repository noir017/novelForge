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

/** 下拉选择。选项是 [值, 说法] 对，选中项按 value 匹配。 */
export function selectField(
  label: string,
  value: string,
  options: [string, string][],
  onChange: (value: string) => void
): HTMLLabelElement {
  const wrap = mk('label', 'field');
  wrap.appendChild(mk('span', undefined, label));

  const select = mk('select') as HTMLSelectElement;
  for (const [v, text] of options) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = text;
    select.appendChild(opt);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  wrap.appendChild(select);
  return wrap;
}
