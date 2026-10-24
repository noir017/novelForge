/**
 * 通用表单弹窗（W3）。一句话、拆细纲两个弹窗都是它。
 *
 * 复用 `providerModal` 那一层遮罩：两种形态（插件 webview 与独立版）都装配了它
 * （`shells/shared/panes.ts`），于是这里一份代码两边都能用——不必像独立版的
 * `prompt.ts` 那样只在浏览器里出现。几个弹窗不会同时出现：它们都只在作者点了
 * 某个按钮之后才打开。
 *
 * 表单只收值、算说明、交出去；**发什么消息由调用方决定**（forms.ts）。前端无状态那条
 * 基本盘不变：提交之后弹窗就关，结果随后端下一次推送回来。
 */
import { el as mk, setHidden } from '../dom';
import { primaryBtn, secondaryBtn } from './buttons';
import { el } from './refs';

export type FormField =
  | {
      kind: 'textarea';
      key: string;
      label: string;
      value?: string;
      placeholder?: string;
      rows?: number;
      /** 空着不许提交。 */
      required?: boolean;
    }
  /**
   * 一行字（新建一本书的书名、作者、放在哪）。单按 Enter 就提交。`browse` 在框右边多一颗按钮（「选…」开目录选择器），
   * 选好了用 `set` 填回框里。
   */
  | {
      kind: 'text';
      key: string;
      label: string;
      value?: string;
      placeholder?: string;
      required?: boolean;
      browse?: { label: string; run(current: string, set: (value: string) => void): void };
    }
  | { kind: 'number'; key: string; label: string; value?: number; min?: number; max?: number; step?: number }
  /** 几选一（批量写章的模式、这一次用哪个模型）。值是字符串。 */
  | { kind: 'select'; key: string; label: string; value?: string; options: SelectOption[] };

/** 下拉框的一项。`group` 相同的相邻几项收进一个 `optgroup`（模型按服务商分组，同对话页）。 */
export interface SelectOption {
  value: string;
  label: string;
  group?: string;
}

/** 一个下拉框。表单与独立版确认框（prompt.ts）共用：同一种下拉框只有一种画法。 */
export function buildSelect(options: SelectOption[], value?: string): HTMLSelectElement {
  const sel = mk('select');
  let group: HTMLOptGroupElement | undefined;
  for (const o of options) {
    if (o.group && o.group !== group?.label) {
      group = mk('optgroup');
      group.label = o.group;
      sel.appendChild(group);
    } else if (!o.group) {
      group = undefined;
    }
    const opt = mk('option', undefined, o.label);
    opt.value = o.value;
    (group ?? sel).appendChild(opt);
  }
  sel.value = value ?? options[0]?.value ?? '';
  return sel;
}

export type FormValues = Record<string, string | number>;

export interface FormSpec {
  title: string;
  /** 字段上方的一句说明。 */
  lead?: string;
  /** 说明下面再列几行小字（导入写好的书：开头几章、丢掉了什么）。 */
  details?: string[];
  fields: FormField[];
  /**
   * 实时说明：任何一个值变了就重算（全书字数、跳过几章、调用几次）。
   * `ok: false` 时提交键禁用——说明里写着为什么。
   */
  note?: (values: FormValues) => { text: string; ok?: boolean };
  submitLabel: string;
  /**
   * 提交要点两下（按钮文案两段式，不叠弹窗）：返回第二下的字，第一下只把提交键换成它；
   * 返回 undefined 就一下提交。任何一个值改了都退回第一段。批量写章「写完即定稿」用它（W9）。
   */
  confirm?: (values: FormValues) => string | undefined;
  onSubmit: (values: FormValues) => void;
}

/** 当前开着的那一个。关掉时置空，遮罩上的 × / Esc 都据此判断该不该由这里管。 */
let active: { close: () => void } | null = null;

export function isFormOpen(): boolean {
  return active !== null;
}

export function closeForm(): void {
  active?.close();
}

