/**
 * 提示条。整个页面只有一条——editor / explorer 经 `window.__nfToast` 复用它，
 * 免得两套提示互相盖住。
 */
import { setHidden } from '../dom';
import { el } from './refs';

/** 错误留久一点：那多半是要照着做点什么的，一闪而过等于没说。 */
const INFO_MS = 3500;
const ERROR_MS = 9000;

let timer: ReturnType<typeof setTimeout> | undefined;

/** 带一个按钮的提示（任务做完时的「打开第 3 章」，D24）要多留一会儿：那是要点的。 */
const ACTION_MS = 12000;

/**
 * 出一条提示。`action` 给了就在提示条上多一颗按钮，点了执行、提示收起。
 */
export function toast(message: string, isError?: boolean, action?: { label: string; run: () => void }): void {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', !!isError);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'link toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      setHidden(el.toast, true);
      action.run();
    });
    el.toast.appendChild(btn);
  }
  setHidden(el.toast, false);
  clearTimeout(timer);
  timer = setTimeout(() => setHidden(el.toast, true), action ? ACTION_MS : isError ? ERROR_MS : INFO_MS);
}

/** 装到全局，供 editor / explorer 复用。 */
export function exposeToast(): void {
  window.__nfToast = toast;
}
