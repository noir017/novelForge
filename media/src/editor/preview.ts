/**
 * 够用的 Markdown 块级渲染：标题、引用、列表、代码块、分隔线、frontmatter，
 * 行内支持 `**粗**` `*斜*` `` `码` `` `[文本](链接)`。怎么切块在零 DOM 的 `previewCore.ts`（`previewBlocks`）。
 *
 * 全部走 createElement + textContent，**不拼 HTML 字符串**——正文里出现
 * `<script>` 也只是普通文字。这不是要做一个完整的 Markdown 实现，只是让
 * 作者能预览自己写的东西；缺的语法原样显示即可，不该为此引一个解析库。
 *
 * **每一块记着它是源文件的哪几行**：`data-line`（第一行，从 0 数）与 `data-line-end`（最后一行的下一行），
 * 挂在 frontmatter、标题、段落、代码块、分隔线、引用与每一个列表项上（不挂在 `<ul>` / `<ol>` 上，各块互不重叠）。
 * 切预览 / 切回编辑时按它两边滚到同一处（`previewSync.ts`）。
 */
import { el } from '../dom';
import { previewBlocks } from './previewCore';

/** 工程内的相对链接点开时的回调（在哪一块预览里点的，就开在哪一块）。 */
export type OpenLink = (path: string) => void;

/** 给一块记上它是第几行到第几行。 */
function mark<T extends HTMLElement>(node: T, span: { start: number; end: number }): T {
  node.dataset.line = String(span.start);
  node.dataset.lineEnd = String(span.end);
  return node;
}

export function renderPreview(
  target: HTMLElement,
  text: string,
  fromPath: string,
  openLink: OpenLink
): void {
  target.innerHTML = '';
  for (const block of previewBlocks(text)) {
    switch (block.kind) {
      case 'frontmatter':
        // frontmatter 是元数据，单独框起来，不混进正文。
        target.appendChild(mark(el('div', 'ed-frontmatter', block.text), block));
        break;
      case 'heading': {
        const h = document.createElement(`h${block.level}`);
        appendInline(h, block.text, fromPath, openLink);
        target.appendChild(mark(h, block));
        break;
      }
      case 'paragraph': {
        const p = el('p');
        appendInline(p, block.text, fromPath, openLink);
        target.appendChild(mark(p, block));
        break;
      }
      case 'code':
        target.appendChild(mark(el('pre', undefined, block.text), block));
        break;
      case 'hr':
        target.appendChild(mark(el('hr'), block));
        break;
      case 'quote': {
        const quote = el('blockquote');
        appendInline(quote, block.text, fromPath, openLink);
        target.appendChild(mark(quote, block));
        break;
      }
      case 'list': {
        const list = el(block.ordered ? 'ol' : 'ul');
        for (const item of block.items) {
          const li = el('li');
          appendInline(li, item.text, fromPath, openLink);
          list.appendChild(mark(li, item));
        }
        target.appendChild(list);
        break;
      }
    }
  }
}

/** 行内：`**粗**`、`*斜*`、`` `码` ``、`[文本](链接)`。其余原样。 */
function appendInline(
  parent: HTMLElement,
  text: string,
  fromPath: string,
  openLink: OpenLink
): void {
  const re = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    }
    const token = m[0];
    if (token.startsWith('**')) {
      parent.appendChild(el('strong', undefined, token.slice(2, -2)));
    } else if (token.startsWith('`')) {
      parent.appendChild(el('code', undefined, token.slice(1, -1)));
    } else if (token.startsWith('[')) {
      parent.appendChild(linkNode(token, fromPath, openLink));
    } else {
      parent.appendChild(el('em', undefined, token.slice(1, -1)));
    }
    last = m.index + token.length;
  }
  if (last < text.length) {
    parent.appendChild(document.createTextNode(text.slice(last)));
  }
}

/**
 * `[文本](链接)`。外链开浏览器，工程内的相对链接点开就是另一个标签页——
 * 角色卡里互相引用得很密，跳浏览器毫无用处。
 */
function linkNode(token: string, fromPath: string, openLink: OpenLink): HTMLElement {
  const split = token.indexOf('](');
  const label = token.slice(1, split);
  const href = token.slice(split + 2, -1);

  if (/^https?:\/\//i.test(href)) {
    const a = el('a', undefined, label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    return a;
  }
  const btn = el('button', 'link', label);
  btn.addEventListener('click', () => openLink(resolveRelative(fromPath, href)));
  return btn;
}

/** `.novelforge/characters/a.md` + `../lore/b.md` → `.novelforge/lore/b.md` */
export function resolveRelative(fromPath: string, href: string): string {
  const target = decodeURI(href.split('#')[0]);
  if (!fromPath || target.startsWith('/')) {
    return target.replace(/^\//, '');
  }
  const parts = fromPath.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