export function openForm(spec: FormSpec): void {
  closeForm();
  const body = el.providerModalBody;
  el.providerModalTitle.textContent = spec.title;
  body.innerHTML = '';

  const form = mk('div', 'nf-form');
  if (spec.lead) {
    form.appendChild(mk('p', 'hint form-lead', spec.lead));
  }
  if (spec.details?.length) {
    const list = mk('ul', 'hint form-details');
    for (const line of spec.details) {
      list.appendChild(mk('li', undefined, line));
    }
    form.appendChild(list);
  }

  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
  const grid = mk('div', 'grid');
  for (const f of spec.fields) {
    const label = mk('label', 'field');
    label.appendChild(mk('span', undefined, f.label));
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (f.kind === 'select') {
      input = buildSelect(f.options, f.value);
      grid.appendChild(label);
    } else if (f.kind === 'text') {
      const line = mk('input');
      line.type = 'text';
      line.placeholder = f.placeholder ?? '';
      line.value = f.value ?? '';
      line.spellcheck = false;
      input = line;
      // 一行字也占满一整行（路径常常很长）；带「选…」时框与按钮并排。
      if (f.browse) {
        const row = mk('div', 'field-row');
        row.appendChild(line);
        const browse = f.browse;
        const btn = mk('button', 'chip-btn', browse.label);
        btn.type = 'button';
        btn.addEventListener('click', () =>
          browse.run(line.value, (v) => {
            line.value = v;
            line.dispatchEvent(new Event('input', { bubbles: true }));
          })
        );
        row.appendChild(btn);
        label.appendChild(row);
      }
      form.appendChild(label);
    } else if (f.kind === 'textarea') {
      const ta = mk('textarea');
      ta.rows = f.rows ?? 4;
      ta.placeholder = f.placeholder ?? '';
      ta.value = f.value ?? '';
      input = ta;
      // 多行文本占满一整行，数字框并排放在下面。
      form.appendChild(label);
    } else {
      const num = mk('input');
      num.type = 'number';
      if (f.min !== undefined) num.min = String(f.min);
      if (f.max !== undefined) num.max = String(f.max);
      if (f.step !== undefined) num.step = String(f.step);
      num.value = f.value !== undefined ? String(f.value) : '';
      input = num;
      grid.appendChild(label);
    }
    input.dataset.key = f.key;
    if (!input.parentElement) {
      label.appendChild(input);
    }
    inputs.set(f.key, input);
  }
  if (grid.childElementCount > 0) {
    form.appendChild(grid);
  }

  const note = mk('p', 'hint form-note');
  form.appendChild(note);

  const values = (): FormValues => {
    const out: FormValues = {};
    for (const f of spec.fields) {
      const raw = inputs.get(f.key)!.value;
      out[f.key] = f.kind === 'number' ? Math.floor(Number(raw)) : raw.trim();
    }
    return out;
  };
  const missing = (v: FormValues): string | undefined => {
    for (const f of spec.fields) {
      if ((f.kind === 'textarea' || f.kind === 'text') && f.required && !String(v[f.key]).trim()) {
        return `「${f.label}」还空着。`;
      }
      if (f.kind === 'number') {
        const n = Number(v[f.key]);
        if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          return `「${f.label}」要在 ${f.min ?? '—'}–${f.max ?? '—'} 之间。`;
        }
      }
    }
    return undefined;
  };

  /** 两段式提交：第一下之后记着第二下的字（{@link FormSpec.confirm}）。 */
  let armed = false;
  const submit = primaryBtn(spec.submitLabel, () => trySubmit());
  const cancel = secondaryBtn('取消', () => close());
  const foot = mk('div', 'modal-foot');
  foot.append(cancel, submit);
  form.appendChild(foot);

  const refresh = (): boolean => {
    const v = values();
    const bad = missing(v);
    const computed = bad ? { text: bad, ok: false } : (spec.note?.(v) ?? { text: '', ok: true });
    note.textContent = computed.text;
    note.classList.toggle('is-error', computed.ok === false);
    submit.disabled = computed.ok === false;
    return computed.ok !== false;
  };
  const trySubmit = () => {
    if (!refresh()) {
      return;
    }
    const v = values();
    const second = spec.confirm?.(v);
    if (second && !armed) {
      armed = true;
      submit.textContent = second;
      submit.classList.add('is-armed');
      return;
    }
    close();
    spec.onSubmit(v);
  };
  const disarm = () => {
    if (armed) {
      armed = false;
      submit.textContent = spec.submitLabel;
      submit.classList.remove('is-armed');
    }
  };
  const close = () => {
    if (active !== handle) {
      return;
    }
    active = null;
    setHidden(el.providerModal, true);
    body.innerHTML = '';
  };
  const handle = { close };

  form.addEventListener('input', () => {
    disarm();
    refresh();
  });
  form.addEventListener('change', () => {
    disarm();
    refresh();
  });
  form.addEventListener('keydown', (e) => {
    // Ctrl/⌘+Enter 提交：多行文本里单按 Enter 是换行。一行字的框里单按 Enter 就提交（输入法还在组字时那一下是选字）。
    const inLine = (e.target as HTMLElement | null)?.matches?.('input[type="text"]') === true;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (inLine && !e.isComposing))) {
      e.preventDefault();
      trySubmit();
    }
  });

  body.appendChild(form);
  active = handle;
  refresh();
  setHidden(el.providerModal, false);
  (inputs.values().next().value as HTMLElement | undefined)?.focus();
}

/**
 * 遮罩上的 × 与 Esc：只在表单开着时由这里关（点空白不关，免得误触丢了填到一半的内容）。服务商弹窗有它自己的一套
 * （settings/providerModal.ts），两边各自判断「是不是我开的」，互不干扰。
 */
export function installForm(): void {
  el.providerModalClose.addEventListener('click', () => closeForm());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFormOpen()) {
      closeForm();
    }
  });
}
