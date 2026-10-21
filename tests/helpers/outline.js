/**
 * 一章一条的情节大纲夹具（docs/design/plans/2026-10-21-outline-per-chapter.md）。
 *
 * 旧格式「## 第1–20章：第一幕」不认了：要「大纲覆盖到第 20 章」，就得有第 1–20 章各一条。
 *
 * ```js
 * outlineOf(20)                                    // 第 1–20 章，每条一行「第N章的事。」
 * outlineOf(20, { text: { 1: '林昭进青云宗。' } })  // 第 1 章换成指定的正文
 * outlineOf(40, { from: 21, heading: false })      // 只要第 21–40 章那几条，不带 `# 情节大纲`
 * ```
 */
function outlineOf(to, { from = 1, title = '情节大纲', heading = true, text = {}, titles = {} } = {}) {
  const entries = [];
  for (let no = from; no <= to; no++) {
    entries.push(`## 第${no}章${titles[no] ? `：${titles[no]}` : ''}\n${text[no] ?? `第${no}章的事。`}`);
  }
  return `${heading ? `# ${title}\n\n` : ''}${entries.join('\n\n')}\n`;
}

module.exports = { outlineOf };
