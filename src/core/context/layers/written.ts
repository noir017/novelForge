/**
 * `written` 层：已写正文（拆书 A）。从作者已经写成的章里整理架构时，模型要看的那几章。
 *
 * **只在 `BuildRequest.derive` 时有内容**：架构那张配方挂着这一层，平时什么都不带。
 * 「这些章已经写成、是权威事实」那句话在 builder 的小标题与契约里说。
 *
 * 带第 1–N 章的梗概与看点（一章一行），加均匀抽样几章（上下文详细度的 `deriveSamples`，缺省 5）的开头节选。
 * 节选按配方（强制）；梗概放不下就隔章抽，写明抽了几章。
 *
 * 从前大纲那张配方也挂着它（照区间里各章定稿过的细纲整理大纲）。情节大纲改成各章细纲梗概的汇总之后，写过的章那一条
 * 就是定稿写下的梗概，不再另整理（docs/design/plans/2026-10-22-outline-from-plots.md）。
 *
 * 只认**定稿过**的细纲（有 `sourceHash`）：没定稿的是写之前的计划，不是「已经写成的东西」。
 *
 * 上游（AI-Novel-Writer 的 `import-novel.command.ts`）推演设定只看首末两章各 3000 字——长书的中段
 * 都丢了。这里设定看全书梗概加均匀抽样。
 */
import { plotLabel } from '../../model/pipeline';
import { evenSample, headOf } from '../../model/importText';
import { Plot } from '../../model/plotFile';
import { NovelProject } from '../../model/project';
import { Chapter } from '../../model/types';
import { estimateTokens } from '../tokenizer';
import type { LayerFn } from './assembly';

/** 首章的节选长一点：开篇交代的东西最多。 */
export const SAMPLE_HEAD_FIRST = 3000;
export const SAMPLE_HEAD = 2000;

export const written: LayerFn = async (a, spec) => {
  const derive = a.request.derive;
  if (!derive) {
    return;
  }
  const chapters = (await a.project.listChapters()).filter((c) => c.wordCount > 0 && c.order <= derive.through);
  if (chapters.length === 0) {
    return;
  }
  if (a.request.action.stage === 'setting') {
    await settingMaterial(a, spec, chapters);
  }
};

/** 这一章定稿过的细纲（正文镜像的那一份，有 `sourceHash`）。没定稿过的是计划，不当已写的东西。 */
async function finalizedPlot(project: NovelProject, chapter: Chapter): Promise<Plot | undefined> {
  const plot = await project.plotOfChapter(chapter);
  return plot?.sourceHash ? plot : undefined;
}

/** 架构那几件：全书梗概 + 抽样节选。 */
async function settingMaterial(a: Parameters<LayerFn>[0], spec: Parameters<LayerFn>[1], chapters: Chapter[]): Promise<void> {
  // 节选先进（强制）：它们是「这本书读起来什么样」的唯一证据，梗概再长也替不了。
  const samples = a.limits.deriveSamples;
  for (const i of evenSample(chapters.length, samples)) {
    const chapter = chapters[i];
    const text = await a.project.readChapterText(chapter);
    const head = i === 0 ? SAMPLE_HEAD_FIRST : SAMPLE_HEAD;
    a.admit(
      {
        id: `written:${chapter.order}`,
        kind: 'written',
        priority: spec.priority,
        label: `${plotLabel(chapter.order, chapter.title)} · 开头节选`,
        source: chapter.relPath,
        text: `【${plotLabel(chapter.order, chapter.title)} · 开头节选】\n${headOf(text, head)}`,
        note: `均匀抽样 ${samples} 章之一，开头 ${head} 字`,
      },
      { force: spec.force }
    );
  }

  const lines: { no: number; line: string }[] = [];
  let missing = 0;
  for (const chapter of chapters) {
    const sections = (await finalizedPlot(a.project, chapter))?.sections;
    const synopsis = sections?.梗概?.trim();
    if (synopsis) {
      // 看点跟在梗概后面：卖点与爽点只能从这里提炼，梗概只写发生了什么。
      const highlight = (sections?.看点 ?? '')
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*[-*·]\s*/, '').trim())
        .filter(Boolean)
        .join('；');
      const tail = highlight ? `｜看点：${highlight}` : '';
      lines.push({ no: chapter.order, line: `${plotLabel(chapter.order, chapter.title)}：${synopsis.replace(/\s+/g, ' ')}${tail}` });
    } else {
      missing++;
    }
  }
  if (lines.length === 0) {
    return;
  }
  const last = chapters[chapters.length - 1].order;
  const base = {
    id: 'written:synopsis',
    kind: 'written' as const,
    priority: spec.priority,
    label: `第 1–${last} 章梗概与看点`,
  };
  const all = `【第 1–${last} 章梗概与看点（一章一行）】\n${lines.map((l) => l.line).join('\n')}`;
  const missingNote = missing > 0 ? `；${missing} 章还没同步，没有梗概可带` : '';
  if (estimateTokens(all) <= a.remaining) {
    a.admit({ ...base, text: all, note: `${lines.length} 章${missingNote}` });
    return;
  }
  // 放不下就隔章抽：每 k 章留一章，首尾都在。宁可稀一点，也不要只剩前半本。
  for (let stride = 2; stride <= lines.length; stride++) {
    const kept = lines.filter((_, i) => i % stride === 0 || i === lines.length - 1);
    const text = `【第 1–${last} 章梗概与看点（每 ${stride} 章取一章）】\n${kept.map((l) => l.line).join('\n')}`;
    const tokens = estimateTokens(text);
    if (tokens <= a.remaining) {
      a.accept({ ...base, text, status: 'degraded', note: `预算不足，${lines.length} 章里每 ${stride} 章取一章，带了 ${kept.length} 章${missingNote}` }, tokens);
      return;
    }
  }
  a.reject({ ...base, text: '' }, 'dropped', `预算不足，梗概一章都放不下${missingNote}`);
}
