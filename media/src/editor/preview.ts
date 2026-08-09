/**
 * 够用的 Markdown 块级渲染：标题、引用、列表、代码块、分隔线、frontmatter，
 * 行内支持 `**粗**` `*斜*` `` `码` `` `[文本](链接)`。
 *
 * 全部走 createElement + textContent，**不拼 HTML 字符串**——正文里出现
 * `<script>` 也只是普通文字。这不是要做一个完整的 Markdown 实现，只是让
 * 作者能预览自己写的东西；缺的语法原样显示即可，不该为此引一个解析库。
 */
import { el } from '../dom';

/** 工程内的相对链接点开时的回调（在哪一块预览里点的，就开在哪一块）。 */
export type OpenLink = (path: string) => void;

export function renderPreview(
  target: HTMLElement,
  text: string,
  fromPath: string,
  openLink: OpenLink
): void {
  target.innerHTML = '';
  const lines = text.split('\n');
  let i = 0;

  // frontmatter 是元数据，单独框起来，不混进正文。
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      target.appendChild(el('div', 'ed-frontmatter', lines.slice(1, end).join('\n')));
      i = end + 1;
    }
  }

  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length === 0) {
      return;
    }
    const p = el('p');
    appendInline(p, paragraph.join('\n'), fromPath, openLink);
    target.appendChild(p);
    paragraph = [];
  };

  let list: HTMLElement | null = null;
  const endList = () => {
    list = null;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') {
      flush();
      endList();
      continue;
    }

    if (trimmed.startsWith('```')) {
      flush();
      endList();
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) {
        buf.push(lines[i]);
      }
      target.appendChild(el('pre', undefined, buf.join('\n')));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      endList();
      // h4 以下都当 h3 画：预览是给人快速扫一眼的，再细分层级没有意义。
      const h = document.createElement(`h${Math.min(heading[1].length, 3)}`);
      appendInline(h, heading[2], fromPath, openLink);
      target.appendChild(h);
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s/g, ''))) {
      flush();
      endList();
      target.appendChild(el('hr'));
      continue;
    }

    if (trimmed.startsWith('>')) {
      flush();
      endList();
      const quote = el('blockquote');
      appendInline(quote, trimmed.replace(/^>\s?/, ''), fromPath, openLink);
      target.appendChild(quote);
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || ordered) {
      flush();
      const want = bullet ? 'UL' : 'OL';
      if (!list || list.tagName !== want) {
        list = el(bullet ? 'ul' : 'ol');
        target.appendChild(list);
      }
      const li = el('li');
      appendInline(li, bullet ? bullet[1] : ordered![2], fromPath, openLink);
      list.appendChild(li);
      continue;
    }

    endList();
    paragraph.push(line);
  }
  flush();
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
