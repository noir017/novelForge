/**
 * 有序模型清单的编辑器。四处复用同一份渲染：
 * 「默认模型」一份，加上快速 / 均衡 / 精标三档各一份。
 *
 * 清单是**排好序**的——第一个是首选，工程页任务串行时用它、失败随机换后面的
 * 重试，并发时在清单里轮转。所以顺序本身是配置的一部分，必须能调。
 */
import { el as mk, maybeById } from '../../dom';
import { MODEL_TIERS, TIER_HINT, TIER_LABEL } from '../../protocol';
import type { ModelTier } from '../../protocol';
import { smallBtn } from '../buttons';
import { toast } from '../toast';
import { allRefs, draft, touch } from './draft';

/** 一份清单要能读、能写、能说出自己空着时该显示什么。 */
interface ListSpec {
  containerId: string;
  get(): string[];
  set(next: string[]): void;
  /** 清单为空时的说明。档位的空态是「沿用默认模型」，不是「还没配」。 */
  emptyHint: string;
  /** 加进这份清单时的 toast。 */
  onAdd(ref: string, size: number): string;
}

const DEFAULT_LIST: ListSpec = {
  containerId: 'defaultModelList',
  get: () => draft.models,
  set: (next) => {
    draft.models = next;
  },
  emptyHint: '还没有选默认模型。',
  onAdd: (ref, size) => (size === 1 ? `已设为首选模型：${ref}` : `已添加 ${ref}，记得保存。`),
};

const TIER_LISTS: ListSpec[] = MODEL_TIERS.map((tier) => ({
  containerId: `tierModelList-${tier}`,
  get: () => draft.tierModels[tier],
  set: (next) => {
    draft.tierModels[tier] = next;
  },
  // 空档位不是「坏了」，而是一个明确的语义：这一档的任务沿用默认模型。
  // 说清楚才不会让人以为归在这档的任务跑不起来。
  emptyHint: `留空＝归在${TIER_LABEL[tier]}的任务沿用上面的「默认模型」。`,
  onAdd: (ref) => `已加入${TIER_LABEL[tier]}：${ref}，记得保存。`,
}));

const ALL_LISTS: ListSpec[] = [DEFAULT_LIST, ...TIER_LISTS];

/** 档位说明，渲染在每档标题下面。 */
export function tierHint(tier: ModelTier): string {
  return TIER_HINT[tier];
}

/**
 * 服务商列表变了要跟着刷新（模型可能被删掉），由 renderProviders 统一调用。
 * 四份清单一起重画——删掉一个服务商可能同时影响默认模型与某几档。
 */
export function renderModelList(): void {
  for (const spec of ALL_LISTS) {
    renderOne(spec);
  }
}

function renderOne(spec: ListSpec): void {
  const box = maybeById<HTMLElement>(spec.containerId);
  if (!box) {
    // 插件形态与独立版共用这份代码，容器不在就跳过。
    return;
  }
  box.innerHTML = '';
  const available = allRefs();
  const list = spec.get();

  if (list.length === 0) {
    box.appendChild(
      mk('div', 'hint', available.length === 0 ? '还没有可选的模型，先在上面添加服务商。' : spec.emptyHint)
    );
  }

  for (const [i, ref] of list.entries()) {
    box.appendChild(buildRow(spec, ref, i, available));
  }

  box.appendChild(buildAdder(spec, available));
}

function buildRow(spec: ListSpec, ref: string, index: number, available: string[]): HTMLElement {
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
  ops.appendChild(moveBtn(spec, '↑', index, -1));
  ops.appendChild(moveBtn(spec, '↓', index, 1));
  ops.appendChild(
    smallBtn('移除', () => {
      spec.set(spec.get().filter((_, i) => i !== index));
      touch();
      renderModelList();
    })
  );
  row.appendChild(ops);
  return row;
}

function moveBtn(spec: ListSpec, text: string, index: number, delta: number): HTMLButtonElement {
  const b = smallBtn(text, () => {
    const list = spec.get();
    const to = index + delta;
    if (to < 0 || to >= list.length) {
      return;
    }
    const next = [...list];
    [next[index], next[to]] = [next[to], next[index]];
    spec.set(next);
    touch();
    renderModelList();
  });
  b.disabled = delta < 0 ? index === 0 : index === spec.get().length - 1;
  b.title = delta < 0 ? '上移' : '下移';
  return b;
}

/** 「添加模型」下拉：只列尚未入列的引用。 */
function buildAdder(spec: ListSpec, available: string[]): HTMLElement {
  const wrap = mk('div', 'model-add');
  const list = spec.get();
  const rest = available.filter((r) => !list.includes(r));

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
    const next = [...spec.get(), ref];
    spec.set(next);
    touch();
    renderModelList();
    toast(spec.onAdd(ref, next.length));
  });

  wrap.appendChild(sel);
  return wrap;
}
