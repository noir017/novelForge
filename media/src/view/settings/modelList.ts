/**
 * 「默认模型」的有序列表编辑器。
 *
 * 从一个单选下拉框改过来的：默认模型现在是一份**排好序的清单**——
 * 第一个是首选，工程页任务串行时用它、失败随机换后面的重试，并发时在
 * 整份清单里轮转。所以顺序本身是配置的一部分，必须能调。
 */
import { el as mk, maybeById } from '../../dom';
import { smallBtn } from '../buttons';
import { toast } from '../toast';
import { allRefs, draft, touch } from './draft';

/** 服务商列表变了要跟着刷新（模型可能被删掉），由 renderProviders 统一调用。 */
export function renderModelList(): void {
  const box = maybeById<HTMLElement>('defaultModelList');
  if (!box) {
    return;
  }
  box.innerHTML = '';
  const available = allRefs();

  if (draft.models.length === 0) {
    box.appendChild(
      mk('div', 'hint', available.length === 0 ? '还没有可选的模型，先在上面添加服务商。' : '还没有选默认模型。')
    );
  }

  for (const [i, ref] of draft.models.entries()) {
    box.appendChild(buildRow(ref, i, available));
  }

  box.appendChild(buildAdder(available));
}

function buildRow(ref: string, index: number, available: string[]): HTMLElement {
  const row = mk('div', 'model-entry');
  row.appendChild(mk('span', 'model-order', `${index + 1}`));

  const name = mk('span', 'model-entry-ref', ref);
  name.title = ref;
  row.appendChild(name);

  if (index === 0) {
    row.appendChild(mk('span', 'model-tag', '首选'));
  }
  // 引用指向已删掉的模型时留着并标出来，不静默丢弃——
  // 用户得知道自己配的那个模型没了，而不是发现列表莫名其妙短了一截。
  if (!available.includes(ref)) {
    const bad = mk('span', 'model-tag danger', '未配置');
    bad.title = '这个引用在上面的服务商列表里找不到，保存时会被移除。';
    row.appendChild(bad);
  }

  const ops = mk('div', 'model-ops');
  ops.appendChild(moveBtn('↑', index, -1));
  ops.appendChild(moveBtn('↓', index, 1));
  ops.appendChild(
    smallBtn('移除', () => {
      draft.models = draft.models.filter((_, i) => i !== index);
      touch();
      renderModelList();
    })
  );
  row.appendChild(ops);
  return row;
}

function moveBtn(text: string, index: number, delta: number): HTMLButtonElement {
  const b = smallBtn(text, () => {
    const to = index + delta;
    if (to < 0 || to >= draft.models.length) {
      return;
    }
    const next = [...draft.models];
    [next[index], next[to]] = [next[to], next[index]];
    draft.models = next;
    touch();
    renderModelList();
  });
  b.disabled = delta < 0 ? index === 0 : index === draft.models.length - 1;
  b.title = delta < 0 ? '上移' : '下移';
  return b;
}

/** 「添加模型」下拉：只列尚未入列的引用。 */
function buildAdder(available: string[]): HTMLElement {
  const wrap = mk('div', 'model-add');
  const rest = available.filter((r) => !draft.models.includes(r));

  const sel = document.createElement('select');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = rest.length === 0 ? '（没有可添加的模型）' : '＋ 添加模型…';
  sel.appendChild(placeholder);

  for (const ref of rest) {
    const opt = document.createElement('option');
    // 显示完整引用——与对话页下拉框口径一致，它才是配置里存的东西。
    opt.value = opt.textContent = ref;
    sel.appendChild(opt);
  }
  sel.disabled = rest.length === 0;
  sel.addEventListener('change', () => {
    const ref = sel.value;
    sel.value = '';
    if (!ref) {
      return;
    }
    draft.models = [...draft.models, ref];
    touch();
    renderModelList();
    toast(draft.models.length === 1 ? `已设为首选模型：${ref}` : `已添加 ${ref}，记得保存。`);
  });

  wrap.appendChild(sel);
  return wrap;
}
