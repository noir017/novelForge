/**
 * 「设定」组标题旁的筛选框：设定几百条时不用一层层翻目录。
 *
 * **纯前端**：筛选串记在 `treeState.loreView.filter`，不发给后端、不进推送；后端每次文件变动
 * 都整棵重推树，筛选照样留着（同折叠开合）。按标题、一句话（行副标题）与关键词筛已建条目，
 * 按名字与分类筛「出现过 · 未建条目」与「待完善」，不分大小写的子串匹配。
 *
 * 难点是**重画会把输入框换掉**：工程页每次都整页重建（`renderProject`），打一个字重画一次，
 * 文件监视推来的树也随时会重画。所以：
 *
 * 1. 重画前记下焦点与光标（`captureLoreFilterFocus`），重画完放回新的输入框上——不然每打一个字
 *    焦点就丢一次，旁边保存一章也会把正在打字的人踢出来。
 * 2. **输入法组字期间不重画**：组字中途换掉输入框，打了一半的拼音就没了。中途的 `input` 不算数，
 *    等 `compositionend` 再筛；这期间推来的树只记下不画（`renderProject` 先问 `loreFilterComposing`），
 *    组字结束那一下按最新的树一起画。
 */
import { el as mk, setHidden } from '../../dom';
import type { LoreUnfiledEntry, ProjectFile, ProjectTree } from '../../protocol';
import { loreView, openGroups } from './treeState';

/** 筛选框里正在用输入法组字。 */
let composing = false;

export function loreFilterComposing(): boolean {
  return composing;
}

function needle(): string {
  return loreView.filter.trim().toLowerCase();
}

function hits(q: string, ...texts: string[]): boolean {
  return texts.some((t) => t.toLowerCase().includes(q));
}

/**
 * 已建条目的匹配函数，交给 `renderNodes`。没在筛选时给 undefined——那条路径照旧按折叠开合画。
 * 关键词不在行上（行上只有标题与一句话），从 `loreByEntry` 里取。
 */
export function loreMatcher(tree: ProjectTree): ((f: ProjectFile) => boolean) | undefined {
  const q = needle();
  if (!q) {
    return undefined;
  }
  return (f) => hits(q, f.label, f.detail, ...(tree.loreByEntry[f.relPath]?.keywords ?? []));
}

/** 「出现过 · 未建条目」「待完善」里按名字与分类匹配的那些（没在筛选时原样返回）。 */
export function filterUnfiled<T extends Pick<LoreUnfiledEntry, 'name' | 'category'>>(list: T[]): T[] {
  const q = needle();
  return q ? list.filter((u) => hits(q, u.name, u.category)) : list;
}

/**
 * 筛选框本身。`rerender` 是整页重画（index.ts 的 `rerenderProject`）。
 *
 * 不用 `type="search"`：Chromium 会再画一个原生的清空叉，和我们自己的 × 叠成两个；
 * 而 Firefox 又不画——自己画一个两边才一样。
 */
export function buildLoreFilter(rerender: () => void): HTMLElement {
  const box = mk('span', 'lore-filter');
  const input = mk('input', 'lore-filter-input');
  input.type = 'text';
  input.placeholder = '筛选设定';
  input.title = '按标题、一句话、关键词筛选设定；也筛下面的「出现过 · 未建条目」（Esc 清空）';
  input.spellcheck = false;
  input.value = loreView.filter;

  const clearBtn = mk('button', 'lore-filter-clear', '×');
  clearBtn.title = '清空筛选（Esc）';
  setHidden(clearBtn, loreView.filter === '');

  const apply = (value: string) => {
    if (value === loreView.filter) {
      return;
    }
    loreView.filter = value;
    // 组折着的时候打字等于什么都看不见：开始筛就把它展开。
    if (value.trim()) {
      openGroups.lore = true;
    }
    rerender();
  };

  input.addEventListener('input', (e) => {
    if ((e as InputEvent).isComposing || composing) {
      return;
    }
    apply(input.value);
  });
  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    // 无条件重画：组字期间推来的树还没画（见文件头第 2 条）。之后浏览器若再补一发 input，
    // apply 看值没变就不再画第二遍。
    loreView.filter = input.value;
    if (input.value.trim()) {
      openGroups.lore = true;
    }
    rerender();
  });
  // 兜底：组字没收尾就失焦（切页签之类）的浏览器不发 compositionend，标志不清的话
  // 之后推来的树永远画不出来。只在真的卡着组字时才重画——平时失焦就重画，会把作者正要点的那一行换掉。
  input.addEventListener('blur', () => {
    if (composing) {
      composing = false;
      rerender();
    }
  });

  input.addEventListener('keydown', (e) => {
    // 组字时的 Esc 是输入法自己的（取消这次组字），放行。
    if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) {
      return;
    }
    if (input.value !== '' || loreView.filter !== '') {
      e.preventDefault();
      input.value = '';
      apply('');
    }
  });

  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    input.value = '';
    apply('');
    // 按下按钮时焦点已经落在按钮上，重画前记不到输入框，这里直接放回去：清完多半接着打别的字。
    document.querySelector<HTMLInputElement>('#projectBody .lore-filter-input')?.focus({ preventScroll: true });
  });

  box.append(input, clearBtn);
  return box;
}

interface FilterFocus {
  start: number | null;
  end: number | null;
  direction: 'forward' | 'backward' | 'none' | null;
}

/** 重画前：焦点在筛选框里就记下光标。 */
export function captureLoreFilterFocus(): FilterFocus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || !active.classList.contains('lore-filter-input')) {
    return null;
  }
  return { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection };
}

/** 重画后：把焦点与光标放回新的那个筛选框（这次重画把筛选框撤掉了就算了）。 */
export function restoreLoreFilterFocus(saved: FilterFocus | null): void {
  if (!saved) {
    return;
  }
  const input = document.querySelector<HTMLInputElement>('#projectBody .lore-filter-input');
  if (!input) {
    return;
  }
  // preventScroll：焦点放回去不该把工程页滚到标题栏那儿。
  input.focus({ preventScroll: true });
  if (saved.start !== null && saved.end !== null) {
    const max = input.value.length;
    input.setSelectionRange(Math.min(saved.start, max), Math.min(saved.end, max), saved.direction ?? undefined);
  }
}
