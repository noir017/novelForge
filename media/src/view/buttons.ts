/** 建按钮的几个小工具。设置页、消息气泡、工程页都在用。 */
import { el } from '../dom';

export function linkBtn(text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'link', text);
  b.addEventListener('click', onClick);
  return b;
}

export function primaryBtn(text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'primary', text);
  b.addEventListener('click', onClick);
  return b;
}

export function secondaryBtn(text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'secondary', text);
  b.addEventListener('click', onClick);
  return b;
}

/** 卡片头部用的小号按钮。 */
export function smallBtn(text: string, onClick: () => void): HTMLButtonElement {
  const b = secondaryBtn(text, onClick);
  b.classList.add('small');
  return b;
}
