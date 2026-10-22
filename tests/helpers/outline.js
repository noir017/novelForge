/**
 * 情节大纲的夹具。大纲一章一条（docs/design/plans/2026-10-21-outline-per-chapter.md），而且**没有文件**：它是各章细纲
 * 「梗概」的汇总（docs/design/plans/2026-10-22-outline-from-plots.md）。要「大纲覆盖到第 20 章」，就得有第 1–20 章
 * 各一份带梗概的细纲——`writeOutline` 照一份大纲文本把它们写出来。
 *
 * ```js
 * outlineOf(20)                                    // 第 1–20 章，每条一行「第N章的事。」
 * outlineOf(20, { text: { 1: '林昭进青云宗。' } })  // 第 1 章换成指定的正文
 * outlineOf(40, { from: 21, heading: false })      // 只要第 21–40 章那几条，不带 `# 情节大纲`
 * writeOutline(t, outlineOf(20))                   // 写成第 1–20 章的细纲空壳（t 是 tmpProject 的路径助手）
 * ```
 */
const fs = require('fs');
const path = require('path');

function outlineOf(to, { from = 1, title = '情节大纲', heading = true, text = {}, titles = {} } = {}) {
  const entries = [];
  for (let no = from; no <= to; no++) {
    entries.push(`## 第${no}章${titles[no] ? `：${titles[no]}` : ''}\n${text[no] ?? `第${no}章的事。`}`);
  }
  return `${heading ? `# ${title}\n\n` : ''}${entries.join('\n\n')}\n`;
}

/** 一章一条认出来：`## 第N章：标题` 下面到下一个 `#` 标题之前。区间标题、认不出的段落不算。 */
function entriesOf(text) {
  const out = [];
  let cur;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^#{2,3}\s*第\s*(\d+)\s*章\s*[:：]?\s*(.*?)\s*$/.exec(line);
    if (m) {
      cur = { no: Number(m[1]), title: m[2], lines: [] };
      if (!out.some((e) => e.no === cur.no)) {
        out.push(cur);
      }
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      cur = undefined;
      continue;
    }
    cur?.lines.push(line);
  }
  return out.map((e) => ({ no: e.no, title: e.title, text: e.lines.join('\n').trim() })).filter((e) => e.text);
}

/** 只有标题与梗概的一份细纲（与网关拆大纲时建的空壳同一个样子，只是不带空的那几节）。 */
function stubOf({ no, title, text }) {
  return `---\nno: ${no}\ntitle: ${title}\ngeneratedBy: novel-forge\n---\n\n# 第${no}章${title ? ` ${title}` : ''}\n\n## 梗概\n\n${text}\n`;
}

/**
 * 照一份大纲文本写各章细纲：这一章还没有细纲（`summaries/` 下没有同号的 .md）就建一份空壳——有正文落正文的镜像
 * （`chapters/003-夜访.md` → `summaries/003-夜访.md`），没有就是 `summaries/NNN.md`；已经有了就只换它的「梗概」一节
 * （与网关存大纲时同一个口径）。`t` 是 tmpProject 的路径助手（`write` / `rel`）；章节根按缺省的 `chapters/` 认。
 */
function writeOutline(t, text) {
  const dir = t.rel('.novelforge/summaries');
  const existing = fs.existsSync(dir) ? listDeep(dir) : [];
  const chaptersDir = t.rel('chapters');
  const chapters = fs.existsSync(chaptersDir) ? listDeep(chaptersDir, () => true) : [];
  for (const e of entriesOf(text)) {
    const hit = existing.find((abs) => Number(/^(\d{1,5})/.exec(path.basename(abs))?.[1]) === e.no);
    if (!hit) {
      const chapter = chapters.find((abs) => Number(/^(\d{1,5})/.exec(path.basename(abs))?.[1]) === e.no);
      const mirror = chapter
        ? path.relative(chaptersDir, chapter).split(path.sep).join('/').replace(/\.[^./]*$/, '') + '.md'
        : `${String(e.no).padStart(3, '0')}.md`;
      t.write(`.novelforge/summaries/${mirror}`, stubOf(e));
      continue;
    }
    const raw = fs.readFileSync(hit, 'utf8');
    const re = /(^##\s*梗概\s*\n)([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/m;
    const next = re.test(raw) ? raw.replace(re, `$1\n${e.text}\n\n`) : raw.replace(/\s*$/, `\n\n## 梗概\n\n${e.text}\n`);
    fs.writeFileSync(hit, next, 'utf8');
  }
}

/** 目录下各级以数字开头的文件（缺省只要 .md）。 */
function listDeep(dir, keep = (name) => /\.md$/i.test(name)) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listDeep(abs, keep));
    } else if (/^\d{1,5}/.test(entry.name) && keep(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

module.exports = { outlineOf, writeOutline };
