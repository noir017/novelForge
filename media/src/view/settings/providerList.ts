/**
 * 设置页的服务商列表：一堆概要卡片，详细配置在弹窗里改。
 * 「默认模型」列表跟着它走（模型可能被删掉），所以在同一处刷新。
 */
import { el as mk } from '../../dom';
import type { SerializedProvider } from '../../protocol';
import { smallBtn } from '../buttons';
import { el } from '../refs';
import { toast } from '../toast';
import { draft, touch } from './draft';
import { renderModelList } from './modelList';
import { KIND_LABEL } from './presets';

/** 由 index.ts 注入：卡片上的「配置」要开弹窗，而弹窗又要能刷新卡片。 */
let openModal: (id: string) => void = () => {};

export function bindOpenModal(fn: (id: string) => void): void {
  openModal = fn;
}

/** 卡片上最多平铺几个模型徽标，多的折成「… 共 N 个」。 */
const MAX_CHIPS = 5;
/** 删除的确认态维持多久。 */
const CONFIRM_MS = 3000;

export function renderProviders(): void {
  el.providerList.innerHTML = '';
  const modelCount = draft.providers.reduce((n, p) => n + p.models.length, 0);
  el.providerCount.textContent = `${draft.providers.length} 个服务商 · ${modelCount} 个模型`;

  if (draft.providers.length === 0) {
    el.providerList.appendChild(
      mk('div', 'hint', '还没有服务商。点下面的预设快速添加一个，或手动添加。')
    );
  }
  for (const p of draft.providers) {
    el.providerList.appendChild(buildProviderCard(p));
  }
  renderModelList();
}

function buildProviderCard(p: SerializedProvider): HTMLElement {
  const card = mk('div', 'provider-card');

  const head = mk('div', 'provider-head');
  const title = mk('span', 'provider-title', p.label || p.id);
  title.title = `模型引用前缀 ${p.id}/`;
  head.appendChild(title);
  head.appendChild(mk('span', 'meta', KIND_LABEL[p.kind] || p.kind));
  head.appendChild(smallBtn('配置', () => openModal(p.id)));
  head.appendChild(buildDeleteBtn(p));
  card.appendChild(head);

  const url = mk(
    'div',
    'provider-url',
    p.kind === 'vscode-lm' ? '内置 · 无需接口地址' : p.baseUrl || '未设置接口地址'
  );
  url.title = p.baseUrl || '';
  card.appendChild(url);

  card.appendChild(buildModelChips(p));
  return card;
}

function buildModelChips(p: SerializedProvider): HTMLElement {
  const models = mk('div', 'provider-models');
  if (p.models.length === 0) {
    models.appendChild(mk('span', 'meta', '还没有模型'));
  }
  for (const m of p.models.slice(0, MAX_CHIPS)) {
    const chip = mk('span', 'model-chip', m.name || '…');
    chip.title = `${p.id}/${m.name}`;
    models.appendChild(chip);
  }
  if (p.models.length > MAX_CHIPS) {
    models.appendChild(mk('span', 'meta', `… 共 ${p.models.length} 个`));
  }
  return models;
}

/** 删除按钮：第一次点击进入确认态，三秒内再点才真删。 */
function buildDeleteBtn(p: SerializedProvider): HTMLElement {
  const b = mk('button', 'link', '删除');
  let timer: ReturnType<typeof setTimeout> | null = null;

  b.addEventListener('click', () => {
    if (timer) {
      clearTimeout(timer);
      draft.providers = draft.providers.filter((x) => x !== p);
      touch();
      renderProviders();
      toast(`已删除服务商「${p.label || p.id}」，记得保存。`);
      return;
    }
    b.textContent = '确认删除？';
    b.classList.add('danger');
    timer = setTimeout(() => {
      timer = null;
      b.textContent = '删除';
      b.classList.remove('danger');
    }, CONFIRM_MS);
  });
  return b;
}
