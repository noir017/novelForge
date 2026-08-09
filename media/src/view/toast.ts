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

export function toast(message: string, isError?: boolean): void {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', !!isError);
  setHidden(el.toast, false);
  clearTimeout(timer);
  timer = setTimeout(() => setHidden(el.toast, true), isError ? ERROR_MS : INFO_MS);
}

/** 装到全局，供 editor / explorer 复用。 */
export function exposeToast(): void {
  window.__nfToast = toast;
}
