/**
 * 建 DOM 的小工具。三个前端产物共用。
 *
 * 全部走 createElement + textContent，**从不拼 HTML 字符串**：
 * 页面上显示的东西大半是模型写的或作者写的（摘要、正文、文件名），
 * 里面出现 `<script>` 也只该是普通文字。
 */

/**
 * 造一个元素。`text` 一律经 textContent 落下去。
 *
 * ```ts
 * el('span', 'meta', '3 章');
 * el('button', 'primary');
 * ```
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** 撑开剩余空间的占位符。工具栏、消息头部里到处在用。 */
export function spacer(): HTMLSpanElement {
  return el('span', 'spacer');
}

/**
 * 按 id 取一个必然存在的节点。取不到就抛——那说明 html.ts 与这里对不上，
 * 静默返回 null 只会让错误在几十行之后以「读 null 的属性」的面目出现。
 */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`页面上找不到 #${id}——html 模板与前端代码不同步`);
  }
  return node as T;
}

/**
 * 按 id 取一个**可能不存在**的节点。
 *
 * 两个壳的 DOM 不完全一样：独立版有活动栏徽标、内置编辑器、资源管理器，
 * 插件形态没有。用它探测能力，而不是判断环境字符串。
 */
export function maybeById<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** `classList.toggle` 的 hidden 版，够短才不会有人图省事去写 style.display。 */
export function setHidden(node: Element, hidden: boolean): void {
  node.classList.toggle('hidden', hidden);
}

/** 清空一个容器。重渲染前都要走一次。 */
export function clear(node: Element): void {
  node.innerHTML = '';
}

/** 事件目标向上找最近的匹配元素。`e.target` 是 EventTarget，得先窄化。 */
export function closestFrom<T extends Element = HTMLElement>(
  target: EventTarget | null,
  selector: string
): T | null {
  return target instanceof Element ? target.closest<T>(selector) : null;
}
